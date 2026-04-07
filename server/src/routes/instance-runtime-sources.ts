import { Router, type Request } from "express";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { runtimeSourcesConfigSchema } from "@paperclipai/shared";
import {
  detectRuntimeSources,
  readCodexPlugins,
  readCodexSkills,
  readCodexThreads,
  readOpenClawSkills,
  readOpenClawSessions,
} from "@paperclipai/shared/runtime-sources";
import { listCodexThreadsViaAppServer } from "../services/runtime-conversations.js";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { writeConfigFile, readConfigFile } from "../config-file.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { getActorInfo } from "./authz.js";

const execFile = promisify(execFileCallback);

export async function pickDirectoryViaOsascript(prompt: string): Promise<{ path: string | null; canceled: boolean }> {
  const { stdout } = await execFile("osascript", [
    "-e",
    `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`,
  ]);
  const pickedPath = stdout.trim();
  if (!pickedPath) {
    return { path: null, canceled: true };
  }
  return { path: pickedPath, canceled: false };
}

export const instanceRuntimeSourcesRouteInternals = {
  pickDirectoryViaOsascript,
  readOpenClawGatewayToken(homeDir: string): string | null {
    const configPath = path.join(homeDir, "openclaw.json");
    if (!fs.existsSync(configPath)) return null;

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const gateway = (parsed as Record<string, unknown>).gateway;
    if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway)) return null;
    const auth = (gateway as Record<string, unknown>).auth;
    if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return null;
    const token = (auth as Record<string, unknown>).token;
    return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
  },
};

function assertBoardRead(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

function assertCanManageInstanceConfig(req: Request) {
  assertBoardRead(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}

export function instanceRuntimeSourcesRoutes(db: Db) {
  const router = Router();
  const instanceSettings = instanceSettingsService(db);

  router.get("/instance/runtime-sources", async (req, res) => {
    assertBoardRead(req);
    const config = readConfigFile();
    res.json(config?.runtimeSources ?? null);
  });

  router.get("/instance/runtime-sources/discovery", async (req, res) => {
    assertBoardRead(req);
    res.json({ data: detectRuntimeSources(process.env) });
  });

  router.post("/instance/runtime-sources/pick-directory", async (req, res) => {
    assertCanManageInstanceConfig(req);

    if (process.platform !== "darwin") {
      res.status(501).json({ error: "Native directory picker is currently only implemented for macOS." });
      return;
    }

    const prompt =
      typeof req.body?.prompt === "string" && req.body.prompt.trim().length > 0
        ? req.body.prompt.trim()
        : "Choose a folder";

    try {
      res.json(await instanceRuntimeSourcesRouteInternals.pickDirectoryViaOsascript(prompt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/User canceled|cancelled|Application isn't running/i.test(message)) {
        res.json({ path: null, canceled: true });
        return;
      }
      throw error;
    }
  });

  router.get("/instance/runtime-sources/codex/threads", async (req, res) => {
    assertBoardRead(req);
    const config = readConfigFile();
    const homeDir = config?.runtimeSources?.codex?.homeDir;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 100;
    const cwd = typeof req.query.cwd === "string" && req.query.cwd.trim().length > 0
      ? req.query.cwd.trim()
      : null;
    res.json({
      data: homeDir
        ? (
          cwd
            ? await listCodexThreadsViaAppServer({ codexHome: homeDir, limit, cwd })
            : readCodexThreads(homeDir, limit)
        )
        : [],
    });
  });

  router.get("/instance/runtime-sources/codex/skills", async (req, res) => {
    assertBoardRead(req);
    const config = readConfigFile();
    const homeDir = config?.runtimeSources?.codex?.homeDir;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 500) : 100;
    res.json({
      data: homeDir ? readCodexSkills(homeDir, limit) : [],
    });
  });

  router.get("/instance/runtime-sources/codex/plugins", async (req, res) => {
    assertBoardRead(req);
    const config = readConfigFile();
    const homeDir = config?.runtimeSources?.codex?.homeDir;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 500) : 100;
    res.json({
      data: homeDir ? readCodexPlugins(homeDir, limit) : [],
    });
  });

  router.get("/instance/runtime-sources/openclaw/sessions", async (req, res) => {
    assertBoardRead(req);
    const config = readConfigFile();
    const homeDir = config?.runtimeSources?.openclaw?.homeDir;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 100;
    res.json({
      data: homeDir ? readOpenClawSessions(homeDir, limit) : [],
    });
  });

  router.get("/instance/runtime-sources/openclaw/skills", async (req, res) => {
    assertBoardRead(req);
    const config = readConfigFile();
    const homeDir = config?.runtimeSources?.openclaw?.homeDir;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 500) : 100;
    res.json({
      data: homeDir ? readOpenClawSkills(homeDir, limit) : [],
    });
  });

  router.get("/instance/runtime-sources/openclaw/gateway-token", async (req, res) => {
    assertCanManageInstanceConfig(req);
    const config = readConfigFile();
    const homeDir = config?.runtimeSources?.openclaw?.homeDir;
    if (!homeDir) {
      res.json({ token: null });
      return;
    }

    try {
      res.json({ token: instanceRuntimeSourcesRouteInternals.readOpenClawGatewayToken(homeDir) });
    } catch {
      res.json({ token: null });
    }
  });

  router.patch(
    "/instance/runtime-sources",
    validate(runtimeSourcesConfigSchema),
    async (req, res) => {
      assertCanManageInstanceConfig(req);
      const config = readConfigFile();
      if (!config) {
        throw new Error("Paperclip config file is not available.");
      }

      config.runtimeSources = req.body;
      config.$meta.updatedAt = new Date().toISOString();
      config.$meta.source = "configure";
      writeConfigFile(config);

      const actor = getActorInfo(req);
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.runtime_sources.updated",
            entityType: "instance_runtime_sources",
            entityId: "default",
            details: {
              runtimeSources: req.body,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );

      res.json(config.runtimeSources ?? null);
    },
  );

  return router;
}
