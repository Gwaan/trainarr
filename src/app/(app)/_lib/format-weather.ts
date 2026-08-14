/**
 * Formatage de la météo — fonctions pures, testées, partagées par les trois
 * écrans qui l'affichent (détail d'activité, calendrier du plan, séance du
 * jour).
 *
 * Deux règles s'y jouent, et elles ne sont pas cosmétiques :
 *
 * - **le libellé dit exactement ce que la mesure est.** `precipitation` est un
 *   cumul (de l'heure précédente pour une observation, de la journée pour une
 *   prévision), jamais « la pluie pendant la séance ». Une valeur de journée est
 *   annoncée comme telle. Écrire « Pluie » au-dessus d'un cumul horaire, c'est
 *   promettre une averse à qui n'aura qu'un ciel gris ;
 * - **une absence se dit.** Chaque état qui empêche d'afficher une météo a sa
 *   phrase, ici et nulle part ailleurs : un blanc se lirait « beau temps ».
 */

import { APP_TIME_ZONE } from "@/config/time";
import { FORECAST_HORIZON_DAYS, type ForecastAvailability } from "@/lib/weather/forecast-plan";
import type { ActivityWeatherStatus } from "@/lib/weather/plan";

import { formatNumber } from "./format";

/*
 * Valeurs.
 */

/** Température à l'entier, ex. `24 °C`. */
export function formatTemperature(celsius: number): string {
  return `${formatNumber(celsius, 0)} °C`;
}

/**
 * Température compacte, ex. `24°` — pour une pastille de calendrier, où
 * l'unité prendrait la place du chiffre.
 */
export function formatTemperatureCompact(celsius: number): string {
  return `${formatNumber(celsius, 0)}°`;
}

/** Amplitude d'une journée, ex. `14 → 25 °C`. */
export function formatTemperatureRange(minC: number, maxC: number): string {
  return `${formatNumber(minC, 0)} → ${formatNumber(maxC, 0)} °C`;
}

/** Vitesse de vent à l'entier, ex. `13 km/h`. */
export function formatWindSpeed(kmh: number): string {
  return `${formatNumber(kmh, 0)} km/h`;
}

/** Hauteur de précipitations au dixième, ex. `0,9 mm`. */
export function formatPrecipitation(mm: number): string {
  return `${formatNumber(mm, 1)} mm`;
}

/** Pourcentage à l'entier, ex. `62 %` — humidité comme probabilité. */
export function formatPercent(value: number): string {
  return `${formatNumber(value, 0)} %`;
}

/**
 * Les huit aires du vent, dans l'ordre des degrés croissants.
 *
 * Huit et non seize : « nord-nord-est » n'apprend rien de plus à un coureur, et
 * la valeur elle-même est une moyenne horaire.
 */
const WIND_DIRECTIONS = [
  "nord",
  "nord-est",
  "est",
  "sud-est",
  "sud",
  "sud-ouest",
  "ouest",
  "nord-ouest",
] as const;

/**
 * Direction **d'où vient** le vent, ex. `nord-ouest` (convention météo : 0 =
 * nord). C'est bien l'origine, pas la destination — un vent de nord-ouest
 * freine celui qui part vers le nord-ouest.
 */
export function formatWindDirection(degrees: number): string {
  const sector = Math.round(degrees / 45) % WIND_DIRECTIONS.length;
  // Le modulo de JavaScript garde le signe : une direction négative (ou
  // supérieure à 360°) doit quand même retomber dans le tour.
  return WIND_DIRECTIONS[(sector + WIND_DIRECTIONS.length) % WIND_DIRECTIONS.length];
}

const readingFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: APP_TIME_ZONE,
});

/**
 * De quand date une prévision, ex. `Relevé du 14 août, 06:02`.
 *
 * Une prévision est périssable : sans son heure de relevé, impossible de savoir
 * si l'on lit celle de ce matin ou celle d'avant-hier.
 */
export function formatForecastReading(fetchedAt: Date): string {
  return `Relevé du ${readingFormatter.format(fetchedAt)}`;
}

const observationFormatter = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: APP_TIME_ZONE,
});

/**
 * L'heure d'un relevé d'activité, ex. `Relevé de 18:00`.
 *
 * L'heure seule suffit : le jour, c'est celui de la séance, déjà écrit en tête
 * de page. Et c'est bien l'heure **rendue** par Open-Meteo — sa grille est
 * horaire — non celle qui a été demandée.
 */
export function formatObservationHour(observedAt: Date): string {
  return `Relevé de ${observationFormatter.format(observedAt)}`;
}

/*
 * Absences.
 */

/**
 * Pourquoi une séance **effectuée** n'a pas de météo.
 *
 * Le tapis a sa phrase à lui : c'est le cas courant, et un athlète doit lire
 * « pas de météo, séance en intérieur » plutôt qu'un vide qu'il prendrait pour
 * une panne.
 */
export const ACTIVITY_WEATHER_ABSENCE: Record<
  Exclude<ActivityWeatherStatus, "observed">,
  string
> = {
  "no-location": "Pas de météo : séance en intérieur, sans position enregistrée.",
  unsupported: "Open-Meteo ne couvre pas ce lieu ou cette date : aucun relevé possible.",
  failed: "Relevé indisponible pour le moment — une nouvelle tentative est programmée.",
};

/** Pourquoi une séance **à venir** n'a pas de prévision. */
export const FORECAST_ABSENCE: Record<Exclude<ForecastAvailability, "forecast">, string> = {
  past: "Jour passé : c'est la météo relevée de la séance qui fait foi.",
  "beyond-horizon": `Pas de prévision au-delà de ${FORECAST_HORIZON_DAYS} jours.`,
  "no-location": "Aucune sortie géolocalisée récente : pas de lieu connu, donc pas de prévision.",
  unsupported: "Open-Meteo ne couvre pas le lieu habituel : pas de prévision.",
  failed: "Prévisions indisponibles — nouvelle tentative dans la matinée.",
  pending: "Prévisions pas encore relevées.",
};
