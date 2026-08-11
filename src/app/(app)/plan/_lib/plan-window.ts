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

import {
  MAX_PLAN_WEEKS,
  MIN_RACE_PLAN_WEEKS,
  firstWeekCountsAsPlanWeek,
} from "@/lib/ai/plan-service";
import { isoWeekStart, shiftCivilDate } from "@/lib/dates/civil";

/**
 * Combien de semaines à l'avance un programme peut être planifié.
 *
 * Au-delà, le plan serait écrit sur une charge d'entraînement qui n'aura plus
 * cours le jour où il démarre : les huit semaines qui le précèdent l'auront
 * changée.
 */
export const MAX_PLAN_START_LEAD_WEEKS = 8;

/**
 * Premier jour de démarrage acceptable : **aujourd'hui**.
 *
 * C'est aussi la valeur par défaut du champ. Démarrer aujourd'hui est permis (la
 * séance du jour reste faisable, et le rapprochement la marquera réalisée si elle
 * l'est déjà), démarrer hier ne l'est pas. Le jour de la semaine, lui, n'a plus
 * d'importance : un départ en milieu de semaine ouvre une première semaine
 * entamée, cf. `planWindow` dans `plan-service.ts`.
 */
export function earliestPlanStart(today: string): string {
  return today;
}

/** Dernier jour de démarrage acceptable : {@link MAX_PLAN_START_LEAD_WEEKS} plus tard. */
export function latestPlanStart(today: string): string {
  return shiftCivilDate(today, MAX_PLAN_START_LEAD_WEEKS * 7);
}

/**
 * Première date de course acceptable, pour un programme démarrant le `startsOn`.
 *
 * Le plan couvre les semaines ISO qui vont du lundi de la semaine de départ
 * (l'**ancre**) au jour de la course inclus : atteindre {@link MIN_RACE_PLAN_WEEKS}
 * semaines d'entraînement exige donc autant de fois sept jours pleins après cette
 * ancre-là, moins la semaine du départ quand elle en porte
 * ({@link firstWeekCountsAsPlanWeek} — un départ du vendredi au dimanche ne la
 * fait pas compter, et repousse la course d'une semaine). C'est exactement le
 * calcul de `planWindow` : les deux arithmétiques doivent dire la même chose,
 * sans quoi le champ proposerait une date que l'action refuserait.
 */
export function earliestRaceDate(startsOn: string): string {
  const weeksAfterAnchor = MIN_RACE_PLAN_WEEKS - (firstWeekCountsAsPlanWeek(startsOn) ? 1 : 0);
  return shiftCivilDate(isoWeekStart(startsOn), weeksAfterAnchor * 7);
}

/**
 * Dernière date de course acceptable pour un programme démarrant le `startsOn` :
 * le dernier jour de la {@link MAX_PLAN_WEEKS}-ième semaine comptée depuis
 * l'ancre.
 *
 * Au-delà, le service refuse la demande (le modèle ne produit pas un plan plus
 * long d'un seul tenant) — mieux vaut que le champ ne propose pas la date.
 */
export function latestRaceDate(startsOn: string): string {
  return shiftCivilDate(isoWeekStart(startsOn), MAX_PLAN_WEEKS * 7 - 1);
}
