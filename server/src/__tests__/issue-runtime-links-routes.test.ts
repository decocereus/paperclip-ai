import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRuntimeLinkRoutes } from "../routes/issue-runtime-links.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockIssueRuntimeLinkService = vi.hoisted(() => ({
  getForIssue: vi.fn(),
  upsertForIssue: vi.fn(),
  unlinkForIssue: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  setTaskSession: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));
const mockReadConfigFile = vi.hoisted(() => vi.fn());
const mockStartCodexThreadViaAppServer = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  issueRuntimeLinkService: () => mockIssueRuntimeLinkService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
}));

vi.mock("../config-file.js", () => ({
  readConfigFile: mockReadConfigFile,
}));

vi.mock("../services/runtime-conversations.js", () => ({
  startCodexThreadViaAppServer: mockStartCodexThreadViaAppServer,
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRuntimeLinkRoutes({} as any));
  app.use(errorHandler);
  return app;
}


describe("issue runtime link routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      assigneeAgentId: "agent-1",
    });
    mockIssueRuntimeLinkService.getForIssue.mockResolvedValue(null);
    mockIssueRuntimeLinkService.upsertForIssue.mockResolvedValue({
      issueId: "issue-1",
      companyId: "company-1",
      runtimeKind: "codex",
      externalConversationId: "thr_1",
      externalConversationLabel: "Thread one",
      metadataJson: null,
      linkedByAgentId: null,
      linkedByUserId: "user-1",
      createdAt: new Date("2026-04-07T00:00:00.000Z"),
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    });
    mockIssueRuntimeLinkService.unlinkForIssue.mockResolvedValue({
      issueId: "issue-1",
      companyId: "company-1",
      runtimeKind: "codex",
      externalConversationId: "thr_1",
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      adapterType: "codex_local",
    });
    mockReadConfigFile.mockReturnValue({
      runtimeSources: {
        codex: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.codex",
        },
      },
    });
    mockStartCodexThreadViaAppServer.mockResolvedValue({
      threadId: "thr_new",
      name: "Issue title",
    });
  });

  it("allows board users to read a runtime link", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/issues/issue-1/runtime-link");

    expect(res.status).toBe(200);
    expect(mockIssueRuntimeLinkService.getForIssue).toHaveBeenCalledWith("issue-1");
  });

  it("allows board users to upsert a runtime link", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .put("/api/issues/issue-1/runtime-link")
      .send({
        runtimeKind: "codex",
        externalConversationId: "thr_1",
        externalConversationLabel: "Thread one",
        metadataJson: {
          cwd: "/Users/test/content",
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueRuntimeLinkService.upsertForIssue).toHaveBeenCalledWith(
      "issue-1",
      {
        runtimeKind: "codex",
        externalConversationId: "thr_1",
        externalConversationLabel: "Thread one",
        metadataJson: {
          cwd: "/Users/test/content",
        },
      },
      {
        agentId: null,
        userId: "user-1",
      },
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.setTaskSession).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "codex_local",
      taskKey: "issue-1",
      sessionParamsJson: {
        sessionId: "thr_1",
        cwd: "/Users/test/content",
      },
      sessionDisplayId: "thr_1",
    });
  });

  it("seeds an openclaw task session when linking an openclaw conversation", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      adapterType: "openclaw_gateway",
    });
    mockIssueRuntimeLinkService.upsertForIssue.mockResolvedValue({
      issueId: "issue-1",
      companyId: "company-1",
      runtimeKind: "openclaw",
      externalConversationId: "agent:main:main",
      externalConversationLabel: "main",
      metadataJson: null,
      linkedByAgentId: null,
      linkedByUserId: "user-1",
      createdAt: new Date("2026-04-07T00:00:00.000Z"),
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .put("/api/issues/issue-1/runtime-link")
      .send({
        runtimeKind: "openclaw",
        externalConversationId: "agent:main:main",
        externalConversationLabel: "main",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.setTaskSession).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "openclaw_gateway",
      taskKey: "issue-1",
      sessionParamsJson: {
        sessionKey: "agent:main:main",
      },
      sessionDisplayId: "agent:main:main",
    });
  });

  it("starts and links a new codex thread for a repo path", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/issues/issue-1/runtime-link/start-codex-thread")
      .send({
        cwd: "/Users/test/content",
        name: "Issue title",
      });

    expect(res.status).toBe(201);
    expect(mockStartCodexThreadViaAppServer).toHaveBeenCalledWith({
      codexHome: "/Users/test/.codex",
      cwd: "/Users/test/content",
      name: "Issue title",
    });
    expect(mockHeartbeatService.setTaskSession).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "codex_local",
      taskKey: "issue-1",
      sessionParamsJson: {
        sessionId: "thr_1",
        cwd: "/Users/test/content",
      },
      sessionDisplayId: "thr_1",
    });
  });

  it("allows board users to remove a runtime link", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).delete("/api/issues/issue-1/runtime-link");

    expect(res.status).toBe(200);
    expect(mockIssueRuntimeLinkService.unlinkForIssue).toHaveBeenCalledWith("issue-1");
    expect(mockHeartbeatService.resetRuntimeSession).toHaveBeenCalledWith("agent-1", { taskKey: "issue-1" });
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects agent callers from mutating runtime links", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .put("/api/issues/issue-1/runtime-link")
      .send({
        runtimeKind: "codex",
        externalConversationId: "thr_1",
      });

    expect(res.status).toBe(403);
    expect(mockIssueRuntimeLinkService.upsertForIssue).not.toHaveBeenCalled();
  });
});
