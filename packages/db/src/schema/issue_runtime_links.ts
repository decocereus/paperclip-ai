import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const issueRuntimeLinks = pgTable(
  "issue_runtime_links",
  {
    issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runtimeKind: text("runtime_kind").notNull(),
    externalConversationId: text("external_conversation_id").notNull(),
    externalConversationLabel: text("external_conversation_label"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
    linkedByAgentId: uuid("linked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    linkedByUserId: text("linked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("issue_runtime_links_company_idx").on(table.companyId),
    runtimeExternalIdx: uniqueIndex("issue_runtime_links_runtime_external_uq").on(
      table.companyId,
      table.runtimeKind,
      table.externalConversationId,
    ),
  }),
);
