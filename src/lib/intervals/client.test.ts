import { describe, expect, it } from 'vitest';

import { MAX_FIT_FILE_BYTES } from '@/lib/fit/limits';

import {
  downloadFitFile,
  formatIntervalsDate,
  IntervalsAbortError,
  IntervalsApiError,
  IntervalsAuthError,
  IntervalsRateLimitError,
  listRecentActivities,
  parseRetryAfterSeconds,
  type FetchLike,
} from './client';

const API_KEY = 'cle-api-de-test-a-ne-jamais-journaliser';
const ATHLETE_ID = 'i123456';

/** Les appels observés — aucun test n'ouvre de connexion réseau. */
type Call = { url: string; init: RequestInit | undefined };

function stubFetch(
  response: Response | ((init: RequestInit | undefined) => Response | Promise<never>),
): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(init) : response;
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Un appel qui ne répond jamais — sauf à être avorté, comme le fait `fetch`.
 * C'est le scénario qui bloquait l'arrêt du poller jusqu'au SIGKILL de Docker.
 */
const neverResolving = (init: RequestInit | undefined): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal == null) return;
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error));
  });

/** Un corps de réponse en flux, qui compte ce qu'il a réellement produit. */
function countedStream(
  chunkBytes: number,
  chunks: number,
): { body: ReadableStream<Uint8Array>; produced: () => number; cancelled: () => boolean } {
  let sent = 0;
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      cancelled = true;
    },
  });

  return { body, produced: () => sent, cancelled: () => cancelled };
}

/** Le couple `utilisateur:mot de passe` porté par un en-tête Basic. */
function decodeBasic(header: string): string {
  return Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8');
}

function authorizationOf(call: Call): string {
  const headers = new Headers(call.init?.headers);
  return headers.get('authorization') ?? '';
}

describe('parseRetryAfterSeconds', () => {
  it('lit un délai en secondes', () => {
    expect(parseRetryAfterSeconds('120')).toBe(120);
  });

  it('convertit une date HTTP en délai', () => {
    const now = Date.parse('2026-08-10T10:00:00Z');
    expect(parseRetryAfterSeconds('Mon, 10 Aug 2026 10:01:00 GMT', now)).toBe(60);
  });

  it("retourne null sur un en-tête absent ou illisible", () => {
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds('  ')).toBeNull();
    expect(parseRetryAfterSeconds('bientôt')).toBeNull();
  });
});

describe('formatIntervalsDate', () => {
  it("exprime le jour civil dans le fuseau de l'athlète", () => {
    // 23 h 30 UTC le 9 août, c'est déjà le 10 à Paris (UTC+2 en été).
    expect(formatIntervalsDate(new Date('2026-08-09T23:30:00Z'), 'Europe/Paris')).toBe('2026-08-10');
    expect(formatIntervalsDate(new Date('2026-08-09T23:30:00Z'), 'UTC')).toBe('2026-08-09');
  });
});

describe('listRecentActivities', () => {
  it("authentifie en Basic avec l'utilisateur littéral API_KEY", async () => {
    const { fetchImpl, calls } = stubFetch(json([]));

    await listRecentActivities({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: new Date('2026-07-11T00:00:00Z'),
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(decodeBasic(authorizationOf(calls[0]))).toBe(`API_KEY:${API_KEY}`);
  });

  it("interroge l'endpoint documenté avec la borne oldest", async () => {
    const { fetchImpl, calls } = stubFetch(json([]));

    await listRecentActivities({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: new Date('2026-07-11T09:00:00Z'),
      timeZone: 'Europe/Paris',
      fetchImpl,
    });

    const url = new URL(calls[0].url);
    expect(url.origin).toBe('https://intervals.icu');
    expect(url.pathname).toBe('/api/v1/athlete/i123456/activities');
    expect(url.searchParams.get('oldest')).toBe('2026-07-11');
  });

  it('ne retient que les champs utiles et ignore les inconnus', async () => {
    const { fetchImpl } = stubFetch(
      json([
        {
          id: 'i900',
          start_date_local: '2026-08-09T07:12:00',
          type: 'Run',
          source: 'UPLOAD',
          icu_training_load: 87,
          name: 'Sortie longue',
        },
        { id: 'i901', start_date_local: null, type: null, source: null },
      ]),
    );

    const activities = await listRecentActivities({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: new Date('2026-07-11T00:00:00Z'),
      fetchImpl,
    });

    expect(activities).toEqual([
      { id: 'i900', startDateLocal: '2026-08-09T07:12:00', type: 'Run', source: 'UPLOAD' },
      { id: 'i901', startDateLocal: null, type: null, source: null },
    ]);
  });

  it('lève une erreur typée sur une réponse de forme inattendue', async () => {
    const { fetchImpl } = stubFetch(json({ activities: [] }));

    await expect(
      listRecentActivities({
        athleteId: ATHLETE_ID,
        apiKey: API_KEY,
        oldest: new Date('2026-07-11T00:00:00Z'),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(IntervalsApiError);
  });

  it.each([401, 403])('traduit un %i en IntervalsAuthError', async (status) => {
    const { fetchImpl } = stubFetch(new Response('nope', { status }));

    const error = await listRecentActivities({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: new Date('2026-07-11T00:00:00Z'),
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsAuthError);
    expect((error as IntervalsAuthError).status).toBe(status);
  });

  it('traduit un 429 en IntervalsRateLimitError avec son Retry-After', async () => {
    const { fetchImpl } = stubFetch(
      new Response('slow down', { status: 429, headers: { 'retry-after': '90' } }),
    );

    const error = await listRecentActivities({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: new Date('2026-07-11T00:00:00Z'),
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsRateLimitError);
    expect((error as IntervalsRateLimitError).retryAfterS).toBe(90);
  });

  it('laisse retryAfterS à null quand le 429 ne dit rien', async () => {
    const { fetchImpl } = stubFetch(new Response('slow down', { status: 429 }));

    const error = await listRecentActivities({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: new Date('2026-07-11T00:00:00Z'),
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect((error as IntervalsRateLimitError).retryAfterS).toBeNull();
  });

  it("ne fait jamais figurer la clé API dans le message d'erreur", async () => {
    const cases: Array<() => Response | Promise<never>> = [
      () => new Response('nope', { status: 401 }),
      () => new Response('slow down', { status: 429 }),
      () => new Response('boom', { status: 500 }),
      () => Promise.reject(new Error(`fetch failed for key ${API_KEY}`)),
    ];

    for (const response of cases) {
      const { fetchImpl } = stubFetch(response);
      const error = await listRecentActivities({
        athleteId: ATHLETE_ID,
        apiKey: API_KEY,
        oldest: new Date('2026-07-11T00:00:00Z'),
        fetchImpl,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(API_KEY);
    }
  });
});

describe('downloadFitFile', () => {
  it("télécharge le fichier original sur l'endpoint documenté", async () => {
    const payload = new Uint8Array([0x0e, 0x10, 0x2e, 0x46, 0x49, 0x54]);
    const { fetchImpl, calls } = stubFetch(new Response(payload, { status: 200 }));

    const file = await downloadFitFile({ apiKey: API_KEY, activityId: 'i900', fetchImpl });

    expect(new URL(calls[0].url).pathname).toBe('/api/v1/activity/i900/file');
    expect(decodeBasic(authorizationOf(calls[0]))).toBe(`API_KEY:${API_KEY}`);
    expect(file).not.toBeNull();
    expect(Uint8Array.from(file as Buffer)).toEqual(payload);
  });

  it('retourne null sur un 404 — activité sans fichier original', async () => {
    const { fetchImpl } = stubFetch(new Response('not found', { status: 404 }));

    await expect(
      downloadFitFile({ apiKey: API_KEY, activityId: 'i901', fetchImpl }),
    ).resolves.toBeNull();
  });

  it('retourne null sur un corps vide', async () => {
    const { fetchImpl } = stubFetch(new Response(null, { status: 204 }));

    await expect(
      downloadFitFile({ apiKey: API_KEY, activityId: 'i902', fetchImpl }),
    ).resolves.toBeNull();
  });

  it('refuse un fichier hors gabarit sans le matérialiser', async () => {
    const { fetchImpl } = stubFetch(
      new Response('x', { status: 200, headers: { 'content-length': String(80 * 1024 * 1024) } }),
    );

    const error = await downloadFitFile({
      apiKey: API_KEY,
      activityId: 'i903',
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsApiError);
  });

  it('lève une IntervalsApiError sur une erreur serveur', async () => {
    const { fetchImpl } = stubFetch(new Response('boom', { status: 500 }));

    const error = await downloadFitFile({
      apiKey: API_KEY,
      activityId: 'i904',
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsApiError);
    expect((error as IntervalsApiError).status).toBe(500);
  });

  it('propage un 429 comme IntervalsRateLimitError', async () => {
    const { fetchImpl } = stubFetch(
      new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
    );

    const error = await downloadFitFile({
      apiKey: API_KEY,
      activityId: 'i905',
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsRateLimitError);
    expect((error as IntervalsRateLimitError).retryAfterS).toBe(30);
  });

  it("coupe un flux hors gabarit qui n'annonce pas sa taille", async () => {
    // Réponse en `Transfer-Encoding: chunked` : aucun `Content-Length` à
    // vérifier, la borne ne peut venir que de la lecture elle-même.
    const chunkBytes = 1024 * 1024;
    const stream = countedStream(chunkBytes, 200);
    const { fetchImpl } = stubFetch(new Response(stream.body, { status: 200 }));

    const error = await downloadFitFile({
      apiKey: API_KEY,
      activityId: 'i906',
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsApiError);
    // Coupé dès le dépassement : jamais les 200 Mo en mémoire.
    expect(stream.produced()).toBeLessThan(MAX_FIT_FILE_BYTES / chunkBytes + 10);
    expect(stream.cancelled()).toBe(true);
  });

  it('assemble un flux qui tient dans le gabarit', async () => {
    const stream = countedStream(8, 3);
    const { fetchImpl } = stubFetch(new Response(stream.body, { status: 200 }));

    const file = await downloadFitFile({ apiKey: API_KEY, activityId: 'i907', fetchImpl });

    expect(file?.byteLength).toBe(24);
  });

  it('rejette sans attendre quand le signal est déjà avorté', async () => {
    const { fetchImpl } = stubFetch(neverResolving);

    const error = await downloadFitFile({
      apiKey: API_KEY,
      activityId: 'i908',
      fetchImpl,
      signal: AbortSignal.abort(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsAbortError);
    expect((error as IntervalsAbortError).timedOut).toBe(false);
  });

  it("rejette dès que le signal s'avorte en cours d'appel", async () => {
    const { fetchImpl } = stubFetch(neverResolving);
    const controller = new AbortController();

    const pending = downloadFitFile({
      apiKey: API_KEY,
      activityId: 'i909',
      fetchImpl,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    controller.abort();

    expect(await pending).toBeInstanceOf(IntervalsAbortError);
  });

  it("pose un délai de garde même sans signal de l'appelant", async () => {
    const { fetchImpl, calls } = stubFetch(new Response('x', { status: 200 }));

    await downloadFitFile({ apiKey: API_KEY, activityId: 'i910', fetchImpl });

    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('listRecentActivities — annulation', () => {
  it('rejette quand le signal est avorté', async () => {
    const { fetchImpl } = stubFetch(neverResolving);

    const error = await listRecentActivities({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: new Date('2026-07-11T00:00:00Z'),
      fetchImpl,
      signal: AbortSignal.abort(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsAbortError);
  });
});
