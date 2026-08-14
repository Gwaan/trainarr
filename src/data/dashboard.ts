import 'server-only';

import { and, desc, eq, getTableColumns, isNull, or } from 'drizzle-orm';

import { isoWeekEnd, isoWeekNumber, shiftCivilDate, toCivilDate } from '@/lib/dates/civil';
import { computeLoadSeries, type LoadPoint } from '@/lib/metrics';

import { toActivitySummaryDto, type ActivitySummaryDto } from './activities';
import { getCurrentAthlete } from './athlete';
import { db } from './db/client';
import { activities, plannedSessions, plans, type PlannedSession } from './db/schema';
import { selectLthrSuggestion, type LthrSuggestionDto } from './lthr-suggestion';
import { selectMaxHrSuggestion, type MaxHrSuggestionDto } from './max-hr-suggestion';
import { getPendingPlanRevision, type PlanRevisionDto } from './plan-revisions';
import {
  selectRestingHrSuggestion,
  type RestingHrSuggestionDto,
} from './resting-hr-suggestion';
import { getWeatherForecast, type WeatherForecastDto } from './weather-forecast';
import {
  emptyWellnessSummary,
  selectWellnessSummary,
  WELLNESS_LATEST_WINDOW_DAYS,
  type WellnessSummaryDto,
} from './wellness';
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
  /**
   * Le jour courant, tel que le DAL le calcule (fuseau de l'athlète).
   *
   * Rendu avec le reste plutôt que recalculé à l'affichage : c'est lui qui a
   * sélectionné la séance du jour, et c'est lui qui doit décider de l'horizon de
   * la prévision. Deux « aujourd'hui » différents entre minuit et l'aube, et le
   * panneau annoncerait la météo de la veille.
   */
  today: string;
  /** Prévisions de l'athlète — le relevé du matin, tel quel (cf. `./weather-forecast.ts`). */
  forecast: WeatherForecastDto;
  recentActivities: ActivitySummaryDto[];
  /**
   * Une FC max soutenue plus haute que celle du profil, `null` s'il n'y a rien à
   * proposer (cf. `./max-hr-suggestion.ts`).
   *
   * Elle vit ici parce que le tableau de bord est le seul endroit où elle se
   * voit sans avoir été cherchée : attendre une visite dans les réglages
   * reviendrait à ne jamais l'ajuster. La lecture est **la même** que celle des
   * réglages — {@link selectMaxHrSuggestion}, à qui le profil déjà lu est passé.
   */
  maxHrSuggestion: MaxHrSuggestionDto | null;
  /**
   * La **réévaluation de plan** que le coach propose, `null` s'il n'y en a pas
   * (cf. `./plan-revisions.ts`).
   *
   * Elle vit ici pour la même raison que la proposition de FC max : le tableau
   * de bord est le seul écran qu'on ouvre sans rien chercher, et une
   * proposition que l'athlète ne verrait qu'en allant sur la page du plan
   * n'aurait pas beaucoup plus d'existence que l'écriture silencieuse qu'elle
   * remplace. Le DTO est **minimal** — le sens, la raison, les totaux : le
   * contenu proposé, lui, ne se juge pas depuis un tableau de bord.
   */
  planRevision: PlanRevisionDto | null;
  /**
   * Les dernières mesures de bien-être connues — HRV, FC de repos, sommeil (cf.
   * `./wellness.ts`).
   *
   * Elles viennent de la montre, pas de l'application : le tableau de bord les
   * met sous les yeux parce que ce sont elles qui expliquent une séance qui ne
   * passe pas, et parce qu'elles sont invisibles partout ailleurs. Chaque champ
   * est indépendamment `null` — l'écran **dit** l'absence, il ne la laisse pas en
   * blanc.
   */
  wellness: WellnessSummaryDto;
  /**
   * Une FC de repos médiane qui s'écarte de celle du profil, `null` s'il n'y a
   * rien à proposer (cf. `./resting-hr-suggestion.ts`).
   *
   * Ici pour la même raison que la proposition de FC max : c'est le seul écran
   * qu'on ouvre sans rien chercher. Elle peut coexister avec elle — les deux
   * cartes s'empilent, et une seule des deux porte le CTA accent (cf. la page).
   */
  restingHrSuggestion: RestingHrSuggestionDto | null;
  /**
   * Une **FC seuil** mesurée qui s'écarte de celle du profil, `null` s'il n'y a
   * rien à proposer (cf. `./lthr-suggestion.ts`).
   *
   * Ici pour la même raison que ses deux aînées — c'est le seul écran qu'on
   * ouvre sans rien chercher —, mais c'est la proposition la plus lourde de
   * conséquences des trois : l'accepter change l'**ancrage** des zones
   * cardiaques. Elle peut coexister avec les deux autres, et c'est la page qui
   * arbitre l'unique CTA accent.
   */
  lthrSuggestion: LthrSuggestionDto | null;
};

const RECENT_ACTIVITIES_COUNT = 3;
const LOAD_WEEKS_COUNT = 6;

const EMPTY_SUMMARY: Omit<DashboardSummary, 'today' | 'wellness'> = {
  athleteName: null,
  fitness: null,
  // Sans athlète, il n'y a pas de cause à expliquer : c'est l'onboarding qui parle.
  fitnessUnavailable: null,
  vo2max: null,
  vo2maxUnavailable: null,
  loadWeeks: [],
  todaySession: null,
  // Sans athlète, il n'y a ni séance ni lieu : la prévision n'a rien à dire.
  forecast: { status: null, fetchedAt: null, location: { source: 'derived' }, days: [] },
  recentActivities: [],
  // Sans athlète, il n'y a aucune séance : rien à proposer.
  maxHrSuggestion: null,
  // Ni plan, donc aucune réévaluation en attente.
  planRevision: null,
  // Sans athlète, aucun relevé bien-être n'a jamais été rapatrié.
  restingHrSuggestion: null,
  // Sans athlète, aucune séance n'a jamais mesuré de seuil.
  lthrSuggestion: null,
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
  const today = toCivilDate(new Date());

  const profile = await getCurrentAthlete();
  if (!profile) return { ...EMPTY_SUMMARY, today, wellness: emptyWellnessSummary(today) };

  const [
    activityRows,
    sessionRows,
    forecast,
    maxHrSuggestion,
    planRevision,
    wellness,
    restingHrSuggestion,
    lthrSuggestion,
  ] = await Promise.all([
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
    getWeatherForecast(),
    // Le profil est déjà lu : la proposition n'a pas à le relire, elle le reçoit.
    selectMaxHrSuggestion(profile),
    // Même lecture que la page du plan, en version courte : l'athlète est passé,
    // jamais redéduit.
    getPendingPlanRevision(profile.id),
    // Le même « aujourd'hui » que le reste de la page : deux lectures de
    // l'horloge à cheval sur minuit dateraient la tuile d'hier.
    selectWellnessSummary(
      profile.id,
      today,
      shiftCivilDate(today, -(WELLNESS_LATEST_WINDOW_DAYS - 1)),
    ),
    // Le profil est déjà lu, comme pour la FC max : la proposition le reçoit.
    selectRestingHrSuggestion(profile, today),
    // Idem — et sa fenêtre porte sur des instants d'activité, pas sur des jours
    // civils : elle prend l'horloge, pas le `today` de la page.
    selectLthrSuggestion(profile),
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
    today,
    forecast,
    recentActivities: activityRows.slice(0, RECENT_ACTIVITIES_COUNT).map(toActivitySummaryDto),
    maxHrSuggestion,
    planRevision,
    wellness,
    restingHrSuggestion,
    lthrSuggestion,
  };
}
