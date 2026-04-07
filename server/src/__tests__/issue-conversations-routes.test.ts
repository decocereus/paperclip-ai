import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueConversationRoutes } from "../routes/issue-conversations.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockIssueRuntimeLinkService = vi.hoisted(() => ({
  getForIssue: vi.fn(),
}));
const mockReadIssueConversation = vi.hoisted(() => vi.fn());
const mockReadConfigFile = vi.hoisted(() => vi.fn());
const mockGetExistingCodexLiveConversationSession = vi.hoisted(() => vi.fn());
const mockGetOrCreateCodexLiveConversationSession = vi.hoisted(() => vi.fn());
const mockIssueConversationApprovalService = vi.hoisted(() => ({
  syncPendingApprovals: vi.fn(),
  resolveByRequestId: vi.fn(),
}));
const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn().mockResolvedValue(null),
  getActiveRunForAgent: vi.fn().mockResolvedValue(null),
  cancelRun: vi.fn().mockResolvedValue(null),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  issueRuntimeLinkService: () => mockIssueRuntimeLinkService,
  issueConversationApprovalService: () => mockIssueConversationApprovalService,
  approvalService: () => mockApprovalService,
  readIssueConversation: mockReadIssueConversation,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
}));

vi.mock("../config-file.js", () => ({
  readConfigFile: mockReadConfigFile,
}));

vi.mock("../services/codex-live-conversations.js", () => ({
  getExistingCodexLiveConversationSession: mockGetExistingCodexLiveConversationSession,
  getOrCreateCodexLiveConversationSession: mockGetOrCreateCodexLiveConversationSession,
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueConversationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("issue conversation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      assigneeAgentId: "agent-1",
    });
    mockIssueRuntimeLinkService.getForIssue.mockResolvedValue({
      issueId: "issue-1",
      companyId: "company-1",
      runtimeKind: "codex",
      externalConversationId: "thr_1",
    });
    mockReadConfigFile.mockReturnValue(null);
    mockGetExistingCodexLiveConversationSession.mockReturnValue(null);
    mockGetOrCreateCodexLiveConversationSession.mockReturnValue({
      send: vi.fn().mockResolvedValue("turn-1"),
      steer: vi.fn().mockResolvedValue("turn-1"),
      interrupt: vi.fn().mockResolvedValue("turn-1"),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({
        issueId: "issue-1",
        runtimeLink: {
          issueId: "issue-1",
          companyId: "company-1",
          runtimeKind: "codex",
          externalConversationId: "thr_1",
        },
        sourceStatus: "ok",
        activeTurnId: "turn-1",
        isStreaming: true,
        pendingApprovals: [],
        items: [],
        error: null,
      }),
    });
    mockIssueConversationApprovalService.syncPendingApprovals.mockImplementation(async ({ pendingApprovals }) => pendingApprovals);
    mockIssueConversationApprovalService.resolveByRequestId.mockResolvedValue(undefined);
    mockApprovalService.list.mockResolvedValue([]);
    mockReadIssueConversation.mockResolvedValue({
      issueId: "issue-1",
      runtimeLink: {
        issueId: "issue-1",
        companyId: "company-1",
        runtimeKind: "codex",
        externalConversationId: "thr_1",
      },
      sourceStatus: "ok",
      activeTurnId: null,
      isStreaming: false,
      pendingApprovals: [],
      items: [],
      error: null,
    });
    mockIssueService.addComment = vi.fn().mockResolvedValue({
      id: "comment-1",
      body: "hello",
    });
  });

  it("returns the normalized conversation snapshot", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/issues/issue-1/conversation?limit=12");

    expect(res.status).toBe(200);
    expect(mockReadIssueConversation).toHaveBeenCalledWith({
      issueId: "issue-1",
      runtimeLink: {
        issueId: "issue-1",
        companyId: "company-1",
        runtimeKind: "codex",
        externalConversationId: "thr_1",
      },
      limit: 12,
    });
  });

  it("syncs live pending codex approvals into the conversation snapshot", async () => {
    mockReadConfigFile.mockReturnValue({
      runtimeSources: {
        codex: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.codex",
        },
      },
    });
    const liveSession = {
      snapshot: vi.fn().mockResolvedValue({
        issueId: "issue-1",
        runtimeLink: {
          issueId: "issue-1",
          companyId: "company-1",
          runtimeKind: "codex",
          externalConversationId: "thr_1",
        },
        sourceStatus: "ok",
        activeTurnId: "turn-1",
        isStreaming: true,
        pendingApprovals: [
          {
            requestId: "42",
            approvalId: null,
            kind: "command",
            turnId: "turn-1",
            itemId: "item-1",
            reason: "Needs approval",
            command: "rm -rf /tmp/x",
            cwd: "/tmp",
            availableDecisions: ["accept", "decline"],
          },
        ],
        items: [],
        error: null,
      }),
    };
    mockGetExistingCodexLiveConversationSession.mockReturnValue(liveSession);
    mockIssueConversationApprovalService.syncPendingApprovals.mockResolvedValue([
      {
        requestId: "42",
        approvalId: "approval-1",
        kind: "command",
        turnId: "turn-1",
        itemId: "item-1",
        reason: "Needs approval",
        command: "rm -rf /tmp/x",
        cwd: "/tmp",
        availableDecisions: ["accept", "decline"],
      },
    ]);

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/issues/issue-1/conversation");

    expect(res.status).toBe(200);
    expect(mockIssueConversationApprovalService.syncPendingApprovals).toHaveBeenCalled();
    expect(res.body.pendingApprovals[0].approvalId).toBe("approval-1");
  });

  it("sends a conversation message by writing a comment and waking the assignee", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/issues/issue-1/conversation/send")
      .send({ body: "hello" });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "issue_conversation_send",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalled();
  });

  it("interrupts the active issue run for board users", async () => {
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue({
      id: "run-1",
      status: "running",
      contextSnapshot: { issueId: "issue-1" },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({ id: "run-1" });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).post("/api/issues/issue-1/conversation/interrupt").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interruptedRunId: "run-1" });
  });

  it("uses the codex live conversation manager when linked codex runtime state is configured", async () => {
    mockReadConfigFile.mockReturnValue({
      runtimeSources: {
        codex: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.codex",
        },
      },
    });

    const liveSession = {
      send: vi.fn().mockResolvedValue("turn-1"),
      steer: vi.fn().mockResolvedValue("turn-1"),
      interrupt: vi.fn().mockResolvedValue("turn-1"),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn(),
    };
    mockGetOrCreateCodexLiveConversationSession.mockReturnValue(liveSession);

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/issues/issue-1/conversation/send")
      .send({ body: "hello codex" });

    expect(res.status).toBe(201);
    expect(liveSession.send).toHaveBeenCalledWith("hello codex");
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("resolves codex live approvals", async () => {
    mockReadConfigFile.mockReturnValue({
      runtimeSources: {
        codex: {
          enabled: true,
          mode: "linked",
          homeDir: "/Users/test/.codex",
        },
      },
    });

    const liveSession = {
      send: vi.fn(),
      steer: vi.fn(),
      interrupt: vi.fn(),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn(),
    };
    mockGetExistingCodexLiveConversationSession.mockReturnValue(liveSession);

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/issues/issue-1/conversation/approvals/42/resolve")
      .send({ decision: "accept" });

    expect(res.status).toBe(200);
    expect(mockIssueConversationApprovalService.resolveByRequestId).toHaveBeenCalledWith(
      "issue-1",
      "42",
      { decision: "accept", decidedByUserId: "user-1" },
    );
    expect(liveSession.resolveApproval).toHaveBeenCalledWith("42", "accept");
  });
});
