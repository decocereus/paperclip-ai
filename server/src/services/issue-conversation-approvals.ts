import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issueConversationApprovals } from "@paperclipai/db";
import type { IssueConversationPendingApproval } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { approvalService } from "./approvals.js";

export function issueConversationApprovalService(db: Db) {
  const approvalsSvc = approvalService(db);

  return {
    syncPendingApprovals: async (
      input: {
        companyId: string;
        issueId: string;
        runtimeKind: "codex" | "openclaw";
        pendingApprovals: IssueConversationPendingApproval[];
      },
    ): Promise<IssueConversationPendingApproval[]> => {
      const existing = await db
        .select()
        .from(issueConversationApprovals)
        .where(eq(issueConversationApprovals.issueId, input.issueId));
      const existingByRequestId = new Map(existing.map((row) => [row.requestId, row]));

      const out: IssueConversationPendingApproval[] = [];
      for (const pending of input.pendingApprovals) {
        const mapped = existingByRequestId.get(pending.requestId);
        if (mapped) {
          out.push({ ...pending, approvalId: mapped.approvalId });
          continue;
        }

        const approval = await approvalsSvc.create(input.companyId, {
          type: pending.kind === "command" ? "runtime_command_approval" : "runtime_file_change_approval",
          requestedByAgentId: null,
          requestedByUserId: null,
          status: "pending",
          payload: {
            issueId: input.issueId,
            requestId: pending.requestId,
            runtimeKind: input.runtimeKind,
            requestKind: pending.kind,
            turnId: pending.turnId,
            itemId: pending.itemId,
            reason: pending.reason,
            command: pending.command,
            cwd: pending.cwd,
            availableDecisions: pending.availableDecisions,
          },
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: new Date(),
        });

        await db.insert(issueApprovals).values({
          companyId: input.companyId,
          issueId: input.issueId,
          approvalId: approval.id,
          linkedByAgentId: null,
          linkedByUserId: null,
        }).onConflictDoNothing();

        await db.insert(issueConversationApprovals).values({
          companyId: input.companyId,
          issueId: input.issueId,
          requestId: pending.requestId,
          approvalId: approval.id,
          runtimeKind: input.runtimeKind,
          requestKind: pending.kind,
          turnId: pending.turnId,
          itemId: pending.itemId,
        }).onConflictDoNothing();

        out.push({ ...pending, approvalId: approval.id });
      }
      return out;
    },

    resolveByRequestId: async (
      issueId: string,
      requestId: string,
      input: {
        decision: "accept" | "acceptForSession" | "decline" | "cancel";
        decidedByUserId: string;
      },
    ) => {
      const mapping = await db
        .select()
        .from(issueConversationApprovals)
        .where(
          and(
            eq(issueConversationApprovals.issueId, issueId),
            eq(issueConversationApprovals.requestId, requestId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!mapping) throw notFound("Conversation approval not found");

      const note = `Conversation approval decision: ${input.decision}`;
      if (input.decision === "accept" || input.decision === "acceptForSession") {
        return approvalsSvc.approve(mapping.approvalId, input.decidedByUserId, note);
      }
      return approvalsSvc.reject(mapping.approvalId, input.decidedByUserId, note);
    },
  };
}
