/**
 * Formatage des valeurs du tableau de bord — fonctions pures, testées.
 *
 * Le DAL renvoie des valeurs brutes (secondes, mètres, flottants) : toute mise
 * en forme destinée à l'affichage vit ici, jamais dans les composants.
 *
 * Conventions françaises : virgule décimale, signe moins typographique (U+2212,
 * aligné sur les chiffres tabulaires de JetBrains Mono), heures « 1 h 05 ».
 */

import { APP_TIME_ZONE } from "@/config/time";
import { civilDaysBetween, toCivilDate } from "@/lib/dates/civil";

const MINUS = "−";

// `timeZone` explicite partout : le container tourne en UTC, alors que le DAL
// agrège les jours en heure locale de l'athlète. Sans ça, entre minuit et
// l'aube, l'affichage et les données désignent des jours différents.
const weekdayFormatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  timeZone: APP_TIME_ZONE,
});

const shortDateFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  timeZone: APP_TIME_ZONE,
});

const shortDateWithYearFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});

const fullDateFormatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: APP_TIME_ZONE,
});

/** Première lettre en capitale — les libellés `Intl` français sont en minuscules. */
export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Nombre arrondi à `fractionDigits`, virgule décimale et signe moins
 * typographique. Un arrondi qui tombe à zéro ne porte jamais de signe.
 */
export function formatNumber(value: number, fractionDigits = 0): string {
  const fixed = Math.abs(value).toFixed(fractionDigits);
  const decimal = fixed.replace(".", ",");
  return value < 0 && Number(fixed) !== 0 ? `${MINUS}${decimal}` : decimal;
}

/** VO₂max au dixième, ex. `52,3`. */
export function formatVo2max(value: number): string {
  return formatNumber(value, 1);
}

/**
 * Facteur correctif de la VO₂max, écrit comme il se lit : `×1,11`, `×1,128`,
 * `×1`.
 *
 * Trois décimales **au plus**, et les zéros de queue tombent : un facteur
 * neutre s'écrit « ×1 » et non « ×1,000 », qui laisserait croire à une
 * précision de mesure là où il n'y a qu'une absence de recalage. Le millième est
 * la précision retenue pour la saisie manuelle (cf. `data/vo2max-correction`),
 * c'est donc lui qui plafonne l'affichage — un facteur qui se relirait
 * autrement qu'il ne s'écrit serait déroutant.
 *
 * {@link formatNumber} ne convient pas ici : elle **fixe** le nombre de
 * décimales, ce qui est le bon comportement pour une allure ou une VO₂max mais
 * pas pour un multiplicateur. Son signe moins typographique n'a rien à y faire
 * non plus — un facteur est toujours positif.
 */
export function formatCorrectionFactor(factor: number): string {
  return `×${String(Number(factor.toFixed(3))).replace(".", ",")}`;
}

/** CTL / ATL / TSB à l'entier, ex. `68`, `−8`. */
export function formatLoad(value: number): string {
  return formatNumber(value, 0);
}

/**
 * Monotonie de Foster au dixième, ex. `1,8`.
 *
 * Un quotient sans unité, dont l'amplitude utile tient entre 0,5 et 3 : à
 * l'entier, deux semaines de nature différente afficheraient le même nombre.
 */
export function formatMonotony(value: number): string {
  return formatNumber(value, 1);
}

/**
 * Contrainte de Foster à l'entier, ex. `2450`.
 *
 * Elle se compte en unités TRIMP × monotonie et se lit par centaines : une
 * décimale n'y ajouterait aucune information lisible.
 */
export function formatStrain(value: number): string {
  return formatNumber(value, 0);
}

/** Allure au format `4:18/km`. */
export function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}/km`;
}

/** Distance en kilomètres au dixième, ex. `18,2 km`. */
export function formatDistance(meters: number): string {
  return `${formatNumber(meters / 1000, 1)} km`;
}

/**
 * Durée exacte façon chronomètre : `48:12`, `1:04:32`.
 *
 * Vit ici, et non plus dans le détail d'une activité : trois routes affichent
 * désormais un chrono à la seconde (le détail d'une séance, les records de tous
 * les temps, les chronos prévus). `activities/[id]/_lib/format-detail` la
 * ré-exporte pour ses appelants — la fonction n'a pas bougé d'un caractère.
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

/** Durée lisible : `45 s`, `48 min`, `1 h 05`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;

  const minutes = Math.round(total / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${String(rest).padStart(2, "0")}` : `${rest} min`;
}

/** Fréquence cardiaque moyenne, ex. `148 bpm`. */
export function formatHeartRate(bpm: number): string {
  return `${Math.round(bpm)} bpm`;
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Date civile `YYYY-MM-DD` → instant repère (minuit UTC de ce jour).
 * `null` si la chaîne n'est pas une date civile valide.
 *
 * Minuit UTC et non minuit local : le fuseau de l'athlète est toujours en avance
 * sur UTC, donc cet instant retombe sur la même date civile une fois formaté,
 * quel que soit le fuseau du process.
 */
export function parseCivilDate(value: string): Date | null {
  const match = CIVIL_DATE.exec(value);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // `Date.UTC(2026, 11, 40)` déborde silencieusement sur le mois suivant.
  const isReal =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
  return isReal ? date : null;
}

/**
 * Jour relatif en minuscules : `aujourd'hui`, `hier`, `demain`, le nom du jour
 * dans la semaine écoulée/à venir (`dimanche`), sinon la date courte
 * (`12 juil.`, avec l'année si elle diffère de l'année en cours).
 */
export function formatRelativeDay(date: Date, now: Date = new Date()): string {
  // Comparaison de jours civils dans le fuseau de l'athlète : les deux repères
  // sont à minuit UTC, donc l'écart est un nombre entier de jours exact.
  const days = civilDaysBetween(toCivilDate(now), toCivilDate(date));

  if (days === 0) return "aujourd'hui";
  if (days === -1) return "hier";
  if (days === 1) return "demain";
  if (days >= -6 && days <= 6) return weekdayFormatter.format(date);

  const sameYear = toCivilDate(date).slice(0, 4) === toCivilDate(now).slice(0, 4);
  return sameYear
    ? shortDateFormatter.format(date)
    : shortDateWithYearFormatter.format(date);
}

/** Date complète en minuscules, ex. `dimanche 9 août`. */
export function formatFullDate(date: Date): string {
  return fullDateFormatter.format(date);
}

/**
 * Date civile en toutes lettres, **millésimée dès qu'elle sort de l'année de
 * `reference`** : `dimanche 9 août`, mais `dimanche 17 mai 2024`.
 *
 * `null` quand la chaîne n'est pas une date civile — jamais une date inventée.
 *
 * Le millésime conditionnel n'est pas de la coquetterie : les écrans qui datent
 * un record de tous les temps ou le chrono de référence d'un plan affichent des
 * jours qui peuvent avoir deux ans, et « dimanche 17 mai » ne désigne alors rien
 * du tout. Il se lit sur la chaîne civile plutôt que sur un troisième
 * formateur : l'année y est déjà écrite.
 */
export function formatCivilFullDate(civilDate: string, reference: string): string | null {
  const date = parseCivilDate(civilDate);
  if (date === null) return null;

  const year = civilDate.slice(0, 4);
  const full = formatFullDate(date);
  return year === reference.slice(0, 4) ? full : `${full} ${year}`;
}
