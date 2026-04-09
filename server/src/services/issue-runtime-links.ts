import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions, agents, issueRuntimeLinks, issues } from "@paperclipai/db";
import type { IssueRuntimeLink } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueRuntimeLinkService(db: Db) {
  function readNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function deriveOpenClawSessionKey(
    issueId: string,
    adapterConfig: Record<string, unknown> | null,
  ): string | null {
    const strategy = readNonEmptyString(adapterConfig?.sessionKeyStrategy)?.toLowerCase() ?? "issue";
    if (strategy === "run") return null;
    if (strategy === "fixed") {
      return readNonEmptyString(adapterConfig?.sessionKey) ?? "paperclip";
    }
    return `paperclip:issue:${issueId}`;
  }

  function toIssueRuntimeLink(row: typeof issueRuntimeLinks.$inferSelect): IssueRuntimeLink {
    return {
      ...row,
      runtimeKind: row.runtimeKind as IssueRuntimeLink["runtimeKind"],
      metadataJson: row.metadataJson ?? null,
      linkedByAgentId: row.linkedByAgentId ?? null,
      linkedByUserId: row.linkedByUserId ?? null,
    };
  }

  async function getIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function inferRuntimeLink(issueId: string) {
    const issue = await getIssue(issueId);
    if (!issue || !issue.assigneeAgentId) return null;

    const assignee = await db
      .select()
      .from(agents)
      .where(eq(agents.id, issue.assigneeAgentId))
      .then((rows) => rows[0] ?? null);
    if (!assignee) return null;

    const latestTaskSession = await db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, issue.companyId),
          eq(agentTaskSessions.agentId, assignee.id),
          eq(agentTaskSessions.adapterType, assignee.adapterType),
          eq(agentTaskSessions.taskKey, issue.id),
        ),
      )
      .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (assignee.adapterType === "openclaw_gateway") {
      const sessionParams = (latestTaskSession?.sessionParamsJson ?? null) as Record<string, unknown> | null;
      const sessionKey =
        readNonEmptyString(sessionParams?.sessionKey) ??
        readNonEmptyString(sessionParams?.session_key) ??
        deriveOpenClawSessionKey(
          issue.id,
          typeof assignee.adapterConfig === "object" && assignee.adapterConfig !== null && !Array.isArray(assignee.adapterConfig)
            ? (assignee.adapterConfig as Record<string, unknown>)
            : null,
        );
      if (!sessionKey) return null;

      return {
        issueId: issue.id,
        companyId: issue.companyId,
        runtimeKind: "openclaw" as const,
        externalConversationId: sessionKey,
        externalConversationLabel:
          readNonEmptyString(latestTaskSession?.sessionDisplayId) ??
          readNonEmptyString(issue.identifier) ??
          issue.title,
        metadataJson: {
          inferred: true,
          inferredSource: latestTaskSession ? "task_session" : "adapter_config",
          ...(sessionParams ? { sessionParams } : {}),
        },
        linkedByAgentId: null,
        linkedByUserId: null,
        createdAt: latestTaskSession?.createdAt ?? issue.createdAt,
        updatedAt: latestTaskSession?.updatedAt ?? issue.updatedAt,
      };
    }

    if (assignee.adapterType === "codex_local" && latestTaskSession) {
      const sessionParams = (latestTaskSession.sessionParamsJson ?? null) as Record<string, unknown> | null;
      const sessionId =
        readNonEmptyString(sessionParams?.sessionId) ??
        readNonEmptyString(sessionParams?.threadId);
      if (!sessionId) return null;

      return {
        issueId: issue.id,
        companyId: issue.companyId,
        runtimeKind: "codex" as const,
        externalConversationId: sessionId,
        externalConversationLabel:
          readNonEmptyString(latestTaskSession.sessionDisplayId) ??
          readNonEmptyString(issue.identifier) ??
          issue.title,
        metadataJson: {
          inferred: true,
          inferredSource: "task_session",
          ...(sessionParams ? { sessionParams } : {}),
        },
        linkedByAgentId: null,
        linkedByUserId: null,
        createdAt: latestTaskSession.createdAt,
        updatedAt: latestTaskSession.updatedAt,
      };
    }

    return null;
  }

  return {
    getForIssue: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      const explicit = await db
        .select()
        .from(issueRuntimeLinks)
        .where(eq(issueRuntimeLinks.issueId, issueId))
        .then((rows) => (rows[0] ? toIssueRuntimeLink(rows[0]) : null));
      return explicit ?? (await inferRuntimeLink(issueId));
    },

    upsertForIssue: async (
      issueId: string,
      data: {
        runtimeKind: "codex" | "openclaw";
        externalConversationId: string;
        externalConversationLabel?: string | null;
        metadataJson?: Record<string, unknown> | null;
      },
      actor?: LinkActor,
    ) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      const existingConflict = await db
        .select()
        .from(issueRuntimeLinks)
        .where(
          and(
            eq(issueRuntimeLinks.companyId, issue.companyId),
            eq(issueRuntimeLinks.runtimeKind, data.runtimeKind),
            eq(issueRuntimeLinks.externalConversationId, data.externalConversationId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existingConflict && existingConflict.issueId !== issueId) {
        throw conflict("This external conversation is already linked to another issue");
      }

      const now = new Date();
      const [row] = await db
        .insert(issueRuntimeLinks)
        .values({
          issueId,
          companyId: issue.companyId,
          runtimeKind: data.runtimeKind,
          externalConversationId: data.externalConversationId,
          externalConversationLabel: data.externalConversationLabel ?? null,
          metadataJson: data.metadataJson ?? null,
          linkedByAgentId: actor?.agentId ?? null,
          linkedByUserId: actor?.userId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueRuntimeLinks.issueId],
          set: {
            runtimeKind: data.runtimeKind,
            externalConversationId: data.externalConversationId,
            externalConversationLabel: data.externalConversationLabel ?? null,
            metadataJson: data.metadataJson ?? null,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
            updatedAt: now,
          },
        })
        .returning();

      return row ? toIssueRuntimeLink(row) : null;
    },

    unlinkForIssue: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      const [removed] = await db
        .delete(issueRuntimeLinks)
        .where(eq(issueRuntimeLinks.issueId, issueId))
        .returning();

      return removed ? toIssueRuntimeLink(removed) : null;
    },
  };
}
