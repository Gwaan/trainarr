/**
 * Mise en forme des libellés du plan — fonctions pures, testées.
 *
 * Les dates manipulées ici sont des **dates civiles** `YYYY-MM-DD` (celles que
 * le DAL renvoie pour un plan et ses séances). Leur repère de calcul est minuit
 * UTC, et le formatage se fait dans le fuseau de l'athlète : le container tourne
 * en UTC, sans `timeZone` explicite les libellés glisseraient d'un jour.
 *
 * Aucun import `server-only` : ces helpers servent aussi bien au rendu serveur
 * du plan qu'aux libellés du formulaire de création, qui est un composant
 * client.
 */

import { APP_TIME_ZONE } from "@/config/time";
import { civilDateToMs } from "@/lib/dates/civil";

import { capitalize } from "../../_lib/format";

/** Jours ISO : l'index 0 vaut lundi, l'index 6 dimanche (`longRunDay` − 1). */
export const ISO_DAY_LABELS = [
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
  "Dimanche",
] as const;

/** Repère de calcul d'une date civile — cf. `src/lib/dates/civil.ts`. */
function asDate(civilDate: string): Date {
  return new Date(civilDateToMs(civilDate));
}

const dayNumberFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  timeZone: APP_TIME_ZONE,
});

const monthFormatter = new Intl.DateTimeFormat("fr-FR", {
  month: "short",
  timeZone: APP_TIME_ZONE,
});

const yearFormatter = new Intl.DateTimeFormat("fr-FR", {
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});

const shortWeekdayFormatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short",
  timeZone: APP_TIME_ZONE,
});

/**
 * Jour de la sortie longue : `1` → « Lundi » … `7` → « Dimanche ». La valeur est
 * bornée à 1..7 par le DAL (`PLAN_LIMITS.longRunDay`).
 */
export function formatIsoDay(longRunDay: number): string {
  return ISO_DAY_LABELS[longRunDay - 1];
}

/** Date courte, ex. `12 oct.`. */
export function formatCivilDay(civilDate: string): string {
  const date = asDate(civilDate);
  return `${dayNumberFormatter.format(date)} ${monthFormatter.format(date)}`;
}

/**
 * Intervalle de dates, aussi court que possible : `18–24 août` dans un même
 * mois, `28 août – 3 sept.` sinon, avec les millésimes quand l'intervalle
 * franchit une année (une semaine de plan peut chevaucher le 31 décembre).
 *
 * Un intervalle d'un seul jour se rend comme une date seule : une première
 * semaine entamée le dimanche ne couvre que ce dimanche-là, et « 16–16 août »
 * annoncerait une étendue qu'elle n'a pas.
 */
export function formatCivilRange(from: string, to: string): string {
  if (from === to) return formatCivilDay(from);

  const start = asDate(from);
  const end = asDate(to);

  const sameYear = yearFormatter.format(start) === yearFormatter.format(end);
  if (sameYear) {
    const sameMonth = monthFormatter.format(start) === monthFormatter.format(end);
    if (sameMonth) {
      return `${dayNumberFormatter.format(start)}–${dayNumberFormatter.format(end)} ${monthFormatter.format(end)}`;
    }
    return `${formatCivilDay(from)} – ${formatCivilDay(to)}`;
  }

  return `${formatCivilDay(from)} ${yearFormatter.format(start)} – ${formatCivilDay(to)} ${yearFormatter.format(end)}`;
}

/**
 * Abréviation du jour de la semaine, ex. `Lun`.
 *
 * Le point abréviatif de `Intl` (« lun. ») est retiré : ces libellés voisinent
 * des chiffres tabulaires, et un point flottant en casserait l'alignement.
 */
export function formatWeekdayShort(civilDate: string): string {
  return capitalize(shortWeekdayFormatter.format(asDate(civilDate)).replace(".", ""));
}

/** Quantième du mois, ex. `18` — sans zéro de tête. */
export function formatDayNumber(civilDate: string): string {
  return dayNumberFormatter.format(asDate(civilDate));
}

/** Jour d'une séance dans sa semaine, ex. `Lun 18`. */
export function formatSessionDay(civilDate: string): string {
  return `${formatWeekdayShort(civilDate)} ${formatDayNumber(civilDate)}`;
}
