CREATE TABLE "resume_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"draft" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resume_draft_did_idx" ON "resume_draft" USING btree ("did");--> statement-breakpoint
CREATE INDEX "resume_draft_expires_at_idx" ON "resume_draft" USING btree ("expires_at");