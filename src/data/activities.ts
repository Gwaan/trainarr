import 'server-only';

import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import { APP_TIME_ZONE } from '@/config/time';
import { paceSecPerKm } from '@/lib/metrics';
import type { StravaActivity, StravaStreamSet } from '@/lib/strava/client';

import { db } from './db/client';
import {
  ACTIVITY_STREAM_TYPES,
  activities,
  activityStreams,
  type Activity,
  type NewActivityStream,
} from './db/schema';

/**
 * DTOs des activités exposés à l'UI.
 *
 * Déclarés explicitement (pas de `typeof row`) : `stravaId`, `athleteId` et
 * `createdAt` sont des champs internes et ne franchissent pas la frontière.
 */
export type ActivitySummaryDto = {
  id: number;
  name: string;
  sportType: string;
  startedAt: Date;
  distanceM: number;
  movingTimeS: number;
  elevationGainM: number | null;
  avgHrBpm: number | null;
  avgPaceSecPerKm: number | null;
};

export type ActivityDetailDto = ActivitySummaryDto & {
  elapsedTimeS: number;
  maxHrBpm: number | null;
  avgCadenceSpm: number | null;
};

/** Une semaine ISO d'entraînement, telle que l'affiche la page « Activités ». */
export type WeekOfActivities = {
  /** Numéro de semaine ISO, ex. « S32 ». */
  weekLabel: string;
  totalDistanceM: number;
  totalMovingTimeS: number;
  /** Activités de la semaine, de la plus récente à la plus ancienne. */
  activities: ActivitySummaryDto[];
};

export function toActivitySummaryDto(row: Activity): ActivitySummaryDto {
  return {
    id: row.id,
    name: row.name,
    sportType: row.sportType,
    startedAt: row.startedAt,
    distanceM: row.distanceM,
    movingTimeS: row.movingTimeS,
    elevationGainM: row.elevationGainM,
    avgHrBpm: row.avgHrBpm,
    avgPaceSecPerKm: row.avgPaceSecPerKm,
  };
}

export function toActivityDetailDto(row: Activity): ActivityDetailDto {
  return {
    ...toActivitySummaryDto(row),
    elapsedTimeS: row.elapsedTimeS,
    maxHrBpm: row.maxHrBpm,
    avgCadenceSpm: row.avgCadenceSpm,
  };
}

/** Les N activités les plus récentes, de la plus récente à la plus ancienne. */
export async function listRecentActivities(limit = 20): Promise<ActivitySummaryDto[]> {
  const rows = await db
    .select()
    .from(activities)
    .orderBy(desc(activities.startedAt))
    .limit(limit);
  return rows.map(toActivitySummaryDto);
}

/*
 * Découpage en semaines ISO.
 *
 * Ces trois helpers dupliquent la logique privée de `dashboard.ts`
 * (`isoDayIndex`, `isoWeekNumber` et le repère « minuit UTC du jour civil ») :
 * elle n'y est pas exportée, et l'y exposer ferait dépendre le module des
 * activités d'un module d'agrégation qui, lui, importe déjà celui-ci. Les
 * commentaires détaillés (choix du jeudi, semaine 1 ISO) vivent là-bas.
 */

const DAY_MS = 86_400_000;

const civilDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Date civile `YYYY-MM-DD` d'un instant, dans le fuseau de l'athlète. */
function toCivilDate(instant: Date): string {
  return civilDateFormatter.format(instant);
}

/** Minuit UTC de la date civile — repère de calcul, jamais affiché. */
function civilDateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Index du jour dans la semaine ISO : lundi = 0 … dimanche = 6. */
function isoDayIndex(date: string): number {
  return (new Date(civilDateToMs(date)).getUTCDay() + 6) % 7;
}

/** Lundi de la semaine ISO contenant `date` — clé de regroupement. */
function isoWeekStart(date: string): string {
  return new Date(civilDateToMs(date) - isoDayIndex(date) * DAY_MS).toISOString().slice(0, 10);
}

/** Numéro de semaine ISO 8601 (la semaine 1 contient le premier jeudi). */
function isoWeekNumber(date: string): number {
  const thursday = new Date(civilDateToMs(date) + (3 - isoDayIndex(date)) * DAY_MS);
  const january4 = `${thursday.getUTCFullYear()}-01-04`;
  const firstThursday = new Date(civilDateToMs(january4) + (3 - isoDayIndex(january4)) * DAY_MS);
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}

/**
 * Regroupe des activités par semaine ISO et retourne les `limit` semaines les
 * plus récentes **ayant au moins une activité** (les semaines de repos ne
 * produisent pas de groupe vide), de la plus récente à la plus ancienne.
 *
 * Le regroupement se fait sur le lundi de la semaine, pas sur son numéro : deux
 * semaines 1 d'années différentes ne doivent pas fusionner.
 *
 * Fonction pure, exportée pour les tests.
 */
export function groupActivitiesByWeek(
  items: readonly ActivitySummaryDto[],
  limit: number,
): WeekOfActivities[] {
  if (limit <= 0) return [];

  // Tri défensif : le regroupement ne dépend pas de l'ordre de la requête.
  const sorted = [...items].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const weeks = new Map<string, WeekOfActivities>();
  for (const activity of sorted) {
    const day = toCivilDate(activity.startedAt);
    const key = isoWeekStart(day);

    let week = weeks.get(key);
    if (!week) {
      if (weeks.size === limit) continue;
      week = {
        weekLabel: `S${isoWeekNumber(day)}`,
        totalDistanceM: 0,
        totalMovingTimeS: 0,
        activities: [],
      };
      weeks.set(key, week);
    }

    week.totalDistanceM += activity.distanceM;
    week.totalMovingTimeS += activity.movingTimeS;
    week.activities.push(activity);
  }

  // L'insertion suit l'ordre décroissant du tri : les semaines le sont aussi.
  return [...weeks.values()];
}

/**
 * Les `limit` dernières semaines ayant des activités, regroupées.
 *
 * L'historique est lu en entier : les semaines à retenir ne forment pas une
 * plage de dates calculable à l'avance (une semaine sans sortie ne compte pas),
 * et une ligne d'activité est légère — les séries temporelles vivent à part.
 */
export async function listActivitiesByWeek(limit: number): Promise<WeekOfActivities[]> {
  if (limit <= 0) return [];

  const rows = await db.select().from(activities).orderBy(desc(activities.startedAt));
  return groupActivitiesByWeek(rows.map(toActivitySummaryDto), limit);
}

/** Une activité par son id interne. `null` si elle n'existe pas. */
export async function getActivityById(id: number): Promise<ActivityDetailDto | null> {
  const rows = await db.select().from(activities).where(eq(activities.id, id)).limit(1);
  const row = rows[0];
  return row ? toActivityDetailDto(row) : null;
}

/*
 * Écritures de la synchronisation Strava (`src/lib/strava/sync.ts`).
 */

/** Colonnes entières du schéma : Strava renvoie des moyennes flottantes. */
function toIntegerBpm(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/**
 * Insère ou met à jour une activité issue de Strava. Idempotent : `strava_id`
 * est unique, un même identifiant met à jour la ligne existante au lieu de la
 * dupliquer. Retourne l'id local.
 *
 * L'allure moyenne est dérivée ici (et non côté Strava) : elle reste `null` si
 * la distance ou la durée ne permettent pas de la calculer.
 */
export async function upsertActivityFromStrava(
  activity: StravaActivity,
  athleteId: number,
): Promise<number> {
  const values = {
    name: activity.name,
    sportType: activity.sportType,
    startedAt: activity.startedAt,
    distanceM: activity.distanceM,
    movingTimeS: activity.movingTimeS,
    elapsedTimeS: activity.elapsedTimeS,
    elevationGainM: activity.elevationGainM,
    avgHrBpm: toIntegerBpm(activity.avgHrBpm),
    maxHrBpm: toIntegerBpm(activity.maxHrBpm),
    avgPaceSecPerKm: paceSecPerKm(activity.distanceM, activity.movingTimeS),
    avgCadenceSpm: activity.avgCadenceSpm,
  };

  const rows = await db
    .insert(activities)
    .values({ athleteId, stravaId: activity.id, ...values })
    .onConflictDoUpdate({ target: activities.stravaId, set: values })
    .returning({ id: activities.id });

  const row = rows[0];
  if (!row) {
    throw new Error(`Upsert de l'activité Strava ${activity.id} sans ligne retournée.`);
  }
  return row.id;
}

/**
 * Parmi `stravaIds`, ceux déjà présents en base. Permet à la sync de distinguer
 * les activités nouvelles (dont il faut importer les streams) des mises à jour.
 */
export async function findKnownStravaIds(
  stravaIds: readonly number[],
): Promise<ReadonlySet<number>> {
  if (stravaIds.length === 0) return new Set();

  const rows = await db
    .select({ stravaId: activities.stravaId })
    .from(activities)
    .where(inArray(activities.stravaId, [...stravaIds]));

  return new Set(rows.map((row) => row.stravaId));
}

/**
 * Parmi `activityIds`, ceux qui n'ont **aucune** série temporelle en base.
 *
 * C'est ce critère — et non « la ligne d'activité était absente » — qui décide
 * de l'import des streams : une activité écrite lors d'un backfill interrompu par
 * le quota Strava n'a pas ses streams, et doit les récupérer au passage suivant.
 */
export async function findActivityIdsWithoutStreams(
  activityIds: readonly number[],
): Promise<ReadonlySet<number>> {
  if (activityIds.length === 0) return new Set();

  const rows = await db
    .selectDistinct({ activityId: activityStreams.activityId })
    .from(activityStreams)
    .where(inArray(activityStreams.activityId, [...activityIds]));

  const withStreams = new Set(rows.map((row) => row.activityId));
  return new Set(activityIds.filter((id) => !withStreams.has(id)));
}

/**
 * Remplace les séries temporelles d'une activité.
 *
 * Upsert sur `(activity_id, type)` — l'index unique du schéma garantit une seule
 * ligne par type, même si deux imports de la même activité se croisent (le
 * delete + insert d'avant en produisait deux jeux). Les types absents de la
 * nouvelle réponse sont purgés à la fin, pour que la fonction reste un
 * remplacement complet sans jamais laisser l'activité sans streams entre-temps.
 *
 * Le tout dans une transaction : une réimportation ne doit pas laisser un état
 * partiel derrière elle.
 *
 * Les streams vides sont ignorés : une ligne sans point n'apporte rien.
 */
export async function saveActivityStreams(
  activityId: number,
  streams: StravaStreamSet,
): Promise<void> {
  const rows: NewActivityStream[] = [];
  for (const type of ACTIVITY_STREAM_TYPES) {
    const data = streams[type];
    if (!data || data.length === 0) continue;
    rows.push({ activityId, type, data });
  }

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(activityStreams)
        .values(rows)
        .onConflictDoUpdate({
          target: [activityStreams.activityId, activityStreams.type],
          set: { data: sql`excluded.data` },
        });
    }

    const written = rows.map((row) => row.type);
    await tx
      .delete(activityStreams)
      .where(
        written.length === 0
          ? eq(activityStreams.activityId, activityId)
          : and(
              eq(activityStreams.activityId, activityId),
              notInArray(activityStreams.type, written),
            ),
      );
  });
}
