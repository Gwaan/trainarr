import { describe, expect, it } from 'vitest';

import { strideLengthM, strideSeries } from './stride';

describe('strideLengthM', () => {
  it('rend la distance par pas', () => {
    // 3,33 m/s (3:00/km) à 170 pas/min.
    expect(strideLengthM(3.33, 170)).toBeCloseTo(1.1753, 4);
  });

  it('reste cohérente avec sa définition sur un cas rond', () => {
    // 3 m/s à 180 pas/min : 180 m parcourus en une minute, 180 pas → 1 m.
    expect(strideLengthM(3, 180)).toBe(1);
  });

  it('s’allonge avec la vitesse à cadence constante', () => {
    const easy = strideLengthM(2.8, 168) ?? 0;
    const fast = strideLengthM(4.5, 168) ?? 0;

    expect(easy).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(easy);
  });

  it('ne calcule rien sans les deux mesures', () => {
    expect(strideLengthM(null, 170)).toBeNull();
    expect(strideLengthM(3.33, null)).toBeNull();
    expect(strideLengthM(null, null)).toBeNull();
  });

  it('ne calcule rien à l’arrêt ni sur une entrée absurde', () => {
    expect(strideLengthM(0, 170)).toBeNull();
    expect(strideLengthM(3.33, 0)).toBeNull();
    expect(strideLengthM(-3.33, 170)).toBeNull();
    expect(strideLengthM(3.33, -170)).toBeNull();
    expect(strideLengthM(Number.NaN, 170)).toBeNull();
    expect(strideLengthM(Number.POSITIVE_INFINITY, 170)).toBeNull();
    expect(strideLengthM(3.33, Number.NaN)).toBeNull();
  });
});

describe('strideSeries', () => {
  it('calcule point par point', () => {
    const strides = strideSeries([3, 3.5, 4], [180, 175, 170]);

    expect(strides).toHaveLength(3);
    expect(strides[0]).toBe(1);
    expect(strides[1]).toBeCloseTo(1.2, 4);
    expect(strides[2]).toBeCloseTo(1.4118, 4);
  });

  it('laisse `null` là où l’un des deux capteurs est muet', () => {
    // Le canal cadence est clairsemé : rien n'est reporté d'un point à l'autre.
    const strides = strideSeries([3, 3, 3, 3], [180, null, null, 180]);

    expect(strides).toEqual([1, null, null, 1]);
  });

  it('n’invente pas de foulée sur un arrêt', () => {
    expect(strideSeries([0, null, 3], [170, 170, 180])).toEqual([null, null, 1]);
  });

  it('tronque à la longueur du plus court canal', () => {
    expect(strideSeries([3, 3, 3], [180])).toEqual([1]);
    expect(strideSeries([3], [180, 180, 180])).toEqual([1]);
  });

  it('rend une série vide sur des entrées vides', () => {
    expect(strideSeries([], [])).toEqual([]);
    expect(strideSeries([3, 3], [])).toEqual([]);
  });
});
