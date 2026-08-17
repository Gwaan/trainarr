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
export {
  CALIBRATED_WINDOW_MIN,
  PREDICTED_DISTANCES,
  SPECULATIVE_FACTOR,
  predictedRaceTimeS,
  predictedRaces,
  predictionConfidence,
  type PredictionConfidence,
  type RacePrediction,
} from './race-prediction';
export { computeMonotonySeries, type MonotonyPoint } from './monotony';
export {
  NEUTRAL_VO2MAX_CORRECTION_FACTOR,
  estimateEffectiveVo2max,
  type EffectiveVo2maxInput,
} from './vo2max';
export {
  VO2MAX_CORRECTION_FACTOR_BOUNDS,
  computeVo2maxCorrection,
  isPlausibleCorrectionFactor,
  type AutomaticVo2maxCorrection,
  type RaceCalibration,
  type RaceCalibrationInput,
  type RaceCalibrationStatus,
  type Vo2maxCorrection,
  type Vo2maxCorrectionInput,
  type Vo2maxCorrectionUnavailable,
} from './vo2max-correction';
export {
  ELEVATION_NOISE_THRESHOLD_M,
  elevationChange,
  elevationMoves,
  type ElevationChange,
  type ElevationMove,
} from './elevation';
export {
  ASCENT_COEF_BOUNDS,
  DEFAULT_ASCENT_COEF_M,
  DEFAULT_DESCENT_COEF_M,
  DESCENT_COEF_BOUNDS,
  correctedDistanceM,
  type ActivityElevation,
  type ElevationCorrection,
} from './elevation-correction';
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
export {
  HR_ZONE_FLOORS_PERCENT,
  computeHrZones,
  hrZoneAnchor,
  hrZoneOf,
  type HrZoneAnchor,
  type HrZoneNumber,
  type ZoneTime,
} from './hr-zones';
export {
  LTHR_BOUNDS,
  LTHR_MIN_SESSIONS,
  LTHR_REPROPOSE_DELTA_BPM,
  LTHR_SOURCES,
  LTHR_SUGGESTION_DELTA_BPM,
  THRESHOLD_BLOCK_MIN_S,
  TIME_TRIAL_TAIL_S,
  blockPlateauHrBpm,
  lthrCandidate,
  lthrSuggestion,
  medianLthrBpm,
  timeTrialLthrBpm,
  type LthrCandidate,
  type LthrSource,
  type LthrSuggestionInput,
} from './lthr';
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
  fastestSegmentWindow,
  type BestSegment,
} from './best-segments';
export {
  EXECUTION_GAPS,
  EXECUTION_METRICS,
  EXECUTION_STANDINGS,
  executionSummary,
  sessionExecution,
  type ExecutionBand,
  type ExecutionGap,
  type ExecutionMetric,
  type ExecutionRepeats,
  type ExecutionRow,
  type ExecutionStanding,
  type SessionExecution,
  type SessionExecutionInput,
} from './session-execution';
export { SUSTAINED_HR_WINDOW_S, sustainedMaxHrBpm } from './sustained-hr';
export {
  RESTING_HR_MIN_SAMPLE,
  RESTING_HR_REPROPOSE_DELTA_BPM,
  RESTING_HR_SUGGESTION_DELTA_BPM,
  RESTING_HR_WINDOW_DAYS,
  medianRestingHrBpm,
  restingHrSuggestionBpm,
  type RestingHrSuggestionInput,
} from './resting-hr';
