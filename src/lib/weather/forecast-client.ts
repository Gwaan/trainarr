/**
 * Client HTTP Open-Meteo : la prévision **quotidienne** d'un lieu, sur seize
 * jours.
 *
 * Le pendant de `./client.ts`, qui lit la météo horaire d'une séance passée. Ce
 * module ne lit que l'API de prévision (`/v1/forecast`) : l'archive ERA5 n'a
 * rien à dire de demain.
 *
 * ## Ce qui a été vérifié contre le service réel
 *
 * Documentation et réponse relues le 2026-08-14 (<https://open-meteo.com/en/docs>).
 * La réponse réelle de ce jour-là est recopiée telle quelle en fixture dans
 * `./forecast-client.test.ts` : c'est **elle** qui vérifie le schéma, jamais
 * l'inverse.
 *
 * - **Un appel rend seize jours** (`forecast_days=16`, le maximum documenté),
 *   aujourd'hui compris. D'où la règle du service : **un appel par compte et par
 *   jour**, jamais un par séance.
 * - **`timezone` explicite**, celui de l'application. C'est indispensable et non
 *   cosmétique : un agrégat quotidien dépend entièrement de l'endroit où l'on
 *   coupe la journée. Laissé à son défaut `GMT`, « le maximum du 15 août »
 *   couvrirait de 2 h du matin à 2 h du matin en heure française. Effet de bord
 *   utile, vérifié : avec un fuseau, `daily.time` est rendu en dates civiles
 *   `YYYY-MM-DD` — exactement la forme des jours que le plan écrit, sans aucune
 *   reconversion.
 * - **Unités envoyées explicitement** (`celsius`, `mm`, `kmh`) : ce sont elles
 *   qui donnent leur sens aux suffixes `*_c`, `*_mm`, `*_kmh`.
 * - **Des `null` au bout des séries.** Observé sur `precipitation_probability_max`
 *   au seizième jour : le modèle de probabilité ne porte pas aussi loin que celui
 *   de température. C'est une mesure absente, pas une réponse malformée.
 *
 * ## Les variables retenues, et pourquoi celles-là
 *
 * Une séance planifiée porte **une date, jamais une heure** : demander une série
 * horaire pour en tirer « la météo de la séance » supposerait une heure de
 * départ que le plan n'écrit nulle part. Ce sont donc des agrégats de journée,
 * et l'écran les libelle comme tels.
 *
 * | Variable | Ce qu'elle apporte |
 * |---|---|
 * | `weather_code` | le temps dominant, la seule variable qui qualifie |
 * | `temperature_2m_max` / `_min` | l'amplitude de la journée |
 * | `apparent_temperature_max` / `_min` | le ressenti, qui décide de la tenue |
 * | `precipitation_sum` | ce qu'il tombera dans la journée, en mm |
 * | `precipitation_probability_max` | la chance de se faire prendre |
 * | `wind_speed_10m_max` | le vent, qui coûte une allure |
 *
 * Module pur : aucun accès base, `fetch` injectable.
 */

import { z } from 'zod';

import { APP_TIME_ZONE } from '@/config/time';

import {
  FORECAST_BASE_URL,
  requestOpenMeteoJson,
  WeatherMalformedError,
  WeatherUnavailableError,
  type OpenMeteoRequestOptions,
} from './client';
import { FORECAST_HORIZON_DAYS, type DailyForecast } from './forecast-plan';
import type { Coordinates } from './plan';

/**
 * Les variables quotidiennes demandées, dans l'ordre où elles partent dans
 * l'URL.
 *
 * Une seule liste : c'est elle qui compose le paramètre `daily` **et** qui
 * décrit la réponse attendue. Ajouter une variable sans l'ajouter au schéma
 * ci-dessous ne compile pas.
 */
const DAILY_VARIABLES = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
] as const;

/**
 * Une série quotidienne : un `null` par jour que le modèle n'a pas su remplir.
 *
 * `nullable` et pas seulement optionnel — vérifié sur le service réel, la
 * probabilité de précipitations manque au seizième jour.
 */
const measureSeries = z.array(z.number().nullable());

/**
 * Réponse quotidienne, telle que l'API la rend avec un fuseau explicite.
 *
 * `daily.time` est une liste de dates civiles `YYYY-MM-DD` (et non des instants) :
 * c'est la conséquence directe de `timezone=…`. Les champs inconnus
 * (`generationtime_ms`, `daily_units`, `elevation`…) sont écartés ; l'absence
 * d'une série demandée, elle, lève.
 */
const dailyResponseSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    weather_code: measureSeries,
    temperature_2m_max: measureSeries,
    temperature_2m_min: measureSeries,
    apparent_temperature_max: measureSeries,
    apparent_temperature_min: measureSeries,
    precipitation_sum: measureSeries,
    precipitation_probability_max: measureSeries,
    wind_speed_10m_max: measureSeries,
  }),
});

export type FetchDailyForecastParams = OpenMeteoRequestOptions & {
  /** Coordonnées **déjà arrondies** (cf. `toRequestCoordinates`). */
  coordinates: Coordinates;
  /** Nombre de jours demandés, aujourd'hui compris. */
  days?: number;
  /** Surcharge de l'URL de base — les tests, et rien d'autre. */
  baseUrl?: string;
};

/** L'URL d'une demande de prévision, montée telle que la documentation la décrit. */
export function buildForecastUrl(params: FetchDailyForecastParams): string {
  const url = new URL(params.baseUrl ?? FORECAST_BASE_URL);

  url.searchParams.set('latitude', String(params.coordinates.latitudeDeg));
  url.searchParams.set('longitude', String(params.coordinates.longitudeDeg));
  url.searchParams.set('daily', DAILY_VARIABLES.join(','));
  url.searchParams.set('forecast_days', String(params.days ?? FORECAST_HORIZON_DAYS));
  // Le fuseau découpe les journées : sans lui, les agrégats seraient ceux d'un
  // jour UTC, et `daily.time` ne serait plus une date civile.
  url.searchParams.set('timezone', APP_TIME_ZONE);
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('precipitation_unit', 'mm');
  url.searchParams.set('wind_speed_unit', 'kmh');

  return url.toString();
}

/**
 * Les seize prochains jours d'un lieu, dans l'ordre où l'API les rend.
 *
 * **Ne rend jamais une liste vide** : une réponse sans un seul jour lève
 * {@link WeatherUnavailableError}. Enregistrer un relevé qui ne dit rien
 * reviendrait à annoncer à l'athlète qu'il n'y a pas de prévision alors qu'on
 * n'a simplement rien lu.
 *
 * @throws {WeatherRejectedError} demande refusée (coordonnées hors bornes)
 * @throws {WeatherRateLimitError} quota atteint
 * @throws {WeatherUnavailableError} réseau, délai, 5xx, ou aucun jour rendu
 * @throws {WeatherMalformedError} réponse illisible ou d'une forme inattendue
 */
export async function fetchDailyForecast(
  params: FetchDailyForecastParams,
): Promise<DailyForecast[]> {
  const context = 'prévisions Open-Meteo';

  const { payload, status } = await requestOpenMeteoJson(buildForecastUrl(params), context, {
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });

  const parsed = dailyResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(racine)').join(', ');
    throw new WeatherMalformedError(
      `${context} : réponse inattendue (champs en défaut : ${fields}).`,
      status,
    );
  }

  const { daily } = parsed.data;

  // Les séries sont indexées sur `time` : une série plus courte décalerait
  // silencieusement les mesures d'un jour. Ça ne se rattrape pas, ça se refuse.
  for (const variable of DAILY_VARIABLES) {
    if (daily[variable].length === daily.time.length) continue;
    throw new WeatherMalformedError(
      `${context} : série « ${variable} » de ${daily[variable].length} valeurs pour ${daily.time.length} jours.`,
      status,
    );
  }

  if (daily.time.length === 0) {
    throw new WeatherUnavailableError(`${context} : aucun jour rendu.`, status);
  }

  return daily.time.map((date, index) => ({
    date,
    weatherCode: daily.weather_code[index],
    temperatureMaxC: daily.temperature_2m_max[index],
    temperatureMinC: daily.temperature_2m_min[index],
    apparentTemperatureMaxC: daily.apparent_temperature_max[index],
    apparentTemperatureMinC: daily.apparent_temperature_min[index],
    precipitationSumMm: daily.precipitation_sum[index],
    precipitationProbabilityMaxPct: daily.precipitation_probability_max[index],
    windSpeedMaxKmh: daily.wind_speed_10m_max[index],
  }));
}
