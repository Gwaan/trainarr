/**
 * Abscisse en dates civiles — fonctions pures, testées.
 *
 * Les graphes de la page « Progression » partagent tous le même axe : des jours,
 * projetés en millisecondes (`civilDateToMs`) pour que la géométrie générique de
 * `src/lib/chart/` les traite comme n'importe quelle grandeur continue.
 *
 * Pourquoi un descripteur dédié plutôt que `niceStep` : un pas « rond » décimal
 * n'a aucun sens sur des jours (2,5 jours ne se lit pas), et une graduation tous
 * les 30 jours tombe à des dates arbitraires alors qu'un multiple de 7 garde le
 * même jour de semaine. C'est la même raison qui a donné `timeStep` pour les
 * durées.
 */

import { APP_TIME_ZONE } from "@/config/time";
import type { XAxisSpec } from "@/lib/chart/series";

const DAY_MS = 86_400_000;

/**
 * Pas de graduation possibles, **en jours**. Des multiples de la semaine tant
 * qu'on lit des semaines (7 → 56), puis des durées de l'ordre du trimestre, du
 * semestre et de l'année. Le pas de 3 jours ne sert qu'aux tout premiers jours
 * d'historique, où la fenêtre demandée dépasse largement les données.
 *
 * L'échelle est resserrée entre 28 et 91 jours (56 : deux mois) parce qu'un
 * saut direct ferait passer un semestre de six graduations à deux.
 */
const STEP_DAYS = [3, 7, 14, 28, 56, 91, 182, 365, 730] as const;

/**
 * Densité visée par défaut. Quatre et non six : une étiquette de date est trois
 * fois plus large qu'une distance, et six d'entre elles se touchent dès qu'on
 * regarde la page sur un téléphone (mesuré à 390 px).
 */
export const DATE_TARGET_TICKS = 4;

/**
 * Plus petit pas de l'échelle qui tient l'axe en `targetCount` intervalles
 * **entiers** au plus — même règle que {@link timeStep}, pour la même raison :
 * c'est le nombre d'étiquettes qu'il faut borner, une de trop et elles se
 * chevauchent.
 *
 * Intervalles entiers et non fraction exacte : une année fait 4,01 trimestres
 * de 91 jours, et l'écarter pour ce centième reviendrait à ne graduer l'axe que
 * deux fois. C'est le nombre de repères posés qui compte, pas la division.
 */
export function dateStep(spanMs: number, targetCount: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0 || targetCount <= 0) return DAY_MS;

  const spanDays = spanMs / DAY_MS;
  for (const step of STEP_DAYS) {
    if (Math.floor(spanDays / step) <= targetCount) return step * DAY_MS;
  }

  return STEP_DAYS[STEP_DAYS.length - 1] * DAY_MS;
}

const dayMonthFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  timeZone: APP_TIME_ZONE,
});

const monthYearFormatter = new Intl.DateTimeFormat("fr-FR", {
  month: "short",
  year: "2-digit",
  timeZone: APP_TIME_ZONE,
});

const fullDateFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});

/** Au-delà de deux mois entre deux repères, le jour n'apporte plus rien. */
const COARSE_STEP_MS = 60 * DAY_MS;

/*
 * **Précondition de fuseau.** Les abscisses de cet axe viennent de
 * `civilDateToMs`, qui rend minuit **UTC** du jour civil ; les formateurs
 * ci-dessus les relisent dans `APP_TIME_ZONE`. La date affichée n'est la bonne
 * que parce que ce fuseau est toujours en avance sur UTC (Europe/Paris, +1/+2) :
 * sous un fuseau à décalage négatif, minuit UTC retomberait la veille et toutes
 * les graduations glisseraient d'un jour.
 */

/** Graduation : `12 mai` sur les pas courts, `mai 25` sur les longs. */
export function formatDateTick(valueMs: number, stepMs: number): string {
  const instant = new Date(valueMs);
  return stepMs < COARSE_STEP_MS
    ? dayMonthFormatter.format(instant)
    : monthYearFormatter.format(instant);
}

/** Date complète, pour le repère du curseur : `12 mai 2026`. */
export function formatFullDay(valueMs: number): string {
  return fullDateFormatter.format(new Date(valueMs));
}

export const DATE_AXIS: XAxisSpec = {
  step: dateStep,
  targetTicks: DATE_TARGET_TICKS,
  formatTick: formatDateTick,
  label: (domain) => `du ${formatFullDay(domain.min)} au ${formatFullDay(domain.max)}`,
};
