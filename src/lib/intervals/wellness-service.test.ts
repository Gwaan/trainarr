import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type FetchLike } from './client';
import { runDailyWellness } from './wellness-service';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { dal } = vi.hoisted(() => ({
  dal: {
    getWellnessReadingDay: vi.fn(),
    saveWellnessDays: vi.fn(),
    setWellnessReadingDay: vi.fn(),
  },
}));

vi.mock('@/data/wellness', () => ({
  getWellnessReadingDay: dal.getWellnessReadingDay,
  saveWellnessDays: dal.saveWellnessDays,
  setWellnessReadingDay: dal.setWellnessReadingDay,
}));

const ATHLETE_ID = 7;
const CREDENTIALS = { intervalsAthleteId: 'i123456', apiKey: 'cle-de-test' };

/** 09 h 30 locales (Europe/Paris, UTC+2 en août) : le relevé du jour est dû. */
const NOW = new Date('2026-08-13T07:30:00Z');

/** L'ordre réel des effets, pour éprouver ce qui précède quoi. */
let order: string[] = [];

function stubFetch(body: unknown, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const ONE_DAY = [{ id: '2026-08-13', restingHR: 47, hrv: 63 }];

beforeEach(() => {
  vi.clearAllMocks();
  order = [];

  dal.getWellnessReadingDay.mockResolvedValue(null);
  dal.saveWellnessDays.mockImplementation(async (_id: number, readings: unknown[]) => {
    order.push('save');
    return readings.length;
  });
  dal.setWellnessReadingDay.mockImplementation(async () => {
    order.push('marker');
  });
});

function run(options: { fetchImpl: FetchLike; now?: Date }) {
  return runDailyWellness(ATHLETE_ID, CREDENTIALS, {
    now: options.now ?? NOW,
    fetchImpl: options.fetchImpl,
  });
}

describe('runDailyWellness — le rendez-vous', () => {
  it('relève et pose son marqueur quand rien n’a jamais été relevé', async () => {
    const report = await run({ fetchImpl: stubFetch(ONE_DAY) });

    expect(report).toEqual({
      status: 'saved',
      readingDay: '2026-08-13',
      days: 1,
      reason: null,
      retryAfterS: null,
    });
    expect(dal.setWellnessReadingDay).toHaveBeenCalledWith(ATHLETE_ID, '2026-08-13');
  });

  it('ne fait rien — et n’appelle pas l’API — quand le jour a déjà été relevé', async () => {
    dal.getWellnessReadingDay.mockResolvedValue('2026-08-13');
    const fetchImpl = vi.fn(stubFetch(ONE_DAY));

    expect(await run({ fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dal.saveWellnessDays).not.toHaveBeenCalled();
  });

  it('écrit les journées **avant** de poser le marqueur', async () => {
    // L'ordre inverse ferait perdre la journée si l'écriture échouait : le
    // marqueur dirait « relevé » sans rien avoir écrit.
    await run({ fetchImpl: stubFetch(ONE_DAY) });

    expect(order).toEqual(['save', 'marker']);
  });

  it('demande la fenêtre des quatorze derniers jours', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    };

    await run({ fetchImpl });

    const params = new URL(calls[0]).searchParams;
    expect(params.get('oldest')).toBe('2026-07-31');
    expect(params.get('newest')).toBe('2026-08-13');
  });
});

describe('runDailyWellness — les échecs', () => {
  it('ne pose aucun marqueur quand l’appel échoue : le cycle suivant reprendra', async () => {
    const report = await run({ fetchImpl: stubFetch({}, 500) });

    expect(report).toMatchObject({ status: 'failed', days: 0 });
    expect(report?.reason).toContain('500');
    expect(dal.setWellnessReadingDay).not.toHaveBeenCalled();
  });

  it('remonte le délai demandé par un quota atteint', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('', { status: 429, headers: { 'retry-after': '120' } });

    const report = await run({ fetchImpl });

    expect(report).toMatchObject({ status: 'failed', retryAfterS: 120 });
  });

  it('ne rend rien — ni marqueur, ni rapport — quand l’arrêt du service coupe l’appel', async () => {
    const controller = new AbortController();
    controller.abort();

    // Un `fetch` qui honore son signal, comme le vrai : c'est lui qui rejette,
    // et le client en fait une `IntervalsAbortError`.
    const abortingFetch: FetchLike = (_url, init) =>
      Promise.reject(init?.signal?.reason ?? new Error('interrompu'));

    const report = await runDailyWellness(ATHLETE_ID, CREDENTIALS, {
      now: NOW,
      signal: controller.signal,
      fetchImpl: abortingFetch,
    });

    expect(report).toBeNull();
    expect(dal.setWellnessReadingDay).not.toHaveBeenCalled();
  });

  it('ne lève pas quand la base est injoignable : c’est un échec de relevé', async () => {
    dal.getWellnessReadingDay.mockRejectedValue(new Error('connexion refusée'));

    const report = await run({ fetchImpl: stubFetch(ONE_DAY) });

    expect(report).toMatchObject({ status: 'failed' });
    expect(report?.reason).toContain('connexion refusée');
  });

  it('ne lève pas non plus quand l’écriture échoue après un appel réussi', async () => {
    dal.saveWellnessDays.mockRejectedValue(new Error('écriture impossible'));

    const report = await run({ fetchImpl: stubFetch(ONE_DAY) });

    expect(report).toMatchObject({ status: 'failed' });
    expect(dal.setWellnessReadingDay).not.toHaveBeenCalled();
  });
});
