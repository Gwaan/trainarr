/**
 * Décisions pures du relevé bien-être — aucun réseau, aucune base.
 *
 * Ce qui se décide ici : quand le relevé du jour est dû, et quelle fenêtre de
 * dates il redemande. Le pendant de `lib/weather/forecast-plan.ts` pour les
 * prévisions, en beaucoup plus court — parce que la fenêtre glissante fait ici
 * tout le travail qu'un compteur de tentatives fait là-bas.
 *
 * ## Un relevé par jour, mais une fenêtre de quatorze
 *
 * Les mesures d'une journée **se complètent après coup** : la montre synchronise
 * quand elle veut, le sommeil d'une nuit peut n'arriver sur intervals.icu que
 * plusieurs heures après la FC de repos du même jour, et une balance pesée le
 * soir n'est visible que le lendemain. Redemander à chaque relevé les
 * {@link WELLNESS_WINDOW_DAYS} derniers jours coûte une requête et referme
 * toutes ces fenêtres à la fois — c'est aussi ce qui rattrape une journée que
 * l'application aurait passée éteinte.
 */

import { APP_TIME_ZONE } from '@/config/time';
import { shiftCivilDate, toCivilDate } from '@/lib/dates/civil';

/**
 * Profondeur de la fenêtre redemandée à chaque relevé, aujourd'hui compris.
 *
 * Quatorze jours : c'est la fenêtre sur laquelle la médiane de FC de repos est
 * calculée (cf. `src/lib/metrics/resting-hr.ts`), et il serait absurde de
 * proposer une valeur sur une période plus large que celle qu'on tient à jour.
 * C'est aussi, en pratique, très au-delà du retard d'une synchronisation de
 * montre — donc une marge, pas une cible.
 */
export const WELLNESS_WINDOW_DAYS = 14;

/**
 * Heure locale du relevé quotidien.
 *
 * 9 h, et pas 6 h comme la météo : ce relevé ne lit pas un modèle qui tourne la
 * nuit, il lit ce que la **montre** a poussé vers intervals.icu, ce qui n'arrive
 * qu'une fois le réveil sonné et le téléphone synchronisé. Relever au petit
 * matin afficherait presque toujours la nuit de la veille — techniquement juste,
 * inutilisable au quotidien.
 *
 * Se tromper d'heure n'est pas grave et c'est délibéré : la fenêtre de
 * {@link WELLNESS_WINDOW_DAYS} jours du lendemain écrira de toute façon les
 * mesures arrivées trop tard.
 */
export const WELLNESS_READING_HOUR = 9;

const localHourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIME_ZONE,
  hour: '2-digit',
  // `hourCycle` explicite : selon la version d'ICU, `hour12: false` rend minuit
  // « 24 » et non « 00 ».
  hourCycle: 'h23',
});

/** Heure locale (0–23) d'un instant, dans le fuseau de l'application. */
function localHour(instant: Date): number {
  return Number(localHourFormatter.format(instant));
}

/**
 * Le **marqueur** du relevé en cours : la date civile du dernier passage de
 * {@link WELLNESS_READING_HOUR} révolu.
 *
 * Même mécanique que `forecastReadingMarker` : comparer un marqueur mémorisé à
 * celui de l'instant donne d'un coup le rendez-vous quotidien **et** son
 * rattrapage. Une application arrêtée à 9 h revient avec un marqueur en retard
 * et relève au premier cycle, sans qu'aucun code de rattrapage n'existe.
 */
export function wellnessReadingMarker(now: Date): string {
  const today = toCivilDate(now);
  return localHour(now) < WELLNESS_READING_HOUR ? shiftCivilDate(today, -1) : today;
}

/**
 * Le relevé du jour est-il dû ?
 *
 * `lastReadingDay` est le marqueur du dernier relevé **abouti**, `null` s'il n'y
 * en a jamais eu. Un marqueur postérieur à l'instant courant (horloge reculée)
 * ne déclenche rien : ce relevé-là a déjà eu lieu, le refaire ne l'améliorerait
 * pas.
 *
 * Il n'y a pas de reprise à borner ici, contrairement aux prévisions : un relevé
 * en échec ne mémorise rien, il est donc redû au cycle suivant, et l'appelant se
 * charge de ne pas en journaliser dix par jour.
 */
export function isWellnessReadingDue(lastReadingDay: string | null, now: Date): boolean {
  if (lastReadingDay === null) return true;
  // Comparaison lexicographique : sur des dates civiles `YYYY-MM-DD` bien
  // formées, elle coïncide avec l'ordre chronologique.
  return lastReadingDay < wellnessReadingMarker(now);
}

/** Bornes civiles, incluses, de la fenêtre redemandée par un relevé. */
export type WellnessWindow = {
  oldest: string;
  newest: string;
};

/**
 * La fenêtre à redemander : les {@link WELLNESS_WINDOW_DAYS} derniers jours, le
 * jour courant compris.
 *
 * Bornée à aujourd'hui et jamais au-delà : demander des jours futurs à un
 * service qui n'enregistre que du passé n'apporterait rien et brouillerait la
 * lecture des journaux.
 */
export function wellnessWindow(now: Date): WellnessWindow {
  const newest = toCivilDate(now);
  return { oldest: shiftCivilDate(newest, -(WELLNESS_WINDOW_DAYS - 1)), newest };
}
