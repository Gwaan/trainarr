import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Schéma Drizzle de Trainarr.
 *
 * Conventions :
 * - toutes les dates/heures sont en `timestamp with time zone` (stockage UTC,
 *   conversion au fuseau de l'utilisateur à l'affichage) ;
 * - les unités sont explicites dans les noms de colonnes (`distance_m`,
 *   `avg_hr_bpm`, `avg_pace_sec_per_km`…), jamais de nombre nu ambigu.
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Sexe biologique — nécessaire au TRIMP de Banister, dont le coefficient
 * exponentiel diffère (1.92 homme / 1.67 femme). Nullable : tant qu'il n'est pas
 * renseigné, la charge d'entraînement n'est pas calculable (jamais approximée).
 */
export const ATHLETE_SEXES = ['male', 'female'] as const;

export type AthleteSex = (typeof ATHLETE_SEXES)[number];

/** Profil de l'athlète. Application mono-utilisateur : une seule ligne, garantie par la base. */
export const athlete = pgTable(
  'athlete',
  {
    id: serial('id').primaryKey(),
    displayName: text('display_name').notNull(),
    sex: text('sex', { enum: ATHLETE_SEXES }),
    maxHrBpm: integer('max_hr_bpm'),
    restingHrBpm: integer('resting_hr_bpm'),
    weightKg: numeric('weight_kg', { precision: 5, scale: 2, mode: 'number' }),
    /** Date civile (mode `string`, `YYYY-MM-DD`) : pas d'heure, donc pas de fuseau. */
    birthDate: date('birth_date'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    /**
     * Contrainte de singleton : un index unique sur l'expression constante
     * `true` produit la même clé pour toute ligne, donc la seconde insertion
     * échoue (`23505`). C'est ce qui ferme la course entre deux soumissions
     * simultanées de l'onboarding — un `SELECT` suivi d'un `INSERT` en
     * `READ COMMITTED` ne la voit pas venir, les deux transactions lisant une
     * table encore vide. Côté DAL, `createAthlete` traduit la violation en
     * `AthleteAlreadyExistsError`.
     */
    uniqueIndex('athlete_singleton').on(sql`(true)`),
  ],
);

/**
 * Nom de l'index unique qui interdit deux activités du même sport au même
 * instant pour le même athlète.
 *
 * Le sport fait partie de la clé, exactement comme dans la recherche de séance
 * du DAL : un enchaînement (natation puis course) démarre légitimement à la
 * seconde où la discipline précédente s'arrête. Sans lui, ce cas violerait
 * l'index sans être rapprochable — l'import échouerait définitivement.
 *
 * Exporté parce que le DAL le lit : quand l'insertion d'un import FIT se heurte à
 * cet index (course entre deux ingestions simultanées de la même séance), c'est
 * ce nom-là qui distingue la collision « même séance » de celle sur
 * `fit_file_hash`, laquelle est déjà absorbée par un `ON CONFLICT`.
 */
export const ACTIVITIES_SESSION_UNIQUE_INDEX = 'activities_athlete_started_at_sport_unique';

/**
 * Une séance.
 *
 * **Deux clés d'idempotence**, et non une seule :
 *
 * 1. `fit_file_hash` (SHA-256 du fichier), unique et **nullable** — une ligne
 *    peut naître autrement qu'en lisant un fichier ; Postgres autorise plusieurs
 *    `NULL` dans une contrainte `UNIQUE`, ces lignes-là ne se collisionnent pas
 *    entre elles. Elle protège du redépôt du **même fichier**.
 * 2. `(athlete_id, started_at)`, unique — elle protège de la **même séance**
 *    arrivée sous plusieurs fichiers d'octets différents. Cas vécu : trois
 *    doublons créés en amont sur intervals.icu ont produit trois fichiers FIT
 *    distincts, donc trois empreintes distinctes, donc trois lignes pour une
 *    seule sortie. Un athlète ne peut pas démarrer deux séances au même instant.
 */
export const activities = pgTable(
  'activities',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    /**
     * Empreinte SHA-256 du fichier FIT à l'origine de l'activité — clé
     * d'idempotence de l'import. Redéposer le même fichier retombe sur la même
     * ligne au lieu de la dupliquer.
     */
    fitFileHash: text('fit_file_hash').unique(),
    name: text('name').notNull(),
    sportType: text('sport_type').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    distanceM: real('distance_m').notNull(),
    movingTimeS: integer('moving_time_s').notNull(),
    elapsedTimeS: integer('elapsed_time_s').notNull(),
    elevationGainM: real('elevation_gain_m'),
    avgHrBpm: integer('avg_hr_bpm'),
    maxHrBpm: integer('max_hr_bpm'),
    avgPaceSecPerKm: real('avg_pace_sec_per_km'),
    avgCadenceSpm: real('avg_cadence_spm'),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Backstop de la déduplication au niveau séance. Le DAL cherche d'abord une
     * séance voisine avant d'insérer, mais en `READ COMMITTED` deux ingestions
     * simultanées du même entraînement lisent toutes les deux une base sans
     * doublon : c'est la contrainte, et non la lecture préalable, qui porte
     * l'idempotence. `upsertActivityFromFit` traduit la violation `23505` en
     * rapprochement (cf. {@link ACTIVITIES_SESSION_UNIQUE_INDEX}).
     *
     * Il sert **aussi** de chemin d'accès aux lectures par athlète ordonnées
     * dans le temps : son préfixe `(athlete_id, started_at)` est celui de
     * l'ancien `activities_athlete_started_at_idx`, que la migration 0006
     * supprime pour cela — un btree se parcourt dans les deux sens, le `DESC`
     * de l'ancien index n'apportait rien de plus.
     */
    uniqueIndex(ACTIVITIES_SESSION_UNIQUE_INDEX).on(
      table.athleteId,
      table.startedAt,
      table.sportType,
    ),
  ],
);

/** Types de séries temporelles conservées (point par point). */
export const ACTIVITY_STREAM_TYPES = [
  'time',
  'distance',
  'heartrate',
  'altitude',
  'cadence',
  'velocity',
  'latlng',
] as const;

export type ActivityStreamType = (typeof ACTIVITY_STREAM_TYPES)[number];

/**
 * Un stream est une série de scalaires, sauf `latlng` qui est une série de
 * couples.
 *
 * **`null` = le capteur n'a rien mesuré à cet index.** Un fichier FIT n'écrit
 * pas tous les champs dans chaque message `record` : chaque message ne porte que
 * les champs déclarés par sa *definition message*, et chaque capteur écrit à sa
 * propre cadence (le GPS à son taux de fix, la FC à celui de la ceinture). Un
 * canal clairsemé est donc la norme, pas une panne — le représenter avec des
 * trous explicites est la seule façon de garder les index alignés entre séries
 * sans inventer de mesure.
 *
 * Le stockage est en JSONB : `null` y est une valeur native, aucune migration
 * n'est nécessaire pour l'accueillir.
 */
export type ActivityStreamData = (number | null)[] | Array<[number, number] | null>;

/** Séries temporelles d'une activité, hors table principale (JSONB). */
export const activityStreams = pgTable(
  'activity_streams',
  {
    id: serial('id').primaryKey(),
    activityId: integer('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ACTIVITY_STREAM_TYPES }).notNull(),
    data: jsonb('data').$type<ActivityStreamData>().notNull(),
  },
  (table) => [
    index('activity_streams_activity_id_idx').on(table.activityId),
    /**
     * Une seule ligne par (activité, type) : c'est cette contrainte qui rend
     * `saveActivityStreams` idempotent (`ON CONFLICT`) et interdit les doublons
     * si deux imports de la même activité se croisent.
     */
    uniqueIndex('activity_streams_activity_id_type_idx').on(table.activityId, table.type),
  ],
);

/**
 * ⚠️ TABLE PROVISOIRE.
 *
 * Modèle volontairement plat, strictement limité à ce que le dashboard affiche
 * aujourd'hui (« séance du jour »). Le vrai modèle de plan — plan, semaines,
 * blocs, répétitions structurées, adaptation par le coach IA — sera conçu au
 * sprint dédié et remplacera cette table. Ne pas l'étendre en attendant.
 */
export const plannedSessions = pgTable(
  'planned_sessions',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    /** Date civile (mode `string`, `YYYY-MM-DD`) : une séance est planifiée un jour, pas à une heure. */
    scheduledOn: date('scheduled_on').notNull(),
    /** Ex. « VMA courte · piste ». */
    kind: text('kind').notNull(),
    /** Ex. « 6 × 800 m ». */
    title: text('title').notNull(),
    targetPaceSecPerKm: real('target_pace_sec_per_km'),
    /** Textes libres affichés tels quels, ex. « 20 min @ 5:30/km ». */
    warmup: text('warmup'),
    recovery: text('recovery'),
    cooldown: text('cooldown'),
    volumeM: real('volume_m'),
    durationS: integer('duration_s'),
    /** Activité qui a réalisé la séance. `null` tant qu'elle n'est pas faite (ou pas rapprochée). */
    completedActivityId: integer('completed_activity_id').references(() => activities.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    index('planned_sessions_athlete_scheduled_on_idx').on(table.athleteId, table.scheduledOn),
  ],
);

// Types inférés depuis le schéma — ne jamais les réécrire à la main.
export type Athlete = InferSelectModel<typeof athlete>;
export type NewAthlete = InferInsertModel<typeof athlete>;

export type Activity = InferSelectModel<typeof activities>;
export type NewActivity = InferInsertModel<typeof activities>;

export type ActivityStream = InferSelectModel<typeof activityStreams>;
export type NewActivityStream = InferInsertModel<typeof activityStreams>;

export type PlannedSession = InferSelectModel<typeof plannedSessions>;
export type NewPlannedSession = InferInsertModel<typeof plannedSessions>;
