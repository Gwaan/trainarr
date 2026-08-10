import { z } from 'zod';

import { usesFootCadenceSportType } from '@/lib/fit/sport';

import { StravaApiError, StravaAuthError, StravaRateLimitError } from './errors';

/**
 * Client de l'API Strava v3 — module pur : le jeton d'accès est passé en
 * argument, jamais lu en base ici (c'est le rôle du DAL).
 *
 * Référence : https://developers.strava.com/docs/reference/
 */

const API_BASE_URL = 'https://www.strava.com/api/v3';

/** Streams demandés, alignés sur `ACTIVITY_STREAM_TYPES` du schéma DB. */
const STREAM_KEYS = 'time,distance,heartrate,altitude,cadence,velocity_smooth,latlng';

/** Les fenêtres court terme de Strava durent 15 min et sont calées sur l'horloge. */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export { StravaApiError, StravaAuthError, StravaRateLimitError } from './errors';

/**
 * Activité Strava réduite aux champs que le schéma DB conserve. Les noms portent
 * les unités, comme partout ailleurs dans le projet ; les champs inconnus de
 * l'API sont ignorés par Zod.
 */
const activitySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    sport_type: z.string().min(1),
    start_date: z.iso.datetime(),
    /** Mètres. */
    distance: z.number(),
    moving_time: z.number().int(),
    elapsed_time: z.number().int(),
    total_elevation_gain: z.number(),
    average_heartrate: z.number().nullish(),
    max_heartrate: z.number().nullish(),
    average_cadence: z.number().nullish(),
    /**
     * Propriétaire de l'activité. Strava le renvoie sur la liste comme sur le
     * détail, mais rien ne le garantit contractuellement : `nullish`, et la sync
     * ne s'en sert qu'en défense en profondeur (jamais comme seule vérification).
     */
    athlete: z.object({ id: z.number().int() }).nullish(),
  })
  .transform((raw) => ({
    id: raw.id,
    /** Identifiant Strava du propriétaire, `null` si l'API ne l'expose pas. */
    athleteStravaId: raw.athlete?.id ?? null,
    name: raw.name,
    sportType: raw.sport_type,
    startedAt: new Date(raw.start_date),
    distanceM: raw.distance,
    movingTimeS: raw.moving_time,
    elapsedTimeS: raw.elapsed_time,
    elevationGainM: raw.total_elevation_gain,
    avgHrBpm: raw.average_heartrate ?? null,
    maxHrBpm: raw.max_heartrate ?? null,
    /**
     * Strava renvoie la cadence des sports à pied en cycles par minute (une
     * jambe) : ~87 pour ~174 pas/min. La colonne stocke des pas par minute
     * (`Spm`) — d'où la conversion ×2 à l'ingestion, pour les sports à pied
     * uniquement : à vélo, la valeur est déjà le régime pédalier (rpm), la
     * doubler donnerait un chiffre absurde. Même règle que le parseur FIT.
     */
    avgCadenceSpm:
      raw.average_cadence == null
        ? null
        : usesFootCadenceSportType(raw.sport_type)
          ? raw.average_cadence * 2
          : raw.average_cadence,
  }));

export type StravaActivity = z.infer<typeof activitySchema>;

const activityListSchema = z.array(activitySchema);

const numberStreamSchema = z.object({ data: z.array(z.number()) });
const latlngStreamSchema = z.object({ data: z.array(z.tuple([z.number(), z.number()])) });

/**
 * Réponse `?key_by_type=true` : un objet dont chaque clé est un type de stream.
 * Renommée `velocity_smooth` → `velocity` pour coller aux types du schéma DB.
 */
const streamSetSchema = z
  .object({
    time: numberStreamSchema.nullish(),
    distance: numberStreamSchema.nullish(),
    heartrate: numberStreamSchema.nullish(),
    altitude: numberStreamSchema.nullish(),
    cadence: numberStreamSchema.nullish(),
    velocity_smooth: numberStreamSchema.nullish(),
    latlng: latlngStreamSchema.nullish(),
  })
  .transform((raw) => {
    const set: StravaStreamSet = {};
    if (raw.time) set.time = raw.time.data;
    if (raw.distance) set.distance = raw.distance.data;
    if (raw.heartrate) set.heartrate = raw.heartrate.data;
    if (raw.altitude) set.altitude = raw.altitude.data;
    if (raw.cadence) set.cadence = raw.cadence.data;
    if (raw.velocity_smooth) set.velocity = raw.velocity_smooth.data;
    if (raw.latlng) set.latlng = raw.latlng.data;
    return set;
  });

/** Séries temporelles d'une activité. Chaque clé est optionnelle : le capteur peut manquer. */
export type StravaStreamSet = {
  time?: number[];
  distance?: number[];
  heartrate?: number[];
  altitude?: number[];
  /**
   * Cadence **brute de l'API** : les cycles d'une seule jambe (~87) pour les
   * sports à pied, les tours de pédalier pour le vélo. La colonne
   * `activity_streams` stocke, elle, des pas par minute pour les sports à pied —
   * la conversion ×2 se fait à l'ingestion (`src/lib/strava/sync.ts`), une seule
   * fois, comme pour le scalaire `avgCadenceSpm`.
   */
  cadence?: number[];
  /** `velocity_smooth` côté Strava, en m/s. */
  velocity?: number[];
  latlng?: Array<[number, number]>;
};

/** Consommation des quotas, telle que renvoyée par la dernière réponse Strava. */
export type StravaRateLimitStatus = {
  shortTermUsage: number;
  shortTermLimit: number;
  dailyUsage: number;
  dailyLimit: number;
  readAt: Date;
};

let lastRateLimit: StravaRateLimitStatus | null = null;

/** Dernier état de quota connu. `null` tant qu'aucun appel n'a abouti. */
export function getRateLimitStatus(): StravaRateLimitStatus | null {
  return lastRateLimit;
}

/** Réservé aux tests : oublie l'état de quota mémorisé. */
export function resetRateLimitStatus(): void {
  lastRateLimit = null;
}

/** Début de la fenêtre de 15 min suivant `instant`. */
function nextWindowStart(instant: Date): Date {
  return new Date((Math.floor(instant.getTime() / RATE_LIMIT_WINDOW_MS) + 1) * RATE_LIMIT_WINDOW_MS);
}

/**
 * Minuit UTC suivant `instant` : les quotas journaliers Strava se réinitialisent
 * à minuit UTC, pas au minuit local de l'athlète.
 */
function nextUtcMidnight(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() + 1),
  );
}

/** En-têtes `X-RateLimit-*` : deux entiers « court terme,journalier ». */
function parsePair(header: string | null): [number, number] | null {
  if (header === null) return null;
  const parts = header.split(',').map((part) => Number.parseInt(part.trim(), 10));
  const [short, daily] = parts;
  if (parts.length !== 2 || short === undefined || daily === undefined) return null;
  if (!Number.isFinite(short) || !Number.isFinite(daily)) return null;
  return [short, daily];
}

function readRateLimitHeaders(headers: Headers): void {
  const usage = parsePair(headers.get('X-RateLimit-Usage'));
  const limit = parsePair(headers.get('X-RateLimit-Limit'));
  if (!usage || !limit) return;

  lastRateLimit = {
    shortTermUsage: usage[0],
    shortTermLimit: limit[0],
    dailyUsage: usage[1],
    dailyLimit: limit[1],
    readAt: new Date(),
  };
}

/**
 * Quota épuisé d'après le dernier appel, et fenêtre non encore écoulée : on
 * s'arrête avant d'émettre la requête (« pas de rafale »).
 *
 * Les deux quotas sont contrôlés : le court terme (fenêtre de 15 min calée sur
 * l'horloge) et le journalier (fenêtre calée sur minuit UTC). Sans le second, la
 * sync continuait de marteler l'API toute la journée une fois le quota
 * journalier atteint, en n'obtenant que des 429.
 */
function assertQuotaAvailable(): void {
  if (!lastRateLimit) return;
  const now = new Date();

  if (lastRateLimit.dailyUsage >= lastRateLimit.dailyLimit) {
    const retryAt = nextUtcMidnight(lastRateLimit.readAt);
    if (now < retryAt) {
      throw new StravaRateLimitError(
        `Quota Strava journalier épuisé (${lastRateLimit.dailyUsage}/${lastRateLimit.dailyLimit}).`,
        { retryAt, now },
      );
    }
  }

  if (lastRateLimit.shortTermUsage >= lastRateLimit.shortTermLimit) {
    const retryAt = nextWindowStart(lastRateLimit.readAt);
    if (now < retryAt) {
      throw new StravaRateLimitError(
        `Quota Strava court terme épuisé (${lastRateLimit.shortTermUsage}/${lastRateLimit.shortTermLimit}).`,
        { retryAt, now },
      );
    }
  }
}

/** Requête authentifiée. Traduit 401 et 429 en erreurs typées ; laisse passer le reste. */
async function stravaFetch(
  accessToken: string,
  path: string,
  query: Record<string, string>,
): Promise<Response> {
  assertQuotaAvailable();

  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    cache: 'no-store',
  });

  readRateLimitHeaders(response.headers);

  if (response.status === 401) {
    throw new StravaAuthError('Jeton Strava refusé (HTTP 401) : rafraîchissement nécessaire.', {
      status: 401,
    });
  }

  if (response.status === 429) {
    const now = new Date();
    throw new StravaRateLimitError('Quota Strava dépassé (HTTP 429).', {
      retryAt: nextWindowStart(now),
      now,
    });
  }

  return response;
}

/** Corps JSON validé, ou `StravaApiError` si la réponse est inexploitable. */
async function parseJson<T>(response: Response, schema: z.ZodType<T>, context: string): Promise<T> {
  const payload: unknown = await response.json().catch((cause: unknown) => {
    throw new StravaApiError(`Réponse Strava illisible (${context}).`, {
      status: response.status,
      cause,
    });
  });

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new StravaApiError(`Réponse Strava inattendue (${context}) : ${parsed.error.message}`, {
      status: response.status,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function assertOk(response: Response, context: string): void {
  if (response.ok) return;
  throw new StravaApiError(`Appel Strava en échec (${context}, HTTP ${response.status}).`, {
    status: response.status,
  });
}

/** Une page des activités de l'athlète authentifié, de la plus récente à la plus ancienne. */
export async function listActivities(
  accessToken: string,
  params: { page: number; perPage: number; after?: Date },
): Promise<StravaActivity[]> {
  const query: Record<string, string> = {
    page: String(params.page),
    per_page: String(params.perPage),
  };
  if (params.after) {
    // `after` est un epoch en secondes, exclusif.
    query.after = String(Math.floor(params.after.getTime() / 1000));
  }

  const response = await stravaFetch(accessToken, '/athlete/activities', query);
  assertOk(response, 'liste des activités');
  return parseJson(response, activityListSchema, 'liste des activités');
}

/** Une activité par son identifiant Strava. */
export async function getActivity(
  accessToken: string,
  stravaActivityId: number,
): Promise<StravaActivity> {
  const response = await stravaFetch(accessToken, `/activities/${stravaActivityId}`, {
    include_all_efforts: 'false',
  });
  assertOk(response, `activité ${stravaActivityId}`);
  return parseJson(response, activitySchema, `activité ${stravaActivityId}`);
}

/**
 * Séries temporelles d'une activité. `null` quand Strava répond 404 : l'activité
 * n'a pas de streams (saisie manuelle, par exemple), ce n'est pas une erreur.
 */
export async function getActivityStreams(
  accessToken: string,
  stravaActivityId: number,
): Promise<StravaStreamSet | null> {
  const response = await stravaFetch(accessToken, `/activities/${stravaActivityId}/streams`, {
    keys: STREAM_KEYS,
    key_by_type: 'true',
  });

  if (response.status === 404) return null;
  assertOk(response, `streams de l'activité ${stravaActivityId}`);
  return parseJson(response, streamSetSchema, `streams de l'activité ${stravaActivityId}`);
}
