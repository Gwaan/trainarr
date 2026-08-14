import { describe, expect, it } from 'vitest';

import {
  WeatherMalformedError,
  WeatherRejectedError,
  WeatherUnavailableError,
  type FetchLike,
} from './client';
import {
  buildForecastUrl,
  fetchDailyForecast,
  type FetchDailyForecastParams,
} from './forecast-client';

const COORDINATES = { latitudeDeg: 48.85, longitudeDeg: 2.35 };

/**
 * Réponse **réelle** d'Open-Meteo, recopiée telle quelle depuis un appel du
 * 2026-08-14 (`api.open-meteo.com/v1/forecast`, `forecast_days=16`,
 * `timezone=Europe/Paris`, `wind_speed_unit=kmh`). C'est elle qui vérifie que le
 * schéma épouse la vraie forme, et pas l'inverse.
 *
 * Deux traits de la vraie réponse valent d'être remarqués — aucun n'aurait été
 * deviné :
 *
 * - `daily.time` est en **dates civiles** `YYYY-MM-DD`, conséquence directe du
 *   fuseau explicite. C'est exactement la forme des jours que le plan écrit ;
 * - `precipitation_probability_max` **manque au seizième jour** : le modèle de
 *   probabilité ne porte pas aussi loin que celui de température. Une mesure
 *   absente, pas une réponse malformée.
 */
const REAL_BODY = {
  latitude: 48.84,
  longitude: 2.3599997,
  generationtime_ms: 1.3703107833862305,
  utc_offset_seconds: 7200,
  timezone: 'Europe/Paris',
  timezone_abbreviation: 'GMT+2',
  elevation: 46.0,
  daily_units: {
    time: 'iso8601',
    weather_code: 'wmo code',
    temperature_2m_max: '°C',
    temperature_2m_min: '°C',
    apparent_temperature_max: '°C',
    apparent_temperature_min: '°C',
    precipitation_sum: 'mm',
    precipitation_probability_max: '%',
    wind_speed_10m_max: 'km/h',
  },
  daily: {
    time: [
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
    ],
    weather_code: [95, 80, 80, 3, 3, 61, 3, 3, 3, 55, 55, 3, 51, 81, 81, 3],
    temperature_2m_max: [
      39.0, 34.4, 28.8, 28.7, 30.7, 31.3, 24.7, 25.2, 25.5, 26.4, 22.4, 25.3, 29.5, 23.9, 23.9,
      22.0,
    ],
    temperature_2m_min: [
      23.3, 24.5, 19.5, 18.0, 18.4, 19.4, 17.4, 14.5, 15.8, 15.6, 14.2, 14.1, 15.9, 18.1, 18.0,
      18.1,
    ],
    apparent_temperature_max: [
      39.0, 34.5, 30.2, 27.7, 29.4, 30.5, 22.3, 23.3, 24.1, 25.6, 22.2, 25.7, 28.8, 24.8, 23.9,
      20.1,
    ],
    apparent_temperature_min: [
      23.7, 24.3, 20.4, 18.3, 19.3, 19.5, 17.2, 13.6, 15.4, 14.5, 14.1, 14.0, 14.7, 20.0, 20.1,
      17.1,
    ],
    precipitation_sum: [
      0.2, 0.1, 0.1, 0.0, 0.0, 3.6, 0.9, 0.0, 0.0, 3.6, 3.0, 0.0, 0.9, 18.9, 9.6, 0.0,
    ],
    precipitation_probability_max: [10, 23, 28, 0, 15, 19, 14, 24, 31, 39, 31, 31, 34, 41, 25, null],
    wind_speed_10m_max: [
      18.1, 15.3, 14.8, 11.5, 19.1, 15.9, 13.5, 16.4, 12.1, 10.1, 8.5, 6.5, 14.1, 15.7, 12.9,
      12.9,
    ],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function respondWith(response: Response | (() => Promise<never>)): FetchLike {
  return typeof response === 'function'
    ? () => response()
    : () => Promise.resolve(response.clone());
}

function params(overrides: Partial<FetchDailyForecastParams> = {}): FetchDailyForecastParams {
  return {
    coordinates: COORDINATES,
    fetchImpl: respondWith(jsonResponse(REAL_BODY)),
    ...overrides,
  };
}

describe('buildForecastUrl', () => {
  const url = new URL(buildForecastUrl(params()));

  it('demande les seize jours en un seul appel', () => {
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('forecast_days')).toBe('16');
  });

  it('impose le fuseau : c’est lui qui découpe les journées', () => {
    expect(url.searchParams.get('timezone')).toBe('Europe/Paris');
  });

  it('envoie le point tel qu’il lui est donné, déjà arrondi', () => {
    expect(url.searchParams.get('latitude')).toBe('48.85');
    expect(url.searchParams.get('longitude')).toBe('2.35');
  });

  it('demande les variables quotidiennes, et rien d’horaire', () => {
    expect(url.searchParams.get('daily')).toBe(
      'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max',
    );
    expect(url.searchParams.get('hourly')).toBeNull();
  });

  it('nomme ses unités plutôt que d’espérer un défaut', () => {
    expect(url.searchParams.get('temperature_unit')).toBe('celsius');
    expect(url.searchParams.get('precipitation_unit')).toBe('mm');
    expect(url.searchParams.get('wind_speed_unit')).toBe('kmh');
  });
});

describe('fetchDailyForecast', () => {
  it('lit la réponse réelle du service', async () => {
    const days = await fetchDailyForecast(params());

    expect(days).toHaveLength(16);
    expect(days[0]).toEqual({
      date: '2026-08-14',
      weatherCode: 95,
      temperatureMaxC: 39.0,
      temperatureMinC: 23.3,
      apparentTemperatureMaxC: 39.0,
      apparentTemperatureMinC: 23.7,
      precipitationSumMm: 0.2,
      precipitationProbabilityMaxPct: 10,
      windSpeedMaxKmh: 18.1,
    });
  });

  it('rend les jours dans l’ordre, en dates civiles', async () => {
    const days = await fetchDailyForecast(params());
    expect(days.map((day) => day.date)).toEqual(REAL_BODY.daily.time);
  });

  it('garde le trou du seizième jour pour ce qu’il est : une mesure absente', async () => {
    const days = await fetchDailyForecast(params());
    expect(days[15].precipitationProbabilityMaxPct).toBeNull();
    expect(days[15].temperatureMaxC).toBe(22.0);
  });

  it('refuse une série plus courte que la liste des jours', async () => {
    const truncated = {
      ...REAL_BODY,
      daily: { ...REAL_BODY.daily, temperature_2m_max: [39.0, 34.4] },
    };

    await expect(
      fetchDailyForecast(params({ fetchImpl: respondWith(jsonResponse(truncated)) })),
    ).rejects.toBeInstanceOf(WeatherMalformedError);
  });

  it('refuse une réponse à qui il manque une série demandée', async () => {
    const daily = { ...REAL_BODY.daily };
    // Une variable retirée de la réponse : le contrat du module n'est plus tenu.
    delete (daily as Partial<typeof daily>).wind_speed_10m_max;

    await expect(
      fetchDailyForecast(
        params({ fetchImpl: respondWith(jsonResponse({ ...REAL_BODY, daily })) }),
      ),
    ).rejects.toBeInstanceOf(WeatherMalformedError);
  });

  it('refuse une réponse sans un seul jour plutôt que de rendre une liste vide', async () => {
    const empty = {
      daily: Object.fromEntries(Object.keys(REAL_BODY.daily).map((key) => [key, []])),
    };

    await expect(
      fetchDailyForecast(params({ fetchImpl: respondWith(jsonResponse(empty)) })),
    ).rejects.toBeInstanceOf(WeatherUnavailableError);
  });

  it('reprend le motif d’un refus du service, tel qu’il est écrit', async () => {
    const refusal = {
      error: true,
      reason: 'Latitude must be in range of -90 to 90°. Given: 148.85.',
    };

    await expect(
      fetchDailyForecast(params({ fetchImpl: respondWith(jsonResponse(refusal, 400)) })),
    ).rejects.toThrow(/Latitude must be in range/);

    await expect(
      fetchDailyForecast(params({ fetchImpl: respondWith(jsonResponse(refusal, 400)) })),
    ).rejects.toBeInstanceOf(WeatherRejectedError);
  });

  it('traduit une panne réseau en indisponibilité, jamais en prévision vide', async () => {
    await expect(
      fetchDailyForecast(
        params({ fetchImpl: respondWith(() => Promise.reject(new TypeError('fetch failed'))) }),
      ),
    ).rejects.toBeInstanceOf(WeatherUnavailableError);
  });
});
