import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import * as runtimeSourcesRoutesModule from "../routes/instance-runtime-sources.js";
const { instanceRuntimeSourcesRoutes, instanceRuntimeSourcesRouteInternals } = runtimeSourcesRoutesModule;

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockReadConfigFile = vi.hoisted(() => vi.fn());
const mockWriteConfigFile = vi.hoisted(() => vi.fn());
const mockDetectRuntimeSources = vi.hoisted(() => vi.fn());
const mockReadCodexThreads = vi.hoisted(() => vi.fn());
const mockReadOpenClawSessions = vi.hoisted(() => vi.fn());
const mockReadCodexSkills = vi.hoisted(() => vi.fn());
const mockReadCodexPlugins = vi.hoisted(() => vi.fn());
const mockReadOpenClawSkills = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
  logActivity: mockLogActivity,
}));

vi.mock("../config-file.js", () => ({
  readConfigFile: mockReadConfigFile,
  writeConfigFile: mockWriteConfigFile,
}));

vi.mock("@paperclipai/shared/runtime-sources", () => ({
  detectRuntimeSources: mockDetectRuntimeSources,
  readCodexSkills: mockReadCodexSkills,
  readCodexPlugins: mockReadCodexPlugins,
  readCodexThreads: mockReadCodexThreads,
  readOpenClawSkills: mockReadOpenClawSkills,
  readOpenClawSessions: mockReadOpenClawSessions,
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceRuntimeSourcesRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("instance runtime sources routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockReadConfigFile.mockReturnValue({
      $meta: {
        version: 1,
        updatedAt: "2026-04-06T00:00:00.000Z",
        source: "configure",
      },
      runtimeSources: {
        codex: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.codex",
        },
      },
    });
    mockDetectRuntimeSources.mockReturnValue([
      {
        kind: "codex",
        homeDir: "/Users/test/.codex",
        status: "available",
        error: null,
        inventory: { codexThreadCount: 3 },
      },
    ]);
    mockReadCodexThreads.mockReturnValue([
      { id: "thr_1", threadName: "Thread one", updatedAt: "2026-04-06T00:00:00.000Z" },
    ]);
    mockReadCodexSkills.mockReturnValue([{ name: "paperclip", path: "/Users/test/.codex/skills/paperclip" }]);
    mockReadCodexPlugins.mockReturnValue([{ name: "github", path: "/Users/test/.codex/plugins/github" }]);
    mockReadOpenClawSessions.mockReturnValue([
      { sessionKey: "agent:main:1", sessionId: "sess_1", updatedAt: 123, sessionFile: "/tmp/sess.jsonl", authProfileOverride: null, originLabel: "main" },
    ]);
    mockReadOpenClawSkills.mockReturnValue([{ name: "paperclip", path: "/Users/test/.openclaw/skills/paperclip" }]);
  });

  it("opens a native directory picker for local board users", async () => {
    const spy = vi
      .spyOn(instanceRuntimeSourcesRouteInternals, "pickDirectoryViaOsascript")
      .mockResolvedValue({ path: "/Users/test/content", canceled: false });

    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/instance/runtime-sources/pick-directory")
      .send({ prompt: "Choose repo folder" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "/Users/test/content", canceled: false });
    spy.mockRestore();
  });

  it("allows board users to read configured runtime sources", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/runtime-sources");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      codex: {
        enabled: true,
        mode: "linked",
        homeDir: "/Users/test/.codex",
      },
    });
  });

  it("allows board users to read runtime source discovery", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/runtime-sources/discovery");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          kind: "codex",
          homeDir: "/Users/test/.codex",
          status: "available",
          error: null,
          inventory: { codexThreadCount: 3 },
        },
      ],
    });
  });

  it("lists codex threads from configured runtime sources", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/runtime-sources/codex/threads?limit=5");

    expect(res.status).toBe(200);
    expect(mockReadCodexThreads).toHaveBeenCalledWith("/Users/test/.codex", 5);
    expect(res.body).toEqual({
      data: [{ id: "thr_1", threadName: "Thread one", updatedAt: "2026-04-06T00:00:00.000Z" }],
    });
  });

  it("lists codex skills from configured runtime sources", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/runtime-sources/codex/skills");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [{ name: "paperclip", path: "/Users/test/.codex/skills/paperclip" }],
    });
  });

  it("lists codex plugins from configured runtime sources", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/runtime-sources/codex/plugins");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [{ name: "github", path: "/Users/test/.codex/plugins/github" }],
    });
  });

  it("lists openclaw sessions from configured runtime sources", async () => {
    mockReadConfigFile.mockReturnValue({
      $meta: {
        version: 1,
        updatedAt: "2026-04-06T00:00:00.000Z",
        source: "configure",
      },
      runtimeSources: {
        openclaw: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.openclaw",
        },
      },
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/runtime-sources/openclaw/sessions");

    expect(res.status).toBe(200);
    expect(mockReadOpenClawSessions).toHaveBeenCalledWith("/Users/test/.openclaw", 100);
    expect(res.body).toEqual({
      data: [
        {
          sessionKey: "agent:main:1",
          sessionId: "sess_1",
          updatedAt: 123,
          sessionFile: "/tmp/sess.jsonl",
          authProfileOverride: null,
          originLabel: "main",
        },
      ],
    });
  });

  it("lists openclaw skills from configured runtime sources", async () => {
    mockReadConfigFile.mockReturnValue({
      $meta: {
        version: 1,
        updatedAt: "2026-04-06T00:00:00.000Z",
        source: "configure",
      },
      runtimeSources: {
        openclaw: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.openclaw",
        },
      },
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/runtime-sources/openclaw/skills");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [{ name: "paperclip", path: "/Users/test/.openclaw/skills/paperclip" }],
    });
  });

  it("returns the local openclaw gateway token for instance-admin capable board users", async () => {
    mockReadConfigFile.mockReturnValue({
      $meta: {
        version: 1,
        updatedAt: "2026-04-06T00:00:00.000Z",
        source: "configure",
      },
      runtimeSources: {
        openclaw: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.openclaw",
        },
      },
    });
    const spy = vi
      .spyOn(instanceRuntimeSourcesRouteInternals, "readOpenClawGatewayToken")
      .mockReturnValue("gateway-token-1234567890");

    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/instance/runtime-sources/openclaw/gateway-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: "gateway-token-1234567890" });
    expect(spy).toHaveBeenCalledWith("/Users/test/.openclaw");
    spy.mockRestore();
  });

  it("requires instance admin capable board access to update runtime sources", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch("/api/instance/runtime-sources")
      .send({
        codex: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.codex",
        },
      });

    expect(res.status).toBe(403);
    expect(mockWriteConfigFile).not.toHaveBeenCalled();
  });

  it("updates runtime sources for local board users", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const payload = {
      codex: {
        enabled: true,
        mode: "linked",
        homeDir: "/Users/test/.codex",
      },
      openclaw: {
        enabled: true,
        mode: "linked",
        homeDir: "/Users/test/.openclaw",
      },
    };

    const res = await request(app)
      .patch("/api/instance/runtime-sources")
      .send(payload);

    expect(res.status).toBe(200);
    expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual(payload);
  });
});
