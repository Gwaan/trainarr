import 'server-only';

import { civilDaysBetween, shiftCivilDate, toCivilDate } from '@/lib/dates/civil';
import {
  computeTrimp,
  estimateEffectiveVo2max,
  type DailyTrimp,
  type LoadPoint,
} from '@/lib/metrics';

import type { Activity, Athlete } from './db/schema';

/**
 * Agrégats d'entraînement partagés par les pages du DAL.
 *
 * Le tableau de bord et la page « Progression » lisent la même table dans la
 * même unité de temps (le jour civil de l'athlète) et construisent les mêmes
 * indicateurs — TRIMP quotidien, charge du jour, VO₂max moyennée. Ces
 * constructions vivent ici plutôt que dans l'un des deux modules : dupliquées,
 * elles auraient dérivé, et deux pages de la même appli n'auraient plus annoncé
 * la même forme.
 *
 * C'est aussi ce module qui porte `isRunning`, que `activities.ts` dupliquait
 * faute de pouvoir importer `dashboard.ts` (lequel dépend de lui) : il ne
 * dépend d'aucun autre module du DAL, donc personne n'a plus de cycle à
 * contourner.
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

/**
 * Fenêtre de la VO₂max : 30 jours glissants vs les 30 précédents. C'est la
 * valeur par défaut de Runalyze (`VO2MAX_DAYS = 30`, cf. `buildVo2max`).
 */
export const VO2MAX_WINDOW_DAYS = 30;

const CTL_DELTA_DAYS = 7;

/** La VO₂max n'a de sens qu'en course à pied (`Run`, `TrailRun`, `VirtualRun`…). */
export function isRunning(sportType: string): boolean {
  return sportType.toLowerCase().includes('run');
}

/**
 * Série TRIMP quotidienne, dense du premier jour actif à aujourd'hui inclus
 * (les jours de repos valent 0). Une activité sans FC moyenne exploitable ne
 * produit pas de TRIMP : elle est ignorée plutôt qu'estimée.
 */
export function buildDailyTrimp(
  rows: readonly Activity[],
  profile: Athlete,
  today: string,
): DailyTrimp[] {
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

/** Dernier point de la série de charge, et sa variation de CTL sur 7 jours. */
export function buildFitness(series: readonly LoadPoint[]): FitnessDto | null {
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
export function averageVo2max(
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

/** VO₂max courante (30 j glissants) et son écart aux 30 jours précédents. */
export function buildVo2max(
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
export function buildFitnessUnavailable(
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

/** Ce qui manque pour estimer la VO₂max — cf. {@link buildFitnessUnavailable}. */
export function buildVo2maxUnavailable(
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

/** VO₂max effective d'une course, avec son jour civil et son poids d'agrégation. */
export type RunVo2maxSample = {
  /** Jour civil de la course. */
  date: string;
  value: number;
  /** Temps de déplacement, en secondes — le poids de la moyenne de Runalyze. */
  weightS: number;
};

/**
 * VO₂max effective de **chaque** course exploitable de l'historique, triée du
 * plus ancien au plus récent.
 *
 * Complément de {@link averageVo2max}, qui agrège une fenêtre donnée : ici on
 * garde les points un par un, de quoi tracer le nuage des séances et faire
 * glisser une fenêtre sur la série sans la reparcourir à chaque jour.
 */
export function collectRunVo2max(
  rows: readonly Activity[],
  profile: Athlete,
): RunVo2maxSample[] {
  const samples: RunVo2maxSample[] = [];

  for (const row of rows) {
    if (!isRunning(row.sportType)) continue;

    const value = estimateEffectiveVo2max({
      distanceM: row.distanceM,
      movingTimeS: row.movingTimeS,
      avgHrBpm: row.avgHrBpm,
      maxHrBpm: profile.maxHrBpm,
    });
    if (value === null) continue;

    samples.push({ date: toCivilDate(row.startedAt), value, weightS: row.movingTimeS });
  }

  // Les dates civiles sont `YYYY-MM-DD` : l'ordre lexicographique est l'ordre
  // chronologique, et la fenêtre glissante en dépend.
  samples.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return samples;
}
