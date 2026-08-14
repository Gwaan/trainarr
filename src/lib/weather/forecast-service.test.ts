import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WeatherAbortError, WeatherRejectedError, WeatherUnavailableError } from './client';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { dalState, clientState } = vi.hoisted(() => ({
  dalState: {
    run: null as unknown,
    configured: null as unknown,
    starts: [] as Array<{ latitudeDeg: number; longitudeDeg: number }>,
    /** Nombre de lectures des départs récents — un lieu réglé doit s'en passer. */
    startsRead: 0,
    saved: [] as Array<{ athleteId: number; readingDay: string; outcome: unknown }>,
  },
  clientState: {
    days: [] as unknown[],
    error: null as unknown,
    calls: [] as unknown[],
  },
}));

vi.mock('@/data/weather-forecast', () => ({
  getForecastRun: () => Promise.resolve(dalState.run),
  getForecastLocation: () => Promise.resolve(dalState.configured),
  listRecentStartCoordinates: () => {
    dalState.startsRead += 1;
    return Promise.resolve(dalState.starts);
  },
  saveForecastReading: (athleteId: number, readingDay: string, outcome: unknown) => {
    dalState.saved.push({ athleteId, readingDay, outcome });
    return Promise.resolve();
  },
}));

vi.mock('./forecast-client', () => ({
  fetchDailyForecast: (params: unknown) => {
    clientState.calls.push(params);
    if (clientState.error !== null) return Promise.reject(clientState.error);
    return Promise.resolve(clientState.days);
  },
}));

const { runDailyForecast } = await import('./forecast-service');

const ATHLETE = 7;
const HOME = { latitudeDeg: 48.85, longitudeDeg: 2.35 };

/** 09 h locales le 14 août : 6 h sont passées, le relevé du jour est dû. */
const MORNING = new Date('2026-08-14T07:00:00Z');

const DAY = {
  date: '2026-08-14',
  weatherCode: 3,
  temperatureMaxC: 24,
  temperatureMinC: 14,
  apparentTemperatureMaxC: 23,
  apparentTemperatureMinC: 13,
  precipitationSumMm: 0,
  precipitationProbabilityMaxPct: 10,
  windSpeedMaxKmh: 12,
};

beforeEach(() => {
  dalState.run = null;
  dalState.configured = null;
  dalState.starts = [HOME];
  dalState.startsRead = 0;
  dalState.saved = [];
  clientState.days = [DAY];
  clientState.error = null;
  clientState.calls = [];
});

/**
 * Le relevé de prévisions du matin.
 *
 * Ce qui est éprouvé ici : **un seul relevé par jour**, son rattrapage quand
 * l'heure a été manquée, et le fait qu'une tentative écrive toujours son état —
 * sans quoi le cycle suivant redemanderait la même chose.
 */
describe('runDailyForecast', () => {
  it('ne fait rien quand le relevé du matin a déjà eu lieu', async () => {
    dalState.run = {
      readingDay: '2026-08-14',
      status: 'forecast',
      attempts: 1,
      lastAttemptAt: new Date('2026-08-14T04:00:10Z'),
    };

    expect(await runDailyForecast(ATHLETE, { now: MORNING })).toBeNull();
    expect(clientState.calls).toHaveLength(0);
    expect(dalState.saved).toHaveLength(0);
  });

  it('relève et enregistre les seize jours, sous le marqueur du matin', async () => {
    const report = await runDailyForecast(ATHLETE, { now: MORNING });

    expect(report).toEqual({
      status: 'forecast',
      readingDay: '2026-08-14',
      days: 1,
      reason: null,
    });
    expect(dalState.saved).toEqual([
      {
        athleteId: ATHLETE,
        readingDay: '2026-08-14',
        outcome: { status: 'forecast', coordinates: HOME, days: [DAY] },
      },
    ]);
  });

  it('n’appelle Open-Meteo qu’une fois, pour un lieu', async () => {
    await runDailyForecast(ATHLETE, { now: MORNING });
    expect(clientState.calls).toHaveLength(1);
    expect(clientState.calls[0]).toMatchObject({ coordinates: HOME });
  });

  it('rattrape l’heure manquée : marqueur d’hier, relevé aussitôt', async () => {
    dalState.run = {
      readingDay: '2026-08-13',
      status: 'forecast',
      attempts: 1,
      lastAttemptAt: new Date('2026-08-13T04:00:10Z'),
    };

    // Retour du container à 9 h locales, après un déploiement qui a couvert 6 h.
    const report = await runDailyForecast(ATHLETE, { now: MORNING });
    expect(report?.readingDay).toBe('2026-08-14');
    expect(report?.status).toBe('forecast');
  });

  it('interroge le départ habituel, pas la dernière sortie en déplacement', async () => {
    const away = { latitudeDeg: 45.19, longitudeDeg: 5.72 };
    dalState.starts = [away, HOME, HOME, HOME];

    await runDailyForecast(ATHLETE, { now: MORNING });
    expect(clientState.calls[0]).toMatchObject({ coordinates: HOME });
  });

  it('dit qu’il n’y a pas de lieu plutôt que d’inventer un point', async () => {
    dalState.starts = [];

    const report = await runDailyForecast(ATHLETE, { now: MORNING });

    expect(report).toEqual({
      status: 'no-location',
      readingDay: '2026-08-14',
      days: 0,
      reason: null,
    });
    expect(clientState.calls).toHaveLength(0);
    // La ligne est écrite quand même : sans elle, chaque cycle rechercherait le
    // même lieu absent.
    expect(dalState.saved).toEqual([
      { athleteId: ATHLETE, readingDay: '2026-08-14', outcome: { status: 'no-location' } },
    ]);
  });

  it('traite un refus argumenté du service comme définitif pour la journée', async () => {
    clientState.error = new WeatherRejectedError('prévisions : demande refusée — …', 400);

    const report = await runDailyForecast(ATHLETE, { now: MORNING });

    expect(report?.status).toBe('unsupported');
    expect(dalState.saved[0].outcome).toMatchObject({
      status: 'unsupported',
      coordinates: HOME,
    });
  });

  it('garde une panne réessayable, avec son motif', async () => {
    clientState.error = new WeatherUnavailableError('prévisions : appel réseau impossible.');

    const report = await runDailyForecast(ATHLETE, { now: MORNING });

    expect(report?.status).toBe('failed');
    expect(report?.reason).toContain('WeatherUnavailableError');
    expect(dalState.saved[0].outcome).toMatchObject({ status: 'failed' });
  });

  it('n’écrit rien quand l’arrêt du service a coupé l’appel', async () => {
    clientState.error = new WeatherAbortError('prévisions', false);

    expect(await runDailyForecast(ATHLETE, { now: MORNING })).toBeNull();
    expect(dalState.saved).toHaveLength(0);
  });

  it('compte en revanche un délai de garde écoulé comme un échec', async () => {
    clientState.error = new WeatherAbortError('prévisions', true);

    const report = await runDailyForecast(ATHLETE, { now: MORNING });
    expect(report?.status).toBe('failed');
    expect(dalState.saved).toHaveLength(1);
  });

  it('interroge le lieu réglé plutôt que le point de départ habituel', async () => {
    dalState.configured = {
      label: 'Bordeaux',
      coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 },
    };

    const report = await runDailyForecast(ATHLETE, { now: MORNING });

    expect(report?.status).toBe('forecast');
    expect(clientState.calls[0]).toMatchObject({
      coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 },
    });
    expect(dalState.saved[0].outcome).toMatchObject({
      coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 },
    });
  });

  it('ne lit même pas les départs récents quand un lieu est réglé', async () => {
    dalState.configured = {
      label: 'Bordeaux',
      coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 },
    };

    await runDailyForecast(ATHLETE, { now: MORNING });

    expect(dalState.startsRead).toBe(0);
  });

  it('garde le lieu déduit tant que rien n’est réglé', async () => {
    await runDailyForecast(ATHLETE, { now: MORNING });

    expect(dalState.startsRead).toBe(1);
    expect(clientState.calls[0]).toMatchObject({ coordinates: HOME });
  });

  it('transmet l’annulation et le `fetch` injecté au client', async () => {
    const signal = AbortSignal.timeout(60_000);
    const fetchImpl = () => Promise.resolve(new Response('{}'));

    await runDailyForecast(ATHLETE, { now: MORNING, signal, fetchImpl });
    expect(clientState.calls[0]).toMatchObject({ signal, fetchImpl });
  });
});
