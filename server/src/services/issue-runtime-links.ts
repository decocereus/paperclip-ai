import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRuntimeLinks, issues } from "@paperclipai/db";
import type { IssueRuntimeLink } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueRuntimeLinkService(db: Db) {
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

  return {
    getForIssue: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      return db
        .select()
        .from(issueRuntimeLinks)
        .where(eq(issueRuntimeLinks.issueId, issueId))
        .then((rows) => (rows[0] ? toIssueRuntimeLink(rows[0]) : null));
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
