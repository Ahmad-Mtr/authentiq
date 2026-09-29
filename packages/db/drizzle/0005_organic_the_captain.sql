CREATE TABLE "community" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"topic" text NOT NULL,
	"rules" text[],
	"created_at" timestamp with time zone NOT NULL,
	"sort_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_hidden_post" (
	"community_uri" text NOT NULL,
	"post_uri" text NOT NULL,
	"hidden_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_hidden_post_community_uri_post_uri_pk" PRIMARY KEY("community_uri","post_uri")
);
--> statement-breakpoint
CREATE TABLE "follow" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"community_uri" text NOT NULL,
	"community_cid" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"facets" jsonb,
	"reply_root_uri" text,
	"reply_root_cid" text,
	"reply_parent_uri" text,
	"reply_parent_cid" text,
	"community_uri" text,
	"community_cid" text,
	"embed" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"sort_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_like" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject_uri" text NOT NULL,
	"subject_cid" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community" ADD CONSTRAINT "community_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_like" ADD CONSTRAINT "post_like_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_did_idx" ON "community" USING btree ("did");--> statement-breakpoint
CREATE INDEX "community_sort_idx" ON "community" USING btree ("sort_at" DESC NULLS LAST,"uri" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "community_hidden_post_post_idx" ON "community_hidden_post" USING btree ("post_uri");--> statement-breakpoint
CREATE INDEX "follow_did_subject_idx" ON "follow" USING btree ("did","subject");--> statement-breakpoint
CREATE INDEX "follow_subject_idx" ON "follow" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "membership_community_did_idx" ON "membership" USING btree ("community_uri","did");--> statement-breakpoint
CREATE INDEX "membership_did_idx" ON "membership" USING btree ("did");--> statement-breakpoint
CREATE INDEX "post_did_sort_idx" ON "post" USING btree ("did","sort_at" DESC NULLS LAST,"uri" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_reply_root_idx" ON "post" USING btree ("reply_root_uri");--> statement-breakpoint
CREATE INDEX "post_reply_parent_idx" ON "post" USING btree ("reply_parent_uri");--> statement-breakpoint
CREATE INDEX "post_community_sort_idx" ON "post" USING btree ("community_uri","sort_at" DESC NULLS LAST,"uri" DESC NULLS LAST) WHERE "post"."community_uri" is not null and "post"."reply_root_uri" is null;--> statement-breakpoint
CREATE INDEX "post_like_did_subject_idx" ON "post_like" USING btree ("did","subject_uri");