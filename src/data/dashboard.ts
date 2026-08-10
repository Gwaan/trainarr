import 'server-only';

import { and, asc, desc, eq } from 'drizzle-orm';

import { APP_TIME_ZONE } from '@/config/time';

import {
  computeLoadSeries,
  computeTrimp,
  estimateEffectiveVo2max,
  type DailyTrimp,
  type LoadPoint,
} from '@/lib/metrics';

import { toActivitySummaryDto, type ActivitySummaryDto } from './activities';
import { db } from './db/client';
import {
  activities,
  athlete,
  plannedSessions,
  type Activity,
  type Athlete,
  type PlannedSession,
} from './db/schema';

/**
 * Contrat unique consommé par le dashboard.
 *
 * Chaque bloc est indépendamment nullable : une base vide ou des données
 * insuffisantes (pas de FC max renseignée, moins de deux semaines d'activités)
 * doivent produire un état vide explicite, jamais une valeur inventée.
 */

export type FitnessDto = {
  ctl: number;
  atl: number;
  tsb: number;
  /** Variation de CTL sur 7 jours, `null` si l'historique est trop court. */
  ctlDelta7d: number | null;
};

/**
 * Pourquoi la charge n'est pas calculable. Renseigné **exactement quand**
 * `fitness` est `null` alors qu'un athlète existe : un placeholder qui récite
 * toutes les conditions possibles ne vaut rien, l'athlète doit lire la sienne.
 */
export type FitnessUnavailableDto = {
  /** Champs de profil manquants, dans l'ordre où le TRIMP de Banister les exige. */
  missingProfileFields: Array<'sex' | 'maxHrBpm' | 'restingHrBpm'>;
  /** Aucune séance importée ne porte de FC moyenne. */
  noHeartRateData: boolean;
};

export type Vo2maxDto = {
  value: number;
  /** Variation sur 30 jours, `null` si aucun point de comparaison. */
  delta30d: number | null;
};

/**
 * Pourquoi la VO₂max n'est pas estimable. Même contrat que
 * `FitnessUnavailableDto` : non-`null` exactement quand `vo2max` est `null` et
 * qu'un athlète existe.
 */
export type Vo2maxUnavailableDto = {
  /**
   * FC max du profil absente. Bloquant : l'estimation corrige l'allure par le
   * rapport FC moyenne / FC max, elle ne peut pas s'en passer.
   */
  missingMaxHrBpm: boolean;
  /** Aucune course des 30 derniers jours ne porte de FC moyenne. */
  noRecentRunWithHeartRate: boolean;
};

export type LoadWeekDto = {
  /** Étiquette d'axe, ex. « S32 ». */
  weekLabel: string;
  ctl: number;
};

export type PlannedSessionDto = {
  id: number;
  scheduledOn: string;
  /** Ex. « VMA courte · piste ». */
  kind: string;
  /** Ex. « 6 × 800 m ». */
  title: string;
  targetPaceSecPerKm: number | null;
  warmup: string | null;
  recovery: string | null;
  cooldown: string | null;
  volumeM: number | null;
  durationS: number | null;
};

export type DashboardSummary = {
  athleteName: string | null;
  fitness: FitnessDto | null;
  fitnessUnavailable: FitnessUnavailableDto | null;
  vo2max: Vo2maxDto | null;
  vo2maxUnavailable: Vo2maxUnavailableDto | null;
  loadWeeks: LoadWeekDto[];
  todaySession: PlannedSessionDto | null;
  recentActivities: ActivitySummaryDto[];
};

/** Fuseau partagé avec le formatage d'affichage — voir `src/config/time.ts`. */
const TIME_ZONE = APP_TIME_ZONE;

const RECENT_ACTIVITIES_COUNT = 3;
const LOAD_WEEKS_COUNT = 6;
/**
 * Fenêtre de la VO₂max : 30 jours glissants vs les 30 précédents. C'est la
 * valeur par défaut de Runalyze (`VO2MAX_DAYS = 30`, cf. `buildVo2max`).
 */
const VO2MAX_WINDOW_DAYS = 30;
const CTL_DELTA_DAYS = 7;
const DAY_MS = 86_400_000;

const EMPTY_SUMMARY: DashboardSummary = {
  athleteName: null,
  fitness: null,
  // Sans athlète, il n'y a pas de cause à expliquer : c'est l'onboarding qui parle.
  fitnessUnavailable: null,
  vo2max: null,
  vo2maxUnavailable: null,
  loadWeeks: [],
  todaySession: null,
  recentActivities: [],
};

const civilDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
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

function shiftCivilDate(date: string, days: number): string {
  return new Date(civilDateToMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function civilDaysBetween(from: string, to: string): number {
  return Math.round((civilDateToMs(to) - civilDateToMs(from)) / DAY_MS);
}

/** Index du jour dans la semaine ISO : lundi = 0 … dimanche = 6. */
function isoDayIndex(date: string): number {
  return (new Date(civilDateToMs(date)).getUTCDay() + 6) % 7;
}

/** Dimanche de la semaine ISO contenant `date`. */
function isoWeekEnd(date: string): string {
  return shiftCivilDate(date, 6 - isoDayIndex(date));
}

/**
 * Numéro de semaine ISO 8601 : la semaine 1 est celle qui contient le premier
 * jeudi de l'année, d'où le passage systématique par le jeudi de la semaine.
 */
function isoWeekNumber(date: string): number {
  const thursday = new Date(civilDateToMs(date) + (3 - isoDayIndex(date)) * DAY_MS);
  const january4 = `${thursday.getUTCFullYear()}-01-04`;
  const firstThursday = new Date(civilDateToMs(january4) + (3 - isoDayIndex(january4)) * DAY_MS);
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}

/** La VO₂max n'a de sens qu'en course à pied (`Run`, `TrailRun`, `VirtualRun`…). */
function isRunning(sportType: string): boolean {
  return sportType.toLowerCase().includes('run');
}

/**
 * Série TRIMP quotidienne, dense du premier jour actif à aujourd'hui inclus
 * (les jours de repos valent 0). Une activité sans FC moyenne exploitable ne
 * produit pas de TRIMP : elle est ignorée plutôt qu'estimée.
 */
function buildDailyTrimp(rows: readonly Activity[], profile: Athlete, today: string): DailyTrimp[] {
  if (profile.sex === null) {
    // Le TRIMP de Banister est sexué : sans cette donnée, rien n'est calculable.
    return [];
  }

  const perDay = new Map<string, number>();
  for (const row of rows) {
    const day = toCivilDate(row.startedAt);
    if (day > today) continue;

    const trimp = computeTrimp({
      movingTimeS: row.movingTimeS,
      avgHrBpm: row.avgHrBpm,
      restingHrBpm: profile.restingHrBpm,
      maxHrBpm: profile.maxHrBpm,
      sex: profile.sex,
    });
    if (trimp === null) continue;

    perDay.set(day, (perDay.get(day) ?? 0) + trimp);
  }

  if (perDay.size === 0) return [];

  const firstDay = [...perDay.keys()].sort()[0];
  const daily: DailyTrimp[] = [];
  for (let offset = 0; offset <= civilDaysBetween(firstDay, today); offset += 1) {
    const date = shiftCivilDate(firstDay, offset);
    daily.push({ date, trimp: perDay.get(date) ?? 0 });
  }
  return daily;
}

function buildFitness(series: readonly LoadPoint[]): FitnessDto | null {
  const last = series[series.length - 1];
  if (!last) return null;

  const reference = series.find(
    (point) => point.date === shiftCivilDate(last.date, -CTL_DELTA_DAYS),
  );

  return {
    ctl: last.ctl,
    atl: last.atl,
    tsb: last.tsb,
    ctlDelta7d: reference ? last.ctl - reference.ctl : null,
  };
}

/**
 * VO₂max des courses de `]after, until]`, moyennée en pondérant chaque séance
 * par son temps de déplacement. `null` si aucune n'est exploitable.
 *
 * C'est l'agrégation de Runalyze, relevée dans
 * `TrainingRepository::calculateVO2maxShape` (branche `support/4.3.x`) :
 * `SUM(s · vo2max) / SUM(s)` sur les 30 derniers jours du sport « course ».
 * https://github.com/Runalyze/Runalyze/blob/support/4.3.x/src/CoreBundle/Entity/TrainingRepository.php
 *
 * Pourquoi pas le maximum brut, qui était le calcul précédent : sur une série de
 * footings, le max retient la séance la plus favorable et suit le bruit d'un
 * seul point. Pourquoi pas la médiane non plus, malgré sa robustesse : la
 * pondération par la durée fait déjà ce travail — une sortie de 12 min pèse
 * cinq fois moins qu'une sortie d'une heure, et ce sont les séances courtes qui
 * portent l'essentiel des aberrations (FC pas encore stabilisée, GPS en ville).
 * S'y ajoutent les garde-fous de `estimateEffectiveVo2max`, qui écarte en amont
 * les efforts trop courts et les valeurs hors de [20, 90].
 */
function averageVo2max(
  rows: readonly Activity[],
  profile: Athlete,
  after: string,
  until: string,
): number | null {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const row of rows) {
    if (!isRunning(row.sportType)) continue;

    const day = toCivilDate(row.startedAt);
    if (day <= after || day > until) continue;

    const value = estimateEffectiveVo2max({
      distanceM: row.distanceM,
      movingTimeS: row.movingTimeS,
      avgHrBpm: row.avgHrBpm,
      maxHrBpm: profile.maxHrBpm,
    });
    if (value === null) continue;

    // `movingTimeS` est nécessairement > 0 ici : l'estimation aurait renvoyé
    // `null` sinon. Le poids total ne peut donc pas être nul après un ajout.
    weightedSum += value * row.movingTimeS;
    totalWeight += row.movingTimeS;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

function buildVo2max(
  rows: readonly Activity[],
  profile: Athlete,
  today: string,
): Vo2maxDto | null {
  const previousWindowStart = shiftCivilDate(today, -2 * VO2MAX_WINDOW_DAYS);
  const currentWindowStart = shiftCivilDate(today, -VO2MAX_WINDOW_DAYS);

  const current = averageVo2max(rows, profile, currentWindowStart, today);
  if (current === null) return null;

  const previous = averageVo2max(rows, profile, previousWindowStart, currentWindowStart);
  return { value: current, delta30d: previous === null ? null : current - previous };
}

/**
 * Ce qui manque pour calculer la charge. Le TRIMP de Banister exige le sexe, la
 * FC max et la FC de repos côté profil, plus une FC moyenne par séance : dire
 * laquelle de ces conditions n'est pas remplie évite la session de debug que le
 * message générique précédent a coûtée.
 */
function buildFitnessUnavailable(
  rows: readonly Activity[],
  profile: Athlete,
  today: string,
): FitnessUnavailableDto {
  const missingProfileFields: FitnessUnavailableDto['missingProfileFields'] = [];
  if (profile.sex === null) missingProfileFields.push('sex');
  if (profile.maxHrBpm === null) missingProfileFields.push('maxHrBpm');
  if (profile.restingHrBpm === null) missingProfileFields.push('restingHrBpm');

  const noHeartRateData = !rows.some(
    (row) => row.avgHrBpm !== null && toCivilDate(row.startedAt) <= today,
  );

  return { missingProfileFields, noHeartRateData };
}

/** Ce qui manque pour estimer la VO₂max — cf. `buildFitnessUnavailable`. */
function buildVo2maxUnavailable(
  rows: readonly Activity[],
  profile: Athlete,
  today: string,
): Vo2maxUnavailableDto {
  const windowStart = shiftCivilDate(today, -VO2MAX_WINDOW_DAYS);

  const noRecentRunWithHeartRate = !rows.some((row) => {
    if (!isRunning(row.sportType) || row.avgHrBpm === null) return false;
    const day = toCivilDate(row.startedAt);
    return day > windowStart && day <= today;
  });

  return { missingMaxHrBpm: profile.maxHrBpm === null, noRecentRunWithHeartRate };
}

/**
 * CTL en fin de chacune des 6 dernières semaines ISO. La semaine en cours n'est
 * pas terminée : on prend son dernier point connu. Une semaine antérieure au
 * début de l'historique est omise plutôt qu'affichée à zéro.
 */
function buildLoadWeeks(series: readonly LoadPoint[], today: string): LoadWeekDto[] {
  if (series.length === 0) return [];

  const byDate = new Map(series.map((point) => [point.date, point]));
  const weeks: LoadWeekDto[] = [];

  for (let index = LOAD_WEEKS_COUNT - 1; index >= 0; index -= 1) {
    const dayInWeek = shiftCivilDate(today, -7 * index);
    const weekEnd = isoWeekEnd(dayInWeek);
    const point = byDate.get(weekEnd > today ? today : weekEnd);
    if (!point) continue;

    weeks.push({ weekLabel: `S${isoWeekNumber(dayInWeek)}`, ctl: point.ctl });
  }

  return weeks;
}

/** DTO explicite : ni `athleteId`, ni `completedActivityId`, ni `createdAt`. */
function toPlannedSessionDto(row: PlannedSession): PlannedSessionDto {
  return {
    id: row.id,
    scheduledOn: row.scheduledOn,
    kind: row.kind,
    title: row.title,
    targetPaceSecPerKm: row.targetPaceSecPerKm,
    warmup: row.warmup,
    recovery: row.recovery,
    cooldown: row.cooldown,
    volumeM: row.volumeM,
    durationS: row.durationS,
  };
}

/** Agrège en une seule passe tout ce que le dashboard affiche. */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const profileRows = await db.select().from(athlete).orderBy(asc(athlete.id)).limit(1);
  const profile = profileRows[0];
  if (!profile) return EMPTY_SUMMARY;

  const today = toCivilDate(new Date());

  const [activityRows, sessionRows] = await Promise.all([
    // Historique complet : la CTL est une moyenne mobile sur 42 jours, et une
    // ligne d'activité est légère (les séries temporelles vivent à part).
    db
      .select()
      .from(activities)
      .where(eq(activities.athleteId, profile.id))
      .orderBy(desc(activities.startedAt)),
    db
      .select()
      .from(plannedSessions)
      .where(
        and(
          eq(plannedSessions.athleteId, profile.id),
          eq(plannedSessions.scheduledOn, today),
        ),
      )
      .limit(1),
  ]);

  const daily = buildDailyTrimp(activityRows, profile, today);
  const loadSeries = daily.length > 0 ? computeLoadSeries(daily) : [];
  const todaySession = sessionRows[0];

  const fitness = buildFitness(loadSeries);
  const vo2max = buildVo2max(activityRows, profile, today);

  return {
    athleteName: profile.displayName,
    fitness,
    fitnessUnavailable: fitness
      ? null
      : buildFitnessUnavailable(activityRows, profile, today),
    vo2max,
    vo2maxUnavailable: vo2max ? null : buildVo2maxUnavailable(activityRows, profile, today),
    loadWeeks: buildLoadWeeks(loadSeries, today),
    todaySession: todaySession ? toPlannedSessionDto(todaySession) : null,
    recentActivities: activityRows.slice(0, RECENT_ACTIVITIES_COUNT).map(toActivitySummaryDto),
  };
}
