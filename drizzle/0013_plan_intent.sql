-- L'intention du plan. Ajoutée nullable, remplie, puis passée NOT NULL : un
-- `ADD COLUMN ... NOT NULL` sans défaut refuserait la table dès qu'elle porte
-- une ligne, et le plan actif de l'athlète en est une.
ALTER TABLE "plans" ADD COLUMN "intent" text;--> statement-breakpoint
-- Reprise des plans existants : un objectif daté était déjà une préparation de
-- course, tout le reste recevait la structure de `faster` (c'est ce que
-- `planIntentOf` en déduisait). Aucun plan ne change donc de forme.
UPDATE "plans" SET "intent" = CASE WHEN "goal_type" = 'race' THEN 'race' ELSE 'faster' END WHERE "intent" IS NULL;--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "intent" SET NOT NULL;--> statement-breakpoint
-- Antécédent de blessure : ne joue qu'en reprise, et aucun plan existant n'en
-- est une — le défaut suffit donc à la reprise des lignes.
ALTER TABLE "plans" ADD COLUMN "return_injury_history" boolean DEFAULT false NOT NULL;
