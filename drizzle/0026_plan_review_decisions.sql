CREATE TABLE "plan_review_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"athlete_id" integer NOT NULL,
	"plan_id" integer NOT NULL,
	"verdict" text NOT NULL,
	"reason" text NOT NULL,
	"plan_week" integer NOT NULL,
	"sessions_completed" integer NOT NULL,
	"sessions_missed" integer NOT NULL,
	"ctl" real,
	"atl" real,
	"tsb" real,
	"revision_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_review_decisions" ADD CONSTRAINT "plan_review_decisions_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_review_decisions" ADD CONSTRAINT "plan_review_decisions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_review_decisions_athlete_created_at_idx" ON "plan_review_decisions" USING btree ("athlete_id","created_at");