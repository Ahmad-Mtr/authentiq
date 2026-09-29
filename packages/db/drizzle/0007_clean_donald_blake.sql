CREATE TABLE "feed_generator" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service_did" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone NOT NULL,
	"sort_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_pin" (
	"did" text PRIMARY KEY NOT NULL,
	"feeds" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feed_generator" ADD CONSTRAINT "feed_generator_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_generator_did_idx" ON "feed_generator" USING btree ("did");--> statement-breakpoint
CREATE INDEX "feed_generator_sort_idx" ON "feed_generator" USING btree ("sort_at","uri");