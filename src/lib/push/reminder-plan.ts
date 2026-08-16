/**
 * Quand le rappel de la séance du jour est dû — décisions pures, aucune base,
 * aucun réseau.
 *
 * Le pendant de `lib/weather/forecast-plan.ts` (relevé de 6 h) et de
 * `lib/intervals/wellness-plan.ts` (bien-être à 9 h), avec **une pièce de plus
 * qu'eux** : une péremption.
 *
 * ## Rien n'est planifié — la boucle repasse et redemande
 *
 * Comme ses deux aînés, ce module n'ordonnance rien. Le repère est une **heure
 * fixe**, matérialisée par un marqueur (la date civile du dernier passage de
 * cette heure). La boucle des notifications passe toutes les minutes et
 * redemande à chaque tour ; l'idempotence est portée par `claimNotice`, en base,
 * sur ce marqueur. C'est ce qui donne le rattrapage gratuitement : une
 * application redéployée à 7 h revient avec un marqueur non réclamé et notifie
 * au premier cycle, sans qu'aucun code de rattrapage n'ait à exister.
 *
 * ## Mais un rappel a une date de péremption, contrairement à un relevé
 *
 * C'est la différence de nature avec la météo. Relever une prévision à 15 h vaut
 * mieux que ne pas la relever du tout — la donnée sert encore. Prévenir à 23 h
 * qu'une séance était prévue le matin ne sert **rien** : la journée est passée,
 * il n'y a plus rien à en faire, et la bannière ne fait que rappeler ce qui n'a
 * pas été fait. C'est culpabilisant et inutile.
 *
 * D'où {@link isReminderDue} : passé {@link REMINDER_WINDOW_HOURS} heures, on ne
 * réclame **même pas** le marqueur et rien ne part. Conséquence voulue et
 * assumée : une application redémarrée à 9 h rattrape le rappel du matin,
 * redémarrée à 15 h, non — et le marqueur du jour reste libre, ce qui est sans
 * effet puisque la fenêtre ne rouvrira que le lendemain, sur un autre marqueur.
 */

import { APP_TIME_ZONE } from '@/config/time';
import { shiftCivilDate, toCivilDate } from '@/lib/dates/civil';

/**
 * Heure locale du rappel, dans le fuseau de l'application.
 *
 * 7 h, et **pas** 6 h : le relevé des prévisions tourne à 6 h
 * (`FORECAST_READING_HOUR`) et la boucle météo a besoin de quelques cycles pour
 * l'écrire. Notifier à la même heure ferait partir la moitié des bannières avec
 * la prévision de la veille — ou sans prévision du tout, le premier matin.
 * Une heure de marge est très au-delà de ce qu'un relevé demande, et 7 h reste
 * avant une sortie matinale.
 */
export const REMINDER_HOUR = 7;

/**
 * Largeur de la fenêtre d'envoi, en heures pleines, à partir de
 * {@link REMINDER_HOUR}.
 *
 * Six heures, soit 7 h → 13 h. Assez large pour absorber un redémarrage, une
 * panne de réseau ou un déploiement matinal ; assez étroite pour qu'un rappel
 * arrive toujours **avant** que la journée n'ait basculé.
 */
export const REMINDER_WINDOW_HOURS = 6;

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
 * Le **marqueur** du rappel en cours : la date civile du dernier passage de
 * {@link REMINDER_HOUR} révolu.
 *
 * C'est la clé de déduplication passée à `claimNotice` — un rappel par athlète
 * et par matinée, quel que soit le nombre de cycles.
 *
 * Avant 7 h, le marqueur est celui d'hier : c'est cohérent avec le sens de
 * « dernier passage révolu », et sans conséquence pratique puisque
 * {@link isReminderDue} interdit alors tout envoi. Le garder juste plutôt que
 * commode évite qu'un futur appelant, qui réclamerait hors fenêtre, ne brûle le
 * marqueur du matin à venir.
 */
export function reminderMarker(now: Date): string {
  const today = toCivilDate(now);
  return localHour(now) < REMINDER_HOUR ? shiftCivilDate(today, -1) : today;
}

/**
 * Sommes-nous dans la fenêtre où un rappel a encore du sens ?
 *
 * `[REMINDER_HOUR, REMINDER_HOUR + REMINDER_WINDOW_HOURS[`, borne haute exclue.
 * Hors de là, l'appelant ne doit **ni réclamer le marqueur ni envoyer** : c'est
 * la garde de péremption décrite en tête de module.
 *
 * La fenêtre est bornée à 24 h par construction (six heures depuis 7 h) : elle
 * ne peut pas déborder sur le lendemain, et il n'y a donc aucun cas où l'heure
 * comparée aurait à repasser par zéro.
 */
export function isReminderDue(now: Date): boolean {
  const hour = localHour(now);
  return hour >= REMINDER_HOUR && hour < REMINDER_HOUR + REMINDER_WINDOW_HOURS;
}
