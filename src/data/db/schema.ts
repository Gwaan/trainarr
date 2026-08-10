import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  bigint,
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

/** Profil de l'athlète. Application mono-utilisateur : une seule ligne en pratique. */
export const athlete = pgTable('athlete', {
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
});

/**
 * Jetons OAuth Strava.
 *
 * ⚠️ SECRET : `access_token`, `refresh_token` et `scope` ne sortent JAMAIS du DAL.
 * Aucun DTO exposé à l'UI, à une Server Action ou à un composant client ne doit
 * contenir ces colonnes, et elles ne doivent jamais être loggées.
 */
export const stravaTokens = pgTable('strava_tokens', {
  id: serial('id').primaryKey(),
  athleteId: integer('athlete_id')
    .notNull()
    .references(() => athlete.id),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  scope: text('scope'),
  updatedAt: updatedAt(),
});

/** Une séance. `stravaId` est unique : l'idempotence de la sync (upsert) en dépend. */
export const activities = pgTable(
  'activities',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    /**
     * Identifiant Strava de l'activité. `mode: 'number'` : les ids Strava (~1e10)
     * restent très en dessous de `Number.MAX_SAFE_INTEGER`, et un `bigint` JS
     * ne serait pas sérialisable vers le client.
     */
    stravaId: bigint('strava_id', { mode: 'number' }).notNull().unique(),
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
    index('activities_athlete_started_at_idx').on(table.athleteId, table.startedAt.desc()),
  ],
);

/** Types de streams Strava conservés (point par point). */
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

/** Un stream est une série de scalaires, sauf `latlng` qui est une série de couples. */
export type ActivityStreamData = number[] | Array<[number, number]>;

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
  (table) => [index('activity_streams_activity_id_idx').on(table.activityId)],
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

export type StravaToken = InferSelectModel<typeof stravaTokens>;
export type NewStravaToken = InferInsertModel<typeof stravaTokens>;

export type Activity = InferSelectModel<typeof activities>;
export type NewActivity = InferInsertModel<typeof activities>;

export type ActivityStream = InferSelectModel<typeof activityStreams>;
export type NewActivityStream = InferInsertModel<typeof activityStreams>;

export type PlannedSession = InferSelectModel<typeof plannedSessions>;
export type NewPlannedSession = InferInsertModel<typeof plannedSessions>;
