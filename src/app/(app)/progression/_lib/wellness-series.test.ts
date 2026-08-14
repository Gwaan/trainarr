import { describe, expect, it } from 'vitest';

import {
  buildWellnessSeries,
  hasNoWellnessMeasure,
  type WellnessDayLike,
} from './wellness-series';

/** Une journée vide, dont chaque test ne renseigne que ce qu'il éprouve. */
function day(date: string, measures: Partial<WellnessDayLike> = {}): WellnessDayLike {
  return {
    day: date,
    restingHrBpm: null,
    hrvRmssdMs: null,
    sleepTimeS: null,
    weightKg: null,
    ...measures,
  };
}

function seriesOf(days: readonly WellnessDayLike[], key: string) {
  const found = buildWellnessSeries(days).find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`Série « ${key} » absente.`);
  return found;
}

describe('buildWellnessSeries', () => {
  it('rend les quatre mesures, dans l’ordre du panneau', () => {
    expect(buildWellnessSeries([]).map((entry) => entry.key)).toEqual([
      'resting-hr',
      'hrv',
      'sleep',
      'weight',
    ]);
  });

  it('ne garde que les valeurs mesurées, dans l’ordre chronologique reçu', () => {
    const series = seriesOf(
      [
        day('2026-08-10', { restingHrBpm: 48 }),
        day('2026-08-11'),
        day('2026-08-12', { restingHrBpm: 47 }),
      ],
      'resting-hr',
    );

    // La nuit sans mesure n'est ni comblée, ni reportée, ni mise à zéro : elle
    // n'est simplement pas un point.
    expect(series.values).toEqual([48, 47]);
  });

  it('rend la dernière valeur formatée avec son unité', () => {
    const days = [day('2026-08-10', { restingHrBpm: 48 }), day('2026-08-12', { restingHrBpm: 47 })];

    expect(seriesOf(days, 'resting-hr').latest).toBe('47 bpm');
  });

  it('formate chaque mesure dans son unité propre', () => {
    const days = [
      day('2026-08-12', { hrvRmssdMs: 63.4, sleepTimeS: 25_800, weightKg: 61.44 }),
    ];

    expect(seriesOf(days, 'hrv').latest).toBe('63 ms');
    expect(seriesOf(days, 'sleep').latest).toBe('7 h 10');
    expect(seriesOf(days, 'weight').latest).toBe('61,4 kg');
  });

  it('rend l’amplitude de la période dès deux mesures distinctes', () => {
    const days = [
      day('2026-08-10', { restingHrBpm: 51 }),
      day('2026-08-11', { restingHrBpm: 46 }),
      day('2026-08-12', { restingHrBpm: 48 }),
    ];

    expect(seriesOf(days, 'resting-hr').range).toBe('46 bpm → 51 bpm');
  });

  it('ne rend aucune amplitude sur une série plate ou trop courte', () => {
    expect(seriesOf([day('2026-08-12', { restingHrBpm: 48 })], 'resting-hr').range).toBeNull();
    expect(
      seriesOf(
        [day('2026-08-11', { restingHrBpm: 48 }), day('2026-08-12', { restingHrBpm: 48 })],
        'resting-hr',
      ).range,
    ).toBeNull();
  });

  it('n’invente rien pour une mesure jamais prise', () => {
    const series = seriesOf([day('2026-08-12', { restingHrBpm: 48 })], 'weight');

    expect(series.values).toEqual([]);
    expect(series.latest).toBeNull();
    expect(series.range).toBeNull();
    // La phrase d'absence nomme la mesure : un vide se lirait comme une panne.
    expect(series.absent).toContain('pesée');
  });
});

describe('hasNoWellnessMeasure', () => {
  it('est vraie quand aucune des quatre mesures n’existe', () => {
    expect(hasNoWellnessMeasure(buildWellnessSeries([day('2026-08-12')]))).toBe(true);
    expect(hasNoWellnessMeasure(buildWellnessSeries([]))).toBe(true);
  });

  it('est fausse dès qu’une seule mesure existe', () => {
    expect(
      hasNoWellnessMeasure(buildWellnessSeries([day('2026-08-12', { weightKg: 61 })])),
    ).toBe(false);
  });
});
