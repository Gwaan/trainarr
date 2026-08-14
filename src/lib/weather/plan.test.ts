import { describe, expect, it } from 'vitest';

import {
  chooseWeatherSource,
  COORDINATE_DECIMALS,
  CYCLE_INTERVAL_MS,
  firstFixedPoint,
  formatHourParam,
  FORECAST_MAX_AGE_DAYS,
  hourWindowAround,
  isRetryableStatus,
  lookupSpacingMs,
  MAX_ATTEMPTS,
  MAX_LOOKUPS_PER_CYCLE,
  MAX_SESSION_SPAN_S,
  nextRetryAt,
  pickNearestSampleIndex,
  RETRY_DELAYS_MS,
  roundCoordinate,
  toRequestCoordinates,
  weatherSampleInstant,
} from './plan';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe('roundCoordinate', () => {
  it('ramène à deux décimales — environ un kilomètre', () => {
    expect(COORDINATE_DECIMALS).toBe(2);
    expect(roundCoordinate(48.8566969)).toBe(48.86);
    expect(roundCoordinate(2.3514616)).toBe(2.35);
  });

  it('arrondit les valeurs négatives vers le point le plus proche, pas vers zéro', () => {
    expect(roundCoordinate(-4.4861)).toBe(-4.49);
  });
});

describe('toRequestCoordinates', () => {
  it('rend le point arrondi — l’adresse exacte ne sort jamais du serveur', () => {
    expect(toRequestCoordinates(48.8566969, 2.3514616)).toEqual({
      latitudeDeg: 48.86,
      longitudeDeg: 2.35,
    });
  });

  it('refuse le point de garde 0/0, qui n’est pas une position', () => {
    expect(toRequestCoordinates(0, 0)).toBeNull();
  });

  it('accepte une coordonnée nulle quand l’autre ne l’est pas', () => {
    expect(toRequestCoordinates(0, 2.35)).toEqual({ latitudeDeg: 0, longitudeDeg: 2.35 });
  });

  it('refuse ce qui n’est pas une coordonnée', () => {
    expect(toRequestCoordinates(91, 2)).toBeNull();
    expect(toRequestCoordinates(-91, 2)).toBeNull();
    expect(toRequestCoordinates(45, 181)).toBeNull();
    expect(toRequestCoordinates(Number.NaN, 2)).toBeNull();
  });
});

describe('firstFixedPoint', () => {
  it('prend le premier point : c’est là que la séance a commencé', () => {
    expect(
      firstFixedPoint([
        [48.8566, 2.3522],
        [48.9, 2.4],
      ]),
    ).toEqual({ latitudeDeg: 48.86, longitudeDeg: 2.35 });
  });

  it('saute les points muets du début — la montre n’a pas encore accroché', () => {
    expect(firstFixedPoint([null, null, [45.7578, 4.832]])).toEqual({
      latitudeDeg: 45.76,
      longitudeDeg: 4.83,
    });
  });

  it('saute aussi le point de garde 0/0', () => {
    expect(firstFixedPoint([[0, 0], [45.7578, 4.832]])).toEqual({
      latitudeDeg: 45.76,
      longitudeDeg: 4.83,
    });
  });

  it('rend `null` quand aucun point n’est exploitable — une séance sur tapis', () => {
    expect(firstFixedPoint([])).toBeNull();
    expect(firstFixedPoint([null, null])).toBeNull();
  });
});

describe('chooseWeatherSource', () => {
  const now = new Date('2026-08-14T12:00:00Z');

  it('lit une séance d’hier sur l’API de prévision — l’archive ne l’a pas encore', () => {
    // Le piège de cette intégration : ERA5 accuse cinq jours de retard.
    expect(chooseWeatherSource(new Date('2026-08-13T09:00:00Z'), now)).toBe('forecast');
  });

  it('lit une séance du jour même sur la prévision', () => {
    expect(chooseWeatherSource(new Date('2026-08-14T07:00:00Z'), now)).toBe('forecast');
  });

  it('bascule sur l’archive au-delà du seuil', () => {
    const justInside = new Date(now.getTime() - FORECAST_MAX_AGE_DAYS * DAY_MS);
    expect(chooseWeatherSource(justInside, now)).toBe('forecast');
    expect(chooseWeatherSource(new Date(justInside.getTime() - HOUR_MS), now)).toBe('archive');
  });

  it('garde le seuil à l’intérieur des deux couvertures', () => {
    // La prévision remonte à 92 jours, l'archive accuse 5 jours de retard : tout
    // seuil entre les deux est servi par les deux APIs.
    expect(FORECAST_MAX_AGE_DAYS).toBeGreaterThan(5);
    expect(FORECAST_MAX_AGE_DAYS).toBeLessThan(92);
  });
});

describe('weatherSampleInstant', () => {
  it('vise le milieu de la séance, pas son départ', () => {
    expect(weatherSampleInstant(new Date('2026-08-14T08:00:00Z'), 3_600)).toEqual(
      new Date('2026-08-14T08:30:00Z'),
    );
  });

  it('retombe sur le départ quand la durée est absente ou absurde', () => {
    const start = new Date('2026-08-14T08:00:00Z');
    expect(weatherSampleInstant(start, 0)).toEqual(start);
    expect(weatherSampleInstant(start, -10)).toEqual(start);
    expect(weatherSampleInstant(start, Number.NaN)).toEqual(start);
  });

  it('plafonne une durée aberrante — un compteur non arrêté ne change pas de journée', () => {
    const start = new Date('2026-08-14T08:00:00Z');
    const capped = weatherSampleInstant(start, 30 * 24 * 3_600);
    expect(capped.getTime() - start.getTime()).toBe((MAX_SESSION_SPAN_S / 2) * 1_000);
  });
});

describe('formatHourParam', () => {
  it('rend `YYYY-MM-DDTHH:mm` en UTC, sans fuseau', () => {
    expect(formatHourParam(new Date('2026-08-14T08:37:12Z'))).toBe('2026-08-14T08:00');
  });
});

describe('hourWindowAround', () => {
  it('encadre l’instant par les deux heures pleines qui l’entourent', () => {
    expect(hourWindowAround(new Date('2026-08-14T08:37:00Z'))).toEqual({
      startHour: '2026-08-14T08:00',
      endHour: '2026-08-14T09:00',
    });
  });

  it('demande quand même deux points sur une heure pile', () => {
    expect(hourWindowAround(new Date('2026-08-14T08:00:00Z'))).toEqual({
      startHour: '2026-08-14T08:00',
      endHour: '2026-08-14T09:00',
    });
  });
});

describe('pickNearestSampleIndex', () => {
  // Secondes Unix, comme `timeformat=unixtime` les rend.
  const times = [
    new Date('2026-08-14T08:00:00Z').getTime() / 1_000,
    new Date('2026-08-14T09:00:00Z').getTime() / 1_000,
  ];

  it('choisit par proximité, pas par défaut', () => {
    expect(pickNearestSampleIndex(times, new Date('2026-08-14T08:20:00Z'))).toBe(0);
    expect(pickNearestSampleIndex(times, new Date('2026-08-14T08:40:00Z'))).toBe(1);
  });

  it('tranche l’égalité sur le premier échantillon', () => {
    expect(pickNearestSampleIndex(times, new Date('2026-08-14T08:30:00Z'))).toBe(0);
  });

  it('rend `null` sur une série vide', () => {
    expect(pickNearestSampleIndex([], new Date())).toBeNull();
  });
});

describe('cadence du rattrapage', () => {
  it('reste très en deçà des limites annoncées par Open-Meteo', () => {
    // « less than 10'000 API calls per day, 5'000 per hour and 600 per minute ».
    const perCycle = MAX_LOOKUPS_PER_CYCLE;
    const cyclesPerHour = (60 * 60 * 1_000) / CYCLE_INTERVAL_MS;
    expect(perCycle).toBeLessThan(600);
    expect(perCycle * cyclesPerHour).toBeLessThan(5_000);
  });

  it('n’envoie pas le premier relevé en retard, et espace les suivants', () => {
    expect(lookupSpacingMs(0)).toBe(0);
    expect(lookupSpacingMs(1)).toBeGreaterThan(0);
    expect(lookupSpacingMs(19)).toBe(lookupSpacingMs(1));
  });
});

describe('nextRetryAt', () => {
  const lastAttemptAt = new Date('2026-08-14T08:00:00Z');

  it('rattrape une panne passagère dans le quart d’heure', () => {
    expect(nextRetryAt(1, lastAttemptAt)).toEqual(new Date('2026-08-14T08:15:00Z'));
  });

  it('espace de plus en plus les tentatives suivantes', () => {
    const delays = RETRY_DELAYS_MS.map((_, index) => {
      const at = nextRetryAt(index + 1, lastAttemptAt);
      return at === null ? null : at.getTime() - lastAttemptAt.getTime();
    });
    expect(delays).toEqual([...RETRY_DELAYS_MS]);
    expect([...RETRY_DELAYS_MS].sort((a, b) => a - b)).toEqual([...RETRY_DELAYS_MS]);
  });

  it('abandonne au-delà du dernier délai — jamais de créneau consommé pour rien', () => {
    expect(nextRetryAt(MAX_ATTEMPTS, lastAttemptAt)).toBeNull();
    expect(nextRetryAt(MAX_ATTEMPTS + 5, lastAttemptAt)).toBeNull();
  });
});

describe('isRetryableStatus', () => {
  it('ne redemande que les échecs', () => {
    expect(isRetryableStatus('failed')).toBe(true);
    // Un tapis n'aura jamais de GPS, et un refus motivé se répétera à l'identique.
    expect(isRetryableStatus('no-location')).toBe(false);
    expect(isRetryableStatus('unsupported')).toBe(false);
    expect(isRetryableStatus('observed')).toBe(false);
  });
});
