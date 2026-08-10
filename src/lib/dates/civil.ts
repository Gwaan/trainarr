/**
 * Dates civiles — fonctions pures, testées.
 *
 * Les instants sont stockés en UTC, mais la notion de « jour » (agrégation
 * quotidienne de la charge, semaines ISO, libellés « hier »/« aujourd'hui »)
 * est civile, dans le fuseau de l'athlète (`src/config/time.ts`). Ce module est
 * le seul endroit où cette conversion est écrite : le DAL, l'affichage et les
 * agrégats doivent la partager, sinon, entre minuit et l'aube, le serveur (en
 * UTC dans le container) et les agrégats ne désignent pas le même jour.
 *
 * Une date civile est une chaîne `YYYY-MM-DD`. Le repère de calcul associé est
 * **minuit UTC** de ce jour : il n'a pas de sens horaire, il sert seulement à
 * compter des jours sans jamais subir de changement d'heure.
 *
 * Sans `server-only` : ces helpers servent aussi au formatage d'affichage.
 */

import { APP_TIME_ZONE } from '@/config/time';

const DAY_MS = 86_400_000;

const civilDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Date civile `YYYY-MM-DD` d'un instant, dans le fuseau de l'athlète. */
export function toCivilDate(instant: Date): string {
  return civilDateFormatter.format(instant);
}

/** Minuit UTC de la date civile — repère de calcul, jamais affiché. */
export function civilDateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Date civile décalée de `days` jours (négatif pour reculer). */
export function shiftCivilDate(date: string, days: number): string {
  return new Date(civilDateToMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Nombre de jours civils de `from` à `to` — négatif si `to` précède `from`. */
export function civilDaysBetween(from: string, to: string): number {
  return Math.round((civilDateToMs(to) - civilDateToMs(from)) / DAY_MS);
}

/** Index du jour dans la semaine ISO : lundi = 0 … dimanche = 6. */
export function isoDayIndex(date: string): number {
  return (new Date(civilDateToMs(date)).getUTCDay() + 6) % 7;
}

/** Lundi de la semaine ISO contenant `date` — clé de regroupement. */
export function isoWeekStart(date: string): string {
  return shiftCivilDate(date, -isoDayIndex(date));
}

/** Dimanche de la semaine ISO contenant `date`. */
export function isoWeekEnd(date: string): string {
  return shiftCivilDate(date, 6 - isoDayIndex(date));
}

/**
 * Numéro de semaine ISO 8601 : la semaine 1 est celle qui contient le premier
 * jeudi de l'année, d'où le passage systématique par le jeudi de la semaine.
 *
 * Le numéro seul ne suffit pas à identifier une semaine (deux « S1 » d'années
 * différentes ne fusionnent pas) : regrouper sur {@link isoWeekStart}.
 */
export function isoWeekNumber(date: string): number {
  const thursday = new Date(civilDateToMs(date) + (3 - isoDayIndex(date)) * DAY_MS);
  const january4 = `${thursday.getUTCFullYear()}-01-04`;
  const firstThursday = new Date(civilDateToMs(january4) + (3 - isoDayIndex(january4)) * DAY_MS);
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}
