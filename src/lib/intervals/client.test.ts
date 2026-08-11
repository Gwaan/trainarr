import { describe, expect, it } from 'vitest';

import { MAX_FIT_FILE_BYTES } from '@/lib/fit/limits';

import {
  createWorkoutEvents,
  deleteCalendarEvents,
  downloadFitFile,
  formatIntervalsDate,
  IntervalsAbortError,
  IntervalsApiError,
  IntervalsAuthError,
  IntervalsRateLimitError,
  listRecentActivities,
  listWorkoutEvents,
  parseRetryAfterSeconds,
  type FetchLike,
  type IntervalsWorkoutEvent,
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

/** Le corps JSON réellement envoyé — c'est le contrat que l'API lit. */
function bodyOf(call: Call): unknown {
  const { body } = call.init ?? {};
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

const WORKOUT: IntervalsWorkoutEvent = {
  externalId: 'trainarr-p3-2026-08-18-0',
  startDate: '2026-08-18',
  type: 'Run',
  name: 'VMA courte · piste — 6 × 800 m',
  description: 'Échauffement : 15 min\nSéance : 6 × 800 m',
  timeTargetS: 3_600,
  distanceTargetM: 12_000,
  target: 'PACE',
};

describe('listWorkoutEvents', () => {
  it("interroge les events WORKOUT de la fenêtre demandée", async () => {
    const { fetchImpl, calls } = stubFetch(json([]));

    await listWorkoutEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: '2026-08-11',
      newest: '2026-09-30',
      fetchImpl,
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/athlete/i123456/events');
    expect(url.searchParams.get('oldest')).toBe('2026-08-11');
    expect(url.searchParams.get('newest')).toBe('2026-09-30');
    expect(url.searchParams.get('category')).toBe('WORKOUT');
    expect(calls[0].init?.method).toBe('GET');
    expect(decodeBasic(authorizationOf(calls[0]))).toBe(`API_KEY:${API_KEY}`);
  });

  it("ne retient que les champs utiles, et lit le marqueur dans external_id", async () => {
    // Le `uid` rendu par l'API est celui que le serveur a généré, pas celui
    // qu'on a posté : il est ignoré, seul `external_id` dit l'origine.
    const { fetchImpl } = stubFetch(
      json([
        {
          id: 4321,
          uid: 'bc3b5987-7e0d-4a2f-9c1e-0f5b2a7d31aa',
          external_id: 'trainarr-p3-2026-08-18-0',
          category: 'WORKOUT',
          start_date_local: '2026-08-18T00:00:00',
          name: 'VMA courte',
          icu_training_load: 60,
        },
        { id: 4322, category: 'WORKOUT' },
      ]),
    );

    const events = await listWorkoutEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      oldest: '2026-08-11',
      newest: '2026-09-30',
      fetchImpl,
    });

    expect(events).toEqual([
      {
        id: 4321,
        externalId: 'trainarr-p3-2026-08-18-0',
        category: 'WORKOUT',
        startDateLocal: '2026-08-18T00:00:00',
        name: 'VMA courte',
      },
      { id: 4322, externalId: null, category: 'WORKOUT', startDateLocal: null, name: null },
    ]);
  });

  it('lève une erreur typée sur une réponse de forme inattendue', async () => {
    const { fetchImpl } = stubFetch(json({ events: [] }));

    await expect(
      listWorkoutEvents({
        athleteId: ATHLETE_ID,
        apiKey: API_KEY,
        oldest: '2026-08-11',
        newest: '2026-09-30',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(IntervalsApiError);
  });

  it('traduit un 401 en IntervalsAuthError', async () => {
    const { fetchImpl } = stubFetch(new Response('nope', { status: 401 }));

    await expect(
      listWorkoutEvents({
        athleteId: ATHLETE_ID,
        apiKey: API_KEY,
        oldest: '2026-08-11',
        newest: '2026-09-30',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(IntervalsAuthError);
  });
});

describe('createWorkoutEvents', () => {
  it('poste les events en bulk, sans upsertOnUid', async () => {
    const { fetchImpl, calls } = stubFetch(json([{ id: 4321, external_id: WORKOUT.externalId }]));

    await createWorkoutEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      events: [WORKOUT],
      fetchImpl,
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/athlete/i123456/events/bulk');
    // L'upsert portait sur un `uid` que le serveur réécrit : il ne matchait rien.
    expect(url.searchParams.get('upsertOnUid')).toBeNull();
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/json');
  });

  it("envoie les champs de l'API, et n'invente pas les cibles absentes", async () => {
    const { fetchImpl, calls } = stubFetch(json([]));

    await createWorkoutEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      events: [
        WORKOUT,
        {
          externalId: 'trainarr-p3-2026-08-20-0',
          startDate: '2026-08-20',
          type: 'Run',
          name: 'Footing',
          description: 'Séance : 45 min',
        },
      ],
      fetchImpl,
    });

    expect(bodyOf(calls[0])).toEqual([
      {
        external_id: 'trainarr-p3-2026-08-18-0',
        category: 'WORKOUT',
        start_date_local: '2026-08-18T00:00:00',
        type: 'Run',
        name: 'VMA courte · piste — 6 × 800 m',
        description: 'Échauffement : 15 min\nSéance : 6 × 800 m',
        time_target: 3_600,
        distance_target: 12_000,
        target: 'PACE',
      },
      {
        external_id: 'trainarr-p3-2026-08-20-0',
        category: 'WORKOUT',
        start_date_local: '2026-08-20T00:00:00',
        type: 'Run',
        name: 'Footing',
        description: 'Séance : 45 min',
      },
    ]);
  });

  it("n'envoie aucun uid : l'API l'ignore et poserait le sien", async () => {
    const { fetchImpl, calls } = stubFetch(json([]));

    await createWorkoutEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      events: [WORKOUT],
      fetchImpl,
    });

    const [payload] = bodyOf(calls[0]) as Record<string, unknown>[];
    expect(payload).not.toHaveProperty('uid');
  });

  it("rend les events tels que l'API les a enregistrés", async () => {
    const { fetchImpl } = stubFetch(
      json([
        {
          id: 4321,
          uid: 'bc3b5987-7e0d-4a2f-9c1e-0f5b2a7d31aa',
          external_id: WORKOUT.externalId,
          category: 'WORKOUT',
          start_date_local: '2026-08-18T00:00:00',
        },
      ]),
    );

    const written = await createWorkoutEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      events: [WORKOUT],
      fetchImpl,
    });

    expect(written).toEqual([
      {
        id: 4321,
        externalId: WORKOUT.externalId,
        category: 'WORKOUT',
        startDateLocal: '2026-08-18T00:00:00',
        name: null,
      },
    ]);
  });

  it('lève une IntervalsApiError sur une erreur serveur', async () => {
    const { fetchImpl } = stubFetch(new Response('boom', { status: 500 }));

    const error = await createWorkoutEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      events: [WORKOUT],
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsApiError);
    expect((error as IntervalsApiError).status).toBe(500);
    expect((error as Error).message).not.toContain(API_KEY);
  });
});

describe('deleteCalendarEvents', () => {
  it('supprime par id, en PUT sur bulk-delete', async () => {
    const { fetchImpl, calls } = stubFetch(new Response(null, { status: 200 }));

    await deleteCalendarEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      ids: [4321, 4322],
      fetchImpl,
    });

    expect(new URL(calls[0].url).pathname).toBe('/api/v1/athlete/i123456/events/bulk-delete');
    expect(calls[0].init?.method).toBe('PUT');
    // Jamais `external_id` : il est réservé aux applications OAuth.
    expect(bodyOf(calls[0])).toEqual([{ id: 4321 }, { id: 4322 }]);
  });

  it("rend le compte que l'API déclare avoir supprimé", async () => {
    // `eventsDeleted` est ce que le service répond réellement (vérifié) : c'est
    // un chiffre mesuré, pas le nombre d'ids qu'on a envoyés.
    const { fetchImpl } = stubFetch(json({ eventsDeleted: 1 }));

    await expect(
      deleteCalendarEvents({
        athleteId: ATHLETE_ID,
        apiKey: API_KEY,
        ids: [4321, 4322],
        fetchImpl,
      }),
    ).resolves.toBe(1);
  });

  it('retombe sur le nombre d\'ids envoyés quand le compte-rendu manque', async () => {
    // Une suppression réussie ne doit jamais échouer sur la forme de sa réponse.
    for (const response of [
      json({}),
      json({ eventsDeleted: null }),
      json({ eventsDeleted: 'deux' }),
      json(['inattendu']),
      new Response('pas du JSON', { status: 200 }),
      new Response(null, { status: 200 }),
    ]) {
      const { fetchImpl } = stubFetch(response);

      await expect(
        deleteCalendarEvents({
          athleteId: ATHLETE_ID,
          apiKey: API_KEY,
          ids: [4321, 4322],
          fetchImpl,
        }),
      ).resolves.toBe(2);
    }
  });

  it('propage un 429 comme IntervalsRateLimitError', async () => {
    const { fetchImpl } = stubFetch(
      new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
    );

    const error = await deleteCalendarEvents({
      athleteId: ATHLETE_ID,
      apiKey: API_KEY,
      ids: [4321],
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntervalsRateLimitError);
    expect((error as IntervalsRateLimitError).retryAfterS).toBe(30);
  });

  it('lève une IntervalsApiError sur une erreur serveur', async () => {
    const { fetchImpl } = stubFetch(new Response('boom', { status: 500 }));

    await expect(
      deleteCalendarEvents({ athleteId: ATHLETE_ID, apiKey: API_KEY, ids: [1], fetchImpl }),
    ).rejects.toBeInstanceOf(IntervalsApiError);
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
