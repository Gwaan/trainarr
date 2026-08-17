CREATE TABLE "race_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"athlete_id" integer NOT NULL,
	"raced_on" date NOT NULL,
	"distance_m" real NOT NULL,
	"time_s" integer NOT NULL,
	"name" text,
	"activity_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "vo2max_correction_factor" real;--> statement-breakpoint
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "race_results_athlete_raced_on_idx" ON "race_results" USING btree ("athlete_id","raced_on");--> statement-breakpoint
CREATE UNIQUE INDEX "race_results_activity_unique" ON "race_results" USING btree ("activity_id");