/**
 * Bornes calendaires que le formulaire de création doit respecter.
 *
 * Elles sont dérivées de la fenêtre que `plan-service` calculera de son côté :
 * l'attribut `min` du champ date ne remplace pas la validation du service, il
 * évite seulement de proposer une date qu'il refuserait ensuite.
 */

import { MAX_PLAN_WEEKS, MIN_RACE_PLAN_WEEKS, nextPlanStart } from "@/lib/ai/plan-service";
import { shiftCivilDate } from "@/lib/dates/civil";

/**
 * Première date de course acceptable, à partir d'aujourd'hui.
 *
 * Le plan démarre le prochain lundi et couvre
 * `ceil((jours jusqu'à la course + 1) / 7)` semaines : atteindre
 * {@link MIN_RACE_PLAN_WEEKS} semaines exige donc `(MIN_RACE_PLAN_WEEKS − 1) × 7`
 * jours pleins après ce lundi-là.
 */
export function earliestRaceDate(today: string): string {
  return shiftCivilDate(nextPlanStart(today), (MIN_RACE_PLAN_WEEKS - 1) * 7);
}

/**
 * Dernière date de course acceptable, à partir d'aujourd'hui : le dernier jour
 * de la {@link MAX_PLAN_WEEKS}-ième semaine du plan.
 *
 * Au-delà, le service refuse la demande (le modèle ne produit pas un plan plus
 * long d'un seul tenant) — mieux vaut que le champ ne propose pas la date.
 */
export function latestRaceDate(today: string): string {
  return shiftCivilDate(nextPlanStart(today), MAX_PLAN_WEEKS * 7 - 1);
}
