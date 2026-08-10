-- Contrainte de singleton sur `athlete`.
--
-- L'application est mono-utilisateur, mais rien ne l'imposait à la base :
-- `createAthlete` lisait la table puis insérait, dans une transaction
-- READ COMMITTED où deux soumissions simultanées de l'onboarding lisent
-- toutes les deux une table vide et insèrent chacune leur ligne. Les
-- activités importées ensuite se répartissaient alors entre deux athlètes
-- selon l'ordre des requêtes.
--
-- L'index unique sur l'expression constante `(true)` donne la même clé à
-- toute ligne : la seconde insertion échoue avec le code Postgres `23505`,
-- que le DAL traduit en `AthleteAlreadyExistsError`.
--
-- Sa création échouerait si la course avait déjà eu lieu : les trois
-- premières étapes dédoublonnent d'abord. La ligne conservée est celle au
-- plus petit `id` — c'est déjà celle que le DAL désigne comme « l'athlète »
-- (`ORDER BY id LIMIT 1`), donc celle que l'application affiche aujourd'hui.

-- 1. Re-parentage des activités vers la ligne conservée. Sans lui, la
--    suppression des doublons violerait la clé étrangère `activities.athlete_id`.
--    Table `athlete` vide : `min("id")` vaut NULL, la comparaison vaut NULL,
--    aucune ligne n'est touchée.
UPDATE "activities"
   SET "athlete_id" = (SELECT min("id") FROM "athlete")
 WHERE "athlete_id" <> (SELECT min("id") FROM "athlete");
--> statement-breakpoint
-- 2. Même chose pour les séances planifiées, qui référencent aussi l'athlète.
UPDATE "planned_sessions"
   SET "athlete_id" = (SELECT min("id") FROM "athlete")
 WHERE "athlete_id" <> (SELECT min("id") FROM "athlete");
--> statement-breakpoint
-- 3. Les doublons ne sont plus référencés : ils peuvent partir. Ce qu'ils
--    portaient de propre (FC max, sexe, poids…) est perdu ; le profil de la
--    ligne conservée fait foi et reste modifiable depuis les réglages.
DELETE FROM "athlete" WHERE "id" <> (SELECT min("id") FROM "athlete");
--> statement-breakpoint
-- 4. La contrainte elle-même. Générée par drizzle-kit depuis
--    `uniqueIndex('athlete_singleton').on(sql`(true)`)` dans le schéma : ne pas
--    la réécrire à la main, le snapshot 0004 doit rester cohérent avec elle.
CREATE UNIQUE INDEX "athlete_singleton" ON "athlete" USING btree ((true));
