-- Import FIT : `strava_id` cesse d'être obligatoire (une sortie importée depuis
-- la montre n'a pas d'identifiant Strava) et `fit_file_hash` devient la clé
-- d'idempotence du second canal. Les deux colonnes sont uniques et nullables :
-- Postgres autorise plusieurs NULL dans une contrainte UNIQUE, donc les
-- activités d'un seul canal ne se collisionnent pas entre elles.
ALTER TABLE "activities" ALTER COLUMN "strava_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "fit_file_hash" text;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_fit_file_hash_unique" UNIQUE("fit_file_hash");
