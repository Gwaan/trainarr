import { describe, expect, it } from 'vitest';

import { estimateVdot } from './vdot';

describe('estimateVdot', () => {
  /**
   * Références croisées avec les tables publiées de Daniels : VDOT 50 correspond
   * à 5 000 m en 19:57 et à 10 km en 41:21. L'implémentation doit retomber sur
   * 50 (± 1) pour ces deux performances.
   */
  it('retrouve VDOT 50 sur les performances de référence de la table Daniels', () => {
    expect(estimateVdot({ distanceM: 5000, movingTimeS: 19 * 60 + 57 })).toBeCloseTo(50, 0);
    expect(estimateVdot({ distanceM: 10_000, movingTimeS: 41 * 60 + 21 })).toBeCloseTo(50, 0);
  });

  it('calcule les valeurs attendues sur des efforts ronds', () => {
    // v = 250 m/min → VO2 = 47.4645 ; t = 20 min → pct = 0.952989 → 49.806
    expect(estimateVdot({ distanceM: 5000, movingTimeS: 20 * 60 })).toBeCloseTo(49.806, 3);
    // v = 250 m/min → VO2 = 47.4645 ; t = 40 min → pct = 0.913762 → 51.944
    expect(estimateVdot({ distanceM: 10_000, movingTimeS: 40 * 60 })).toBeCloseTo(51.944, 3);
    // Marathon en 3 h.
    expect(estimateVdot({ distanceM: 42_195, movingTimeS: 3 * 3600 })).toBeCloseTo(53.528, 3);
  });

  it('croît quand la performance s’améliore à distance égale', () => {
    const slower = estimateVdot({ distanceM: 10_000, movingTimeS: 45 * 60 });
    const faster = estimateVdot({ distanceM: 10_000, movingTimeS: 38 * 60 });

    expect(slower).not.toBeNull();
    expect(faster).not.toBeNull();
    expect(faster!).toBeGreaterThan(slower!);
  });

  it('donne un VDOT cohérent entre distances pour un même niveau', () => {
    // 5 km 20:00 et 10 km 41:35 sont deux performances de niveau très proche.
    const fiveK = estimateVdot({ distanceM: 5000, movingTimeS: 20 * 60 })!;
    const tenK = estimateVdot({ distanceM: 10_000, movingTimeS: 41 * 60 + 35 })!;

    expect(Math.abs(fiveK - tenK)).toBeLessThan(1);
  });

  it('renvoie null en dessous de 1500 m (hors domaine du modèle)', () => {
    expect(estimateVdot({ distanceM: 1499, movingTimeS: 6 * 60 })).toBeNull();
    expect(estimateVdot({ distanceM: 800, movingTimeS: 5 * 60 })).toBeNull();
    // La borne elle-même reste calculable.
    expect(estimateVdot({ distanceM: 1500, movingTimeS: 5 * 60 })).not.toBeNull();
  });

  it('renvoie null en dessous de 4 minutes (hors domaine du modèle)', () => {
    expect(estimateVdot({ distanceM: 1500, movingTimeS: 239 })).toBeNull();
    expect(estimateVdot({ distanceM: 1500, movingTimeS: 240 })).not.toBeNull();
  });

  it('renvoie null hors de la plage physiologiquement plausible [20, 90]', () => {
    // 1500 m en 12 min → VDOT ≈ 19.97, sous la borne basse.
    expect(estimateVdot({ distanceM: 1500, movingTimeS: 12 * 60 })).toBeNull();
    // Une marche de 5 km en 1 h → VDOT ≈ 12.7.
    expect(estimateVdot({ distanceM: 5000, movingTimeS: 3600 })).toBeNull();
    // Une distance GPS aberrante sur une durée courte → au-dessus de 90.
    expect(estimateVdot({ distanceM: 20_000, movingTimeS: 20 * 60 })).toBeNull();
  });

  it.each([
    ['distance nulle', { distanceM: 0, movingTimeS: 1200 }],
    ['distance négative', { distanceM: -5000, movingTimeS: 1200 }],
    ['durée nulle', { distanceM: 5000, movingTimeS: 0 }],
    ['durée négative', { distanceM: 5000, movingTimeS: -1200 }],
    ['distance NaN', { distanceM: Number.NaN, movingTimeS: 1200 }],
    ['durée NaN', { distanceM: 5000, movingTimeS: Number.NaN }],
    ['distance infinie', { distanceM: Number.POSITIVE_INFINITY, movingTimeS: 1200 }],
    ['durée infinie', { distanceM: 5000, movingTimeS: Number.POSITIVE_INFINITY }],
  ])('renvoie null pour une entrée invalide (%s)', (_label, effort) => {
    expect(estimateVdot(effort)).toBeNull();
  });
});
