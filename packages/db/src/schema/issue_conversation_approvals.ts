import { pgTable, uuid, text, timestamp, primaryKey, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { approvals } from "./approvals.js";

export const issueConversationApprovals = pgTable(
  "issue_conversation_approvals",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
    runtimeKind: text("runtime_kind").notNull(),
    requestKind: text("request_kind").notNull(),
    turnId: text("turn_id"),
    itemId: text("item_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issueId, table.requestId], name: "issue_conversation_approvals_pk" }),
    approvalIdUq: uniqueIndex("issue_conversation_approvals_approval_id_uq").on(table.approvalId),
    companyIdx: index("issue_conversation_approvals_company_idx").on(table.companyId),
    issueIdx: index("issue_conversation_approvals_issue_idx").on(table.issueId),
  }),
);
