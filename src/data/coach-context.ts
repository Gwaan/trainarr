import 'server-only';

import { and, asc, desc, eq, gte, lt, lte } from 'drizzle-orm';

import { civilDaysBetween, isoWeekStart, shiftCivilDate, toCivilDate } from '@/lib/dates/civil';
import { computeLoadSeries, computeTrimp } from '@/lib/metrics';

import { todayCivilDate } from './athlete';
import { db } from './db/client';
import { activities, athlete, type Activity, type Athlete, type AthleteSex } from './db/schema';
import { buildDailyTrimp, buildFitness, buildVo2max, isRunning } from './training-metrics';

/**
 * Le « R » du RAG du coach : la récupération structurée qui alimente ses
 * prompts.
 *
 * Ce module ne calcule rien de neuf — il rassemble ce que `training-metrics`
 * produit déjà pour le tableau de bord et la page « Progression », et le réduit
 * à des DTOs **minuscules**. Le modèle cible tient dans 6 Go de VRAM avec 32 k
 * de contexte : chaque champ envoyé se paie en tokens, et une série point par
 * point ne rentre pas. On envoie donc des agrégats, jamais des courbes.
 *
 * Règle du projet appliquée à la lettre : **une donnée absente est absente**.
 * Les champs de profil non renseignés ne figurent pas dans le DTO, et rien n'est
 * approximé pour combler un trou — le prompt n'en parlera pas, et le coach ne
 * pourra donc pas l'inventer.
 */

/**
 * Profil physiologique réduit à ce qu'un coach utilise pour calibrer un plan.
 *
 * Champs **facultatifs et omis** quand ils manquent : `maxHrBpm: null` se
 * sérialiserait en « FC max : null » dans un prompt, ce qu'un petit modèle lit
 * volontiers comme une valeur.
 */
export type SnapshotProfileDto = {
  /** Âge révolu au jour de la lecture, dérivé de la date de naissance. */
  ageYears?: number;
  sex?: AthleteSex;
  maxHrBpm?: number;
  restingHrBpm?: number;
  weightKg?: number;
};

/** Volume d'une semaine ISO, **course à pied uniquement**. */
export type SnapshotWeekDto = {
  /** Lundi de la semaine, date civile `YYYY-MM-DD`. */
  startsOn: string;
  distanceKm: number;
  movingTimeS: number;
  /** Nombre de sorties de la semaine. */
  sessions: number;
};

/** Où en est l'athlète aujourd'hui — le contexte commun à toutes les générations. */
export type TrainingSnapshotDto = {
  /** Jour civil de la lecture : le prompt date ce qu'il affirme. */
  today: string;
  profile: SnapshotProfileDto;
  /** Charge du jour, `null` si elle n'est pas calculable (cf. `buildFitnessUnavailable`). */
  fitness: { ctl: number; atl: number; tsb: number } | null;
  /** VO₂max des 30 derniers jours, `null` si aucune course n'est exploitable. */
  vo2max: number | null;
  /** Les {@link SNAPSHOT_WEEKS} dernières semaines, de la plus ancienne à la semaine en cours. */
  weeks: SnapshotWeekDto[];
  /** Allure moyenne des {@link RECENT_PACE_ACTIVITIES} dernières courses, `null` si aucune. */
  recentAvgPaceSecPerKm: number | null;
};

/** Une sortie comparable, telle que le feedback la met en regard de la séance analysée. */
export type ComparableActivityDto = {
  /** Jour civil de la sortie. */
  date: string;
  distanceM: number;
  movingTimeS: number;
  avgPaceSecPerKm: number | null;
  avgHrBpm: number | null;
  elevationGainM: number | null;
  /** `null` sans FC moyenne ou sans profil complet (le TRIMP de Banister est sexué). */
  trimp: number | null;
};

/** Quatre semaines : de quoi voir une progression de volume sans noyer le prompt. */
export const SNAPSHOT_WEEKS = 4;

/** Fenêtre de l'allure de référence : les 5 dernières courses. */
export const RECENT_PACE_ACTIVITIES = 5;

/**
 * Écart de distance toléré pour qu'une sortie soit « comparable » : ±25 %.
 * Au-delà, comparer les allures n'a plus de sens (un 5 km et un 20 km ne se
 * courent pas au même régime).
 */
export const COMPARABLE_DISTANCE_TOLERANCE = 0.25;

/*
 * Constructions pures, exportées pour les tests.
 */

/** Âge révolu à la date civile `today`. */
export function ageYearsOn(birthDate: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  // Comparaison `MM-JJ` : l'anniversaire n'est pas encore passé cette année.
  return today.slice(5) < birthDate.slice(5) ? years - 1 : years;
}

/** Profil réduit, les champs non renseignés étant purement et simplement omis. */
export function toSnapshotProfile(profile: Athlete, today: string): SnapshotProfileDto {
  const dto: SnapshotProfileDto = {};
  if (profile.birthDate !== null) dto.ageYears = ageYearsOn(profile.birthDate, today);
  if (profile.sex !== null) dto.sex = profile.sex;
  if (profile.maxHrBpm !== null) dto.maxHrBpm = profile.maxHrBpm;
  if (profile.restingHrBpm !== null) dto.restingHrBpm = profile.restingHrBpm;
  if (profile.weightKg !== null) dto.weightKg = profile.weightKg;
  return dto;
}

/**
 * Les `count` dernières semaines ISO, la dernière étant celle de `today`.
 *
 * Course à pied uniquement : le volume d'entraînement d'un coureur ne compte pas
 * une sortie vélo, et le plan qu'on lui demande de bâtir ne parle que de course.
 * Une semaine sans sortie reste dans la liste, à zéro — c'est une donnée.
 */
export function buildRecentWeeks(
  rows: readonly Activity[],
  today: string,
  count = SNAPSHOT_WEEKS,
): SnapshotWeekDto[] {
  const currentWeekStart = isoWeekStart(today);
  const weeks: SnapshotWeekDto[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    weeks.push({
      startsOn: shiftCivilDate(currentWeekStart, -7 * index),
      distanceKm: 0,
      movingTimeS: 0,
      sessions: 0,
    });
  }

  const firstWeekStart = weeks[0].startsOn;
  for (const row of rows) {
    if (!isRunning(row.sportType)) continue;

    const day = toCivilDate(row.startedAt);
    // Les dates civiles `YYYY-MM-DD` s'ordonnent lexicographiquement.
    if (day < firstWeekStart || day > today) continue;

    const week = weeks[Math.floor(civilDaysBetween(firstWeekStart, day) / 7)];
    if (!week) continue;

    week.distanceKm += row.distanceM / 1000;
    week.movingTimeS += row.movingTimeS;
    week.sessions += 1;
  }

  return weeks;
}

/**
 * Allure moyenne des `limit` dernières courses, en secondes par kilomètre.
 *
 * Distance cumulée sur temps cumulé, et non moyenne des allures : une sortie de
 * 20 km doit peser plus qu'un footing de 5 km dans une allure « de référence ».
 * `null` si aucune de ces sorties n'a de distance ni de temps exploitables.
 */
export function recentRunPace(
  rows: readonly Activity[],
  limit = RECENT_PACE_ACTIVITIES,
): number | null {
  const recent = [...rows]
    .filter((row) => isRunning(row.sportType))
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, limit);

  let distanceM = 0;
  let movingTimeS = 0;
  for (const row of recent) {
    if (row.distanceM <= 0 || row.movingTimeS <= 0) continue;
    distanceM += row.distanceM;
    movingTimeS += row.movingTimeS;
  }

  return distanceM > 0 ? movingTimeS / (distanceM / 1000) : null;
}

/** DTO d'une sortie comparable. Le TRIMP est recalculé : il n'est pas stocké. */
export function toComparableActivityDto(row: Activity, profile: Athlete): ComparableActivityDto {
  return {
    date: toCivilDate(row.startedAt),
    distanceM: row.distanceM,
    movingTimeS: row.movingTimeS,
    avgPaceSecPerKm: row.avgPaceSecPerKm,
    avgHrBpm: row.avgHrBpm,
    elevationGainM: row.elevationGainM,
    trimp:
      profile.sex === null
        ? null
        : computeTrimp({
            movingTimeS: row.movingTimeS,
            avgHrBpm: row.avgHrBpm,
            restingHrBpm: profile.restingHrBpm,
            maxHrBpm: profile.maxHrBpm,
            sex: profile.sex,
          }),
  };
}

/** Snapshot d'un athlète qui n'existe pas encore : tout est absent, rien n'est inventé. */
function emptySnapshot(today: string): TrainingSnapshotDto {
  return {
    today,
    profile: {},
    fitness: null,
    vo2max: null,
    weeks: [],
    recentAvgPaceSecPerKm: null,
  };
}

/*
 * Lectures.
 */

/**
 * L'état d'entraînement courant : profil, charge, volume des dernières semaines,
 * VO₂max et allure de référence.
 *
 * Une seule lecture de l'historique, comme le tableau de bord : la CTL est une
 * moyenne mobile sur 42 jours, elle a besoin de tout l'historique, et une ligne
 * d'activité est légère (les séries temporelles vivent dans une autre table).
 */
export async function getTrainingSnapshot(): Promise<TrainingSnapshotDto> {
  const today = todayCivilDate();

  const profileRows = await db.select().from(athlete).orderBy(asc(athlete.id)).limit(1);
  const profile = profileRows[0];
  if (!profile) return emptySnapshot(today);

  const rows = await db
    .select()
    .from(activities)
    .where(eq(activities.athleteId, profile.id))
    .orderBy(desc(activities.startedAt));

  const daily = buildDailyTrimp(rows, profile, today);
  const fitness = buildFitness(daily.length > 0 ? computeLoadSeries(daily) : []);
  const vo2max = buildVo2max(rows, profile, today);

  return {
    today,
    profile: toSnapshotProfile(profile, today),
    fitness: fitness === null ? null : { ctl: fitness.ctl, atl: fitness.atl, tsb: fitness.tsb },
    vo2max: vo2max === null ? null : vo2max.value,
    weeks: buildRecentWeeks(rows, today),
    recentAvgPaceSecPerKm: recentRunPace(rows),
  };
}

/**
 * Les `limit` sorties les plus récentes **antérieures** à l'activité donnée, du
 * même sport et de distance voisine (±{@link COMPARABLE_DISTANCE_TOLERANCE}).
 *
 * C'est le point de comparaison qui permet au coach de dire « plus rapide que
 * tes trois dernières sorties du même format » sans rien extrapoler. Liste vide
 * s'il n'y a pas d'athlète, si l'activité n'est pas la sienne (anti-IDOR :
 * même réponse que si elle n'existait pas), ou si rien n'est comparable.
 */
export async function getComparableActivities(
  activityId: number,
  limit = 5,
): Promise<ComparableActivityDto[]> {
  if (limit <= 0) return [];

  const profileRows = await db.select().from(athlete).orderBy(asc(athlete.id)).limit(1);
  const profile = profileRows[0];
  if (!profile) return [];

  const referenceRows = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, profile.id)))
    .limit(1);

  const reference = referenceRows[0];
  if (!reference) return [];

  const rows = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, profile.id),
        eq(activities.sportType, reference.sportType),
        // Antérieures à la séance analysée : le feedback la situe dans son
        // passé, pas dans un historique qui la contiendrait elle-même.
        lt(activities.startedAt, reference.startedAt),
        gte(activities.distanceM, reference.distanceM * (1 - COMPARABLE_DISTANCE_TOLERANCE)),
        lte(activities.distanceM, reference.distanceM * (1 + COMPARABLE_DISTANCE_TOLERANCE)),
      ),
    )
    .orderBy(desc(activities.startedAt))
    .limit(limit);

  return rows.map((row) => toComparableActivityDto(row, profile));
}
