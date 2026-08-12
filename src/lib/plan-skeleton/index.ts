/**
 * Le squelette d'un plan d'entraînement, calculé par l'appli.
 *
 * Point d'entrée du module : la périodisation, la grille de qualité, le placement
 * des jours et le générateur qui les assemble. Tout est **pur** — ni base, ni
 * réseau, ni `server-only`, ni horloge, ni aléa —, et l'ensemble se teste sans
 * rien monter.
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
export { planPhases, type PlanPhase, type PlanPhasesParams } from './phases';
export { goalFamily, qualityZones, QUALITY_ZONE_KINDS, type QualityZone } from './quality';
export {
  buildPlanSkeleton,
  type PlanSkeletonParams,
  type QualitySlot,
  type SkeletonWeek,
} from './skeleton';
