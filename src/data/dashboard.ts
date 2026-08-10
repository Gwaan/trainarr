import 'server-only';

import { and, asc, desc, eq } from 'drizzle-orm';

import { APP_TIME_ZONE } from '@/config/time';

import {
  computeLoadSeries,
  computeTrimp,
  estimateVdot,
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

export type Vo2maxDto = {
  value: number;
  /** Variation sur 30 jours, `null` si aucun point de comparaison. */
  delta30d: number | null;
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
  vo2max: Vo2maxDto | null;
  loadWeeks: LoadWeekDto[];
  todaySession: PlannedSessionDto | null;
  recentActivities: ActivitySummaryDto[];
};

/** Fuseau partagé avec le formatage d'affichage — voir `src/config/time.ts`. */
const TIME_ZONE = APP_TIME_ZONE;

const RECENT_ACTIVITIES_COUNT = 3;
const LOAD_WEEKS_COUNT = 6;
/** Fenêtre de comparaison du VDOT : 30 jours glissants vs les 30 précédents. */
const VO2MAX_WINDOW_DAYS = 30;
const CTL_DELTA_DAYS = 7;
const DAY_MS = 86_400_000;

const EMPTY_SUMMARY: DashboardSummary = {
  athleteName: null,
  fitness: null,
  vo2max: null,
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

/** Le VDOT n'a de sens qu'en course à pied (`Run`, `TrailRun`, `VirtualRun`…). */
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

/** Meilleur VDOT des efforts de course situés dans `]after, until]`. */
function bestVdot(rows: readonly Activity[], after: string, until: string): number | null {
  let best: number | null = null;
  for (const row of rows) {
    if (!isRunning(row.sportType)) continue;

    const day = toCivilDate(row.startedAt);
    if (day <= after || day > until) continue;

    const vdot = estimateVdot({ distanceM: row.distanceM, movingTimeS: row.movingTimeS });
    if (vdot === null) continue;
    if (best === null || vdot > best) best = vdot;
  }
  return best;
}

function buildVo2max(rows: readonly Activity[], today: string): Vo2maxDto | null {
  const previousWindowStart = shiftCivilDate(today, -2 * VO2MAX_WINDOW_DAYS);
  const currentWindowStart = shiftCivilDate(today, -VO2MAX_WINDOW_DAYS);

  const current = bestVdot(rows, currentWindowStart, today);
  if (current === null) return null;

  const previous = bestVdot(rows, previousWindowStart, currentWindowStart);
  return { value: current, delta30d: previous === null ? null : current - previous };
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

  return {
    athleteName: profile.displayName,
    fitness: buildFitness(loadSeries),
    vo2max: buildVo2max(activityRows, today),
    loadWeeks: buildLoadWeeks(loadSeries, today),
    todaySession: todaySession ? toPlannedSessionDto(todaySession) : null,
    recentActivities: activityRows.slice(0, RECENT_ACTIVITIES_COUNT).map(toActivitySummaryDto),
  };
}
