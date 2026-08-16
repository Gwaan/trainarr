/**
 * Formatage propre à la page de détail d'une activité — fonctions pures, testées.
 *
 * Complète `src/app/(app)/_lib/format.ts` (partagé par tout le groupe) avec les
 * formats que seul le détail utilise : horloge exacte plutôt que durée arrondie,
 * allure nue pour les axes de graphe, dénivelé signé, date complète horodatée.
 */

import { APP_TIME_ZONE } from "@/config/time";

import { capitalize, formatClock, formatNumber } from "../../../_lib/format";

/**
 * L'horloge exacte est remontée dans le formatage partagé du groupe : les
 * records de tous les temps et les chronos prévus l'affichent eux aussi, et
 * deux implémentations d'un même chrono finiraient par diverger. Ré-exportée
 * ici parce que c'est de ce module que le détail d'une séance la tient.
 */
export { formatClock };

/** Valeur absente : tiret cadratin, jamais une case vide ni un zéro inventé. */
export const MISSING = "—";

const dateTimeFormatter = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "full",
  timeStyle: "short",
  timeZone: APP_TIME_ZONE,
});

/** Date complète et heure, ex. `Dimanche 9 août 2026 à 18:42`. */
export function formatFullDateTime(date: Date): string {
  return capitalize(dateTimeFormatter.format(date));
}

const dateTimeStampFormatter = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: APP_TIME_ZONE,
});

/**
 * Horodatage discret, ex. `9 août 2026 à 18:42` — pour les mentions de pied
 * (« Généré le… »), où le jour de la semaine et la capitale de
 * `formatFullDateTime` alourdiraient la phrase.
 */
export function formatDateTimeStamp(date: Date): string {
  return dateTimeStampFormatter.format(date);
}

/** Allure nue `4:35` — sans `/km`, pour les axes et les cellules de tableau. */
export function formatPaceValue(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Dénivelé positif, toujours signé, ex. `+124 m`. */
export function formatElevationGain(meters: number): string {
  return `+${formatNumber(Math.max(0, meters), 0)} m`;
}

/** Altitude absolue, ex. `412 m`. */
export function formatAltitude(meters: number): string {
  return `${formatNumber(meters, 0)} m`;
}

/** Cadence, ex. `174 spm`. */
export function formatCadence(spm: number): string {
  return `${formatNumber(spm, 0)} spm`;
}

/**
 * Longueur de foulée, ex. `1,18 m`.
 *
 * Deux décimales : l'écart utile entre deux séances se joue au centimètre
 * (1,18 m contre 1,24 m), qu'un arrondi au décimètre effacerait.
 */
export function formatStride(meters: number): string {
  return `${formatNumber(meters, 2)} m`;
}

/** Foulée nue `1,20` — sans unité, pour les graduations d'axe. */
export function formatStrideTick(meters: number): string {
  return formatNumber(meters, 2);
}

/**
 * Temps passé dans une tranche d'histogramme : `45 s`, `12 min 30`, `48 min`,
 * `1 h 04`.
 *
 * Exact à la seconde, contrairement à `formatDuration` qui arrondit à la minute :
 * une tranche de 90 s ne doit pas s'afficher « 2 min » à côté d'une part de 3 %
 * qui, elle, est calculée sur la valeur réelle.
 */
export function formatBinTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")}`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${String(rest).padStart(2, "0")}`;
}

/**
 * Pourcentage signé, ex. `+4,2 %`, `−1,8 %`. Le signe porte le sens de la
 * dérive : sans lui, « 4,2 % » ne dirait pas dans quel sens le cœur a dérivé.
 * Une valeur qui s'arrondit à zéro ne reçoit aucun signe.
 */
export function formatSignedPercent(value: number, fractionDigits = 1): string {
  const rounded = Number(value.toFixed(fractionDigits));
  const text = formatNumber(value, fractionDigits);
  return rounded > 0 ? `+${text} %` : `${text} %`;
}

/** TRIMP à l'entier — l'unité n'a pas de symbole. */
export function formatTrimp(value: number): string {
  return formatNumber(value, 0);
}

/**
 * Distance d'un axe de graphe : `0`, `2,5`, `10` km — la précision suit le pas
 * de graduation (un pas de 500 m demande une décimale, un pas kilométrique non).
 */
export function formatDistanceTick(meters: number, stepM: number): string {
  return formatNumber(meters / 1000, stepM % 1000 === 0 ? 0 : 1);
}

/** Temps d'un axe de graphe : `12:00`, `1:05:00` — même lecture que l'horloge. */
export function formatTimeTick(seconds: number): string {
  return formatClock(seconds);
}
