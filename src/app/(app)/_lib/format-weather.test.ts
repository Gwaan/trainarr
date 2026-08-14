import { describe, expect, it } from 'vitest';

import { FORECAST_HORIZON_DAYS, type ForecastAvailability } from '@/lib/weather/forecast-plan';
import type { ActivityWeatherStatus } from '@/lib/weather/plan';

import {
  ACTIVITY_WEATHER_ABSENCE,
  FORECAST_ABSENCE,
  formatForecastReading,
  formatObservationHour,
  formatPercent,
  formatPrecipitation,
  formatTemperature,
  formatTemperatureCompact,
  formatTemperatureRange,
  formatWindDirection,
  formatWindSpeed,
} from './format-weather';

describe('valeurs météo', () => {
  it('arrondit la température à l’entier et garde l’unité', () => {
    expect(formatTemperature(24.4)).toBe('24 °C');
    expect(formatTemperature(-1.6)).toBe('−2 °C');
  });

  it('rend une température compacte pour une pastille', () => {
    expect(formatTemperatureCompact(24.4)).toBe('24°');
  });

  it('écrit l’amplitude d’une journée', () => {
    expect(formatTemperatureRange(14.2, 24.7)).toBe('14 → 25 °C');
  });

  it('garde le dixième des précipitations : 0,4 mm n’est pas 0', () => {
    expect(formatPrecipitation(0.4)).toBe('0,4 mm');
    expect(formatPrecipitation(18.9)).toBe('18,9 mm');
  });

  it('rend vent et pourcentages à l’entier', () => {
    expect(formatWindSpeed(13.5)).toBe('14 km/h');
    expect(formatPercent(61.6)).toBe('62 %');
  });
});

describe('formatWindDirection', () => {
  it('nomme les huit aires', () => {
    expect(formatWindDirection(0)).toBe('nord');
    expect(formatWindDirection(45)).toBe('nord-est');
    expect(formatWindDirection(90)).toBe('est');
    expect(formatWindDirection(180)).toBe('sud');
    expect(formatWindDirection(315)).toBe('nord-ouest');
  });

  it('arrondit à l’aire la plus proche', () => {
    expect(formatWindDirection(326)).toBe('nord-ouest');
    // 22,5° est la frontière : en deçà c'est encore le nord, au-delà le nord-est.
    expect(formatWindDirection(22)).toBe('nord');
    expect(formatWindDirection(23)).toBe('nord-est');
  });

  it('reboucle le tour plutôt que de sortir du tableau', () => {
    expect(formatWindDirection(359)).toBe('nord');
    expect(formatWindDirection(360)).toBe('nord');
    expect(formatWindDirection(-45)).toBe('nord-ouest');
  });
});

describe('horodatages', () => {
  it('date une prévision de son relevé — elle est périssable', () => {
    // 06 h 02 à Paris, en été.
    expect(formatForecastReading(new Date('2026-08-14T04:02:00Z'))).toBe(
      'Relevé du 14 août, 06:02',
    );
  });

  it('ne garde que l’heure pour une observation : le jour est celui de la séance', () => {
    expect(formatObservationHour(new Date('2026-08-14T16:00:00Z'))).toBe('Relevé de 18:00');
  });
});

/**
 * Les absences.
 *
 * Ce qui est éprouvé n'est pas la formulation exacte mais le fait qu'**aucun
 * état ne reste sans phrase** : un vide se lirait « beau temps ».
 */
describe('phrases d’absence', () => {
  it('a une phrase pour chaque état d’une séance effectuée', () => {
    const statuses: Exclude<ActivityWeatherStatus, 'observed'>[] = [
      'no-location',
      'unsupported',
      'failed',
    ];
    for (const status of statuses) expect(ACTIVITY_WEATHER_ABSENCE[status]).not.toBe('');
  });

  it('dit « en intérieur » à une séance sans position', () => {
    expect(ACTIVITY_WEATHER_ABSENCE['no-location']).toContain('intérieur');
  });

  it('a une phrase pour chaque état d’une séance à venir', () => {
    const absences: Exclude<ForecastAvailability, 'forecast'>[] = [
      'past',
      'beyond-horizon',
      'no-location',
      'unsupported',
      'failed',
      'pending',
    ];
    for (const absence of absences) expect(FORECAST_ABSENCE[absence]).not.toBe('');
  });

  it('cite l’horizon réel plutôt qu’un nombre écrit à la main', () => {
    expect(FORECAST_ABSENCE['beyond-horizon']).toContain(String(FORECAST_HORIZON_DAYS));
  });
});
