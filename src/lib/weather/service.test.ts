import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WeatherAbortError, WeatherRejectedError, WeatherUnavailableError } from './client';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { dalState, clientState } = vi.hoisted(() => ({
  dalState: {
    target: null as unknown,
    saved: [] as Array<{ activityId: number; athleteId: number; outcome: unknown }>,
    /** `false` = la séance n'appartient pas à cet athlète : rien n'est écrit. */
    writable: true,
  },
  clientState: {
    result: null as unknown,
    error: null as unknown,
    calls: [] as unknown[],
  },
}));

vi.mock('@/data/activity-weather', () => ({
  getWeatherLookupTarget: () => Promise.resolve(dalState.target),
  listActivitiesAwaitingWeather: () => Promise.resolve([]),
  saveActivityWeather: (activityId: number, athleteId: number, outcome: unknown) => {
    if (!dalState.writable) return Promise.resolve(false);
    dalState.saved.push({ activityId, athleteId, outcome });
    return Promise.resolve(true);
  },
}));

vi.mock('@/data/athlete', () => ({ listAthleteIds: () => Promise.resolve([]) }));

vi.mock('./client', async (importOriginal) => {
  const original = await importOriginal<typeof import('./client')>();
  return {
    ...original,
    fetchHourlyWeather: (params: unknown) => {
      clientState.calls.push(params);
      if (clientState.error !== null) return Promise.reject(clientState.error);
      return Promise.resolve(clientState.result);
    },
  };
});

const { lookupActivityWeather, recordActivityWeather } = await import('./service');

const SAMPLE = {
  observedAt: new Date('2026-08-14T06:00:00Z'),
  temperatureC: 24.3,
  apparentTemperatureC: 25.1,
  precipitationMm: 0,
  windSpeedKmh: 1.3,
  windDirectionDeg: 326,
  relativeHumidityPct: 50,
  weatherCode: 1,
};

function targetWithLocation(startedAt = new Date('2026-08-14T06:00:00Z')) {
  return {
    activityId: 42,
    startedAt,
    elapsedTimeS: 3_600,
    coordinates: { latitudeDeg: 48.86, longitudeDeg: 2.35 },
  };
}

beforeEach(() => {
  dalState.target = targetWithLocation();
  dalState.saved = [];
  dalState.writable = true;
  clientState.result = SAMPLE;
  clientState.error = null;
  clientState.calls = [];
  vi.restoreAllMocks();
});

describe('lookupActivityWeather', () => {
  it('enregistre les mesures d’une séance localisée', async () => {
    await expect(lookupActivityWeather(42, 7)).resolves.toBe('observed');

    expect(dalState.saved).toEqual([
      {
        activityId: 42,
        athleteId: 7,
        outcome: {
          status: 'observed',
          source: 'forecast',
          coordinates: { latitudeDeg: 48.86, longitudeDeg: 2.35 },
          sample: SAMPLE,
        },
      },
    ]);
  });

  it('vise le milieu de la séance', async () => {
    await lookupActivityWeather(42, 7);

    expect(clientState.calls[0]).toMatchObject({
      instant: new Date('2026-08-14T06:30:00Z'),
    });
  });

  it('lit une séance ancienne sur l’archive, une récente sur la prévision', async () => {
    const now = new Date('2026-08-14T12:00:00Z');

    dalState.target = targetWithLocation(new Date('2026-08-13T06:00:00Z'));
    await lookupActivityWeather(42, 7, { now });
    expect(clientState.calls[0]).toMatchObject({ source: 'forecast' });

    dalState.target = targetWithLocation(new Date('2025-01-05T06:00:00Z'));
    await lookupActivityWeather(42, 7, { now });
    expect(clientState.calls[1]).toMatchObject({ source: 'archive' });
  });

  it('n’appelle jamais Open-Meteo pour une séance sans position', async () => {
    dalState.target = { ...targetWithLocation(), coordinates: null };

    await expect(lookupActivityWeather(42, 7)).resolves.toBe('no-location');
    expect(clientState.calls).toEqual([]);
    expect(dalState.saved[0]?.outcome).toEqual({ status: 'no-location' });
  });

  it('traite un refus motivé comme définitif', async () => {
    clientState.error = new WeatherRejectedError('demande refusée — hors plage.', 400);

    await expect(lookupActivityWeather(42, 7)).resolves.toBe('unsupported');
    expect(dalState.saved[0]?.outcome).toMatchObject({
      status: 'unsupported',
      reason: expect.stringContaining('hors plage'),
    });
  });

  it('traite une indisponibilité comme réessayable', async () => {
    clientState.error = new WeatherUnavailableError('appel réseau impossible.');

    await expect(lookupActivityWeather(42, 7)).resolves.toBe('failed');
    expect(dalState.saved[0]?.outcome).toMatchObject({ status: 'failed' });
  });

  it('n’écrit rien quand l’arrêt du service coupe l’appel', async () => {
    // Une tentative interrompue n'est pas un échec de la séance : lui faire
    // consommer un essai serait injuste.
    clientState.error = new WeatherAbortError('météo', false);

    await expect(lookupActivityWeather(42, 7)).resolves.toBeNull();
    expect(dalState.saved).toEqual([]);
  });

  it('compte en revanche un délai de garde écoulé comme un échec', async () => {
    clientState.error = new WeatherAbortError('météo', true);

    await expect(lookupActivityWeather(42, 7)).resolves.toBe('failed');
  });

  it('ne fait rien pour une séance qui n’est pas celle de cet athlète', async () => {
    dalState.target = null;

    await expect(lookupActivityWeather(42, 7)).resolves.toBeNull();
    expect(clientState.calls).toEqual([]);
    expect(dalState.saved).toEqual([]);
  });

  it('rend `null` quand l’écriture est refusée, sans en dire plus', async () => {
    dalState.writable = false;

    await expect(lookupActivityWeather(42, 7)).resolves.toBeNull();
  });
});

describe('recordActivityWeather', () => {
  it('ne lève jamais — une séance sans météo reste une séance valide', async () => {
    clientState.error = new WeatherUnavailableError('appel réseau impossible.');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(recordActivityWeather(42, 7)).resolves.toBeUndefined();
    // L'échec est journalisé avec son motif, jamais tu.
    expect(log).toHaveBeenCalled();
  });

  it('ne journalise rien quand le relevé aboutit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await recordActivityWeather(42, 7);

    expect(log).not.toHaveBeenCalled();
  });
});
