/**
 * Client HTTP intervals.icu : lister les activités récentes, récupérer le
 * fichier d'activité original, et tenir à jour le calendrier des séances
 * planifiées.
 *
 * ## Ce que dit la documentation officielle
 *
 * Spécification OpenAPI : <https://intervals.icu/api/v1/docs> (c'est la
 * `spec-url` que charge <https://intervals.icu/api-docs.html>). Post de
 * référence : <https://forum.intervals.icu/t/api-access-to-intervals-icu/609>.
 *
 * - **Authentification** — `components.securitySchemes.APIKey` de la spec :
 *   `{ "type": "http", "scheme": "basic", "description": "Username is API_KEY,
 *   Password is your API key found in /settings" }`. Le nom d'utilisateur est
 *   donc la chaîne **littérale** `API_KEY`, le mot de passe la clé personnelle
 *   (Settings → Developer Settings). Confirmé par l'exemple du forum :
 *   `curl -u API_KEY:<clé> https://intervals.icu/api/v1/athlete/…`.
 *   (L'autre schéma, `AccessToken` en bearer, relève du flux OAuth — hors sujet
 *   pour un usage personnel.)
 * - **Identifiant d'athlète** — préfixé d'un `i` dans les URL de l'API
 *   (`/api/v1/athlete/i123456/activities`), tel qu'intervals.icu l'affiche.
 * - **Liste des activités** — `GET /api/v1/athlete/{id}/activities`, « List
 *   activities for a date range in desc date order ». `oldest` est **requis**,
 *   `newest` optionnel (défaut : maintenant) ; format documenté « Local ISO-8601
 *   date or date and time e.g. 2019-07-22T16:18:49 or 2019-07-22 » — donc une
 *   date **locale** de l'athlète, d'où {@link formatIntervalsDate}.
 * - **Pas de pagination sur cet endpoint** (spec relue le 2026-08-10) : ni
 *   `page`, ni `offset`, ni curseur. Les seuls paramètres restants sont
 *   `route_id`, `fields` (« comma separated list of field names to include…,
 *   also excludes null values ») et `limit` (« Return at most this many
 *   activities »), sans défaut documenté. `limit` est **volontairement omis** :
 *   la liste est triée du plus récent au plus ancien, le borner tronquerait
 *   précisément l'historique ancien que le backfill vient chercher. Une réponse
 *   d'historique complet reste une seule requête, et le plafonnement du travail
 *   se fait à l'étape suivante, sur les téléchargements (cf.
 *   `MAX_DOWNLOADS_PER_CYCLE`). Si le volume de cette réponse devenait un
 *   problème, `fields=id,start_date_local,type,source` est le levier prévu par
 *   l'API — non utilisé ici, faute de pouvoir le vérifier contre le service.
 * - **Fichier original** — `GET /api/v1/activity/{id}/file`, « Download original
 *   activity file, Strava activities not supported ». À ne pas confondre avec
 *   `/api/v1/activity/{id}/fit-file`, qui **régénère** un FIT à partir des
 *   données d'intervals.icu (éventuellement retouchées) : ici on veut l'original
 *   tel que HealthFit l'a produit.
 * - **Objet activité** — 183 champs, dont `id` (string), `start_date_local`
 *   (string, heure locale sans fuseau), `type` (string) et `source` (enum
 *   STRAVA, UPLOAD, MANUAL, GARMIN_CONNECT, OAUTH_CLIENT, …). Les autres sont
 *   ignorés ici. La spec précise « An empty stub object is returned for Strava
 *   activities ».
 * - **Calendrier** (spec relue le 2026-08-11) — trois endpoints, utilisés par
 *   la synchronisation du plan (`push-plan.ts`) :
 *   - `GET /api/v1/athlete/{id}/events?oldest=…&newest=…&category=WORKOUT` :
 *     les events de la fenêtre, chacun portant `id`, `uid`, `category`,
 *     `start_date_local` et `name`. Les bornes sont des dates **locales** de
 *     l'athlète, comme pour les activités.
 *   - `POST /api/v1/athlete/{id}/events/bulk?upsertOnUid=true` : un tableau
 *     d'events. Avec `upsertOnUid`, un event portant un `uid` déjà présent est
 *     **mis à jour** au lieu d'être dupliqué — c'est ce qui rend le push
 *     idempotent. La réponse est la liste des events créés ou mis à jour.
 *   - `PUT /api/v1/athlete/{id}/events/bulk-delete` : un tableau de `{ id }`.
 *     La suppression par `external_id` existe mais est **réservée aux
 *     applications OAuth** : avec une clé API, on ne supprime que par `id`,
 *     donc uniquement des events qu'un GET vient de nous rendre.
 *
 * ## Points ambigus, tranchés au plus prudent
 *
 * - La spec ne documente **que** la réponse 200 de `/file` : rien sur une séance
 *   saisie à la main, qui n'a pas de fichier. Retenu : un 404 **comme** un corps
 *   vide valent « pas de fichier » → `null`, jamais une erreur.
 * - Aucun code 429, aucun en-tête `Retry-After` n'apparaît dans la spec. Les
 *   deux sont traités quand même ({@link IntervalsRateLimitError}) : mieux vaut
 *   savoir ralentir sur un quota non documenté que marteler l'API.
 *
 * ## Deux garde-fous, parce que l'appelant est un service au long cours
 *
 * - **Aucun appel ne peut rester suspendu** : un délai de garde
 *   ({@link REQUEST_TIMEOUT_MS}) est posé sur chaque requête, combiné au signal
 *   d'annulation de l'appelant s'il en fournit un. Sans lui, une connexion qui
 *   traîne retiendrait le poller au-delà du délai de grâce de Docker.
 * - **Aucune réponse ne peut remplir la mémoire** : la taille est bornée sur
 *   `Content-Length` quand il existe, et de toute façon en cours de lecture —
 *   une réponse `chunked` n'annonce rien.
 *
 * Module pur : aucun accès base ni système de fichiers, `fetch` injectable. La
 * clé API ne transite que dans l'en-tête `Authorization` et n'apparaît dans
 * aucun message d'erreur.
 */

import { z } from 'zod';

import { APP_TIME_ZONE } from '@/config/time';
import { MAX_FIT_FILE_BYTES, toMegabytes } from '@/lib/fit/limits';

export const INTERVALS_BASE_URL = 'https://intervals.icu';

/** Nom d'utilisateur littéral imposé par l'authentification Basic d'intervals.icu. */
const BASIC_AUTH_USERNAME = 'API_KEY';

/**
 * Délai de garde posé sur **tout** appel, même quand l'appelant ne fournit pas
 * de signal.
 *
 * Sans lui, une connexion qui traîne reste suspendue jusqu'aux temporisations
 * d'undici (300 s) : le poller n'observe son drapeau d'arrêt qu'entre deux
 * cycles, un SIGTERM ne le réveillerait pas et Docker finirait par SIGKILL.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Signature minimale de `fetch` — le global y est assignable. Injectable pour
 * que les tests n'ouvrent aucune connexion.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/*
 * Erreurs typées.
 */

/** Échec d'un appel à l'API intervals.icu. */
export class IntervalsApiError extends Error {
  /** Code HTTP reçu, `null` si l'appel n'a pas abouti (panne réseau, DNS). */
  readonly status: number | null;

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IntervalsApiError';
    this.status = status;
  }
}

/** 401/403 : clé absente, révoquée, ou athlète qui n'est pas le vôtre. */
export class IntervalsAuthError extends IntervalsApiError {
  constructor(status: number) {
    super(
      `intervals.icu a refusé l'authentification (HTTP ${status}) — vérifier INTERVALS_ATHLETE_ID et INTERVALS_API_KEY.`,
      status,
    );
    this.name = 'IntervalsAuthError';
  }
}

/**
 * Appel interrompu : arrêt du service demandé, ou absence de réponse au bout de
 * {@link REQUEST_TIMEOUT_MS}.
 *
 * Distinguée des autres pannes réseau parce que l'appelant en fait un usage
 * distinct : un arrêt demandé est une sortie propre, pas un incident à
 * journaliser.
 */
export class IntervalsAbortError extends IntervalsApiError {
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
    this.name = 'IntervalsAbortError';
    this.timedOut = timedOut;
  }
}

/** 429 : quota atteint. Attendre avant tout nouvel appel. */
export class IntervalsRateLimitError extends IntervalsApiError {
  /** Délai demandé par l'en-tête `Retry-After`, en secondes. `null` s'il est absent ou illisible. */
  readonly retryAfterS: number | null;

  constructor(retryAfterS: number | null) {
    super(
      retryAfterS === null
        ? 'intervals.icu a répondu 429 (quota atteint), sans indiquer de délai.'
        : `intervals.icu a répondu 429 (quota atteint), réessai possible dans ${retryAfterS} s.`,
      429,
    );
    this.name = 'IntervalsRateLimitError';
    this.retryAfterS = retryAfterS;
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
 * Appel de base.
 */

function authorizationHeader(apiKey: string): string {
  const credentials = Buffer.from(`${BASIC_AUTH_USERNAME}:${apiKey}`, 'utf8').toString('base64');
  return `Basic ${credentials}`;
}

/**
 * `true` si l'échec vient d'une annulation (`AbortError`) ou du délai de garde
 * (`TimeoutError`) plutôt que d'une vraie panne réseau.
 */
function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Ce qui change d'un appel à l'autre, au-delà de l'URL. */
type RequestOptions = {
  /** Défaut : `GET`. */
  method?: 'GET' | 'POST' | 'PUT';
  /** Corps de la requête, sérialisé en JSON. Absent = pas de corps. */
  body?: unknown;
  /** Annulation de l'appel en vol. Combiné au délai de garde. */
  signal?: AbortSignal;
};

/**
 * Un appel authentifié, avec les deux échecs qui appellent une réaction
 * particulière déjà traduits en erreurs typées. Le reste (404, 5xx) revient à
 * l'appelant, qui seul sait ce qu'un code donné signifie pour son endpoint.
 *
 * Le signal de l'appelant, quand il y en a un, est **combiné** au délai de garde
 * de {@link REQUEST_TIMEOUT_MS} : aucun appel ne peut rester suspendu, et un
 * arrêt demandé coupe sans attendre l'échéance.
 */
async function authorizedRequest(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike,
  context: string,
  options: RequestOptions = {},
): Promise<Response> {
  const { signal } = options;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  const headers: Record<string, string> = {
    authorization: authorizationHeader(apiKey),
    accept: '*/*',
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: combined,
    });
  } catch (cause) {
    if (isAbortLike(cause) || combined.aborted) {
      throw new IntervalsAbortError(context, signal?.aborted !== true, { cause });
    }
    // Le message d'une erreur réseau (undici) ne contient que l'URL — la clé
    // vit dans l'en-tête, elle n'a aucun chemin vers les journaux.
    throw new IntervalsApiError(`${context} : appel réseau impossible.`, null, { cause });
  }

  if (response.status === 401 || response.status === 403) {
    throw new IntervalsAuthError(response.status);
  }
  if (response.status === 429) {
    throw new IntervalsRateLimitError(parseRetryAfterSeconds(response.headers.get('retry-after')));
  }
  return response;
}

/**
 * Corps JSON d'une réponse, validé.
 *
 * Les champs inconnus sont écartés par le schéma. En revanche une réponse dont
 * la **forme** est inattendue lève : mieux vaut un appel en échec, visible dans
 * les journaux, qu'une liste silencieusement amputée.
 */
async function parseJsonBody<T>(
  response: Response,
  context: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new IntervalsApiError(`${context} : réponse JSON illisible.`, response.status, { cause });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join('.') || '(racine)')
      .join(', ');
    throw new IntervalsApiError(
      `${context} : réponse inattendue (champs en défaut : ${fields}).`,
      response.status,
    );
  }

  return parsed.data;
}

/*
 * Liste des activités.
 */

/** Les seuls champs de l'objet activité dont le rapatriement a besoin. */
const activityListSchema = z.array(
  z.object({
    id: z.string(),
    start_date_local: z.string().nullish(),
    type: z.string().nullish(),
    source: z.string().nullish(),
  }),
);

export type IntervalsActivity = {
  id: string;
  /** Début de la séance en heure locale de l'athlète, sans fuseau (format intervals.icu). */
  startDateLocal: string | null;
  /** Type de séance intervals.icu (`Run`, `Ride`, …). */
  type: string | null;
  /** Origine de l'activité (`UPLOAD`, `MANUAL`, `STRAVA`, …). */
  source: string | null;
};

/**
 * Jour civil de l'athlète au format `yyyy-MM-dd`, tel que l'attendent `oldest`
 * et `newest`.
 *
 * Ces paramètres sont documentés comme des dates **locales** : envoyer un
 * instant UTC décalerait la fenêtre d'une journée une partie de l'année. On
 * envoie donc le jour civil dans le fuseau de l'athlète, à la granularité du
 * jour — élargir la fenêtre de quelques heures est sans conséquence, la
 * déduplication se fait sur les fichiers déjà rapatriés.
 */
export function formatIntervalsDate(date: Date, timeZone: string = APP_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  return `${part('year')}-${part('month')}-${part('day')}`;
}

export type ListRecentActivitiesParams = {
  /** Identifiant d'athlète intervals.icu, préfixé d'un `i` (ex. `i123456`). */
  athleteId: string;
  apiKey: string;
  /** Borne basse de la fenêtre ; `newest` est laissé à son défaut (maintenant). */
  oldest: Date;
  /** Fuseau dans lequel exprimer `oldest`. Défaut : celui de l'athlète. */
  timeZone?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Annulation de l'appel en vol (arrêt du service). Combiné au délai de garde. */
  signal?: AbortSignal;
};

/** Activités de l'athlète depuis `oldest`, les plus récentes d'abord. */
export async function listRecentActivities(
  params: ListRecentActivitiesParams,
): Promise<IntervalsActivity[]> {
  const url = new URL(
    `/api/v1/athlete/${encodeURIComponent(params.athleteId)}/activities`,
    params.baseUrl ?? INTERVALS_BASE_URL,
  );
  url.searchParams.set('oldest', formatIntervalsDate(params.oldest, params.timeZone));

  const context = 'liste des activités intervals.icu';
  const response = await authorizedRequest(
    url.toString(),
    params.apiKey,
    params.fetchImpl ?? globalThis.fetch,
    context,
    { signal: params.signal },
  );

  if (!response.ok) {
    throw new IntervalsApiError(`${context} : HTTP ${response.status}.`, response.status);
  }

  const activities = await parseJsonBody(response, context, activityListSchema);

  return activities.map((activity) => ({
    id: activity.id,
    startDateLocal: activity.start_date_local ?? null,
    type: activity.type ?? null,
    source: activity.source ?? null,
  }));
}

/*
 * Téléchargement du fichier original.
 */

export type DownloadFitFileParams = {
  apiKey: string;
  activityId: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Annulation de l'appel en vol (arrêt du service). Combiné au délai de garde. */
  signal?: AbortSignal;
};

/**
 * Corps de la réponse, lu par morceaux et coupé net au premier octet de trop.
 *
 * `arrayBuffer()` matérialiserait tout avant de pouvoir mesurer quoi que ce
 * soit : sur une réponse `chunked`, où aucun `Content-Length` n'annonce la
 * taille, c'est le process du watcher qui part en mémoire. Ici le cumul est
 * vérifié à chaque morceau et le flux annulé dès le dépassement — la connexion
 * se ferme, le reste n'est jamais téléchargé.
 *
 * `null` sur un corps vide (activité sans fichier).
 */
async function readBoundedBody(
  response: Response,
  context: string,
  signal: AbortSignal | undefined,
): Promise<Buffer | null> {
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      received += value.byteLength;
      if (received > MAX_FIT_FILE_BYTES) {
        await reader.cancel();
        throw new IntervalsApiError(
          `${context} : plus de ${toMegabytes(MAX_FIT_FILE_BYTES)} Mo reçus, téléchargement interrompu.`,
          response.status,
        );
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof IntervalsApiError) throw cause;
    if (isAbortLike(cause) || signal?.aborted === true) {
      throw new IntervalsAbortError(context, signal?.aborted !== true, { cause });
    }
    throw new IntervalsApiError(`${context} : lecture de la réponse interrompue.`, response.status, {
      cause,
    });
  }

  if (received === 0) return null;
  return Buffer.concat(chunks);
}

/**
 * Fichier d'activité **original**, tel qu'il a été déposé sur intervals.icu.
 *
 * `null` quand l'activité n'a pas de fichier — séance saisie à la main, activité
 * Strava (non supportée par l'endpoint) : un 404 ou un corps vide valent tous
 * deux « rien à rapatrier », et ce n'est pas une anomalie.
 *
 * La taille est bornée par `MAX_FIT_FILE_BYTES` de deux façons : rejet immédiat
 * si l'en-tête `Content-Length` annonce déjà trop, et coupure en cours de
 * lecture sinon (cf. {@link readBoundedBody}). Ce client tourne dans le process
 * du watcher — une réponse démesurée le ferait redémarrer en boucle et plus
 * aucun import ne passerait.
 */
export async function downloadFitFile(params: DownloadFitFileParams): Promise<Buffer | null> {
  const url = new URL(
    `/api/v1/activity/${encodeURIComponent(params.activityId)}/file`,
    params.baseUrl ?? INTERVALS_BASE_URL,
  );

  const context = `fichier de l'activité ${params.activityId}`;
  const response = await authorizedRequest(
    url.toString(),
    params.apiKey,
    params.fetchImpl ?? globalThis.fetch,
    context,
    { signal: params.signal },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new IntervalsApiError(`${context} : HTTP ${response.status}.`, response.status);
  }

  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_FIT_FILE_BYTES) {
    throw new IntervalsApiError(
      `${context} : ${Math.round(toMegabytes(Number(declared)))} Mo annoncés pour un maximum de ${toMegabytes(MAX_FIT_FILE_BYTES)} Mo, non téléchargé.`,
      response.status,
    );
  }

  return readBoundedBody(response, context, params.signal);
}

/*
 * Calendrier : les séances planifiées que Trainarr pousse chez intervals.icu.
 */

/**
 * Identifiant d'un event du calendrier.
 *
 * La spec le donne numérique ; une chaîne est acceptée sans conversion, parce
 * que cet identifiant ne sert qu'à repartir tel quel dans le corps du
 * `bulk-delete`. Le normaliser n'apporterait rien et pourrait le corrompre.
 */
export type IntervalsEventId = number | string;

/** Les seuls champs d'un event dont la synchronisation du plan a besoin. */
const eventListSchema = z.array(
  z.object({
    id: z.union([z.number(), z.string()]),
    uid: z.string().nullish(),
    category: z.string().nullish(),
    start_date_local: z.string().nullish(),
    name: z.string().nullish(),
  }),
);

export type IntervalsEvent = {
  id: IntervalsEventId;
  /**
   * Identifiant applicatif posé par le créateur de l'event. `null` pour un
   * event créé à la main dans intervals.icu — c'est à ce signe qu'on reconnaît
   * ce que Trainarr n'a pas écrit, et donc ne doit pas toucher.
   */
  uid: string | null;
  category: string | null;
  /** Date locale de l'athlète, sans fuseau (format intervals.icu). */
  startDateLocal: string | null;
  name: string | null;
};

/** Un event de l'API vers son DTO — même forme pour la liste et pour le push. */
function toIntervalsEvent(event: z.infer<typeof eventListSchema>[number]): IntervalsEvent {
  return {
    id: event.id,
    uid: event.uid ?? null,
    category: event.category ?? null,
    startDateLocal: event.start_date_local ?? null,
    name: event.name ?? null,
  };
}

/**
 * Une séance planifiée, telle que Trainarr la publie au calendrier.
 *
 * Les facultatifs le sont **au sens strict** : un champ absent n'est pas envoyé
 * du tout, jamais rempli d'une valeur par défaut — un plan qui ne donne pas de
 * durée n'en invente pas une.
 */
export type IntervalsWorkoutEvent = {
  /** Clé d'idempotence : c'est sur elle que porte `upsertOnUid`. */
  uid: string;
  /** Date civile `YYYY-MM-DD` de la séance. */
  startDate: string;
  /** Type de séance intervals.icu (`Run`, `Ride`, …). */
  type: string;
  name: string;
  description: string;
  /** Durée prévue, en secondes. */
  timeTargetS?: number;
  /** Distance prévue, en mètres. */
  distanceTargetM?: number;
  /** Nature de la cible de la séance. */
  target?: 'PACE';
};

/** Un event WORKOUT au format attendu par l'API. */
function toEventPayload(event: IntervalsWorkoutEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    uid: event.uid,
    category: 'WORKOUT',
    // L'API attend un instant local ; une séance planifiée n'a pas d'heure de
    // départ, elle occupe la journée.
    start_date_local: `${event.startDate}T00:00:00`,
    type: event.type,
    name: event.name,
    description: event.description,
  };

  if (event.timeTargetS !== undefined) payload.time_target = event.timeTargetS;
  if (event.distanceTargetM !== undefined) payload.distance_target = event.distanceTargetM;
  if (event.target !== undefined) payload.target = event.target;

  return payload;
}

/** Ce dont tout appel au calendrier a besoin. */
type CalendarParams = {
  /** Identifiant d'athlète intervals.icu (`i123456`, ou `0` pour le porteur de la clé). */
  athleteId: string;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

function athleteUrl(params: CalendarParams, path: string): URL {
  return new URL(
    `/api/v1/athlete/${encodeURIComponent(params.athleteId)}${path}`,
    params.baseUrl ?? INTERVALS_BASE_URL,
  );
}

export type ListWorkoutEventsParams = CalendarParams & {
  /** Bornes **civiles** `YYYY-MM-DD`, incluses, en heure locale de l'athlète. */
  oldest: string;
  newest: string;
};

/**
 * Les events de catégorie `WORKOUT` de la fenêtre demandée.
 *
 * Filtrer sur la catégorie côté API plutôt qu'ici : une note ou une course
 * cible n'a rien à faire dans un diff de séances planifiées, et la rapatrier
 * pour l'écarter ensuite ne ferait que grossir la réponse.
 */
export async function listWorkoutEvents(
  params: ListWorkoutEventsParams,
): Promise<IntervalsEvent[]> {
  const url = athleteUrl(params, '/events');
  url.searchParams.set('oldest', params.oldest);
  url.searchParams.set('newest', params.newest);
  url.searchParams.set('category', 'WORKOUT');

  const context = 'liste des séances planifiées intervals.icu';
  const response = await authorizedRequest(
    url.toString(),
    params.apiKey,
    params.fetchImpl ?? globalThis.fetch,
    context,
    { signal: params.signal },
  );

  if (!response.ok) {
    throw new IntervalsApiError(`${context} : HTTP ${response.status}.`, response.status);
  }

  const events = await parseJsonBody(response, context, eventListSchema);
  return events.map(toIntervalsEvent);
}

export type UpsertWorkoutEventsParams = CalendarParams & {
  events: readonly IntervalsWorkoutEvent[];
};

/**
 * Publie (ou met à jour) des séances au calendrier, en un seul appel.
 *
 * `upsertOnUid=true` fait toute l'idempotence de la synchronisation : un event
 * portant un `uid` déjà présent est **modifié**, pas dupliqué. Republier le même
 * plan deux fois de suite ne laisse donc qu'une séance par jour.
 *
 * Rend les events tels que l'API les a enregistrés — c'est ce qu'elle
 * **confirme** avoir écrit, la seule mesure honnête de ce que le push a fait.
 */
export async function upsertWorkoutEvents(
  params: UpsertWorkoutEventsParams,
): Promise<IntervalsEvent[]> {
  const url = athleteUrl(params, '/events/bulk');
  url.searchParams.set('upsertOnUid', 'true');

  const context = 'publication des séances planifiées intervals.icu';
  const response = await authorizedRequest(
    url.toString(),
    params.apiKey,
    params.fetchImpl ?? globalThis.fetch,
    context,
    { method: 'POST', body: params.events.map(toEventPayload), signal: params.signal },
  );

  if (!response.ok) {
    throw new IntervalsApiError(`${context} : HTTP ${response.status}.`, response.status);
  }

  const events = await parseJsonBody(response, context, eventListSchema);
  return events.map(toIntervalsEvent);
}

export type DeleteCalendarEventsParams = CalendarParams & {
  /** Identifiants rendus par {@link listWorkoutEvents}, et eux seuls. */
  ids: readonly IntervalsEventId[];
};

/**
 * Supprime des events du calendrier, par identifiant.
 *
 * **Uniquement par `id`** : la suppression par `external_id` est réservée aux
 * applications OAuth, et Trainarr s'authentifie par clé API. Les identifiants
 * viennent donc toujours d'un GET préalable — on ne supprime que ce qu'on vient
 * de lire, et dont on a vérifié le `uid`.
 *
 * La réponse n'est pas lue : le code HTTP dit tout ce dont l'appelant a besoin.
 */
export async function deleteCalendarEvents(params: DeleteCalendarEventsParams): Promise<void> {
  const url = athleteUrl(params, '/events/bulk-delete');

  const context = 'suppression de séances planifiées intervals.icu';
  const response = await authorizedRequest(
    url.toString(),
    params.apiKey,
    params.fetchImpl ?? globalThis.fetch,
    context,
    {
      method: 'PUT',
      body: params.ids.map((id) => ({ id })),
      signal: params.signal,
    },
  );

  if (!response.ok) {
    throw new IntervalsApiError(`${context} : HTTP ${response.status}.`, response.status);
  }
}
