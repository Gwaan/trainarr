import { describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_BASE_URL,
  buildRequestUrl,
  fetchHourlyWeather,
  FORECAST_BASE_URL,
  parseRetryAfterSeconds,
  WeatherAbortError,
  WeatherMalformedError,
  WeatherRateLimitError,
  WeatherRejectedError,
  WeatherUnavailableError,
  type FetchLike,
  type FetchHourlyWeatherParams,
} from './client';

const COORDINATES = { latitudeDeg: 48.86, longitudeDeg: 2.35 };
const INSTANT = new Date('2026-08-14T06:30:00Z');

/**
 * Réponse réelle d'Open-Meteo, recopiée telle quelle depuis un appel du
 * 2026-08-14 (`api.open-meteo.com/v1/forecast`, deux heures pleines,
 * `timeformat=unixtime`, `wind_speed_unit=kmh`). C'est elle qui vérifie que le
 * schéma épouse la vraie forme, et pas l'inverse.
 */
const REAL_BODY = {
  latitude: 48.84,
  longitude: 2.3599997,
  generationtime_ms: 0.11014938354492188,
  utc_offset_seconds: 0,
  timezone: 'GMT',
  timezone_abbreviation: 'GMT',
  elevation: 46.0,
  hourly_units: {
    time: 'unixtime',
    temperature_2m: '°C',
    apparent_temperature: '°C',
    precipitation: 'mm',
    weather_code: 'wmo code',
    wind_speed_10m: 'km/h',
    wind_direction_10m: '°',
    relative_humidity_2m: '%',
  },
  hourly: {
    time: [1786687200, 1786690800],
    temperature_2m: [24.3, 26.0],
    apparent_temperature: [25.1, 26.7],
    precipitation: [0.0, 0.0],
    weather_code: [1, 1],
    wind_speed_10m: [1.3, 1.8],
    wind_direction_10m: [326, 323],
    relative_humidity_2m: [50, 45],
  },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function respondWith(response: Response | (() => Promise<never>)): FetchLike {
  return typeof response === 'function'
    ? () => response()
    : () => Promise.resolve(response.clone());
}

function params(overrides: Partial<FetchHourlyWeatherParams> = {}): FetchHourlyWeatherParams {
  return {
    coordinates: COORDINATES,
    instant: INSTANT,
    source: 'forecast',
    fetchImpl: respondWith(jsonResponse(REAL_BODY)),
    ...overrides,
  };
}

describe('buildRequestUrl', () => {
  it('interroge l’API de prévision pour une séance récente', () => {
    expect(buildRequestUrl(params())).toContain(FORECAST_BASE_URL);
  });

  it('interroge l’archive pour une séance ancienne', () => {
    expect(buildRequestUrl(params({ source: 'archive' }))).toContain(ARCHIVE_BASE_URL);
  });

  it('n’envoie que les coordonnées qu’on lui donne — arrondies en amont', () => {
    const url = new URL(buildRequestUrl(params()));
    expect(url.searchParams.get('latitude')).toBe('48.86');
    expect(url.searchParams.get('longitude')).toBe('2.35');
  });

  it('ne demande que les sept variables retenues', () => {
    const url = new URL(buildRequestUrl(params()));
    expect(url.searchParams.get('hourly')?.split(',')).toEqual([
      'temperature_2m',
      'apparent_temperature',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
      'relative_humidity_2m',
    ]);
  });

  it('borne la demande aux deux heures utiles, en UTC', () => {
    const url = new URL(buildRequestUrl(params()));
    expect(url.searchParams.get('start_hour')).toBe('2026-08-14T06:00');
    expect(url.searchParams.get('end_hour')).toBe('2026-08-14T07:00');
    // Fuseau laissé à son défaut (GMT) : rien à réinterpréter.
    expect(url.searchParams.get('timezone')).toBeNull();
  });

  it('fixe les unités plutôt que de les supposer — ce sont elles qui nomment les colonnes', () => {
    const url = new URL(buildRequestUrl(params()));
    expect(url.searchParams.get('timeformat')).toBe('unixtime');
    expect(url.searchParams.get('temperature_unit')).toBe('celsius');
    expect(url.searchParams.get('precipitation_unit')).toBe('mm');
    expect(url.searchParams.get('wind_speed_unit')).toBe('kmh');
  });

  it('n’envoie aucune clé — Open-Meteo n’en demande pas pour un usage non commercial', () => {
    const url = new URL(buildRequestUrl(params()));
    expect(url.searchParams.get('apikey')).toBeNull();
  });
});

describe('fetchHourlyWeather', () => {
  it('lit la réponse réelle d’Open-Meteo et rend l’échantillon le plus proche', async () => {
    // 06:30 est à égale distance des deux heures : le premier échantillon gagne.
    await expect(fetchHourlyWeather(params())).resolves.toEqual({
      observedAt: new Date(1786687200 * 1_000),
      temperatureC: 24.3,
      apparentTemperatureC: 25.1,
      precipitationMm: 0,
      windSpeedKmh: 1.3,
      windDirectionDeg: 326,
      relativeHumidityPct: 50,
      weatherCode: 1,
    });
  });

  it('retient l’heure suivante quand la séance en est plus proche', async () => {
    const sample = await fetchHourlyWeather(
      params({ instant: new Date('2026-08-14T06:50:00Z') }),
    );
    expect(sample.observedAt).toEqual(new Date(1786690800 * 1_000));
    expect(sample.temperatureC).toBe(26.0);
  });

  it('garde les trous du modèle plutôt que d’inventer une mesure', async () => {
    const withHole = structuredClone(REAL_BODY);
    Object.assign(withHole.hourly, { apparent_temperature: [null, null] });

    const sample = await fetchHourlyWeather(
      params({ fetchImpl: respondWith(jsonResponse(withHole)) }),
    );
    expect(sample.apparentTemperatureC).toBeNull();
    expect(sample.temperatureC).toBe(24.3);
  });

  it('refuse de rendre un relevé entièrement vide', async () => {
    const empty = structuredClone(REAL_BODY);
    for (const key of Object.keys(empty.hourly)) {
      if (key === 'time') continue;
      Object.assign(empty.hourly, { [key]: [null, null] });
    }

    await expect(
      fetchHourlyWeather(params({ fetchImpl: respondWith(jsonResponse(empty)) })),
    ).rejects.toBeInstanceOf(WeatherUnavailableError);
  });

  it('refuse une fenêtre sans aucun instant', async () => {
    const nothing = structuredClone(REAL_BODY);
    nothing.hourly.time = [];
    for (const key of Object.keys(nothing.hourly)) {
      Object.assign(nothing.hourly, { [key]: [] });
    }

    await expect(
      fetchHourlyWeather(params({ fetchImpl: respondWith(jsonResponse(nothing)) })),
    ).rejects.toBeInstanceOf(WeatherUnavailableError);
  });

  it('traite un 400 motivé comme un refus, pas comme une panne', async () => {
    // Corps réel : coordonnées hors bornes, date hors de la couverture…
    const body = {
      error: true,
      reason: "Parameter 'start_hour' is out of allowed range from 2026-05-13 to 2026-08-29",
    };

    const error = await fetchHourlyWeather(
      params({ fetchImpl: respondWith(jsonResponse(body, 400)) }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeatherRejectedError);
    // Le motif d'Open-Meteo est repris tel quel : c'est lui qui rend l'échec lisible.
    expect(String(error)).toContain('out of allowed range');
  });

  it('distingue le quota et lit son délai', async () => {
    const error = await fetchHourlyWeather(
      params({
        fetchImpl: respondWith(jsonResponse({ error: true, reason: 'quota' }, 429, {
          'retry-after': '120',
        })),
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeatherRateLimitError);
    expect(error).toMatchObject({ retryAfterS: 120 });
  });

  it('traite un 5xx comme une indisponibilité, donc réessayable', async () => {
    await expect(
      fetchHourlyWeather(params({ fetchImpl: respondWith(new Response('', { status: 503 })) })),
    ).rejects.toBeInstanceOf(WeatherUnavailableError);
  });

  it('traite une panne réseau comme une indisponibilité', async () => {
    const error = await fetchHourlyWeather(
      params({
        fetchImpl: respondWith(() => Promise.reject(new TypeError('fetch failed'))),
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeatherUnavailableError);
    expect(error).not.toBeInstanceOf(WeatherAbortError);
  });

  it('lève sur un corps qui n’est pas du JSON', async () => {
    await expect(
      fetchHourlyWeather(
        params({ fetchImpl: respondWith(new Response('<html>502</html>', { status: 200 })) }),
      ),
    ).rejects.toBeInstanceOf(WeatherMalformedError);
  });

  it('lève sur une forme inattendue plutôt que de propager des valeurs vides', async () => {
    const truncated = structuredClone(REAL_BODY);
    Reflect.deleteProperty(truncated.hourly, 'wind_direction_10m');

    const error = await fetchHourlyWeather(
      params({ fetchImpl: respondWith(jsonResponse(truncated)) }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeatherMalformedError);
    expect(String(error)).toContain('wind_direction_10m');
  });

  it('lève quand une série est plus courte que l’axe des instants', async () => {
    // Une série amputée décalerait silencieusement les mesures d'une heure.
    const misaligned = structuredClone(REAL_BODY);
    misaligned.hourly.temperature_2m = [24.3];

    await expect(
      fetchHourlyWeather(params({ fetchImpl: respondWith(jsonResponse(misaligned)) })),
    ).rejects.toBeInstanceOf(WeatherMalformedError);
  });

  it('rend une erreur d’abandon distincte quand l’appelant coupe', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await fetchHourlyWeather(
      params({
        signal: controller.signal,
        fetchImpl: (_input, init) => {
          init?.signal?.throwIfAborted();
          return Promise.resolve(jsonResponse(REAL_BODY));
        },
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeatherAbortError);
    // Arrêt demandé, pas délai écoulé : c'est une sortie propre.
    expect(error).toMatchObject({ timedOut: false });
  });

  it('combine le signal de l’appelant au délai de garde', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse(REAL_BODY)));
    await fetchHourlyWeather(params({ fetchImpl }));

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('parseRetryAfterSeconds', () => {
  it('lit un nombre de secondes', () => {
    expect(parseRetryAfterSeconds('30')).toBe(30);
  });

  it('lit une date HTTP', () => {
    const now = Date.parse('2026-08-14T08:00:00Z');
    expect(parseRetryAfterSeconds('Fri, 14 Aug 2026 08:01:00 GMT', now)).toBe(60);
  });

  it('rend `null` sur un en-tête absent ou illisible', () => {
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds('  ')).toBeNull();
    expect(parseRetryAfterSeconds('bientôt')).toBeNull();
  });
});
