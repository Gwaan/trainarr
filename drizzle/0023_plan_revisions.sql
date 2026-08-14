CREATE TABLE "plan_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"athlete_id" integer NOT NULL,
	"plan_id" integer NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"direction" text NOT NULL,
	"weeks" integer NOT NULL,
	"before_volume_km" real NOT NULL,
	"before_intensity_km" real NOT NULL,
	"after_volume_km" real NOT NULL,
	"after_intensity_km" real NOT NULL,
	"payload" jsonb NOT NULL,
	"plan_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_revisions_pending_per_athlete" ON "plan_revisions" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "plan_revisions_plan_id_idx" ON "plan_revisions" USING btree ("plan_id");