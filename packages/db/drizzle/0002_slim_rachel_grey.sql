CREATE TABLE "actor" (
	"did" text PRIMARY KEY NOT NULL,
	"handle" text,
	"active" boolean DEFAULT true NOT NULL,
	"status" text,
	"rev" text,
	"backfilled_at" timestamp with time zone,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "education" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"school" text NOT NULL,
	"degree" text,
	"field_of_study" text,
	"start_date" text,
	"end_date" text,
	"description" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"organization" text NOT NULL,
	"employment_type" text,
	"location_type" text,
	"location" text,
	"start_date" text NOT NULL,
	"end_date" text,
	"description" text,
	"skills" text[],
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"uri" text PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"did" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text NOT NULL,
	"headline" text,
	"about" text,
	"avatar_cid" text,
	"location" text,
	"open_to_work" boolean,
	"skills" text[],
	"created_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "education" ADD CONSTRAINT "education_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position" ADD CONSTRAINT "position_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_did_actor_did_fk" FOREIGN KEY ("did") REFERENCES "public"."actor"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actor_handle_idx" ON "actor" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "education_did_idx" ON "education" USING btree ("did");--> statement-breakpoint
CREATE INDEX "position_did_idx" ON "position" USING btree ("did");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_did_idx" ON "profile" USING btree ("did");