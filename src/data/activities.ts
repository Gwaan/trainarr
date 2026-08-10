import 'server-only';

import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import { APP_TIME_ZONE } from '@/config/time';
import type { FitStreamSet, ParsedFitActivity } from '@/lib/fit/parse';
import { defaultActivityName } from '@/lib/fit/sport';
import { paceSecPerKm } from '@/lib/metrics';

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
 * Déclarés explicitement (pas de `typeof row`) : `fitFileHash`, `athleteId` et
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
 * Écritures de l'import FIT (`src/lib/fit/ingest.ts`).
 */

/** Colonnes entières du schéma : le FIT renvoie des moyennes flottantes. */
function toIntegerBpm(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/**
 * Parmi `activityIds`, ceux qui n'ont **aucune** série temporelle en base.
 *
 * C'est ce critère — et non « la ligne d'activité était absente » — qui décide
 * de l'écriture des séries : une activité insérée par un import dont l'écriture
 * des streams a échoué n'a pas les siennes, et doit les récupérer au redépôt du
 * fichier.
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
 * **Unités** : les séries sont stockées telles quelles, dans les unités du
 * schéma. En particulier la cadence est en **pas par minute** pour les sports à
 * pied (comme la colonne `avg_cadence_spm`), en tours de pédalier par minute
 * pour le vélo : c'est à l'appelant de convertir avant d'écrire — le FIT livre
 * les cycles d'une seule jambe.
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
  streams: FitStreamSet,
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

/** Colonnes nullables qu'un redépôt du même fichier peut venir combler. */
type CompletableColumns = Pick<
  Activity,
  'elevationGainM' | 'avgHrBpm' | 'maxHrBpm' | 'avgPaceSecPerKm' | 'avgCadenceSpm'
>;

/** Résultat d'un import, du point de vue de la ligne d'activité. */
export type FitUpsertResult = {
  activityId: number;
  /** `true` si la ligne n'existait pas et vient d'être insérée. */
  created: boolean;
};

/**
 * Les champs que l'import apporte et qui manquent (`null`) à la ligne existante.
 *
 * On ne **complète** que les trous : une valeur déjà en base n'est jamais
 * écrasée. C'est ce qui rend un redépôt inoffensif — une mesure affinée depuis
 * (ou un nom corrigé à la main) survit — tout en laissant un fichier relu par
 * une version plus complète du parseur remplir ce qui manquait.
 *
 * Fonction pure, exportée pour les tests.
 */
export function completableFields(
  existing: CompletableColumns,
  incoming: CompletableColumns,
): Partial<CompletableColumns> {
  const completion: Partial<CompletableColumns> = {};
  if (existing.elevationGainM === null && incoming.elevationGainM !== null) {
    completion.elevationGainM = incoming.elevationGainM;
  }
  if (existing.avgHrBpm === null && incoming.avgHrBpm !== null) {
    completion.avgHrBpm = incoming.avgHrBpm;
  }
  if (existing.maxHrBpm === null && incoming.maxHrBpm !== null) {
    completion.maxHrBpm = incoming.maxHrBpm;
  }
  if (existing.avgPaceSecPerKm === null && incoming.avgPaceSecPerKm !== null) {
    completion.avgPaceSecPerKm = incoming.avgPaceSecPerKm;
  }
  if (existing.avgCadenceSpm === null && incoming.avgCadenceSpm !== null) {
    completion.avgCadenceSpm = incoming.avgCadenceSpm;
  }
  return completion;
}

/**
 * Colonnes du schéma dérivées d'un FIT parsé.
 *
 * - `avgPaceSecPerKm` est dérivée ici : elle reste `null` si distance ou durée
 *   ne la permettent pas ;
 * - `name` : le format FIT n'a pas de champ « titre » (le parseur ne le renseigne
 *   que si la séance suivait un entraînement structuré). La colonne étant
 *   obligatoire, on retombe sur le libellé français de la discipline — factuel,
 *   que Gwen pourra renommer — plutôt que d'inventer un titre.
 */
function fitColumns(parsed: ParsedFitActivity) {
  return {
    name: parsed.name ?? defaultActivityName(parsed.sportType),
    sportType: parsed.sportType,
    startedAt: parsed.startedAt,
    distanceM: parsed.distanceM,
    movingTimeS: parsed.movingTimeS,
    elapsedTimeS: parsed.elapsedTimeS,
    elevationGainM: parsed.elevationGainM,
    avgHrBpm: toIntegerBpm(parsed.avgHrBpm),
    maxHrBpm: toIntegerBpm(parsed.maxHrBpm),
    avgPaceSecPerKm: paceSecPerKm(parsed.distanceM, parsed.movingTimeS),
    avgCadenceSpm: parsed.avgCadenceSpm,
  };
}

/**
 * `SET col = coalesce(activities.col, excluded.col)` : la même politique que
 * {@link completableFields}, mais exprimée en SQL pour le `ON CONFLICT`.
 *
 * Les colonnes obligatoires (nom, sport, distance, durées) en sont absentes :
 * elles ne sont jamais `null`, donc jamais à compléter — les réécrire ferait
 * perdre un nom corrigé à la main au moindre redépôt du même fichier.
 */
const FIT_HASH_CONFLICT_SET = {
  elevationGainM: sql`coalesce(${activities.elevationGainM}, excluded.elevation_gain_m)`,
  avgHrBpm: sql`coalesce(${activities.avgHrBpm}, excluded.avg_hr_bpm)`,
  maxHrBpm: sql`coalesce(${activities.maxHrBpm}, excluded.max_hr_bpm)`,
  avgPaceSecPerKm: sql`coalesce(${activities.avgPaceSecPerKm}, excluded.avg_pace_sec_per_km)`,
  avgCadenceSpm: sql`coalesce(${activities.avgCadenceSpm}, excluded.avg_cadence_spm)`,
};

/**
 * Insère ou met à jour l'activité décrite par un fichier FIT.
 *
 * Deux chemins, dans cet ordre :
 *
 * 1. **Déjà importée depuis ce même fichier** (`fit_file_hash` connu) → seuls les
 *    trous de la ligne sont comblés (cf. {@link completableFields}) ; rien de ce
 *    qui est déjà renseigné n'est écrasé.
 * 2. Sinon → insertion. Le `ON CONFLICT (fit_file_hash)` couvre la course entre
 *    deux imports simultanés du même fichier, avec la même politique qu'en 1 :
 *    c'est la contrainte unique, et non la lecture préalable, qui porte
 *    l'idempotence.
 */
export async function upsertActivityFromFit(
  parsed: ParsedFitActivity,
  athleteId: number,
): Promise<FitUpsertResult> {
  const values = fitColumns(parsed);

  const sameFile = await db
    .select()
    .from(activities)
    .where(eq(activities.fitFileHash, parsed.fileHash))
    .limit(1);

  const existing = sameFile[0];
  if (existing) {
    const completion = completableFields(existing, values);
    if (Object.keys(completion).length > 0) {
      await db.update(activities).set(completion).where(eq(activities.id, existing.id));
    }

    return { activityId: existing.id, created: false };
  }

  const rows = await db
    .insert(activities)
    .values({ athleteId, fitFileHash: parsed.fileHash, ...values })
    .onConflictDoUpdate({ target: activities.fitFileHash, set: FIT_HASH_CONFLICT_SET })
    .returning({ id: activities.id });

  const row = rows[0];
  if (!row) {
    throw new Error(`Upsert de l'activité FIT ${parsed.fileHash} sans ligne retournée.`);
  }
  return { activityId: row.id, created: true };
}
