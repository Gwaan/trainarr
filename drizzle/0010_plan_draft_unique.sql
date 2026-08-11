-- Filet avant la contrainte : si deux générations concurrentes ont déjà laissé
-- deux propositions au même athlète, la création de l'index échouerait et
-- bloquerait la migration. On ne garde que la plus récente — c'est déjà celle
-- que le DAL sert (lecture ordonnée par `created_at` décroissant), et les
-- séances des autres partent par cascade.
DELETE FROM "plans" WHERE "status" = 'draft' AND "id" NOT IN (
	SELECT DISTINCT ON ("athlete_id") "id" FROM "plans"
	WHERE "status" = 'draft'
	ORDER BY "athlete_id", "created_at" DESC, "id" DESC
);--> statement-breakpoint
CREATE UNIQUE INDEX "plans_draft_per_athlete" ON "plans" USING btree ("athlete_id") WHERE status = 'draft';
