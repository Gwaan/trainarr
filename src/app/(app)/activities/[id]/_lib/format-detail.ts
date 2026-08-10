/**
 * Formatage propre à la page de détail d'une activité — fonctions pures, testées.
 *
 * Complète `src/app/(app)/_lib/format.ts` (partagé par tout le groupe) avec les
 * formats que seul le détail utilise : horloge exacte plutôt que durée arrondie,
 * allure nue pour les axes de graphe, dénivelé signé, date complète horodatée.
 */

import { APP_TIME_ZONE } from "@/config/time";

import { capitalize, formatNumber } from "../../../_lib/format";

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

/**
 * Durée exacte façon chronomètre : `48:12`, `1:04:32`.
 *
 * Le détail d'une séance affiche la durée à la seconde (l'arrondi de
 * `formatDuration` convient aux totaux hebdomadaires, pas à une sortie).
 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(rest).padStart(2, "0")}`
    : `${mm}:${String(rest).padStart(2, "0")}`;
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
