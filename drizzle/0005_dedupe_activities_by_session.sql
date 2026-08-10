-- Déduplication des activités au niveau séance.
--
-- Incident : trois activités dupliquées sur intervals.icu ont produit trois
-- fichiers FIT aux octets différents pour une seule et même sortie. L'unique clé
-- d'idempotence de l'époque — `fit_file_hash` — ne rapproche que le même
-- *fichier*, jamais la même *séance* : chaque sortie s'est retrouvée en trois
-- exemplaires en base, au `started_at` strictement identique.
--
-- Ce nettoyage précède l'index unique `(athlete_id, started_at, sport_type)` de
-- la migration suivante, qui échouerait sur une base encore polluée.
--
-- **Clé de groupe** : `(athlete_id, started_at, sport_type)`, exactement celle
-- de l'index. Le sport en fait partie : un enchaînement (natation puis course)
-- démarre légitimement à la seconde où la discipline précédente s'arrête, et
-- fusionner deux disciplines détruirait une séance réelle.
--
-- Pour chaque groupe de plus d'une ligne :
--   1. la ligne gardienne est complétée par ce que les autres savent ;
--   2. les séances planifiées qui pointaient vers un doublon sont repointées ;
--   3. les séries temporelles que la gardienne n'a pas lui sont transférées ;
--   4. les doublons sont supprimés (leurs `activity_streams` restants suivent en
--      cascade).
--
-- **Classement**, identique et répété à l'identique dans les quatre
-- instructions :
--   a. celle qui possède des séries temporelles ;
--   b. à égalité, le plus de colonnes physio renseignées ;
--   c. à égalité encore, le plus petit `id`.
--
-- L'ordre des deux premiers critères n'est pas indifférent : un exemplaire
-- « résumé seul » (les cinq scalaires, aucune série) l'emporterait sur un
-- exemplaire porteur des séries si le compte de colonnes passait devant — et la
-- gardienne serait alors la ligne la plus pauvre du groupe.
--
-- **Le classement est stable d'une instruction à l'autre**, ce dont dépend la
-- correction de l'ensemble :
--   - l'instruction 1 ne fait qu'augmenter le nombre de colonnes renseignées de
--     la gardienne, qui était déjà maximal à égalité de critère (a) — et elle ne
--     touche ni les séries, ni les `id` ;
--   - l'instruction 3 déplace des séries, donc le critère (a) lui-même : mais
--     une gardienne qui a des séries en garde (on ne lui en retire jamais), et
--     si personne n'en a dans le groupe il n'y a rien à déplacer. Dans les deux
--     cas la gardienne reste la gardienne.
--
-- **Idempotent** : sur une base déjà propre, aucun groupe n'a plus d'une ligne,
-- les quatre instructions ne touchent aucune ligne. Rejouable sans effet.

-- 1. Complétion de la gardienne.
--
-- Le `coalesce` par priorité est obtenu par `array_agg ... ORDER BY rang` suivi
-- du retrait des NULL (`array_remove` compare en `IS NOT DISTINCT FROM`) : le
-- premier élément restant est la valeur de la ligne la mieux classée qui en
-- possède une — la gardienne d'abord, donc jamais écrasée.
WITH base AS (
  SELECT
    a.id,
    a.athlete_id,
    a.started_at,
    a.sport_type,
    a.elevation_gain_m,
    a.avg_hr_bpm,
    a.max_hr_bpm,
    a.avg_pace_sec_per_km,
    a.avg_cadence_spm,
    EXISTS (SELECT 1 FROM activity_streams s WHERE s.activity_id = a.id) AS a_des_series,
    (
      (a.elevation_gain_m IS NOT NULL)::int
      + (a.avg_hr_bpm IS NOT NULL)::int
      + (a.max_hr_bpm IS NOT NULL)::int
      + (a.avg_pace_sec_per_km IS NOT NULL)::int
      + (a.avg_cadence_spm IS NOT NULL)::int
    ) AS colonnes_renseignees
  FROM activities a
),
classees AS (
  SELECT
    b.*,
    row_number() OVER (
      PARTITION BY b.athlete_id, b.started_at, b.sport_type
      ORDER BY b.a_des_series DESC, b.colonnes_renseignees DESC, b.id ASC
    ) AS rang
  FROM base b
),
groupes_doublons AS (
  SELECT athlete_id, started_at, sport_type
  FROM classees
  GROUP BY athlete_id, started_at, sport_type
  HAVING count(*) > 1
),
fusion AS (
  SELECT
    min(c.id) FILTER (WHERE c.rang = 1) AS gardienne_id,
    (array_remove(array_agg(c.elevation_gain_m ORDER BY c.rang), NULL::real))[1]
      AS elevation_gain_m,
    (array_remove(array_agg(c.avg_hr_bpm ORDER BY c.rang), NULL::integer))[1]
      AS avg_hr_bpm,
    (array_remove(array_agg(c.max_hr_bpm ORDER BY c.rang), NULL::integer))[1]
      AS max_hr_bpm,
    (array_remove(array_agg(c.avg_pace_sec_per_km ORDER BY c.rang), NULL::real))[1]
      AS avg_pace_sec_per_km,
    (array_remove(array_agg(c.avg_cadence_spm ORDER BY c.rang), NULL::real))[1]
      AS avg_cadence_spm
  FROM classees c
  JOIN groupes_doublons g
    ON g.athlete_id = c.athlete_id
   AND g.started_at = c.started_at
   AND g.sport_type = c.sport_type
  GROUP BY c.athlete_id, c.started_at, c.sport_type
)
UPDATE activities a
SET
  elevation_gain_m = f.elevation_gain_m,
  avg_hr_bpm = f.avg_hr_bpm,
  max_hr_bpm = f.max_hr_bpm,
  avg_pace_sec_per_km = f.avg_pace_sec_per_km,
  avg_cadence_spm = f.avg_cadence_spm
FROM fusion f
WHERE a.id = f.gardienne_id;
--> statement-breakpoint

-- 2. Les séances planifiées repointent vers la gardienne.
--
-- Avant la suppression, et non après : la référence de `planned_sessions` est
-- `ON DELETE SET NULL`, supprimer d'abord effacerait le rapprochement séance
-- planifiée ↔ séance réalisée au lieu de le conserver.
WITH base AS (
  SELECT
    a.id,
    a.athlete_id,
    a.started_at,
    a.sport_type,
    EXISTS (SELECT 1 FROM activity_streams s WHERE s.activity_id = a.id) AS a_des_series,
    (
      (a.elevation_gain_m IS NOT NULL)::int
      + (a.avg_hr_bpm IS NOT NULL)::int
      + (a.max_hr_bpm IS NOT NULL)::int
      + (a.avg_pace_sec_per_km IS NOT NULL)::int
      + (a.avg_cadence_spm IS NOT NULL)::int
    ) AS colonnes_renseignees
  FROM activities a
),
classees AS (
  SELECT
    b.*,
    row_number() OVER (
      PARTITION BY b.athlete_id, b.started_at, b.sport_type
      ORDER BY b.a_des_series DESC, b.colonnes_renseignees DESC, b.id ASC
    ) AS rang
  FROM base b
),
gardiennes AS (
  SELECT athlete_id, started_at, sport_type, id AS gardienne_id
  FROM classees
  WHERE rang = 1
),
doublons AS (
  SELECT c.id, g.gardienne_id
  FROM classees c
  JOIN gardiennes g
    ON g.athlete_id = c.athlete_id
   AND g.started_at = c.started_at
   AND g.sport_type = c.sport_type
  WHERE c.rang > 1
)
UPDATE planned_sessions p
SET completed_activity_id = d.gardienne_id
FROM doublons d
WHERE p.completed_activity_id = d.id;
--> statement-breakpoint

-- 3. Transfert des séries temporelles que la gardienne n'a pas.
--
-- Une gardienne peut être la mieux renseignée en scalaires tout en ignorant un
-- canal qu'un doublon porte (deux exports d'une même sortie n'embarquent pas
-- forcément les mêmes capteurs). Supprimer sans transférer perdrait ce canal
-- pour toujours — c'est le seul endroit de cette migration où une donnée
-- pourrait disparaître sans que rien ne la remplace.
--
-- `DISTINCT ON (gardienne_id, type)` : un seul exemplaire par canal, celui de la
-- perdante la mieux classée. Sans cela, deux doublons porteurs du même canal
-- violeraient l'index unique `activity_streams_activity_id_type_idx`. Le
-- `NOT EXISTS` garantit qu'on n'écrase jamais un canal déjà présent chez la
-- gardienne : ce transfert comble des trous, il ne remplace rien.
WITH base AS (
  SELECT
    a.id,
    a.athlete_id,
    a.started_at,
    a.sport_type,
    EXISTS (SELECT 1 FROM activity_streams s WHERE s.activity_id = a.id) AS a_des_series,
    (
      (a.elevation_gain_m IS NOT NULL)::int
      + (a.avg_hr_bpm IS NOT NULL)::int
      + (a.max_hr_bpm IS NOT NULL)::int
      + (a.avg_pace_sec_per_km IS NOT NULL)::int
      + (a.avg_cadence_spm IS NOT NULL)::int
    ) AS colonnes_renseignees
  FROM activities a
),
classees AS (
  SELECT
    b.*,
    row_number() OVER (
      PARTITION BY b.athlete_id, b.started_at, b.sport_type
      ORDER BY b.a_des_series DESC, b.colonnes_renseignees DESC, b.id ASC
    ) AS rang
  FROM base b
),
gardiennes AS (
  SELECT athlete_id, started_at, sport_type, id AS gardienne_id
  FROM classees
  WHERE rang = 1
),
perdantes AS (
  SELECT c.id, c.rang, g.gardienne_id
  FROM classees c
  JOIN gardiennes g
    ON g.athlete_id = c.athlete_id
   AND g.started_at = c.started_at
   AND g.sport_type = c.sport_type
  WHERE c.rang > 1
),
transferables AS (
  SELECT DISTINCT ON (p.gardienne_id, s.type)
    s.id AS stream_id,
    p.gardienne_id
  FROM perdantes p
  JOIN activity_streams s ON s.activity_id = p.id
  WHERE NOT EXISTS (
    SELECT 1
    FROM activity_streams deja
    WHERE deja.activity_id = p.gardienne_id AND deja.type = s.type
  )
  ORDER BY p.gardienne_id, s.type, p.rang, s.id
)
UPDATE activity_streams s
SET activity_id = t.gardienne_id
FROM transferables t
WHERE s.id = t.stream_id;
--> statement-breakpoint

-- 4. Suppression des doublons.
--
-- Les séries qu'ils portent encore (canaux que la gardienne avait déjà) partent
-- en cascade (`ON DELETE CASCADE`) ; plus aucune ligne de `planned_sessions` ne
-- les référence après l'instruction 2.
WITH base AS (
  SELECT
    a.id,
    a.athlete_id,
    a.started_at,
    a.sport_type,
    EXISTS (SELECT 1 FROM activity_streams s WHERE s.activity_id = a.id) AS a_des_series,
    (
      (a.elevation_gain_m IS NOT NULL)::int
      + (a.avg_hr_bpm IS NOT NULL)::int
      + (a.max_hr_bpm IS NOT NULL)::int
      + (a.avg_pace_sec_per_km IS NOT NULL)::int
      + (a.avg_cadence_spm IS NOT NULL)::int
    ) AS colonnes_renseignees
  FROM activities a
),
classees AS (
  SELECT
    b.id,
    row_number() OVER (
      PARTITION BY b.athlete_id, b.started_at, b.sport_type
      ORDER BY b.a_des_series DESC, b.colonnes_renseignees DESC, b.id ASC
    ) AS rang
  FROM base b
)
DELETE FROM activities a
USING classees c
WHERE a.id = c.id AND c.rang > 1;
