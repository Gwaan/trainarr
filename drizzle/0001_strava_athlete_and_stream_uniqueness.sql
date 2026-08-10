ALTER TABLE "athlete" ADD COLUMN "strava_athlete_id" bigint;--> statement-breakpoint
-- Ajouté à la main : l'index unique ci-dessous échouerait si `activity_streams`
-- contenait déjà des doublons (deux imports concurrents de la même activité,
-- exactement ce que l'index vient interdire). On ne garde que la ligne la plus
-- récente (`id` le plus grand) de chaque couple (activity_id, type).
DELETE FROM "activity_streams" WHERE "id" NOT IN (
	SELECT MAX("id") FROM "activity_streams" GROUP BY "activity_id", "type"
);--> statement-breakpoint
CREATE UNIQUE INDEX "activity_streams_activity_id_type_idx" ON "activity_streams" USING btree ("activity_id","type");--> statement-breakpoint
ALTER TABLE "athlete" ADD CONSTRAINT "athlete_strava_athlete_id_unique" UNIQUE("strava_athlete_id");
