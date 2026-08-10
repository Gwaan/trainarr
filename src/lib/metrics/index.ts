/**
 * Calculs physiologiques.
 *
 * Fonctions pures, sans accès base ni réseau. Règle du projet : ne jamais
 * approximer — toute valeur non calculable faute de données renvoie `null`.
 * Chaque implémentation cite la source de sa formule dans son module.
 */

export { computeTrimp, type Sex, type TrimpInput } from './trimp';
export { computeLoadSeries, type DailyTrimp, type LoadPoint } from './load';
export { estimateVdot, type EffortInput } from './vdot';
export { estimateEffectiveVo2max, type EffectiveVo2maxInput } from './vo2max';
export { paceSecPerKm } from './pace';
export { smoothPace } from './pace-smoothing';
export { MAX_CHART_POINTS, resamplePoints, type SeriesSample } from './resample';
export {
  FULL_SPLIT_TOLERANCE_M,
  computeSplits,
  isPartialSplit,
  type Split,
} from './splits';
export { computeHrZones, type HrZoneNumber, type ZoneTime } from './hr-zones';
