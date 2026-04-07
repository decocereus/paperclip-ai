CREATE TABLE "issue_runtime_links" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"runtime_kind" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"external_conversation_label" text,
	"metadata_json" jsonb,
	"linked_by_agent_id" uuid,
	"linked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_runtime_links" ADD CONSTRAINT "issue_runtime_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_runtime_links" ADD CONSTRAINT "issue_runtime_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_runtime_links" ADD CONSTRAINT "issue_runtime_links_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "issue_runtime_links_company_idx" ON "issue_runtime_links" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_runtime_links_runtime_external_uq" ON "issue_runtime_links" USING btree ("company_id","runtime_kind","external_conversation_id");
