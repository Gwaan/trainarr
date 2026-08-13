/**
 * Le squelette d'un plan d'entraînement, calculé par l'appli.
 *
 * Point d'entrée du module : la périodisation, la grille de qualité, le placement
 * des jours et le générateur qui les assemble. Tout est **pur** — ni base, ni
 * réseau, ni `server-only`, ni horloge, ni aléa —, et l'ensemble se teste sans
 * rien monter.
 *
 * Ce que le plan **est** se décide d'abord par l'{@link PlanIntent} : préparer
 * une course, courir plus vite, perdre du poids ou reprendre. Ces quatre
 * intentions ne sont pas quatre libellés d'un même plan — elles changent la
 * périodisation, la grille de qualité, le nombre de séances dures et la sortie
 * longue. Chaque paramètre et la recherche qui le fonde vivent dans `intent.ts`.
 *
 * Le contrat, du plus gros au plus fin : {@link buildPlanSkeleton} rend une
 * semaine par semaine du plan, dont les footings et la sortie longue sont
 * entièrement écrits et dont les séances de qualité ne sont que des créneaux
 * ({@link QualitySlot}) — jour, zone, `kind`, budget kilométrique — à faire
 * remplir séance par séance par le coach.
 *
 * Le squelette **refuse** les plans qu'il ne peut pas écrire honnêtement : une
 * cible hebdomadaire qui ne finance pas les séances demandées lève
 * {@link PlanSkeletonInfeasibleError}, à charge de l'appelant d'en faire un
 * message d'UI ({@link minFundableWeeklyKm} dit à partir de quel volume une
 * semaine tient).
 */

export {
  isDevelopmentPhase,
  QUALITY_SHARE,
  weeklyQualityShares,
  type CompositionAnchor,
} from './composition';
export { placeSessionDays, type PlaceSessionDaysParams, type SessionDayPlacement } from './days';
export {
  minFundableWeeklyKm,
  PlanSkeletonInfeasibleError,
  type PlanSkeletonUnderfundedWeek,
} from './feasibility';
export {
  fitnessTestWeekNumbers,
  FITNESS_TEST_CADENCE_WEEKS,
  FITNESS_TEST_EFFORT_M,
  FITNESS_TEST_KIND,
  FITNESS_TEST_SESSION_KM,
} from './fitness-test';
export { PLAN_INTENTS, type PlanIntent } from './intent';
export { planPhases, type PlanPhase, type PlanPhasesParams } from './phases';
export { goalFamily, qualityZones, QUALITY_ZONE_KINDS, type QualityZone } from './quality';
export {
  qualityEffortCapKm,
  QUALITY_EFFORT_CAPS,
  sessionEffortKm,
  sessionEffortM,
} from './quality-load';
export {
  buildPlanSkeleton,
  SESSION_KINDS,
  type PlanSkeletonParams,
  type QualitySlot,
  type SkeletonWeek,
} from './skeleton';
