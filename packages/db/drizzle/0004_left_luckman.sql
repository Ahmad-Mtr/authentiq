CREATE TABLE "embedding" (
	"subject" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"did" text NOT NULL,
	"document" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("embedding"."document", ''))) STORED,
	"content_hash" text,
	"embedded_hash" text,
	"model" text,
	"vector" vector(1024),
	"embed_count" integer DEFAULT 0 NOT NULL,
	"dirty_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"embedded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embedding_did_idx" ON "embedding" USING btree ("did");--> statement-breakpoint
CREATE INDEX "embedding_vector_idx" ON "embedding" USING hnsw ("vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "embedding_search_idx" ON "embedding" USING gin ("search");--> statement-breakpoint
CREATE INDEX "embedding_dirty_idx" ON "embedding" USING btree ("next_attempt_at") WHERE "embedding"."dirty_at" is not null;