import { describe, expect, it } from 'vitest';

import { paceSecPerKm } from './pace';

describe('paceSecPerKm', () => {
  it('convertit une distance et une durée en allure', () => {
    expect(paceSecPerKm(10_000, 50 * 60)).toBe(300); // 5:00/km
    expect(paceSecPerKm(5000, 20 * 60)).toBe(240); // 4:00/km
    expect(paceSecPerKm(42_195, 3 * 3600)).toBeCloseTo(255.9545, 3);
  });

  it('gère les distances inférieures au kilomètre', () => {
    expect(paceSecPerKm(400, 72)).toBe(180); // 3:00/km
  });

  it.each([
    ['distance nulle', 0, 1200],
    ['distance négative', -5000, 1200],
    ['durée nulle', 5000, 0],
    ['durée négative', 5000, -1200],
    ['distance NaN', Number.NaN, 1200],
    ['durée NaN', 5000, Number.NaN],
    ['distance infinie', Number.POSITIVE_INFINITY, 1200],
    ['durée infinie', 5000, Number.POSITIVE_INFINITY],
  ])('renvoie null pour une entrée invalide (%s)', (_label, distanceM, movingTimeS) => {
    expect(paceSecPerKm(distanceM, movingTimeS)).toBeNull();
  });
});
