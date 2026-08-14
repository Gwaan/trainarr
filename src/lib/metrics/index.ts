/**
 * Calculs physiologiques.
 *
 * Fonctions pures, sans accès base ni réseau. Règle du projet : ne jamais
 * approximer — toute valeur non calculable faute de données renvoie `null`.
 * Chaque implémentation cite la source de sa formule dans son module.
 */

export { computeTrimp, type Sex, type TrimpInput } from './trimp';
export { computeLoadSeries, type DailyTrimp, type LoadPoint } from './load';
export {
  InvalidRacePerformanceError,
  REFERENCE_DISTANCES,
  VDOT_ZONE_FRACTIONS,
  estimateVdot,
  paceSecPerKmAtVdotFraction,
  trainingPacesFromRace,
  vdotFromRace,
  type EffortInput,
  type PaceZone,
  type ReferenceDistance,
  type TrainingPaces,
} from './vdot';
export { estimateEffectiveVo2max, type EffectiveVo2maxInput } from './vo2max';
export { paceSecPerKm } from './pace';
export { deriveVelocity } from './velocity';
export { smoothPace } from './pace-smoothing';
export { MAX_CHART_POINTS, resamplePoints, type SeriesSample } from './resample';
export {
  FULL_SPLIT_TOLERANCE_M,
  computeSplits,
  isPartialSplit,
  type Split,
} from './splits';
export { computeHrZones, hrZoneOf, type HrZoneNumber, type ZoneTime } from './hr-zones';
export {
  EASY_HR_ZONE,
  PRESCRIBED_HR_ZONES,
  PRESCRIPTION_MAX_HR_BOUNDS,
  canPrescribeHeartRate,
  hrZoneTargetBpm,
  type HrTargetBpm,
  type PrescribedHrZone,
} from './hr-targets';
export { strideLengthM, strideSeries } from './stride';
export {
  computeTimeDistribution,
  hrDistribution,
  paceDistribution,
  type DistributionBin,
  type DistributionOptions,
} from './distribution';
export { computeDecoupling, type Decoupling, type HalfStats } from './decoupling';
export {
  BEST_SEGMENT_TARGETS_M,
  computeBestSegments,
  type BestSegment,
} from './best-segments';
export { SUSTAINED_HR_WINDOW_S, sustainedMaxHrBpm } from './sustained-hr';
