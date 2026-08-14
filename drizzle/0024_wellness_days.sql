CREATE TABLE "wellness_days" (
	"athlete_id" integer NOT NULL,
	"day" date NOT NULL,
	"resting_hr_bpm" integer,
	"hrv_rmssd_ms" real,
	"sleep_time_s" integer,
	"sleep_score" real,
	"avg_sleeping_hr_bpm" real,
	"weight_kg" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellness_days_athlete_id_day_pk" PRIMARY KEY("athlete_id","day")
);
--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "resting_hr_suggestion_dismissed_bpm" integer;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "wellness_reading_day" date;--> statement-breakpoint
ALTER TABLE "wellness_days" ADD CONSTRAINT "wellness_days_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;