import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { addIssueCommentSchema, resolveIssueConversationApprovalSchema } from "@paperclipai/shared";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import {
  agentService,
  approvalService,
  heartbeatService,
  issueConversationApprovalService,
  issueRuntimeLinkService,
  issueService,
  logActivity,
  readIssueConversation,
  secretService,
} from "../services/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { readConfigFile } from "../config-file.js";
import {
  getExistingCodexLiveConversationSession,
  getOrCreateCodexLiveConversationSession,
} from "../services/codex-live-conversations.js";
import {
  getExistingOpenClawLiveConversationSession,
  getOrCreateOpenClawLiveConversationSession,
} from "../services/openclaw-live-conversations.js";

export function issueConversationRoutes(db: Db) {
  const router = Router();
  const issues = issueService(db);
  const runtimeLinks = issueRuntimeLinkService(db);
  const conversationApprovals = issueConversationApprovalService(db);
  const approvals = approvalService(db);
  const heartbeat = heartbeatService(db);
  const agents = agentService(db);
  const secrets = secretService(db);

  function buildLocalConversationEnv(agent: {
    id: string;
    companyId: string;
    adapterType: string;
  }) {
    const env = { ...buildPaperclipEnv(agent) };
    const authToken = createLocalAgentJwt(
      agent.id,
      agent.companyId,
      agent.adapterType,
      `issue-chat-${Date.now()}`,
    );
    if (authToken) {
      env.PAPERCLIP_API_KEY = authToken;
    }
    return env;
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      const normalized = await issues.getById(rawId);
      req.params.id = normalized?.id ?? rawId;
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/issues/:id/conversation", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issues.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 1000) : 100;
    const runtimeLink = await runtimeLinks.getForIssue(issue.id);
    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;
    if (runtimeLink?.runtimeKind === "codex" && codexHome) {
      const assignee = issue.assigneeAgentId ? await agents.getById(issue.assigneeAgentId) : null;
      const liveSession = getExistingCodexLiveConversationSession(issue.id, runtimeLink.externalConversationId, codexHome);
      if (liveSession) {
        const snapshot = await liveSession.snapshot(issue.id, runtimeLink, limit);
        snapshot.pendingApprovals = await conversationApprovals.syncPendingApprovals({
          companyId: issue.companyId,
          issueId: issue.id,
          runtimeKind: "codex",
          pendingApprovals: snapshot.pendingApprovals,
        });
        res.json(snapshot);
        return;
      }
    }
    if (runtimeLink?.runtimeKind === "openclaw" && openclawHome && issue.assigneeAgentId) {
      const assignee = await agents.getById(issue.assigneeAgentId);
      if (assignee?.adapterType === "openclaw_gateway") {
        const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
          issue.companyId,
          (assignee.adapterConfig ?? {}) as Record<string, unknown>,
        );
        const liveSession = getOrCreateOpenClawLiveConversationSession({
          issueId: issue.id,
          sessionKey: runtimeLink.externalConversationId,
          openclawHome,
          adapterConfig: runtimeAdapterConfig,
        });
        res.json(await liveSession.snapshot(issue.id, runtimeLink, limit));
        return;
      }
    }
    res.json(await readIssueConversation({ issueId: issue.id, runtimeLink, limit }));
  });

  router.post("/issues/:id/conversation/send", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await issues.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const runtimeLink = await runtimeLinks.getForIssue(issue.id);
    const actor = getActorInfo(req);
    const comment = await issues.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
    });

    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;
    if (runtimeLink?.runtimeKind === "codex" && codexHome) {
      const assignee = issue.assigneeAgentId ? await agents.getById(issue.assigneeAgentId) : null;
      const liveSession = getOrCreateCodexLiveConversationSession(
        issue.id,
        runtimeLink.externalConversationId,
        codexHome,
        assignee?.adapterType === "codex_local" ? buildLocalConversationEnv(assignee) : undefined,
      );
      const turnId = await liveSession.send(req.body.body);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.conversation_sent",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          codexTurnId: turnId,
          bodySnippet: comment.body.slice(0, 120),
        },
      });
      res.status(201).json({ comment });
      return;
    }
    if (runtimeLink?.runtimeKind === "openclaw" && openclawHome && issue.assigneeAgentId) {
      const assignee = await agents.getById(issue.assigneeAgentId);
      if (assignee?.adapterType === "openclaw_gateway") {
        const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
          issue.companyId,
          (assignee.adapterConfig ?? {}) as Record<string, unknown>,
        );
        const liveSession = getOrCreateOpenClawLiveConversationSession({
          issueId: issue.id,
          sessionKey: runtimeLink.externalConversationId,
          openclawHome,
          adapterConfig: runtimeAdapterConfig,
        });
        const runId = await liveSession.send(req.body.body);
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.conversation_sent",
          entityType: "issue",
          entityId: issue.id,
          details: {
            commentId: comment.id,
            openclawRunId: runId,
            bodySnippet: comment.body.slice(0, 120),
          },
        });
        res.status(201).json({ comment });
        return;
      }
    }

    if (issue.assigneeAgentId && !(actor.actorType === "agent" && actor.actorId === issue.assigneeAgentId)) {
      void heartbeat.wakeup(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_conversation_send",
        payload: {
          issueId: issue.id,
          commentId: comment.id,
          mutation: "conversation_send",
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          commentId: comment.id,
          source: "issue.conversation.send",
          wakeReason: "issue_conversation_send",
        },
      }).catch(() => undefined);
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.conversation_sent",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
      },
    });

    res.status(201).json({ comment });
  });

  router.post("/issues/:id/conversation/steer", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await issues.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const runtimeLink = await runtimeLinks.getForIssue(issue.id);
    const actor = getActorInfo(req);
    const comment = await issues.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
    });

    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;
    if (runtimeLink?.runtimeKind === "codex" && codexHome) {
      const assignee = issue.assigneeAgentId ? await agents.getById(issue.assigneeAgentId) : null;
      const liveSession = getOrCreateCodexLiveConversationSession(
        issue.id,
        runtimeLink.externalConversationId,
        codexHome,
        assignee?.adapterType === "codex_local" ? buildLocalConversationEnv(assignee) : undefined,
      );
      const turnId = await liveSession.steer(req.body.body);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.conversation_steered",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          codexTurnId: turnId,
          bodySnippet: comment.body.slice(0, 120),
        },
      });
      res.status(201).json({ comment });
      return;
    }
    if (runtimeLink?.runtimeKind === "openclaw" && openclawHome && issue.assigneeAgentId) {
      const assignee = await agents.getById(issue.assigneeAgentId);
      if (assignee?.adapterType === "openclaw_gateway") {
        const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
          issue.companyId,
          (assignee.adapterConfig ?? {}) as Record<string, unknown>,
        );
        const liveSession = getOrCreateOpenClawLiveConversationSession({
          issueId: issue.id,
          sessionKey: runtimeLink.externalConversationId,
          openclawHome,
          adapterConfig: runtimeAdapterConfig,
        });
        const runId = await liveSession.steer(req.body.body);
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.conversation_steered",
          entityType: "issue",
          entityId: issue.id,
          details: {
            commentId: comment.id,
            openclawRunId: runId,
            bodySnippet: comment.body.slice(0, 120),
          },
        });
        res.status(201).json({ comment });
        return;
      }
    }

    if (issue.assigneeAgentId) {
      void heartbeat.wakeup(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_conversation_steer",
        payload: {
          issueId: issue.id,
          commentId: comment.id,
          mutation: "conversation_steer",
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          commentId: comment.id,
          source: "issue.conversation.steer",
          wakeReason: "issue_conversation_steer",
        },
      }).catch(() => undefined);
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.conversation_steered",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
      },
    });

    res.status(201).json({ comment });
  });

  router.post("/issues/:id/conversation/interrupt", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issues.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can interrupt active runs" });
      return;
    }

    const runtimeLink = await runtimeLinks.getForIssue(issue.id);
    const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
    const openclawHome = readConfigFile()?.runtimeSources?.openclaw?.homeDir ?? null;
      if (runtimeLink?.runtimeKind === "codex" && codexHome) {
        const liveSession = getExistingCodexLiveConversationSession(issue.id, runtimeLink.externalConversationId, codexHome);
      const interruptedTurnId = liveSession ? await liveSession.interrupt() : null;
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.conversation_interrupted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interruptedTurnId,
        },
      });
      res.json({ interruptedRunId: interruptedTurnId });
      return;
    }
    if (runtimeLink?.runtimeKind === "openclaw" && openclawHome) {
      let interruptedRunId: string | null = null;
      const existingLiveSession = getExistingOpenClawLiveConversationSession(
        issue.id,
        runtimeLink.externalConversationId,
        openclawHome,
      );
      if (existingLiveSession) {
        interruptedRunId = await existingLiveSession.interrupt();
      } else if (issue.assigneeAgentId) {
        const assignee = await agents.getById(issue.assigneeAgentId);
        if (assignee?.adapterType === "openclaw_gateway") {
          const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
            issue.companyId,
            (assignee.adapterConfig ?? {}) as Record<string, unknown>,
          );
          const liveSession = getOrCreateOpenClawLiveConversationSession({
            issueId: issue.id,
            sessionKey: runtimeLink.externalConversationId,
            openclawHome,
            adapterConfig: runtimeAdapterConfig,
          });
          interruptedRunId = await liveSession.interrupt();
        }
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.conversation_interrupted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interruptedRunId,
        },
      });
      res.json({ interruptedRunId });
      return;
    }

    const activeRun =
      issue.assigneeAgentId
        ? await heartbeat.getActiveRunForAgent(issue.assigneeAgentId)
        : null;
    const issueIdFromContext =
      activeRun?.contextSnapshot &&
      typeof activeRun.contextSnapshot === "object" &&
      typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
        ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
        : null;
    const runToInterrupt = activeRun && activeRun.status === "running" && issueIdFromContext === issue.id
      ? activeRun
      : null;

    const cancelled = runToInterrupt ? await heartbeat.cancelRun(runToInterrupt.id) : null;
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.conversation_interrupted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interruptedRunId: cancelled?.id ?? null,
      },
    });

    res.json({ interruptedRunId: cancelled?.id ?? null });
  });

  router.post(
    "/issues/:id/conversation/approvals/:requestId/resolve",
    validate(resolveIssueConversationApprovalSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const requestId = req.params.requestId as string;
      const issue = await issues.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can resolve conversation approvals" });
        return;
      }

      const runtimeLink = await runtimeLinks.getForIssue(issue.id);
      const codexHome = readConfigFile()?.runtimeSources?.codex?.homeDir ?? null;
      if (!runtimeLink || runtimeLink.runtimeKind !== "codex" || !codexHome) {
        res.status(404).json({ error: "No live codex approval context available" });
        return;
      }

      const liveSession = getExistingCodexLiveConversationSession(issue.id, runtimeLink.externalConversationId, codexHome);
      if (!liveSession) {
        res.status(404).json({ error: "No live codex approval context available" });
        return;
      }

      await conversationApprovals.resolveByRequestId(issue.id, requestId, {
        decision: req.body.decision,
        decidedByUserId: req.actor.userId ?? "board",
      });
      await liveSession.resolveApproval(requestId, req.body.decision);
      const latestApproval = await approvals
        .list(issue.companyId)
        .then((rows) =>
          rows.find((row) => {
            const payload = row.payload as Record<string, unknown>;
            return payload.issueId === issue.id && payload.requestId === requestId;
          }) ?? null,
        );
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.conversation_approval_resolved",
        entityType: "issue",
        entityId: issue.id,
        details: {
          requestId,
          approvalId: latestApproval?.id ?? null,
          decision: req.body.decision,
        },
      });
      res.json({ ok: true });
    },
  );

  return router;
}
