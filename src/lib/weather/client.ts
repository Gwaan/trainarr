/**
 * Client HTTP Open-Meteo : la météo horaire d'un point, à un instant donné.
 *
 * ## Ce que dit la documentation officielle
 *
 * Documentation relue le 2026-08-14 : <https://open-meteo.com/en/docs> (API de
 * prévision) et <https://open-meteo.com/en/docs/historical-weather-api>
 * (archive). Chaque paramètre ci-dessous a été **vérifié contre le service
 * réel** le même jour — aucun n'est deviné.
 *
 * - **Pas de clé API** pour un usage non commercial. Rien à mettre dans
 *   l'environnement, rien à chiffrer, rien qui puisse fuir : ce module n'envoie
 *   aucun en-tête d'authentification. Les conditions annoncent en contrepartie
 *   « less than 10'000 API calls per day, 5'000 per hour and 600 per minute » —
 *   c'est l'appelant qui tient cette cadence (cf. `./plan.ts`).
 * - **Deux points d'entrée, et ils ne couvrent pas la même chose** :
 *   - `https://api.open-meteo.com/v1/forecast` — jusqu'à `past_days=92` en
 *     arrière (défaut 0) et `forecast_days=16` en avant (défaut 7), **sans
 *     latence** ;
 *   - `https://archive-api.open-meteo.com/v1/archive` — réanalyse ERA5 depuis
 *     1940, « Daily with 5 days delay ».
 *
 *   C'est le piège de cette intégration : **une séance d'hier n'est pas dans
 *   l'archive**, elle se lit sur l'API de prévision. Le choix se fait dans
 *   `chooseWeatherSource`, pas ici.
 * - **Fenêtre horaire** — `start_hour` / `end_hour` au format `yyyy-MM-ddTHH:mm`,
 *   acceptés par les **deux** endpoints (vérifié). Hors couverture, la réponse
 *   est un 400 qui cite sa plage autorisée : `{"error":true,"reason":"Parameter
 *   'start_hour' is out of allowed range from 2026-05-13 to 2026-08-29"}`.
 *   Demander exactement les deux heures utiles évite de rapatrier une journée
 *   entière pour en garder un point.
 * - **Fuseau** — laissé à son défaut, `GMT` : les bornes envoyées sont donc de
 *   l'UTC, et `timeformat=unixtime` fait rendre les instants en secondes Unix.
 *   Aucune chaîne de date locale à réinterpréter, dans aucun sens.
 * - **Unités** — envoyées explicitement (`celsius`, `mm`, `kmh`) plutôt que
 *   laissées à un défaut : ce sont elles qui donnent leur sens aux colonnes
 *   `*_c`, `*_mm`, `*_kmh`. Vérifié dans `hourly_units` de la réponse réelle.
 * - **Erreurs** — HTTP 400 et un corps `{"error": true, "reason": "…"}`, forme
 *   identique sur les deux endpoints (vérifié sur une variable inconnue, une
 *   latitude hors bornes et une date hors plage).
 *
 * ## Les variables horaires retenues, et pourquoi celles-là
 *
 * | Variable | Ce qu'elle apporte |
 * |---|---|
 * | `temperature_2m` | la mesure de référence |
 * | `apparent_temperature` | le ressenti — chaleur humide et refroidissement éolien, c'est lui qui explique une allure dégradée à température « normale » |
 * | `precipitation` | pluie, averses et neige confondues, en mm |
 * | `weather_code` | code WMO : la seule variable qui qualifie le temps (brouillard, orage, neige) au lieu de le quantifier |
 * | `wind_speed_10m` | vitesse du vent |
 * | `wind_direction_10m` | direction du vent |
 * | `relative_humidity_2m` | humidité, qui décide de l'évaporation donc de la thermorégulation |
 *
 * Et ce qui a été **écarté**, parce qu'une variable qui ne sert pas est du
 * volume et du bruit : `rain` / `showers` / `snowfall` (déjà dans
 * `precipitation`, et le code WMO dit laquelle des trois), `wind_gusts_10m` (la
 * rafale se lit déjà dans le ressenti, et une valeur horaire ne dit rien de
 * l'instant où elle est tombée), la pression, la couverture nuageuse, le
 * rayonnement et tout l'étage sol — rien de tout cela ne se lit dans une séance.
 *
 * ## Deux garde-fous
 *
 * - **Aucun appel ne peut rester suspendu** : délai de garde sur chaque requête
 *   ({@link REQUEST_TIMEOUT_MS}), combiné au signal d'annulation de l'appelant.
 * - **Une réponse d'une forme inattendue lève**, elle ne se dégrade pas en
 *   mesures vides : mieux vaut un échec visible qu'une séance à qui l'on prête
 *   une météo qu'on n'a pas lue.
 *
 * Module pur : aucun accès base ni système de fichiers, `fetch` injectable.
 */

import { z } from 'zod';

import {
  formatHourParam,
  hourWindowAround,
  pickNearestSampleIndex,
  type Coordinates,
  type WeatherSource,
} from './plan';

/** Point d'entrée de l'API de prévision — jusqu'à 92 jours en arrière, sans latence. */
export const FORECAST_BASE_URL = 'https://api.open-meteo.com/v1/forecast';

/** Point d'entrée de l'archive ERA5 — depuis 1940, avec 5 jours de latence. */
export const ARCHIVE_BASE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/**
 * Délai de garde posé sur **tout** appel, même sans signal de l'appelant.
 *
 * Plus large que les 30 s du client intervals.icu, et pour une raison mesurée :
 * l'archive ERA5 calcule sa réponse à la demande (`generationtime_ms` observé à
 * 2 900 ms sur une seule journée), là où la prévision répond en une fraction de
 * milliseconde. Sans ce délai, une connexion qui traîne retiendrait la boucle de
 * rattrapage au-delà du délai de grâce de Docker.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Signature minimale de `fetch` — le global y est assignable. Injectable pour
 * que les tests n'ouvrent aucune connexion.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/*
 * Erreurs typées. Trois familles, parce que l'appelant en fait trois choses
 * différentes (cf. `ActivityWeatherStatus`).
 */

/** Échec d'un appel à Open-Meteo. */
export class WeatherApiError extends Error {
  /** Code HTTP reçu, `null` si l'appel n'a pas abouti (panne réseau, DNS, délai). */
  readonly status: number | null;

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WeatherApiError';
    this.status = status;
  }
}

/**
 * Le service n'a pas répondu, ou pas pu répondre : panne réseau, délai de garde,
 * 5xx, ou aucune mesure dans la fenêtre demandée.
 *
 * **Réessayable** : rien n'est dit de la séance elle-même.
 */
export class WeatherUnavailableError extends WeatherApiError {
  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, status, options);
    this.name = 'WeatherUnavailableError';
  }
}

/**
 * Le service a **refusé** la demande, en le motivant (400 et son champ `reason`) :
 * coordonnées hors bornes, date hors de la couverture de l'endpoint.
 *
 * **Définitif pour cette séance** : redemander la même chose donnera le même
 * refus. Le motif d'Open-Meteo est repris tel quel — c'est lui qui rend l'échec
 * lisible dans les journaux.
 */
export class WeatherRejectedError extends WeatherApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'WeatherRejectedError';
  }
}

/** 429 : quota atteint. Réessayable, mais pas tout de suite. */
export class WeatherRateLimitError extends WeatherApiError {
  /** Délai demandé par `Retry-After`, en secondes. `null` s'il est absent ou illisible. */
  readonly retryAfterS: number | null;

  constructor(retryAfterS: number | null) {
    super(
      retryAfterS === null
        ? 'Open-Meteo a répondu 429 (quota atteint), sans indiquer de délai.'
        : `Open-Meteo a répondu 429 (quota atteint), réessai possible dans ${retryAfterS} s.`,
      429,
    );
    this.name = 'WeatherRateLimitError';
    this.retryAfterS = retryAfterS;
  }
}

/**
 * Réponse illisible : ni JSON, ou d'une forme que le schéma ne reconnaît pas.
 *
 * C'est le signe d'une API qui a changé, pas d'une séance en défaut — d'où une
 * erreur distincte du refus, et un message qui nomme les champs fautifs.
 */
export class WeatherMalformedError extends WeatherApiError {
  constructor(message: string, status: number | null, options?: ErrorOptions) {
    super(message, status, options);
    this.name = 'WeatherMalformedError';
  }
}

/**
 * Appel interrompu : arrêt du service demandé, ou absence de réponse au bout de
 * {@link REQUEST_TIMEOUT_MS}.
 *
 * Distinguée des autres indisponibilités parce que l'appelant en fait un usage
 * distinct : un arrêt demandé est une sortie propre, pas un incident à
 * journaliser (cf. `.claude/rules/data-import.md`, « le silence est un bug » —
 * le silence se déduit du drapeau d'arrêt, jamais du seul type de l'erreur).
 */
export class WeatherAbortError extends WeatherUnavailableError {
  /** `true` si c'est le délai de garde qui a coupé, `false` si l'appelant l'a demandé. */
  readonly timedOut: boolean;

  constructor(context: string, timedOut: boolean, options?: ErrorOptions) {
    super(
      timedOut
        ? `${context} : aucune réponse en ${REQUEST_TIMEOUT_MS / 1_000} s, appel abandonné.`
        : `${context} : appel interrompu.`,
      null,
      options,
    );
    this.name = 'WeatherAbortError';
    this.timedOut = timedOut;
  }
}

/**
 * Valeur de `Retry-After` en secondes (RFC 7231 : delta-seconds **ou** date
 * HTTP). `null` si l'en-tête est absent ou inexploitable.
 */
export function parseRetryAfterSeconds(header: string | null, now: number = Date.now()): number | null {
  const raw = header?.trim() ?? '';
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number(raw);

  const target = Date.parse(raw);
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.ceil((target - now) / 1_000));
}

/*
 * Forme des réponses.
 */

/**
 * Les variables horaires demandées, dans l'ordre où elles partent dans l'URL.
 *
 * Une seule liste : c'est elle qui compose le paramètre `hourly` **et** qui
 * décrit la réponse attendue. Ajouter une variable sans l'ajouter au schéma
 * ci-dessous ne compile pas.
 */
const HOURLY_VARIABLES = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'relative_humidity_2m',
] as const;

/**
 * Une série de mesures : un `null` par point que le modèle n'a pas su remplir.
 *
 * `nullable` et pas seulement optionnel : ERA5 a des trous, et un trou est une
 * absence de mesure — pas une réponse malformée.
 */
const measureSeries = z.array(z.number().nullable());

/**
 * Réponse horaire, telle que les **deux** endpoints la rendent (forme vérifiée
 * sur l'un et sur l'autre).
 *
 * Les champs inconnus (`generationtime_ms`, `elevation`, `hourly_units`, …) sont
 * écartés par le schéma : ils ne servent à rien ici. En revanche l'absence d'une
 * série demandée lève — c'est le contrat que ce module vend à ses appelants.
 */
const hourlyResponseSchema = z.object({
  hourly: z.object({
    /** Secondes Unix : conséquence de `timeformat=unixtime`. */
    time: z.array(z.number()),
    temperature_2m: measureSeries,
    apparent_temperature: measureSeries,
    precipitation: measureSeries,
    weather_code: measureSeries,
    wind_speed_10m: measureSeries,
    wind_direction_10m: measureSeries,
    relative_humidity_2m: measureSeries,
  }),
});

/** Corps d'erreur documenté : `{"error": true, "reason": "…"}`. */
const errorBodySchema = z.object({
  error: z.literal(true),
  reason: z.string(),
});

/*
 * Le relevé rendu à l'appelant.
 */

/** La météo d'un point, à une heure. */
export type HourlyWeatherSample = {
  /** Heure Open-Meteo effectivement retenue — pas celle demandée. */
  observedAt: Date;
  temperatureC: number | null;
  /** Ressenti (`apparent_temperature`) : humidité, vent et rayonnement compris. */
  apparentTemperatureC: number | null;
  /**
   * Précipitations en mm.
   *
   * **Cumul de l'heure qui précède `observedAt`**, comme toute variable de
   * somme chez Open-Meteo — les autres, elles, sont instantanées. C'est donc « il
   * est tombé tant dans l'heure autour de la séance », pas « pendant la séance ».
   */
  precipitationMm: number | null;
  windSpeedKmh: number | null;
  /** Direction **d'où vient** le vent, en degrés (convention météo : 0 = nord). */
  windDirectionDeg: number | null;
  relativeHumidityPct: number | null;
  /** Code temps WMO 4677 (0 = ciel clair, 61 = pluie faible, 95 = orage…). */
  weatherCode: number | null;
};

/*
 * Appel.
 */

/**
 * `true` si l'échec vient d'une annulation (`AbortError`) ou du délai de garde
 * (`TimeoutError`) plutôt que d'une vraie panne réseau.
 */
function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function baseUrlFor(source: WeatherSource): string {
  return source === 'forecast' ? FORECAST_BASE_URL : ARCHIVE_BASE_URL;
}

export type FetchHourlyWeatherParams = {
  /** Coordonnées **déjà arrondies** (cf. `toRequestCoordinates`). */
  coordinates: Coordinates;
  /** Instant dont on veut la météo ; l'échantillon rendu est le plus proche. */
  instant: Date;
  /** Endpoint à interroger, décidé par `chooseWeatherSource`. */
  source: WeatherSource;
  /** Surcharge de l'URL de base — les tests, et rien d'autre. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Annulation de l'appel en vol (arrêt du service). Combiné au délai de garde. */
  signal?: AbortSignal;
};

/** L'URL d'une demande, montée telle que la documentation la décrit. */
export function buildRequestUrl(params: FetchHourlyWeatherParams): string {
  const window = hourWindowAround(params.instant);
  const url = new URL(params.baseUrl ?? baseUrlFor(params.source));

  url.searchParams.set('latitude', String(params.coordinates.latitudeDeg));
  url.searchParams.set('longitude', String(params.coordinates.longitudeDeg));
  url.searchParams.set('hourly', HOURLY_VARIABLES.join(','));
  url.searchParams.set('start_hour', window.startHour);
  url.searchParams.set('end_hour', window.endHour);
  // Instants en secondes Unix : aucune date locale à réinterpréter.
  url.searchParams.set('timeformat', 'unixtime');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('precipitation_unit', 'mm');
  url.searchParams.set('wind_speed_unit', 'kmh');

  return url.toString();
}

/** Le motif d'un refus, tel qu'Open-Meteo le donne. Repli sur le code HTTP. */
async function rejectionReason(response: Response): Promise<string> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Corps vide ou non JSON : le code HTTP dira ce qu'il peut.
    payload = null;
  }

  const parsed = errorBodySchema.safeParse(payload);
  return parsed.success ? parsed.data.reason : `HTTP ${response.status}, sans motif exploitable`;
}

/**
 * La série horaire brute d'une demande, validée.
 *
 * Sépare l'appel de la sélection : ce qui suit (choisir l'échantillon) est pur
 * et testable sans réseau.
 */
async function requestHourly(
  params: FetchHourlyWeatherParams,
  context: string,
): Promise<z.infer<typeof hourlyResponseSchema>['hourly']> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined =
    params.signal === undefined ? timeout : AbortSignal.any([params.signal, timeout]);

  const fetchImpl = params.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(buildRequestUrl(params), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: combined,
    });
  } catch (cause) {
    if (isAbortLike(cause) || combined.aborted) {
      throw new WeatherAbortError(context, params.signal?.aborted !== true, { cause });
    }
    throw new WeatherUnavailableError(`${context} : appel réseau impossible.`, null, { cause });
  }

  if (response.status === 429) {
    throw new WeatherRateLimitError(parseRetryAfterSeconds(response.headers.get('retry-after')));
  }
  // 4xx : le service a compris la demande et la refuse. Redemander la même chose
  // donnera le même refus — c'est un état de la séance, pas une panne.
  if (response.status >= 400 && response.status < 500) {
    throw new WeatherRejectedError(
      `${context} : demande refusée — ${await rejectionReason(response)}.`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new WeatherUnavailableError(`${context} : HTTP ${response.status}.`, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new WeatherMalformedError(`${context} : réponse JSON illisible.`, response.status, {
      cause,
    });
  }

  const parsed = hourlyResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(racine)').join(', ');
    throw new WeatherMalformedError(
      `${context} : réponse inattendue (champs en défaut : ${fields}).`,
      response.status,
    );
  }

  const { hourly } = parsed.data;

  // Les séries sont indexées sur `time` : une série plus courte décalerait
  // silencieusement les mesures d'une heure. Ça ne se rattrape pas, ça se refuse.
  for (const variable of HOURLY_VARIABLES) {
    if (hourly[variable].length === hourly.time.length) continue;
    throw new WeatherMalformedError(
      `${context} : série « ${variable} » de ${hourly[variable].length} valeurs pour ${hourly.time.length} instants.`,
      response.status,
    );
  }

  return hourly;
}

/**
 * La météo d'un point à un instant, lue sur l'endpoint qui la connaît.
 *
 * Rend l'échantillon horaire le plus proche de `instant`. **Ne rend jamais un
 * relevé vide** : une fenêtre sans aucun instant, ou un échantillon dont pas une
 * seule variable n'est renseignée, lève {@link WeatherUnavailableError} — ce sont
 * deux façons de ne pas savoir, et les enregistrer comme une météo observée
 * serait un mensonge en base.
 *
 * @throws {WeatherRejectedError} demande refusée (définitif pour cette séance)
 * @throws {WeatherRateLimitError} quota atteint
 * @throws {WeatherUnavailableError} réseau, délai, 5xx, ou aucune mesure
 * @throws {WeatherMalformedError} réponse illisible ou d'une forme inattendue
 */
export async function fetchHourlyWeather(
  params: FetchHourlyWeatherParams,
): Promise<HourlyWeatherSample> {
  const context = `météo ${params.source} du ${formatHourParam(params.instant)} UTC`;
  const hourly = await requestHourly(params, context);

  const index = pickNearestSampleIndex(hourly.time, params.instant);
  if (index === null) {
    throw new WeatherUnavailableError(
      `${context} : aucun instant dans la fenêtre demandée.`,
      null,
    );
  }

  const at = (series: readonly (number | null)[]): number | null => series[index] ?? null;

  const sample: HourlyWeatherSample = {
    // `time` est en secondes Unix (`timeformat=unixtime`).
    observedAt: new Date(hourly.time[index] * 1_000),
    temperatureC: at(hourly.temperature_2m),
    apparentTemperatureC: at(hourly.apparent_temperature),
    precipitationMm: at(hourly.precipitation),
    windSpeedKmh: at(hourly.wind_speed_10m),
    windDirectionDeg: at(hourly.wind_direction_10m),
    relativeHumidityPct: at(hourly.relative_humidity_2m),
    weatherCode: at(hourly.weather_code),
  };

  const measures = [
    sample.temperatureC,
    sample.apparentTemperatureC,
    sample.precipitationMm,
    sample.windSpeedKmh,
    sample.windDirectionDeg,
    sample.relativeHumidityPct,
    sample.weatherCode,
  ];
  if (measures.every((measure) => measure === null)) {
    throw new WeatherUnavailableError(`${context} : aucune mesure à cette heure.`, null);
  }

  return sample;
}
