import { describe, expect, it } from 'vitest';

import { MAX_CHART_POINTS, resamplePoints, type SeriesSample } from './resample';

function sample(overrides: Partial<SeriesSample> & { timeS: number }): SeriesSample {
  return {
    distanceM: null,
    paceSecPerKm: null,
    hrBpm: null,
    altitudeM: null,
    cadenceSpm: null,
    ...overrides,
  };
}

/** Séance synthétique de `count` secondes, FC et allure pilotées par le temps. */
function activity(
  count: number,
  hrAt: (second: number) => number,
  paceAt: (second: number) => number = () => 300,
): SeriesSample[] {
  return Array.from({ length: count }, (_, second) =>
    sample({
      timeS: second,
      distanceM: second * 3,
      hrBpm: hrAt(second),
      paceSecPerKm: paceAt(second),
      altitudeM: 100,
      cadenceSpm: 170,
    }),
  );
}

describe('resamplePoints', () => {
  it('laisse intacte une série déjà sous le budget', () => {
    const points = activity(120, () => 140);
    expect(resamplePoints(points)).toEqual(points);
  });

  it('respecte le budget de points', () => {
    const points = activity(10_000, (second) => 140 + (second % 30));
    expect(resamplePoints(points).length).toBeLessThanOrEqual(MAX_CHART_POINTS);
  });

  it('conserve le premier et le dernier point', () => {
    const points = activity(5_000, () => 140);
    const reduced = resamplePoints(points);

    expect(reduced[0]).toEqual(points[0]);
    expect(reduced[reduced.length - 1]).toEqual(points[points.length - 1]);
  });

  it('rend les points dans l’ordre chronologique', () => {
    const points = activity(5_000, (second) => 140 + Math.sin(second) * 20);
    const reduced = resamplePoints(points);

    for (let index = 1; index < reduced.length; index += 1) {
      expect(reduced[index].timeS).toBeGreaterThan(reduced[index - 1].timeS);
    }
  });

  it('conserve un pic de FC isolé d’une seconde', () => {
    // 190 bpm sur un seul point noyé dans 5 000 : une décimation uniforme
    // (1 point sur 8) le perdrait presque sûrement.
    const points = activity(5_000, (second) => (second === 3_333 ? 190 : 140));
    const reduced = resamplePoints(points);

    expect(reduced.some((point) => point.hrBpm === 190)).toBe(true);
  });

  it('conserve les extrema d’allure comme ceux de FC', () => {
    const points = activity(
      5_000,
      (second) => (second === 1_111 ? 190 : 140),
      (second) => (second === 4_444 ? 180 : 300),
    );
    const reduced = resamplePoints(points);

    expect(reduced.some((point) => point.hrBpm === 190)).toBe(true);
    expect(reduced.some((point) => point.paceSecPerKm === 180)).toBe(true);
  });

  it('n’invente aucune valeur : chaque point de sortie est un point d’entrée', () => {
    const points = activity(5_000, (second) => 140 + (second % 40));
    const source = new Set(points);

    for (const point of resamplePoints(points)) {
      expect(source.has(point)).toBe(true);
    }
  });

  it('couvre l’axe des temps même sans FC ni allure', () => {
    const points = Array.from({ length: 5_000 }, (_, second) =>
      sample({ timeS: second, altitudeM: 100 + second }),
    );
    const reduced = resamplePoints(points);

    expect(reduced.length).toBeGreaterThan(100);
    expect(reduced[reduced.length - 1].timeS).toBe(4_999);
  });

  it('rend une série vide sur une entrée vide', () => {
    expect(resamplePoints([])).toEqual([]);
  });
});
