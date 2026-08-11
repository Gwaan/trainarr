import 'server-only';

import { and, asc, desc, eq, getTableColumns, isNull, or } from 'drizzle-orm';

import { isoWeekEnd, isoWeekNumber, shiftCivilDate, toCivilDate } from '@/lib/dates/civil';
import { computeLoadSeries, type LoadPoint } from '@/lib/metrics';

import { toActivitySummaryDto, type ActivitySummaryDto } from './activities';
import { db } from './db/client';
import { activities, athlete, plannedSessions, plans, type PlannedSession } from './db/schema';
import {
  buildDailyTrimp,
  buildFitness,
  buildFitnessUnavailable,
  buildVo2max,
  buildVo2maxUnavailable,
  type FitnessDto,
  type FitnessUnavailableDto,
  type Vo2maxDto,
  type Vo2maxUnavailableDto,
} from './training-metrics';

/**
 * Contrat unique consommé par le dashboard.
 *
 * Chaque bloc est indépendamment nullable : une base vide ou des données
 * insuffisantes (pas de FC max renseignée, moins de deux semaines d'activités)
 * doivent produire un état vide explicite, jamais une valeur inventée.
 *
 * Les indicateurs eux-mêmes (TRIMP quotidien, charge, VO₂max) sont construits
 * par `./training-metrics`, partagé avec la page « Progression ». Leurs DTOs
 * sont ré-exportés ici : l'UI du tableau de bord les importe depuis ce module
 * depuis toujours, et son contrat n'a pas de raison de bouger.
 */

export type {
  FitnessDto,
  FitnessUnavailableDto,
  Vo2maxDto,
  Vo2maxUnavailableDto,
} from './training-metrics';

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

const RECENT_ACTIVITIES_COUNT = 3;
const LOAD_WEEKS_COUNT = 6;

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
    /*
     * La séance du jour, à condition qu'un plan actif la porte encore.
     *
     * Archiver un plan laisse en base ses séances passées ou déjà réalisées : le
     * filtre sur `plans.status` évite qu'une d'elles ne s'affiche à la place de
     * celle du plan en cours. Une séance hors plan (`plan_id` nul) reste, elle,
     * toujours valable.
     */
    db
      .select(getTableColumns(plannedSessions))
      .from(plannedSessions)
      .leftJoin(plans, eq(plannedSessions.planId, plans.id))
      .where(
        and(
          eq(plannedSessions.athleteId, profile.id),
          eq(plannedSessions.scheduledOn, today),
          or(isNull(plannedSessions.planId), eq(plans.status, 'active')),
        ),
      )
      // Deux séances peuvent tomber le même jour : la plus récemment créée gagne,
      // plutôt que celle que Postgres rend en premier ce jour-là.
      .orderBy(desc(plannedSessions.id))
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
