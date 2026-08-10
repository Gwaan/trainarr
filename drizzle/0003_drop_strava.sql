ALTER TABLE "strava_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "strava_tokens" CASCADE;--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_strava_id_unique";--> statement-breakpoint
ALTER TABLE "athlete" DROP CONSTRAINT "athlete_strava_athlete_id_unique";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "strava_id";--> statement-breakpoint
ALTER TABLE "athlete" DROP COLUMN "strava_athlete_id";