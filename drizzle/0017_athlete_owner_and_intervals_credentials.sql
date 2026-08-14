-- L'athlète devient la propriété d'un compte, et porte ses identifiants
-- intervals.icu.
--
-- Trois changements solidaires :
--
-- 1. `user_id` — le compte propriétaire (`auth_users.id`). **Nullable** : cette
--    migration s'applique très probablement avant qu'un seul compte existe, et
--    il n'y aurait alors aucune valeur à écrire dans une colonne `NOT NULL`.
--    Une ligne à `user_id IS NULL` est un athlète *à réclamer* : le premier
--    compte connecté qui n'a pas encore d'athlète se l'attribue (une seule mise
--    à jour conditionnelle, cf. `getCurrentAthleteId`). C'est ce qui évite
--    qu'un athlète existant devienne invisible derrière un profil neuf et vide.
--    `ON DELETE RESTRICT` : supprimer un compte ne doit ni emporter des années
--    d'entraînement (CASCADE), ni rendre l'athlète orphelin donc réclamable par
--    le compte suivant (SET NULL) — la base refuse, et l'humain tranche.
--
-- 2. Suppression de `athlete_singleton`. Cet index unique sur l'expression
--    constante `(true)` (migration 0004) donnait la même clé à toute ligne :
--    il interdisait matériellement un second athlète. Ce qui borne la table
--    désormais, c'est l'unicité de `user_id` — un athlète par compte.
--    Conséquence assumée : entre cette migration et la réclamation, plusieurs
--    lignes sans propriétaire pourraient coexister ; le DAL n'en réclame qu'une
--    (la plus ancienne) et ne rend jamais « le premier athlète venu ».
--
-- 3. Les identifiants intervals.icu, jusqu'ici dans l'environnement du serveur
--    (`INTERVALS_ATHLETE_ID`, `INTERVALS_API_KEY`), deviennent une donnée de
--    l'athlète. La clé n'est **jamais** stockée en clair : la colonne porte une
--    enveloppe AES-256-GCM `v1:<base64>` (cf. `src/lib/crypto/`), dont la clé
--    dérive de `BETTER_AUTH_SECRET`.
--
-- Aucune donnée existante n'est perdue ni déplacée : trois colonnes s'ajoutent
-- à `NULL`, un index disparaît.

DROP INDEX "athlete_singleton";--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "intervals_athlete_id" text;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "intervals_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "athlete" ADD CONSTRAINT "athlete_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete" ADD CONSTRAINT "athlete_user_id_unique" UNIQUE("user_id");
