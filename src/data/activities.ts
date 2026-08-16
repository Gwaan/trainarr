import 'server-only';

import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  isNotNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import { APP_TIME_ZONE } from '@/config/time';
import { isoWeekNumber, isoWeekStart, toCivilDate } from '@/lib/dates/civil';
import type { FitStreamSet, ParsedFitActivity } from '@/lib/fit/parse';
import { defaultActivityName, usesFootCadenceSportType } from '@/lib/fit/sport';
import {
  computeBestSegments,
  computeDecoupling,
  computeHrZones,
  computeSplits,
  computeTrimp,
  deriveVelocity,
  estimateEffectiveVo2max,
  hrDistribution,
  hrZoneAnchor,
  type HrZoneAnchor,
  paceDistribution,
  paceSecPerKm,
  resamplePoints,
  sessionExecution,
  smoothPace,
  strideSeries,
  type BestSegment,
  type Decoupling,
  type DistributionBin,
  type SeriesSample,
  type SessionExecution,
  type Sex,
} from '@/lib/metrics';

import { getAthleteProfileById, getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import { uniqueViolationConstraint } from './db/errors';
import {
  ACTIVITIES_SESSION_UNIQUE_INDEX,
  ACTIVITY_STREAM_TYPES,
  activities,
  activityStreams,
  plannedSessions,
  type Activity,
  type ActivityStream,
  type ActivityStreamType,
  type NewActivityStream,
} from './db/schema';
import { isRunning } from './training-metrics';

/**
 * Activités — lectures d'écran et écritures de l'import FIT.
 *
 * **Toute lecture est cloisonnée par athlète**, et de deux façons seulement :
 *
 * - les lectures de **requête** (historique, détail d'une séance) résolvent
 *   l'athlète depuis la session ({@link getCurrentAthleteId}) et ne rendent rien
 *   quand il n'y en a pas ;
 * - les écritures de l'**ingestion** tournent hors requête (watcher, poller) :
 *   elles reçoivent l'athlète en paramètre, comme `ingestFitBuffer` lui-même.
 *
 * Un identifiant d'activité venu du client (segment `[id]` d'URL, argument
 * d'action) n'est jamais une preuve d'appartenance : chaque fonction qui en
 * reçoit un le confronte à l'athlète avant de lire ou d'écrire, et une activité
 * qui n'est pas la sienne se comporte exactement comme une activité inexistante
 * (`null`, ou {@link ActivityNotFoundError} à l'écriture) — les distinguer
 * révélerait l'existence de la ligne.
 */

/**
 * L'activité visée n'existe pas ou n'appartient pas à l'athlète.
 *
 * Les deux cas partagent la même erreur : volontairement indistincte,
 * anti-IDOR. Réexportée par `./activity-feedback`, où elle vivait, pour tous ses
 * appelants historiques.
 */
export class ActivityNotFoundError extends Error {
  constructor() {
    super('Aucune activité ne correspond à cet identifiant.');
    this.name = 'ActivityNotFoundError';
  }
}

/**
 * `true` si l'activité existe **et** appartient à l'athlète donné.
 *
 * Le filtre porte les deux critères dans la **même** clause : une lecture par
 * `id` suivie d'une comparaison en mémoire aurait ramené la ligne d'autrui dans
 * le process avant de la refuser.
 */
async function ownsActivity(activityId: number, athleteId: number): Promise<boolean> {
  const rows = await db
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, athleteId)))
    .limit(1);

  return rows.length > 0;
}

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
  /**
   * Lundi de la semaine, date civile `YYYY-MM-DD`.
   *
   * C'est la **vraie** identité de la semaine : deux « S1 » d'années
   * différentes portent le même libellé, jamais le même lundi. Elle sert de clé
   * de rendu et de repère de position dans l'historique.
   */
  startsOn: string;
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

/**
 * Les N activités les plus récentes **de l'athlète connecté**, de la plus
 * récente à la plus ancienne. Liste vide s'il n'y a pas de session, ou pas
 * encore d'athlète.
 */
export async function listRecentActivities(limit = 20): Promise<ActivitySummaryDto[]> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return [];

  const rows = await db
    .select()
    .from(activities)
    .where(eq(activities.athleteId, athleteId))
    .orderBy(desc(activities.startedAt))
    .limit(limit);
  return rows.map(toActivitySummaryDto);
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
        startsOn: key,
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
 * Bornes de la pagination de l'historique.
 *
 * Les deux existent pour la même raison : `limit` et `offset` viennent d'une
 * URL. Sans plafond, `?page=99999999` ferait balayer à Postgres un OFFSET
 * arbitraire pour ne rien rendre. Les valeurs hors bornes sont **ramenées**
 * dans la plage, jamais rejetées : une URL trafiquée doit donner un écran
 * banal, pas une erreur.
 */
export const ACTIVITY_WEEK_PAGE_LIMITS = {
  /** Au-delà, une page ne se lit plus d'un seul coup d'œil. */
  maxWeeksPerPage: 26,
  /** Environ trente ans d'historique : très au-delà de toute carrière. */
  maxOffset: 1_600,
} as const;

/** Une page de semaines, et de quoi savoir où l'on est dans l'historique. */
export type ActivityWeekPage = {
  /** Les semaines de la page, de la plus récente à la plus ancienne. */
  weeks: WeekOfActivities[];
  /** Rang de la première semaine affichée — 0 = la semaine la plus récente. */
  offset: number;
  /**
   * `true` s'il reste au moins une semaine **plus ancienne** au-delà de cette
   * page. Répondu par une semaine lue en trop (`limit + 1`), jamais par un
   * comptage de l'historique : la question est « y a-t-il une suite ? », pas
   * « combien de pages ? ».
   */
  hasOlder: boolean;
};

/** Ramène une valeur d'URL dans une plage d'entiers. Le non-fini retombe sur `min`. */
function boundInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Le lundi de la semaine ISO d'une activité, en date civile `YYYY-MM-DD`,
 * calculé **par Postgres**.
 *
 * `date_trunc('week', …)` tronque au lundi (ISO 8601), et `AT TIME ZONE` le
 * fait dans le fuseau de l'athlète : c'est exactement la règle de
 * `isoWeekStart(toCivilDate(…))`, dont dépend le regroupement en mémoire. Les
 * deux doivent rester d'accord — une sortie du dimanche 23 h tombe sinon dans
 * une semaine côté SQL et dans une autre côté JS.
 *
 * `to_char` plutôt qu'un `::date` : le pilote rendrait une `Date` JS à minuit
 * *local du serveur*, alors qu'on veut une date civile, comparable et
 * transportable telle quelle. Le fuseau est un paramètre lié (`$n::text`), pas
 * une chaîne concaténée.
 */
const weekStartExpr = sql`to_char(date_trunc('week', ${activities.startedAt} at time zone ${APP_TIME_ZONE}::text), 'YYYY-MM-DD')`;

/**
 * Une page de l'historique hebdomadaire de l'athlète connecté.
 *
 * Deux requêtes, toutes deux bornées :
 *
 * 1. les lundis des semaines qui portent au moins une activité, agrégés par
 *    Postgres et paginés (`LIMIT limit + 1 OFFSET offset`) — une ligne par
 *    semaine, jamais l'historique entier ;
 * 2. les activités de la fenêtre ainsi délimitée, regroupées en mémoire.
 *
 * Les semaines de repos ne comptent pas : la pagination porte sur les semaines
 * **ayant couru**, ce qui rend chaque page pleine et interdit de calculer la
 * fenêtre par un simple décalage de dates.
 *
 * Page vide (`weeks: []`) quand il n'y a pas de session, pas encore d'athlète,
 * ou que le rang demandé dépasse l'historique.
 */
export async function listActivityWeekPage(input: {
  limit: number;
  offset: number;
}): Promise<ActivityWeekPage> {
  const limit = boundInteger(input.limit, 1, ACTIVITY_WEEK_PAGE_LIMITS.maxWeeksPerPage);
  const offset = boundInteger(input.offset, 0, ACTIVITY_WEEK_PAGE_LIMITS.maxOffset);

  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return { weeks: [], offset, hasOlder: false };

  const weekRows = await db
    .select({ weekStart: weekStartExpr })
    .from(activities)
    .where(eq(activities.athleteId, athleteId))
    // `1` désigne la première colonne du SELECT : répéter l'expression ici
    // lierait deux fois de plus le paramètre de fuseau, pour le même résultat.
    .groupBy(sql`1`)
    .orderBy(sql`1 desc`)
    .limit(limit + 1)
    .offset(offset);

  // Le contenu d'une colonne calculée n'est pas garanti par le typage : on
  // vérifie sa forme au lieu de l'affirmer.
  const starts: string[] = [];
  for (const row of weekRows) {
    if (typeof row.weekStart === 'string') starts.push(row.weekStart);
  }

  const hasOlder = starts.length > limit;
  const page = starts.slice(0, limit);
  const newest = page[0];
  const oldest = page[page.length - 1];
  if (newest === undefined || oldest === undefined) {
    return { weeks: [], offset, hasOlder: false };
  }

  // Fenêtre fermée sur la **même** expression que la pagination : les bornes
  // sont des lundis rendus par Postgres, comparés à des lundis calculés par
  // Postgres. Les dates ISO se comparent dans l'ordre chronologique.
  const rows = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        gte(weekStartExpr, oldest),
        lte(weekStartExpr, newest),
      ),
    )
    .orderBy(desc(activities.startedAt));

  return {
    weeks: groupActivitiesByWeek(rows.map(toActivitySummaryDto), page.length),
    offset,
    hasOlder,
  };
}

/**
 * Une activité de l'athlète connecté, par son id interne.
 *
 * `null` si elle n'existe pas **ou** si elle n'est pas la sienne : l'id vient
 * du client, et les deux cas doivent être indistinguables.
 */
export async function getActivityById(id: number): Promise<ActivityDetailDto | null> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return null;

  const rows = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, id), eq(activities.athleteId, athleteId)))
    .limit(1);
  const row = rows[0];
  return row ? toActivityDetailDto(row) : null;
}

/*
 * Détail complet d'une activité : ce que la page de séance affiche.
 *
 * Chaque bloc est indépendamment nullable — même principe que le dashboard. Une
 * séance sans GPS garde ses splits et ses zones, une séance sans ceinture garde
 * sa trace et son profil altimétrique : rien n'est estimé pour combler un trou.
 */

export type ActivityChartsDto = {
  /** Points rééchantillonnés (~600 max) pour les graphes, alignés entre séries. */
  points: Array<{
    /** Secondes depuis le départ. */
    timeS: number;
    /** Mètres depuis le départ, null si pas de stream distance. */
    distanceM: number | null;
    /** Allure lissée en s/km, null si vitesse inexploitable à ce point. */
    paceSecPerKm: number | null;
    hrBpm: number | null;
    altitudeM: number | null;
    cadenceSpm: number | null;
    /** Longueur de foulée en mètres, null si vitesse ou cadence manque ici. */
    strideM: number | null;
  }>;
  /**
   * Trace GPS complète (pas rééchantillonnée), `null` si absente.
   *
   * **Compactée** : les points où le GPS n'a rien mesuré sont retirés, alors que
   * le stream stocké les porte en `null` pour rester aligné sur l'axe des temps.
   * Une polyligne n'a pas de notion de « pas de position ici » — elle relie deux
   * fix consécutifs, ce qui est exactement le tracé attendu — et aucun affichage
   * ne corrèle aujourd'hui la carte à l'index temporel.
   */
  latlng: Array<[number, number]> | null;
};

export type ActivitySplitDto = {
  /** Numéro du km, 1-indexé ; le dernier peut être partiel. */
  km: number;
  /** 1000, sauf pour le dernier split s'il est partiel. */
  distanceM: number;
  timeS: number;
  paceSecPerKm: number;
  avgHrBpm: number | null;
  elevationGainM: number | null;
};

export type HrZoneDto = {
  zone: 1 | 2 | 3 | 4 | 5;
  timeS: number;
  /** Part de la durée totale, dans [0, 1]. */
  share: number;
};

export type ActivityFullDto = {
  detail: ActivityDetailDto;
  /** `null` si l'activité n'a aucune série temporelle exploitable. */
  charts: ActivityChartsDto | null;
  /** Vide si l'activité n'a pas de stream de distance. */
  splits: ActivitySplitDto[];
  /** `null` sans stream de FC ou sans référence cardiaque au profil. */
  hrZones: HrZoneDto[] | null;
  /**
   * La référence **du profil athlète** sur laquelle les zones sont ancrées —
   * FC seuil si l'athlète en a adopté une, FC max sinon —, distincte de
   * `detail.maxHrBpm` (le maximum atteint pendant cette séance). C'est elle qui
   * découpe les zones : l'affichage en a besoin pour colorer une tranche
   * d'histogramme dans la rampe des zones et pour dire sur quoi elles sont
   * calées, et il n'a pas d'autre chemin vers le profil.
   */
  hrAnchor: HrZoneAnchor | null;
  /** Temps par tranche d'allure. `null` sans vitesse mesurée ni dérivable. */
  paceDistribution: DistributionBin[] | null;
  /** Temps par tranche de FC. `null` sans stream de FC. */
  hrDistribution: DistributionBin[] | null;
  /** Dérive cardiaque. `null` sous 20 min ou si un capteur couvre mal une moitié. */
  decoupling: Decoupling | null;
  /** Meilleurs efforts sur les distances de référence — course à pied uniquement. */
  bestSegments: BestSegment[];
  /**
   * Ce que la séance du plan prescrivait, confronté à ce qui a été couru —
   * `null` quand l'activité ne réalise aucune séance planifiée, ou que la
   * séance ne prescrit rien de comparable.
   *
   * Calculé à la lecture comme les zones : rien n'est stocké, et corriger sa FC
   * max ou adopter une FC seuil relit toute la comparaison dans le nouveau
   * cadre.
   */
  sessionExecution: SessionExecution | null;
  trimp: number | null;
  /**
   * Le référentiel de charge de l'athlète, pour situer le TRIMP de cette séance
   * parmi les siennes. `null` sous {@link TRIMP_CONTEXT_MIN_SESSIONS} séances
   * exploitables — on n'invente pas une échelle sur trois points.
   */
  trimpContext: TrimpContextDto | null;
  /** Course à pied uniquement. */
  effectiveVo2max: number | null;
};

/*
 * Référentiel de charge — « ce TRIMP, c'est beaucoup ou peu, pour moi ? »
 *
 * Un TRIMP nu ne dit rien : 120 est une grosse séance pour l'une, une sortie
 * ordinaire pour l'autre. La réponse ne peut venir que de l'historique récent de
 * **cet** athlète, jamais d'une échelle universelle.
 */

/** Quartiles du TRIMP des séances récentes, et l'effectif qui les fonde. */
export type TrimpContextDto = {
  p25: number;
  p50: number;
  p75: number;
  /** Séance la plus chargée de la fenêtre — la borne haute de l'échelle. */
  max: number;
  /** Nombre de séances portant un TRIMP dans la fenêtre. */
  sampleSize: number;
};

/**
 * Fenêtre du référentiel : trois mois glissants, assez pour couvrir un bloc
 * d'entraînement complet (du volume au spécifique) sans traîner la forme d'une
 * saison précédente.
 */
export const TRIMP_CONTEXT_DAYS = 90;

/**
 * Plancher d'effectif : sous cinq séances, des « quartiles » ne décrivent que
 * les quelques points qui les portent. Mieux vaut le chiffre nu qu'une échelle
 * qui prétend situer.
 */
export const TRIMP_CONTEXT_MIN_SESSIONS = 5;

/** Ce qu'une séance doit porter pour entrer dans le référentiel. */
type TrimpSession = { movingTimeS: number; avgHrBpm: number | null };

/** Ce que le profil doit porter pour qu'un TRIMP soit calculable. */
type TrimpProfile = {
  sex: Sex | null;
  restingHrBpm: number | null;
  maxHrBpm: number | null;
};

/**
 * Quantile à interpolation linéaire — la définition de `percentile_cont` de
 * Postgres, et celle qu'attend une échelle continue : entre deux séances, la
 * borne se pose entre leurs deux charges plutôt que sur l'une d'elles.
 *
 * `sorted` est croissante et non vide (garanti par l'appelant).
 */
function quantile(sorted: readonly number[], fraction: number): number {
  const rank = (sorted.length - 1) * fraction;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/**
 * Quartiles du TRIMP des séances données, ou `null` s'il y en a trop peu.
 *
 * Le TRIMP est **recalculé** ici (il n'est pas stocké : il dépend du profil, et
 * corriger sa FC max doit relire tout l'historique dans le nouveau cadre). Les
 * séances dont il n'est pas calculable — pas de FC moyenne, profil incomplet —
 * ne comptent pas, et une charge nulle non plus : une FC moyenne sous la FC de
 * repos est une aberration de mesure, pas une séance sans effort.
 *
 * Fonction pure, exportée pour les tests.
 */
export function trimpContextOf(
  sessions: readonly TrimpSession[],
  profile: TrimpProfile,
): TrimpContextDto | null {
  if (profile.sex === null) return null;

  const values: number[] = [];
  for (const session of sessions) {
    const trimp = computeTrimp({
      movingTimeS: session.movingTimeS,
      avgHrBpm: session.avgHrBpm,
      restingHrBpm: profile.restingHrBpm,
      maxHrBpm: profile.maxHrBpm,
      sex: profile.sex,
    });
    if (trimp !== null && trimp > 0) values.push(trimp);
  }

  if (values.length < TRIMP_CONTEXT_MIN_SESSIONS) return null;

  values.sort((a, b) => a - b);
  return {
    p25: quantile(values, 0.25),
    p50: quantile(values, 0.5),
    p75: quantile(values, 0.75),
    max: values[values.length - 1],
    sampleSize: values.length,
  };
}

/**
 * Streams scalaires d'une activité, indexés par type.
 *
 * `null` par point = le capteur n'a rien mesuré à cet instant (échantillonnage
 * clairsemé, cf. `ActivityStreamData`). Les index restent alignés entre séries.
 */
type NumericStreams = Partial<Record<Exclude<ActivityStreamType, 'latlng'>, (number | null)[]>>;

/*
 * Le contenu des colonnes JSONB est typé côté schéma (`$type<ActivityStreamData>`)
 * mais rien ne le garantit à la lecture : Postgres rend ce qui y a été écrit,
 * éventuellement par une version antérieure du code. On vérifie donc la forme au
 * lieu de l'affirmer par une assertion de type.
 */

function isNumberSeries(data: readonly unknown[]): data is (number | null)[] {
  return data.every((value) => value === null || typeof value === 'number');
}

function isLatLngSeries(data: readonly unknown[]): data is Array<[number, number] | null> {
  return data.every(
    (value) =>
      value === null ||
      (Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === 'number' &&
        typeof value[1] === 'number'),
  );
}

/** Range les lignes de `activity_streams` par type. Les séries vides sont ignorées. */
function collectStreams(rows: readonly ActivityStream[]): {
  numeric: NumericStreams;
  latlng: Array<[number, number] | null> | null;
} {
  const numeric: NumericStreams = {};
  let latlng: Array<[number, number] | null> | null = null;

  for (const row of rows) {
    const { data } = row;
    if (data.length === 0) continue;

    if (row.type === 'latlng') {
      if (isLatLngSeries(data)) latlng = data;
      continue;
    }
    if (isNumberSeries(data)) numeric[row.type] = data;
  }

  return { numeric, latlng };
}

/**
 * Axe des temps, ou `null` s'il est inexploitable.
 *
 * C'est le seul canal qui ne tolère **aucun** trou : tous les autres se lisent
 * par rapport à lui, et une durée d'échantillon ne se calcule pas autour d'un
 * instant inconnu. Le parseur FIT le garantit dense (il ne retient que les
 * `record` horodatés) ; on le vérifie quand même, la base pouvant contenir ce
 * qu'y a écrit une version antérieure du code.
 */
function denseTimeAxis(time: (number | null)[] | undefined): number[] | null {
  if (time === undefined) return null;

  const axis: number[] = [];
  for (const instant of time) {
    if (instant === null || !Number.isFinite(instant)) return null;
    axis.push(instant);
  }
  return axis.length > 0 ? axis : null;
}

/**
 * Nombre de points exploitables en commun.
 *
 * Le parseur FIT écrit des streams de longueur identique (tous alignés sur
 * l'axe `time`, `null` compris) ; on retient malgré tout la plus courte, parce
 * qu'un désalignement d'index attribuerait la FC d'un instant à un autre — une
 * donnée fausse est pire qu'une donnée tronquée.
 */
function alignedLength(numeric: NumericStreams): number {
  let shortest = Number.POSITIVE_INFINITY;
  for (const type of ACTIVITY_STREAM_TYPES) {
    if (type === 'latlng') continue;
    const stream = numeric[type];
    if (stream !== undefined) shortest = Math.min(shortest, stream.length);
  }
  return Number.isFinite(shortest) ? shortest : 0;
}

/** Première valeur mesurée d'un canal clairsemé, `null` s'il n'en a aucune. */
function firstMeasured(values: readonly (number | null)[]): number | null {
  for (const value of values) {
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Vitesse instantanée de la séance, en m/s, alignée sur l'axe des temps.
 *
 * Le canal `velocity` du fichier prime toujours : c'est une mesure. Quand il est
 * absent (cas des Apple Watch, qui n'écrivent pas `speed` dans leurs `record`)
 * mais que `distance` est là, la vitesse est calculée par `deriveVelocity`.
 * C'est une division entre deux mesures réelles, pas une estimation — et elle
 * vaut pour tout l'historique déjà en base, puisqu'elle se fait à la lecture.
 * Le stream stocké, lui, reste ce que le fichier contenait.
 *
 * `undefined` quand la séance ne porte ni vitesse ni distance : rien à dériver.
 *
 * Calculée **une fois** par lecture et partagée : l'allure des graphes, la
 * foulée, la distribution d'allure et la dérive cardiaque lisent toutes cette
 * série-là.
 */
function activitySpeeds(
  numeric: NumericStreams,
  time: number[] | null,
): (number | null)[] | undefined {
  const { velocity, distance } = numeric;
  if (velocity !== undefined) return velocity;
  if (distance === undefined || time === null) return undefined;
  return deriveVelocity(distance, time);
}

/**
 * Séries prêtes pour les graphes.
 *
 * L'axe des temps (`time`) est la colonne vertébrale : sans lui, aucun point
 * n'est plaçable. La trace GPS, elle, est renvoyée entière — une carte a besoin
 * de tous ses points pour ne pas couper les virages, et une paire de flottants
 * pèse bien moins qu'un point de graphe.
 *
 * La vitesse arrive de {@link activitySpeeds} : allure, foulée et distributions
 * doivent lire exactement la même série, sans quoi deux blocs de la page
 * décriraient la même séance différemment.
 */
function buildCharts(
  numeric: NumericStreams,
  time: number[] | null,
  sparseLatlng: Array<[number, number] | null> | null,
  speeds: (number | null)[] | undefined,
  footCadence: boolean,
): ActivityChartsDto | null {
  const { distance, heartrate, altitude, cadence } = numeric;
  const count = time === null ? 0 : alignedLength(numeric);

  const path = sparseLatlng?.filter((fix): fix is [number, number] => fix !== null) ?? null;
  const latlng = path === null || path.length === 0 ? null : path;

  if (time === null || count === 0) {
    return latlng === null ? null : { points: [], latlng };
  }

  const paces = speeds === undefined ? null : smoothPace(speeds, time);

  // Foulée : vitesse ÷ cadence, sur la **même** vitesse que l'allure. Ni l'une
  // ni l'autre n'est reportée sur un point où son capteur s'est tu.
  //
  // Sports à pied uniquement : ailleurs, `cadence` compte des tours de pédalier
  // (le parseur ne double que la cadence des sports à pied, cf. `usesFootCadence`)
  // et le quotient donnerait un développement — 5,65 m à vélo — affiché comme
  // une foulée. Une grandeur juste sous un mauvais nom reste une donnée fausse.
  const strides =
    !footCadence || speeds === undefined || cadence === undefined
      ? null
      : strideSeries(speeds, cadence);

  // Le cumul de distance du FIT ne repart pas de zéro : la page affiche des
  // mètres depuis le départ de la trace, donc depuis sa première mesure.
  const startDistance = distance === undefined ? 0 : (firstMeasured(distance) ?? 0);

  const samples: SeriesSample[] = new Array<SeriesSample>(count);
  for (let index = 0; index < count; index += 1) {
    const mark = distance === undefined ? null : distance[index];
    samples[index] = {
      timeS: time[index],
      distanceM: mark === null ? null : mark - startDistance,
      paceSecPerKm: paces === null ? null : paces[index],
      hrBpm: heartrate === undefined ? null : heartrate[index],
      altitudeM: altitude === undefined ? null : altitude[index],
      cadenceSpm: cadence === undefined ? null : cadence[index],
      strideM: strides === null ? null : strides[index],
    };
  }

  return { points: resamplePoints(samples), latlng };
}

/**
 * Tout ce que la page de détail d'une activité affiche, en une lecture.
 *
 * `null` si l'activité n'existe pas **ou** si elle n'est pas celle de l'athlète
 * connecté — l'id vient de l'URL, les deux cas sont indistinguables. Sinon,
 * chaque bloc se dégrade seul : pas de streams → `charts` à `null` mais le
 * détail et le TRIMP restent ; pas de FC max au profil → pas de zones, mais les
 * splits sont là.
 *
 * `activity_streams` n'a pas d'`athlete_id` : son cloisonnement passe par sa
 * table parente, et la jointure le **vérifie** au lieu de le supposer — les
 * séries d'autrui ne sont pas lues puis écartées, elles ne sont jamais lues.
 *
 * Distributions, dérive cardiaque et meilleurs segments se calculent **ici**, sur
 * les streams entiers : les points des graphes sont décimés (600 au plus), et un
 * histogramme de temps bâti dessus compterait le temps de la décimation, pas
 * celui de la séance.
 */
export async function getActivityFull(id: number): Promise<ActivityFullDto | null> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return null;

  // Fenêtre du référentiel de charge. Décalage en millisecondes plutôt qu'en
  // jours civils : 90 jours de recul n'ont pas de bord à la minute près, et
  // aucune frontière de fuseau n'a d'incidence sur des quartiles.
  const contextSince = new Date(Date.now() - TRIMP_CONTEXT_DAYS * 24 * 60 * 60 * 1000);

  const [activityRows, streamRows, profile, plannedRows, contextRows] = await Promise.all([
    db
      .select()
      .from(activities)
      .where(and(eq(activities.id, id), eq(activities.athleteId, athleteId)))
      .limit(1),
    db
      .select(getTableColumns(activityStreams))
      .from(activityStreams)
      .innerJoin(
        activities,
        and(eq(activities.id, activityStreams.activityId), eq(activities.athleteId, athleteId)),
      )
      .where(eq(activityStreams.activityId, id)),
    getAthleteProfileById(athleteId),
    // La séance du plan que cette activité réalise, s'il y en a une. Les
    // colonnes strictement nécessaires à la comparaison : le déroulé et ce qui
    // en tient lieu sur les séances historiques.
    db
      .select({
        steps: plannedSessions.steps,
        targetPaceSecPerKm: plannedSessions.targetPaceSecPerKm,
        volumeM: plannedSessions.volumeM,
        durationS: plannedSessions.durationS,
      })
      .from(plannedSessions)
      .where(
        and(
          eq(plannedSessions.completedActivityId, id),
          eq(plannedSessions.athleteId, athleteId),
        ),
      )
      .limit(1),
    // Le référentiel de charge : les séances de la fenêtre qui portent une FC
    // moyenne — les seules dont un TRIMP se calcule. Deux colonnes, et la
    // fenêtre borne le volume : jamais l'historique entier en mémoire.
    //
    // La séance lue en fait partie **quelle que soit sa date** : relire une
    // vieille sortie ne doit pas la comparer à un référentiel dont elle est
    // exclue.
    db
      .select({ movingTimeS: activities.movingTimeS, avgHrBpm: activities.avgHrBpm })
      .from(activities)
      .where(
        and(
          eq(activities.athleteId, athleteId),
          isNotNull(activities.avgHrBpm),
          or(gte(activities.startedAt, contextSince), eq(activities.id, id)),
        ),
      ),
  ]);

  const row = activityRows[0];
  if (!row) return null;

  const { numeric, latlng } = collectStreams(streamRows);
  const { distance, heartrate, altitude } = numeric;
  const time = denseTimeAxis(numeric.time);
  const maxHrBpm = profile?.maxHrBpm ?? null;
  // L'ancrage des zones : la FC seuil si l'athlète en a adopté une, la FC max
  // sinon. La décision se prend **une fois**, ici, et voyage jusqu'à l'écran —
  // deux valeurs traînées côte à côte auraient laissé chaque affichage
  // redécider laquelle l'emporte.
  const anchor = hrZoneAnchor(maxHrBpm, profile?.lthrBpm ?? null);
  const speeds = activitySpeeds(numeric, time);

  // Deux questions distinctes, et deux prédicats distincts : « est-ce de la
  // course ? » (les lectures d'allure) et « la cadence compte-t-elle des pas ? »
  // (la foulée, vraie aussi en marche et en randonnée).
  const running = isRunning(row.sportType);
  const footCadence = usesFootCadenceSportType(row.sportType);

  const splits =
    time !== null && distance !== undefined
      ? computeSplits(distance, time, heartrate, altitude)
      : [];

  const hrZones =
    time !== null && heartrate !== undefined && anchor !== null
      ? computeHrZones(heartrate, time, anchor)
      : [];

  const trimp =
    profile !== null && profile.sex !== null
      ? computeTrimp({
          movingTimeS: row.movingTimeS,
          avgHrBpm: row.avgHrBpm,
          restingHrBpm: profile.restingHrBpm,
          maxHrBpm,
          sex: profile.sex,
        })
      : null;

  // Le référentiel n'existe que si le TRIMP de la séance existe : une jauge sans
  // valeur à situer n'a rien à montrer.
  const trimpContext =
    trimp === null || profile === null ? null : trimpContextOf(contextRows, profile);

  const effectiveVo2max = running
    ? estimateEffectiveVo2max({
        distanceM: row.distanceM,
        movingTimeS: row.movingTimeS,
        avgHrBpm: row.avgHrBpm,
        maxHrBpm,
      })
    : null;

  // Course à pied seulement : l'axe d'allure de `paceDistribution` est borné à
  // 3:00–12:00/km, des bornes de coureur. Une sortie vélo à 8 m/s tomberait tout
  // entière dans le bin de bord « < 3:00 » — un histogramme d'une seule barre,
  // qui n'apprendrait rien et prétendrait pourtant décrire la séance.
  const paceBins =
    running && time !== null && speeds !== undefined
      ? paceDistribution(speeds, time)
      : null;

  // La FC, elle, ne présume d'aucun sport : c'est la même mesure partout.
  const hrBins = time !== null && heartrate !== undefined ? hrDistribution(heartrate, time) : null;

  // Course à pied seulement : la méthode Pa:Hr de Friel compare des allures, et
  // le panneau affiche une ligne « Allure » — à vélo elle annoncerait 2:05/km.
  const decoupling =
    running && time !== null && speeds !== undefined && heartrate !== undefined
      ? computeDecoupling(speeds, heartrate, time)
      : null;

  // Un « record » à l'allure n'a pas de sens à vélo : les meilleurs efforts sont
  // une lecture de course à pied, comme la VO₂max effective au-dessus.
  const bestSegments =
    running && time !== null && distance !== undefined
      ? computeBestSegments(distance, time)
      : [];

  /*
   * La comparaison aux objectifs de la séance planifiée.
   *
   * Course à pied seulement, comme les lectures d'allure ci-dessus : une cible
   * en s/km n'a pas de sens sur un vélo, et le rapprochement au plan est de
   * toute façon celui d'une séance de course.
   */
  const planned = plannedRows[0];
  const execution =
    running && planned !== undefined
      ? sessionExecution({
          steps: planned.steps,
          targetPaceSecPerKm: planned.targetPaceSecPerKm,
          volumeM: planned.volumeM,
          durationS: planned.durationS,
          hrAnchor: anchor,
          actual: {
            distanceM: row.distanceM,
            movingTimeS: row.movingTimeS,
            avgPaceSecPerKm: row.avgPaceSecPerKm,
            avgHrBpm: row.avgHrBpm,
          },
          streams: time !== null && distance !== undefined ? { distance, time } : null,
        })
      : null;

  return {
    detail: toActivityDetailDto(row),
    charts: buildCharts(numeric, time, latlng, speeds, footCadence),
    splits,
    hrZones: hrZones.length > 0 ? hrZones : null,
    hrAnchor: anchor,
    paceDistribution: paceBins,
    hrDistribution: hrBins,
    decoupling,
    bestSegments,
    sessionExecution: execution,
    trimp,
    trimpContext,
    effectiveVo2max,
  };
}

/*
 * Écritures de l'import FIT (`src/lib/fit/ingest.ts`).
 */

/** Colonnes entières du schéma : le FIT renvoie des moyennes flottantes. */
function toIntegerBpm(value: number | null): number | null {
  return value === null ? null : Math.round(value);
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
 * **Remplacement, pas complétion.** Contrairement aux colonnes de `activities`
 * (qui ne se complètent que sur leurs trous, cf. {@link completableFields}), les
 * séries sont intégralement réécrites à chaque appel : elles ne sont pas
 * éditables à la main, leur seule source est le fichier, et c'est ce qui permet
 * à une correction du parseur de réparer un import passé au simple redépôt du
 * fichier.
 *
 * Les streams vides sont ignorés : une ligne sans point n'apporte rien.
 *
 * **L'athlète est un paramètre**, comme pour l'ingestion qui l'appelle : elle
 * tourne dans le watcher, hors requête, il n'y a pas de session à interroger.
 * L'appartenance est vérifiée dans la transaction, avant toute écriture —
 * `activity_streams` n'ayant pas d'`athlete_id`, c'est la table parente qui la
 * porte.
 *
 * @throws {ActivityNotFoundError} si l'activité n'est pas celle de l'athlète
 * (ou n'existe pas : les deux cas ne se distinguent pas).
 */
export async function saveActivityStreams(
  activityId: number,
  athleteId: number,
  streams: FitStreamSet,
): Promise<void> {
  const rows: NewActivityStream[] = [];
  for (const type of ACTIVITY_STREAM_TYPES) {
    const data = streams[type];
    if (!data || data.length === 0) continue;
    rows.push({ activityId, type, data });
  }

  if (!(await ownsActivity(activityId, athleteId))) throw new ActivityNotFoundError();

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

/**
 * `true` si l'activité **de cet athlète** porte au moins une série temporelle.
 *
 * Sert la politique de streams de l'ingestion (`src/lib/fit/ingest.ts`) : un
 * fichier rapproché **par séance** (autre source, autres octets) ne réécrit les
 * séries que si l'activité n'en a aucune. Un doublon amont n'est pas une
 * meilleure version du même entraînement — il n'a donc aucun titre à écraser des
 * séries saines, alors que le redépôt du fichier d'origine, lui, doit toujours
 * les rafraîchir.
 *
 * `false` pour une activité qui n'est pas la sienne, exactement comme pour une
 * activité inexistante : la jointure sur la table parente porte le
 * cloisonnement que `activity_streams` ne peut pas porter seule.
 */
export async function hasActivityStreams(
  activityId: number,
  athleteId: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: activityStreams.id })
    .from(activityStreams)
    .innerJoin(
      activities,
      and(eq(activities.id, activityStreams.activityId), eq(activities.athleteId, athleteId)),
    )
    .where(eq(activityStreams.activityId, activityId))
    .limit(1);
  return rows.length > 0;
}

/** Colonnes nullables qu'un redépôt du même fichier peut venir combler. */
type CompletableColumns = Pick<
  Activity,
  'elevationGainM' | 'avgHrBpm' | 'maxHrBpm' | 'avgPaceSecPerKm' | 'avgCadenceSpm'
>;

/**
 * Comment l'import s'est rattaché à la base.
 *
 * - `created` : aucune correspondance, la ligne vient d'être insérée ;
 * - `same-file` : ce **fichier** avait déjà été importé (même empreinte) ;
 * - `same-session` : cette **séance** était déjà en base, importée depuis un
 *   fichier différent (autre source, octets différents).
 *
 * Les deux derniers ne se confondent pas : ils appellent des politiques de
 * séries temporelles opposées (cf. `src/lib/fit/ingest.ts`).
 */
export type FitUpsertOutcome = 'created' | 'same-file' | 'same-session';

/** Résultat d'un import, du point de vue de la ligne d'activité. */
export type FitUpsertResult = {
  activityId: number;
  outcome: FitUpsertOutcome;
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
 * Tolérance d'horodatage entre deux fichiers décrivant la même séance.
 *
 * Les doublons observés en base partagent un `started_at` **strictement**
 * identique, mais rien ne le garantit en général : deux exports d'une même
 * sortie (montre, application téléphone, retraitement d'un service tiers)
 * peuvent placer le départ à quelques secondes d'écart selon qu'ils datent le
 * premier `record`, le premier fix GPS ou l'appui sur le bouton. Une minute est
 * assez large pour absorber cet écart et bien trop courte pour confondre deux
 * séances réelles : personne n'enchaîne deux entraînements du même sport à
 * moins d'une minute d'intervalle.
 */
export const SESSION_MATCH_WINDOW_MS = 60_000;

/**
 * L'activité déjà en base qui décrit la même séance que ce fichier, `null` si
 * aucune.
 *
 * Trois critères : le même athlète, le même sport, et un départ dans la fenêtre
 * {@link SESSION_MATCH_WINDOW_MS}. Le sport en fait partie parce qu'un
 * enchaînement (natation puis course) peut légitimement démarrer à la seconde où
 * la discipline précédente s'arrête.
 *
 * La plus proche en temps l'emporte, et à écart égal la plus ancienne ligne :
 * le rapprochement ne doit pas dépendre de l'ordre que Postgres a servi.
 */
async function findSessionMatch(
  athleteId: number,
  sportType: string,
  startedAt: Date,
): Promise<Activity | null> {
  const instant = startedAt.getTime();
  const candidates = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        eq(activities.sportType, sportType),
        gte(activities.startedAt, new Date(instant - SESSION_MATCH_WINDOW_MS)),
        lte(activities.startedAt, new Date(instant + SESSION_MATCH_WINDOW_MS)),
      ),
    );

  let closest: Activity | null = null;
  let closestGapMs = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const gapMs = Math.abs(candidate.startedAt.getTime() - instant);
    const tie = gapMs === closestGapMs && closest !== null && candidate.id < closest.id;
    if (gapMs < closestGapMs || tie) {
      closest = candidate;
      closestGapMs = gapMs;
    }
  }
  return closest;
}

/**
 * Comble les trous de la ligne existante avec ce qu'apporte le fichier.
 *
 * `fit_file_hash` n'en fait jamais partie : le premier fichier importé reste
 * l'origine canonique de la ligne, y compris quand un second fichier vient s'y
 * rattacher par la séance.
 */
async function completeExistingRow(
  existing: Activity,
  values: CompletableColumns,
): Promise<void> {
  const completion = completableFields(existing, values);
  if (Object.keys(completion).length === 0) return;
  await db.update(activities).set(completion).where(eq(activities.id, existing.id));
}

/**
 * Insère ou met à jour l'activité décrite par un fichier FIT.
 *
 * Trois chemins, dans cet ordre :
 *
 * 1. **Déjà importée depuis ce même fichier** (`fit_file_hash` connu) → seuls les
 *    trous de la ligne sont comblés (cf. {@link completableFields}) ; rien de ce
 *    qui est déjà renseigné n'est écrasé.
 * 2. **Même séance, autre fichier** (cf. {@link findSessionMatch}) → même
 *    politique de complétion, mais l'empreinte n'est pas touchée. C'est le cas
 *    des doublons créés en amont : trois activités sur intervals.icu pour une
 *    seule sortie ont donné trois fichiers aux octets différents, que
 *    l'empreinte seule ne pouvait pas rapprocher.
 * 3. Sinon → insertion. Deux contraintes la protègent des courses entre imports
 *    simultanés : `ON CONFLICT (fit_file_hash)` pour le même fichier, et
 *    l'index unique `(athlete_id, started_at, sport_type)` pour la même séance —
 *    dont la violation est rattrapée ici et rejouée comme un rapprochement.
 *    C'est la contrainte, et non la lecture préalable, qui porte l'idempotence.
 *    L'index porte les mêmes trois critères que {@link findSessionMatch}, à la
 *    fenêtre temporelle près : ce qu'il rejette est donc toujours rapprochable.
 *
 * @throws {Error} si l'index de séance a rejeté l'insertion sans qu'aucune
 * séance ne soit ensuite trouvable — la transaction concurrente a été annulée
 * entre les deux. Rarissime, mais jamais silencieux : le fichier part dans
 * `failed/` avec son motif plutôt que d'être perdu ou dupliqué.
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
    await completeExistingRow(existing, values);
    return { activityId: existing.id, outcome: 'same-file' };
  }

  const sameSession = await findSessionMatch(athleteId, values.sportType, values.startedAt);
  if (sameSession) {
    await completeExistingRow(sameSession, values);
    return { activityId: sameSession.id, outcome: 'same-session' };
  }

  let rows: Array<{ id: number }>;
  try {
    rows = await db
      .insert(activities)
      .values({ athleteId, fitFileHash: parsed.fileHash, ...values })
      .onConflictDoUpdate({ target: activities.fitFileHash, set: FIT_HASH_CONFLICT_SET })
      .returning({ id: activities.id });
  } catch (error) {
    if (uniqueViolationConstraint(error) !== ACTIVITIES_SESSION_UNIQUE_INDEX) throw error;

    // Course : une ingestion concurrente a inséré la séance entre notre lecture
    // et notre écriture. On rejoue le chemin 2 sur la ligne qu'elle a créée.
    const raced = await findSessionMatch(athleteId, values.sportType, values.startedAt);
    if (raced === null) {
      throw new Error(
        `Course perdue sur l'index de séance à l'instant ${values.startedAt.toISOString()}, mais aucune séance correspondante en base : le fichier ${parsed.fileHash.slice(0, 12)} n'a pas pu être rattaché.`,
        { cause: error },
      );
    }

    await completeExistingRow(raced, values);
    return { activityId: raced.id, outcome: 'same-session' };
  }

  const row = rows[0];
  if (!row) {
    throw new Error(`Upsert de l'activité FIT ${parsed.fileHash} sans ligne retournée.`);
  }
  return { activityId: row.id, outcome: 'created' };
}
