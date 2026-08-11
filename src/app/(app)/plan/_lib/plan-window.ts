/**
 * Bornes calendaires que le formulaire de création doit respecter.
 *
 * Elles sont dérivées de la fenêtre que `plan-service` calculera de son côté :
 * les attributs `min`/`max` d'un champ date ne remplacent pas la validation du
 * service, ils évitent seulement de proposer une date qu'il refuserait ensuite.
 *
 * Les bornes de la course se calculent depuis le **jour où le programme
 * démarre**, pas depuis aujourd'hui : c'est ce jour-là qui ancre la fenêtre du
 * plan, et l'athlète peut le repousser de plusieurs semaines.
 */

import { MAX_PLAN_WEEKS, MIN_RACE_PLAN_WEEKS, nextPlanStart } from "@/lib/ai/plan-service";
import { shiftCivilDate } from "@/lib/dates/civil";

/**
 * Combien de semaines à l'avance un programme peut être planifié.
 *
 * Au-delà, le plan serait écrit sur une charge d'entraînement qui n'aura plus
 * cours le jour où il démarre : les huit semaines qui le précèdent l'auront
 * changée.
 */
export const MAX_PLAN_START_LEAD_WEEKS = 8;

/**
 * Premier jour de démarrage acceptable — le prochain lundi, aujourd'hui même
 * si l'on est lundi.
 *
 * C'est aussi la valeur par défaut du champ : démarrer aujourd'hui est permis
 * (la séance du jour reste faisable, et le rapprochement la marquera réalisée
 * si elle l'est déjà), démarrer hier ne l'est pas. Le jour de la semaine, lui,
 * n'est pas négociable : cf. `planStart` dans `plan-service.ts`.
 */
export function earliestPlanStart(today: string): string {
  return nextPlanStart(today);
}

/** Dernier jour de démarrage acceptable : le huitième lundi proposé. */
export function latestPlanStart(today: string): string {
  return shiftCivilDate(nextPlanStart(today), (MAX_PLAN_START_LEAD_WEEKS - 1) * 7);
}

/**
 * Première date de course acceptable, pour un programme démarrant le lundi
 * `startsOn`.
 *
 * Le plan couvre `ceil((jours jusqu'à la course + 1) / 7)` semaines : atteindre
 * {@link MIN_RACE_PLAN_WEEKS} semaines exige donc `(MIN_RACE_PLAN_WEEKS − 1) × 7`
 * jours pleins après ce lundi-là.
 */
export function earliestRaceDate(startsOn: string): string {
  return shiftCivilDate(startsOn, (MIN_RACE_PLAN_WEEKS - 1) * 7);
}

/**
 * Dernière date de course acceptable pour un programme démarrant le lundi
 * `startsOn` : le dernier jour de sa {@link MAX_PLAN_WEEKS}-ième semaine.
 *
 * Au-delà, le service refuse la demande (le modèle ne produit pas un plan plus
 * long d'un seul tenant) — mieux vaut que le champ ne propose pas la date.
 */
export function latestRaceDate(startsOn: string): string {
  return shiftCivilDate(startsOn, MAX_PLAN_WEEKS * 7 - 1);
}
