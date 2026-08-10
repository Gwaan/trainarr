import { describe, expect, it } from 'vitest';

import { computeTrimp, type TrimpInput } from './trimp';

const base: TrimpInput = {
  movingTimeS: 3600,
  avgHrBpm: 150,
  restingHrBpm: 50,
  maxHrBpm: 190,
  sex: 'male',
};

describe('computeTrimp', () => {
  it('applique la pondération masculine (0.64 / 1.92)', () => {
    // HRr = (150 - 50) / (190 - 50) = 0.714286
    // 60 × 0.714286 × 0.64 × e^(1.92 × 0.714286) = 108.0954
    expect(computeTrimp(base)).toBeCloseTo(108.0954, 3);
  });

  it('applique la pondération féminine (0.86 / 1.67)', () => {
    // 60 × 0.714286 × 0.86 × e^(1.67 × 0.714286) = 121.4991
    expect(computeTrimp({ ...base, sex: 'female' })).toBeCloseTo(121.4991, 3);
  });

  it('est proportionnel à la durée', () => {
    const oneHour = computeTrimp(base);
    const halfHour = computeTrimp({ ...base, movingTimeS: 1800 });

    expect(oneHour).not.toBeNull();
    expect(halfHour).not.toBeNull();
    expect(halfHour!).toBeCloseTo(oneHour! / 2, 10);
  });

  it('croît plus que linéairement avec l’intensité', () => {
    const easy = computeTrimp({ ...base, avgHrBpm: 120 });
    const hard = computeTrimp({ ...base, avgHrBpm: 180 });

    expect(easy).not.toBeNull();
    expect(hard).not.toBeNull();
    expect(hard!).toBeGreaterThan(easy! * 2);
  });

  it('vaut 0 à la FC de repos et atteint son maximum à la FC max', () => {
    // 60 × 1 × 0.64 × e^1.92 = 261.9248
    expect(computeTrimp({ ...base, avgHrBpm: 50 })).toBe(0);
    expect(computeTrimp({ ...base, avgHrBpm: 190 })).toBeCloseTo(261.9248, 3);
  });

  it('borne HRr dans [0, 1] plutôt que d’extrapoler une mesure aberrante', () => {
    const underResting = computeTrimp({ ...base, avgHrBpm: 30 });
    const overMax = computeTrimp({ ...base, avgHrBpm: 230 });

    expect(underResting).toBe(0);
    expect(overMax).toBeCloseTo(261.9248, 3);
  });

  it.each([
    ['FC moyenne absente', { avgHrBpm: null }],
    ['FC de repos absente', { restingHrBpm: null }],
    ['FC max absente', { maxHrBpm: null }],
  ] satisfies ReadonlyArray<[string, Partial<TrimpInput>]>)(
    'renvoie null quand la %s',
    (_label, patch) => {
      expect(computeTrimp({ ...base, ...patch })).toBeNull();
    },
  );

  it('renvoie null si l’échelle de réserve cardiaque est incohérente', () => {
    expect(computeTrimp({ ...base, maxHrBpm: 50, restingHrBpm: 50 })).toBeNull();
    expect(computeTrimp({ ...base, maxHrBpm: 40, restingHrBpm: 50 })).toBeNull();
  });

  it('renvoie null pour une durée nulle ou négative', () => {
    expect(computeTrimp({ ...base, movingTimeS: 0 })).toBeNull();
    expect(computeTrimp({ ...base, movingTimeS: -600 })).toBeNull();
  });

  it.each([
    ['movingTimeS', { movingTimeS: Number.NaN }],
    ['movingTimeS infini', { movingTimeS: Number.POSITIVE_INFINITY }],
    ['avgHrBpm', { avgHrBpm: Number.NaN }],
    ['restingHrBpm', { restingHrBpm: Number.NaN }],
    ['maxHrBpm', { maxHrBpm: Number.POSITIVE_INFINITY }],
  ] satisfies ReadonlyArray<[string, Partial<TrimpInput>]>)(
    'ne propage pas une valeur non finie (%s)',
    (_label, patch) => {
      expect(computeTrimp({ ...base, ...patch })).toBeNull();
    },
  );
});
