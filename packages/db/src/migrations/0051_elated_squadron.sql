CREATE TABLE "issue_conversation_approvals" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"approval_id" uuid NOT NULL,
	"runtime_kind" text NOT NULL,
	"request_kind" text NOT NULL,
	"turn_id" text,
	"item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_conversation_approvals_pk" PRIMARY KEY("issue_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "issue_conversation_approvals" ADD CONSTRAINT "issue_conversation_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_conversation_approvals" ADD CONSTRAINT "issue_conversation_approvals_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_conversation_approvals" ADD CONSTRAINT "issue_conversation_approvals_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_conversation_approvals_approval_id_uq" ON "issue_conversation_approvals" USING btree ("approval_id");
--> statement-breakpoint
CREATE INDEX "issue_conversation_approvals_company_idx" ON "issue_conversation_approvals" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "issue_conversation_approvals_issue_idx" ON "issue_conversation_approvals" USING btree ("issue_id");
