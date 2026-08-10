-- Ajouté à la main : l'image pgvector/pgvector:pg17 fournit l'extension mais ne
-- l'active pas, et drizzle-kit ne la déclare pas tant qu'aucune colonne `vector`
-- n'existe. Elle est activée dès la première migration pour que les embeddings
-- RAG du coach puissent être ajoutés sans intervention manuelle sur la base.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"athlete_id" integer NOT NULL,
	"strava_id" bigint NOT NULL,
	"name" text NOT NULL,
	"sport_type" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"distance_m" real NOT NULL,
	"moving_time_s" integer NOT NULL,
	"elapsed_time_s" integer NOT NULL,
	"elevation_gain_m" real,
	"avg_hr_bpm" integer,
	"max_hr_bpm" integer,
	"avg_pace_sec_per_km" real,
	"avg_cadence_spm" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_strava_id_unique" UNIQUE("strava_id")
);
--> statement-breakpoint
CREATE TABLE "activity_streams" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity_id" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"sex" text,
	"max_hr_bpm" integer,
	"resting_hr_bpm" integer,
	"weight_kg" numeric(5, 2),
	"birth_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planned_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"athlete_id" integer NOT NULL,
	"scheduled_on" date NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"target_pace_sec_per_km" real,
	"warmup" text,
	"recovery" text,
	"cooldown" text,
	"volume_m" real,
	"duration_s" integer,
	"completed_activity_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strava_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"athlete_id" integer NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_streams" ADD CONSTRAINT "activity_streams_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_sessions" ADD CONSTRAINT "planned_sessions_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_sessions" ADD CONSTRAINT "planned_sessions_completed_activity_id_activities_id_fk" FOREIGN KEY ("completed_activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strava_tokens" ADD CONSTRAINT "strava_tokens_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_athlete_started_at_idx" ON "activities" USING btree ("athlete_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_streams_activity_id_idx" ON "activity_streams" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "planned_sessions_athlete_scheduled_on_idx" ON "planned_sessions" USING btree ("athlete_id","scheduled_on");