import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { startIssueCodexThreadSchema, upsertIssueRuntimeLinkSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { agentService, heartbeatService, issueRuntimeLinkService, issueService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { readConfigFile } from "../config-file.js";
import { startCodexThreadViaAppServer } from "../services/runtime-conversations.js";

function assertBoardIssueWrite(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function issueRuntimeLinkRoutes(db: Db) {
  const router = Router();
  const issues = issueService(db);
  const runtimeLinks = issueRuntimeLinkService(db);
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);

  router.param("id", async (req, _res, next, rawId) => {
    try {
      const normalized = await issues.getById(rawId);
      req.params.id = normalized?.id ?? rawId;
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/issues/:id/runtime-link", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issues.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    res.json(await runtimeLinks.getForIssue(issue.id));
  });

  router.put("/issues/:id/runtime-link", validate(upsertIssueRuntimeLinkSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await issues.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    assertBoardIssueWrite(req);

    const actor = getActorInfo(req);
    const assignee =
      issue.assigneeAgentId ? await agents.getById(issue.assigneeAgentId) : null;
    const link = await runtimeLinks.upsertForIssue(
      issue.id,
      req.body,
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    if (!link) {
      res.status(500).json({ error: "Failed to persist runtime link" });
      return;
    }

    if (assignee?.adapterType === "codex_local" && link.runtimeKind === "codex") {
      const metadataJson =
        req.body && typeof req.body === "object" && "metadataJson" in req.body
          ? (req.body.metadataJson as Record<string, unknown> | null | undefined)
          : null;
      const cwd =
        typeof metadataJson?.cwd === "string" && metadataJson.cwd.trim().length > 0
          ? metadataJson.cwd.trim()
          : null;
      await heartbeat.setTaskSession({
        companyId: issue.companyId,
        agentId: assignee.id,
        adapterType: assignee.adapterType,
        taskKey: issue.id,
        sessionParamsJson: {
          sessionId: link.externalConversationId,
          ...(cwd ? { cwd } : {}),
        },
        sessionDisplayId: link.externalConversationId,
      });
    }
    if (assignee?.adapterType === "openclaw_gateway" && link.runtimeKind === "openclaw") {
      await heartbeat.setTaskSession({
        companyId: issue.companyId,
        agentId: assignee.id,
        adapterType: assignee.adapterType,
        taskKey: issue.id,
        sessionParamsJson: {
          sessionKey: link.externalConversationId,
        },
        sessionDisplayId: link.externalConversationId,
      });
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.runtime_link_upserted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        runtimeKind: link.runtimeKind,
        externalConversationId: link.externalConversationId,
        externalConversationLabel: link.externalConversationLabel,
        ...(typeof req.body?.metadataJson?.cwd === "string" && req.body.metadataJson.cwd.trim().length > 0
          ? { cwd: req.body.metadataJson.cwd.trim() }
          : {}),
      },
    });

    res.json(link);
  });

  router.post(
    "/issues/:id/runtime-link/start-codex-thread",
    validate(startIssueCodexThreadSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await issues.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoardIssueWrite(req);

      const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir;
      if (!codexHome) {
        res.status(409).json({ error: "Codex runtime source is not configured" });
        return;
      }

      const started = await startCodexThreadViaAppServer({
        codexHome,
        cwd: req.body.cwd,
        name: req.body.name ?? issue.title,
      });

      const actor = getActorInfo(req);
      const assignee =
        issue.assigneeAgentId ? await agents.getById(issue.assigneeAgentId) : null;
      const link = await runtimeLinks.upsertForIssue(
        issue.id,
        {
          runtimeKind: "codex",
          externalConversationId: started.threadId,
          externalConversationLabel: started.name ?? issue.title,
          metadataJson: {
            cwd: req.body.cwd,
            startedFrom: "paperclip_issue",
          },
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      if (!link) {
        res.status(500).json({ error: "Failed to link new Codex thread" });
        return;
      }

      if (assignee?.adapterType === "codex_local") {
        await heartbeat.setTaskSession({
          companyId: issue.companyId,
          agentId: assignee.id,
          adapterType: assignee.adapterType,
          taskKey: issue.id,
          sessionParamsJson: {
            sessionId: link.externalConversationId,
            cwd: req.body.cwd,
          },
          sessionDisplayId: link.externalConversationId,
        });
      }

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.runtime_link_upserted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          runtimeKind: "codex",
          externalConversationId: link.externalConversationId,
          externalConversationLabel: link.externalConversationLabel,
          cwd: req.body.cwd,
          createdThread: true,
        },
      });

      res.status(201).json(link);
    },
  );

  router.delete("/issues/:id/runtime-link", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issues.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    assertBoardIssueWrite(req);

    const removed = await runtimeLinks.unlinkForIssue(issue.id);
    const actor = getActorInfo(req);
    const assignee =
      issue.assigneeAgentId ? await agents.getById(issue.assigneeAgentId) : null;
    if (assignee?.adapterType === "codex_local" || assignee?.adapterType === "openclaw_gateway") {
      await heartbeat.resetRuntimeSession(assignee.id, { taskKey: issue.id });
    }
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.runtime_link_removed",
      entityType: "issue",
      entityId: issue.id,
      details: removed
        ? {
          runtimeKind: removed.runtimeKind,
          externalConversationId: removed.externalConversationId,
        }
        : null,
    });

    res.json({ ok: true });
  });

  return router;
}
