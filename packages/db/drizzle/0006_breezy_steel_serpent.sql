CREATE TABLE "job_posting" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"organization" text NOT NULL,
	"description" text,
	"location" text,
	"location_type" text,
	"employment_type" text,
	"skills" text[],
	"salary_min" bigint NOT NULL,
	"salary_max" bigint NOT NULL,
	"salary_currency" text NOT NULL,
	"salary_period" text NOT NULL,
	"annual_min" bigint NOT NULL,
	"annual_max" bigint NOT NULL,
	"apply_url" text,
	"close_date" text,
	"closes_at" timestamp with time zone,
	"search_text" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "job_posting"."search_text")) STORED,
	"created_at" timestamp with time zone NOT NULL,
	"sort_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_posting" ADD CONSTRAINT "job_posting_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_posting_did_idx" ON "job_posting" USING btree ("did");--> statement-breakpoint
CREATE INDEX "job_posting_sort_idx" ON "job_posting" USING btree ("sort_at" DESC NULLS LAST,"uri" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_posting_salary_idx" ON "job_posting" USING btree ("salary_currency","annual_min" DESC NULLS LAST,"annual_max" DESC NULLS LAST,"uri" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_posting_search_idx" ON "job_posting" USING gin ("search");