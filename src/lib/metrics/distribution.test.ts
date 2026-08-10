import { describe, expect, it } from 'vitest';

import { computeTimeDistribution, hrDistribution, paceDistribution } from './distribution';

/** Série 1 Hz de `count` secondes, valeur donnée par une fonction du temps. */
function series(count: number, valueAt: (second: number) => number | null) {
  const time: number[] = [];
  const values: (number | null)[] = [];
  for (let second = 0; second < count; second += 1) {
    time.push(second);
    values.push(valueAt(second));
  }
  return { time, values };
}

/** Somme des secondes de tous les bins. */
function totalSeconds(bins: { seconds: number }[]): number {
  return bins.reduce((sum, bin) => sum + bin.seconds, 0);
}

describe('computeTimeDistribution', () => {
  it('range tout le temps dans une seule tranche quand la valeur ne bouge pas', () => {
    const { time, values } = series(100, () => 155);

    expect(computeTimeDistribution(values, time, { binWidth: 5 })).toEqual([
      { from: 155, to: 160, seconds: 99 },
    ]);
  });

  it('aligne l’origine sur le multiple de binWidth sous la plus petite valeur', () => {
    const { time, values } = series(10, () => 153);
    const bins = computeTimeDistribution(values, time, { binWidth: 5 }) ?? [];

    expect(bins).toHaveLength(1);
    expect(bins[0].from).toBe(150);
    expect(bins[0].to).toBe(155);
  });

  it('émet les tranches vides intermédiaires', () => {
    const { time, values } = series(100, (second) => (second < 50 ? 120 : 140));
    const bins = computeTimeDistribution(values, time, { binWidth: 5 });

    expect(bins).toEqual([
      { from: 120, to: 125, seconds: 49.5 },
      { from: 125, to: 130, seconds: 0 },
      { from: 130, to: 135, seconds: 0 },
      { from: 135, to: 140, seconds: 0 },
      { from: 140, to: 145, seconds: 49.5 },
    ]);
  });

  it('pondère par le temps représenté, pas par le nombre de points', () => {
    // 10 s de valeur haute à 1 Hz (11 points) puis 60 s de valeur basse toutes
    // les 3 s (20 points) : compter les points donnerait 35 % de valeur haute.
    const time: number[] = [];
    const values: number[] = [];
    for (let second = 0; second <= 10; second += 1) {
      time.push(second);
      values.push(190);
    }
    for (let second = 13; second <= 70; second += 3) {
      time.push(second);
      values.push(130);
    }

    const bins = computeTimeDistribution(values, time, { binWidth: 10 }) ?? [];
    expect(bins).toHaveLength(7);
    expect(bins[0]).toEqual({ from: 130, to: 140, seconds: 58.5 });
    expect(bins[6]).toEqual({ from: 190, to: 200, seconds: 11.5 });
    expect(totalSeconds(bins)).toBe(70);
  });

  it('ne compte pas une auto-pause comme du temps passé', () => {
    // 10 min à 140, 20 min sans le moindre point, 10 min à 160 : le total doit
    // rester les 20 min mesurées, pas les 40 min écoulées.
    const time: number[] = [];
    const values: number[] = [];
    for (let second = 0; second < 600; second += 1) {
      time.push(second);
      values.push(140);
    }
    for (let second = 1800; second < 2400; second += 1) {
      time.push(second);
      values.push(160);
    }

    const bins = computeTimeDistribution(values, time, { binWidth: 5 }) ?? [];
    expect(totalSeconds(bins)).toBe(1203);
    expect(bins).toHaveLength(5);
    expect(bins[0]).toEqual({ from: 140, to: 145, seconds: 601.5 });
    expect(bins[4]).toEqual({ from: 160, to: 165, seconds: 601.5 });
  });

  it('compte le temps couvert par un canal clairsemé, pas ses mesures', () => {
    // Valeur écrite un point sur quatre sur un axe à 1 Hz de 601 points.
    const { time, values } = series(601, (second) => (second % 4 === 0 ? 152 : null));

    expect(computeTimeDistribution(values, time, { binWidth: 5 })).toEqual([
      { from: 150, to: 155, seconds: 600 },
    ]);
  });

  it('écarte les points sans instant exploitable', () => {
    const bins = computeTimeDistribution([100, 100, 100], [0, null, 2], { binWidth: 10 });

    // Sous-axe réduit à {0, 2} : 2 s représentées, pas 2 points comptés.
    expect(bins).toEqual([{ from: 100, to: 110, seconds: 2 }]);
  });

  it('regroupe le hors-bornes dans des bins de bord ouverts', () => {
    const bins = computeTimeDistribution([10, 100, 200], [0, 1, 2], {
      binWidth: 50,
      min: 50,
      max: 150,
    });

    expect(bins).toEqual([
      { from: Number.NEGATIVE_INFINITY, to: 50, seconds: 0.5 },
      { from: 100, to: 150, seconds: 1 },
      { from: 150, to: Number.POSITIVE_INFINITY, seconds: 0.5 },
    ]);
  });

  it('n’émet pas de bin de bord vide', () => {
    const { time, values } = series(10, () => 100);
    const bins = computeTimeDistribution(values, time, { binWidth: 50, min: 50, max: 150 });

    expect(bins).toEqual([{ from: 100, to: 150, seconds: 9 }]);
  });

  it('remonte la borne haute au multiple de binWidth supérieur', () => {
    const bins = computeTimeDistribution([200, 200], [0, 10], {
      binWidth: 50,
      min: 0,
      max: 130,
    });

    // Le bin de bord haut commence à 150, pas à 130 : pas de tranche tronquée.
    expect(bins).toEqual([{ from: 150, to: Number.POSITIVE_INFINITY, seconds: 10 }]);
  });

  it('ne calcule rien sans échantillon exploitable', () => {
    expect(computeTimeDistribution([], [], { binWidth: 5 })).toBeNull();
    expect(computeTimeDistribution([null, null], [0, 1], { binWidth: 5 })).toBeNull();
    expect(computeTimeDistribution([150], [0], { binWidth: 5 })).toBeNull();
    expect(computeTimeDistribution([150, 150], [null, null], { binWidth: 5 })).toBeNull();
  });

  it('ne calcule rien sur des options incohérentes', () => {
    const { time, values } = series(10, () => 100);

    expect(computeTimeDistribution(values, time, { binWidth: 0 })).toBeNull();
    expect(computeTimeDistribution(values, time, { binWidth: -5 })).toBeNull();
    expect(computeTimeDistribution(values, time, { binWidth: Number.NaN })).toBeNull();
    expect(
      computeTimeDistribution(values, time, { binWidth: 5, min: 100, max: 100 }),
    ).toBeNull();
    expect(computeTimeDistribution(values, time, { binWidth: 5, min: 200, max: 100 })).toBeNull();
    expect(
      computeTimeDistribution(values, time, { binWidth: 5, max: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});

describe('paceDistribution', () => {
  it('convertit la vitesse en allure et range par tranche de 15 s/km', () => {
    // 3,2 m/s = 312,5 s/km → tranche [300, 315).
    const { time, values } = series(10, () => 3.2);

    expect(paceDistribution(values, time)).toEqual([{ from: 300, to: 315, seconds: 9 }]);
  });

  it('range le plus rapide que 3:00/km dans le bin de bord bas', () => {
    const { time, values } = series(10, () => 6);

    expect(paceDistribution(values, time)).toEqual([
      { from: Number.NEGATIVE_INFINITY, to: 180, seconds: 9 },
    ]);
  });

  it('range le plus lent que 12:00/km dans le bin de bord haut', () => {
    // 1 m/s = 1000 s/km.
    const { time, values } = series(10, () => 1);

    expect(paceDistribution(values, time)).toEqual([
      { from: 720, to: Number.POSITIVE_INFINITY, seconds: 9 },
    ]);
  });

  it('n’assimile pas l’arrêt à une allure très lente', () => {
    // 1 min de course puis 1 min à 0,2 m/s : l'arrêt n'est nulle part.
    const { time, values } = series(120, (second) => (second < 60 ? 3.2 : 0.2));
    const bins = paceDistribution(values, time);

    expect(bins).toEqual([{ from: 300, to: 315, seconds: 59 }]);
  });

  it('ne calcule rien quand la vitesse ne parle jamais', () => {
    const { time, values } = series(10, () => null);

    expect(paceDistribution(values, time)).toBeNull();
    expect(paceDistribution([], [])).toBeNull();
  });
});

describe('hrDistribution', () => {
  it('déduit ses bornes des données, arrondies au multiple de 5', () => {
    const { time, values } = series(22, (second) => 142 + second);

    expect(hrDistribution(values, time)).toEqual([
      { from: 140, to: 145, seconds: 2.5 },
      { from: 145, to: 150, seconds: 5 },
      { from: 150, to: 155, seconds: 5 },
      { from: 155, to: 160, seconds: 5 },
      { from: 160, to: 165, seconds: 3.5 },
    ]);
  });

  it('n’a jamais de bin de bord', () => {
    const { time, values } = series(600, (second) => 90 + (second % 100));
    const bins = hrDistribution(values, time) ?? [];

    expect(bins.length).toBeGreaterThan(1);
    for (const bin of bins) {
      expect(Number.isFinite(bin.from)).toBe(true);
      expect(Number.isFinite(bin.to)).toBe(true);
    }
  });

  it('écarte les mesures nulles ou négatives', () => {
    const { time, values } = series(10, (second) => (second % 2 === 0 ? 150 : 0));
    const bins = hrDistribution(values, time);

    expect(bins).toEqual([{ from: 150, to: 155, seconds: 8 }]);
  });

  it('ne calcule rien sans mesure de FC', () => {
    expect(hrDistribution([null, null, null], [0, 1, 2])).toBeNull();
  });
});
