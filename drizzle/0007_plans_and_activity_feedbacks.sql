CREATE TABLE "activity_feedbacks" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity_id" integer NOT NULL,
	"content" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_feedbacks_activity_id_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"athlete_id" integer NOT NULL,
	"status" text NOT NULL,
	"goal_type" text NOT NULL,
	"goal_text" text NOT NULL,
	"race_date" date,
	"starts_on" date NOT NULL,
	"weeks" integer NOT NULL,
	"sessions_per_week" integer NOT NULL,
	"weekly_time_minutes" integer,
	"long_run_day" integer NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "planned_sessions" ADD COLUMN "plan_id" integer;--> statement-breakpoint
ALTER TABLE "activity_feedbacks" ADD CONSTRAINT "activity_feedbacks_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_active_per_athlete" ON "plans" USING btree ("athlete_id") WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "planned_sessions" ADD CONSTRAINT "planned_sessions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planned_sessions_plan_id_idx" ON "planned_sessions" USING btree ("plan_id");