import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActivity,
  getActivityStreams,
  getRateLimitStatus,
  listActivities,
  resetRateLimitStatus,
} from './client';
import { StravaApiError, StravaAuthError, StravaRateLimitError } from './errors';

const fetchMock = vi.fn<typeof fetch>();

/** 9 h 07 min 30 s UTC : la fenêtre de quota suivante démarre à 9 h 15. */
const NOW = new Date('2026-08-10T09:07:30.000Z');
const NEXT_WINDOW = new Date('2026-08-10T09:15:00.000Z');

/** Le quota journalier, lui, ne se réinitialise qu'à minuit UTC. */
const NEXT_UTC_MIDNIGHT = new Date('2026-08-11T00:00:00.000Z');

vi.useFakeTimers();
vi.setSystemTime(NOW);

afterAll(() => {
  vi.useRealTimers();
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/** Activité Strava telle que renvoyée par l'API, champs surnuméraires compris. */
const RAW_ACTIVITY = {
  resource_state: 2,
  id: 15_123_456_789,
  name: 'Sortie longue',
  sport_type: 'Run',
  type: 'Run',
  start_date: '2026-08-02T06:30:00Z',
  start_date_local: '2026-08-02T08:30:00Z',
  distance: 21_097.5,
  moving_time: 6_120,
  elapsed_time: 6_300,
  total_elevation_gain: 187.4,
  average_heartrate: 152.4,
  max_heartrate: 176,
  average_cadence: 87.5,
  average_speed: 3.447,
  athlete: { id: 987_654 },
  map: { polyline: 'abc' },
};

const PARSED_ACTIVITY = {
  id: 15_123_456_789,
  athleteStravaId: 987_654,
  name: 'Sortie longue',
  sportType: 'Run',
  startedAt: new Date('2026-08-02T06:30:00.000Z'),
  distanceM: 21_097.5,
  movingTimeS: 6_120,
  elapsedTimeS: 6_300,
  elevationGainM: 187.4,
  avgHrBpm: 152.4,
  maxHrBpm: 176,
  avgCadenceSpm: 175, // average_cadence 87.5 cycles/min × 2 → pas/min
};

function requestUrl(call = 0): URL {
  const input = fetchMock.mock.calls[call]?.[0];
  if (!(input instanceof URL)) throw new Error('La requête doit viser une URL.');
  return input;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  resetRateLimitStatus();
  vi.setSystemTime(NOW);
});

describe('listActivities', () => {
  it('appelle le endpoint paginé de l’athlète avec le jeton fourni', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await listActivities('access-xyz', { page: 2, perPage: 100 });

    const url = requestUrl();
    expect(url.origin + url.pathname).toBe('https://www.strava.com/api/v3/athlete/activities');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.has('after')).toBe(false);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer access-xyz');
  });

  it('convertit `after` en epoch secondes', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await listActivities('access-xyz', {
      page: 1,
      perPage: 100,
      after: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(requestUrl().searchParams.get('after')).toBe('1782864000');
  });

  it('ne retient que les champs utiles et normalise les unités', async () => {
    fetchMock.mockResolvedValue(jsonResponse([RAW_ACTIVITY]));

    const activities = await listActivities('access-xyz', { page: 1, perPage: 100 });

    expect(activities).toEqual([PARSED_ACTIVITY]);
    expect(activities[0]).not.toHaveProperty('map');
    expect(activities[0]).not.toHaveProperty('athlete');
  });

  it('conserve le propriétaire annoncé par l’API, pour le contrôle de la sync', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ ...RAW_ACTIVITY, athlete: { id: 111_222 } }]));

    const [activity] = await listActivities('access-xyz', { page: 1, perPage: 100 });

    expect(activity?.athleteStravaId).toBe(111_222);
  });

  it('laisse `athleteStravaId` à null quand l’API n’expose pas le propriétaire', async () => {
    const withoutOwner = { ...RAW_ACTIVITY };
    delete (withoutOwner as Partial<typeof RAW_ACTIVITY>).athlete;
    fetchMock.mockResolvedValue(jsonResponse([withoutOwner]));

    const [activity] = await listActivities('access-xyz', { page: 1, perPage: 100 });

    expect(activity?.athleteStravaId).toBeNull();
  });

  it('met à `null` les métriques absentes plutôt que de les inventer', async () => {
    const withoutSensors = { ...RAW_ACTIVITY };
    delete (withoutSensors as Partial<typeof RAW_ACTIVITY>).average_heartrate;
    delete (withoutSensors as Partial<typeof RAW_ACTIVITY>).max_heartrate;
    delete (withoutSensors as Partial<typeof RAW_ACTIVITY>).average_cadence;
    fetchMock.mockResolvedValue(jsonResponse([withoutSensors]));

    const [activity] = await listActivities('access-xyz', { page: 1, perPage: 100 });

    expect(activity).toMatchObject({ avgHrBpm: null, maxHrBpm: null, avgCadenceSpm: null });
  });

  it('rejette une réponse dont un champ requis manque', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: 1, name: 'Incomplète' }]));

    await expect(listActivities('access-xyz', { page: 1, perPage: 100 })).rejects.toBeInstanceOf(
      StravaApiError,
    );
  });

  it('signale un jeton expiré (HTTP 401) pour déclencher un refresh', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Authorization Error' }, { status: 401 }));

    const error = await listActivities('access-perime', { page: 1, perPage: 100 }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(StravaAuthError);
    expect(error).toMatchObject({ status: 401 });
  });

  it('remonte les autres statuts en erreur typée', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Server Error' }, { status: 500 }));

    const error = await listActivities('access-xyz', { page: 1, perPage: 100 }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(StravaApiError);
    expect(error).toMatchObject({ status: 500 });
  });
});

describe('quotas', () => {
  it('mémorise les en-têtes de quota de la dernière réponse', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([], {
        headers: {
          'X-RateLimit-Usage': '42, 300',
          'X-RateLimit-Limit': '200, 2000',
        },
      }),
    );

    await listActivities('access-xyz', { page: 1, perPage: 100 });

    expect(getRateLimitStatus()).toEqual({
      shortTermUsage: 42,
      shortTermLimit: 200,
      dailyUsage: 300,
      dailyLimit: 2000,
      readAt: NOW,
    });
  });

  it('lève StravaRateLimitError sur 429, avec l’attente jusqu’à la fenêtre suivante', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Rate Limit Exceeded' }, { status: 429 }));

    const error = await listActivities('access-xyz', { page: 1, perPage: 100 }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(StravaRateLimitError);
    expect(error).toMatchObject({ retryAt: NEXT_WINDOW, retryAfterS: 450 });
  });

  it('s’arrête avant d’émettre la requête quand le quota court terme est épuisé', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([], {
        headers: { 'X-RateLimit-Usage': '200, 300', 'X-RateLimit-Limit': '200, 2000' },
      }),
    );
    await listActivities('access-xyz', { page: 1, perPage: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const error = await listActivities('access-xyz', { page: 2, perPage: 100 }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(StravaRateLimitError);
    expect(error).toMatchObject({ retryAt: NEXT_WINDOW });
    // Aucune requête supplémentaire : pas de rafale contre un quota épuisé.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('s’arrête aussi quand le quota journalier est épuisé', async () => {
    // Quota court terme intact (12/200) : seul le journalier est atteint.
    fetchMock.mockResolvedValue(
      jsonResponse([], {
        headers: { 'X-RateLimit-Usage': '12, 2000', 'X-RateLimit-Limit': '200, 2000' },
      }),
    );
    await listActivities('access-xyz', { page: 1, perPage: 100 });

    const error = await listActivities('access-xyz', { page: 2, perPage: 100 }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(StravaRateLimitError);
    // Les fenêtres journalières Strava se réinitialisent à minuit UTC.
    expect(error).toMatchObject({ retryAt: NEXT_UTC_MIDNIGHT, retryAfterS: 53_550 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ne repart pas au bout de 15 min quand c’est le quota journalier', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse([], {
          headers: { 'X-RateLimit-Usage': '12, 2000', 'X-RateLimit-Limit': '200, 2000' },
        }),
      ),
    );
    await listActivities('access-xyz', { page: 1, perPage: 100 });

    vi.setSystemTime(NEXT_WINDOW);
    await expect(listActivities('access-xyz', { page: 2, perPage: 100 })).rejects.toBeInstanceOf(
      StravaRateLimitError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NEXT_UTC_MIDNIGHT);
    await expect(listActivities('access-xyz', { page: 2, perPage: 100 })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('repart une fois la fenêtre de 15 min écoulée', async () => {
    // Une nouvelle réponse par appel : un corps `Response` ne se lit qu'une fois.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse([], {
          headers: { 'X-RateLimit-Usage': '200, 300', 'X-RateLimit-Limit': '200, 2000' },
        }),
      ),
    );
    await listActivities('access-xyz', { page: 1, perPage: 100 });

    vi.setSystemTime(NEXT_WINDOW);
    await expect(listActivities('access-xyz', { page: 2, perPage: 100 })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getActivity', () => {
  it('récupère une activité par son identifiant Strava', async () => {
    fetchMock.mockResolvedValue(jsonResponse(RAW_ACTIVITY));

    const activity = await getActivity('access-xyz', 15_123_456_789);

    expect(requestUrl().pathname).toBe('/api/v3/activities/15123456789');
    expect(activity).toEqual(PARSED_ACTIVITY);
  });
});

describe('getActivityStreams', () => {
  it('demande les streams typés par clé', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await getActivityStreams('access-xyz', 42);

    const url = requestUrl();
    expect(url.pathname).toBe('/api/v3/activities/42/streams');
    expect(url.searchParams.get('key_by_type')).toBe('true');
    expect(url.searchParams.get('keys')).toBe(
      'time,distance,heartrate,altitude,cadence,velocity_smooth,latlng',
    );
  });

  it('normalise les séries et renomme `velocity_smooth`', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        time: { data: [0, 1, 2], series_type: 'distance', original_size: 3, resolution: 'high' },
        heartrate: { data: [120, 130, 140] },
        velocity_smooth: { data: [3.1, 3.2, 3.3] },
        latlng: { data: [[48.85, 2.35]] },
      }),
    );

    const streams = await getActivityStreams('access-xyz', 42);

    expect(streams).toEqual({
      time: [0, 1, 2],
      heartrate: [120, 130, 140],
      velocity: [3.1, 3.2, 3.3],
      latlng: [[48.85, 2.35]],
    });
  });

  it('retourne null quand l’activité n’a pas de streams (404)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Record Not Found' }, { status: 404 }));

    await expect(getActivityStreams('access-xyz', 42)).resolves.toBeNull();
  });

  it('rejette une série malformée', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ heartrate: { data: ['120'] } }));

    await expect(getActivityStreams('access-xyz', 42)).rejects.toBeInstanceOf(StravaApiError);
  });
});
