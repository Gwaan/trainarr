import { describe, expect, it } from 'vitest';

import { computeLoadSeries, type DailyTrimp } from './load';

describe('computeLoadSeries', () => {
  it('renvoie un tableau vide pour une entrée vide', () => {
    expect(computeLoadSeries([])).toEqual([]);
  });

  it('calcule le premier point depuis des réservoirs à 0', () => {
    const [point] = computeLoadSeries([{ date: '2026-01-01', trimp: 100 }]);

    expect(point).toBeDefined();
    expect(point!.date).toBe('2026-01-01');
    expect(point!.ctl).toBeCloseTo(100 / 42, 10); // 2.380952
    expect(point!.atl).toBeCloseTo(100 / 7, 10); // 14.285714
    expect(point!.tsb).toBeCloseTo(100 / 42 - 100 / 7, 10); // -11.904762
  });

  it('densifie les jours manquants entre deux activités', () => {
    const series = computeLoadSeries([
      { date: '2026-01-01', trimp: 100 },
      { date: '2026-01-05', trimp: 80 },
    ]);

    expect(series.map((point) => point.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ]);

    // Trou de 3 jours à TRIMP = 0 : décroissance géométrique de facteur 41/42.
    expect(series[0]!.ctl).toBeCloseTo(2.380952, 6);
    expect(series[1]!.ctl).toBeCloseTo(2.324263, 6);
    expect(series[2]!.ctl).toBeCloseTo(2.268923, 6);
    expect(series[3]!.ctl).toBeCloseTo(2.214901, 6);
    // Reprise le 5 : la charge remonte.
    expect(series[4]!.ctl).toBeCloseTo(4.066928, 6);

    // ATL décroît plus vite que CTL (7 jours contre 42).
    expect(series[3]!.atl).toBeCloseTo(8.996252, 6);
  });

  it('fait décroître CTL, ATL et |TSB| pendant le trou', () => {
    const series = computeLoadSeries([
      { date: '2026-01-01', trimp: 100 },
      { date: '2026-01-05', trimp: 0 },
    ]);

    const gap = series.slice(1);
    for (let i = 1; i < gap.length; i += 1) {
      expect(gap[i]!.ctl).toBeLessThan(gap[i - 1]!.ctl);
      expect(gap[i]!.atl).toBeLessThan(gap[i - 1]!.atl);
    }

    // La forme (TSB) remonte vers 0 au repos.
    expect(series.at(-1)!.tsb).toBeGreaterThan(series[0]!.tsb);
    expect(series.at(-1)!.tsb).toBeLessThan(0);
  });

  it('fait tendre CTL et ATL vers 0 après une longue coupure', () => {
    const series = computeLoadSeries([
      { date: '2026-01-01', trimp: 200 },
      { date: '2027-02-04', trimp: 0 }, // ~400 jours plus tard
    ]);

    expect(series).toHaveLength(400);

    const last = series.at(-1)!;
    expect(last.ctl).toBeGreaterThan(0);
    expect(last.ctl).toBeLessThan(0.01);
    expect(last.atl).toBeLessThan(0.01);
    expect(last.tsb).toBeCloseTo(0, 3);
  });

  it('converge vers la charge quotidienne quand elle est constante', () => {
    const daily: DailyTrimp[] = Array.from({ length: 400 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
      trimp: 50,
    }));

    const last = computeLoadSeries(daily).at(-1)!;

    expect(last.ctl).toBeCloseTo(50, 1);
    expect(last.atl).toBeCloseTo(50, 6);
    expect(last.tsb).toBeCloseTo(0, 1);
  });

  it('trie l’entrée et renvoie des dates croissantes', () => {
    const series = computeLoadSeries([
      { date: '2026-03-03', trimp: 40 },
      { date: '2026-03-01', trimp: 100 },
      { date: '2026-03-02', trimp: 60 },
    ]);

    expect(series.map((point) => point.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(series[0]!.ctl).toBeCloseTo(100 / 42, 10);
  });

  it('somme les séances d’une même journée', () => {
    const split = computeLoadSeries([
      { date: '2026-01-01', trimp: 60 },
      { date: '2026-01-01', trimp: 40 },
    ]);
    const merged = computeLoadSeries([{ date: '2026-01-01', trimp: 100 }]);

    expect(split).toHaveLength(1);
    expect(split[0]!.ctl).toBeCloseTo(merged[0]!.ctl, 10);
  });

  it('traverse correctement les frontières de mois et les années bissextiles', () => {
    const series = computeLoadSeries([
      { date: '2028-02-27', trimp: 30 },
      { date: '2028-03-01', trimp: 30 },
    ]);

    expect(series.map((point) => point.date)).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
  });

  it('ignore les entrées dont la date n’est pas une date calendaire', () => {
    expect(computeLoadSeries([{ date: 'pas-une-date', trimp: 100 }])).toEqual([]);
    expect(computeLoadSeries([{ date: '2026-02-30', trimp: 100 }])).toEqual([]);
    expect(computeLoadSeries([{ date: '2026-1-1', trimp: 100 }])).toEqual([]);

    const series = computeLoadSeries([
      { date: '2026-01-01', trimp: 100 },
      { date: '2026-13-01', trimp: 999 },
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]!.ctl).toBeCloseTo(100 / 42, 10);
  });

  it('compte 0 pour une charge non finie ou négative', () => {
    const series = computeLoadSeries([
      { date: '2026-01-01', trimp: Number.NaN },
      { date: '2026-01-02', trimp: Number.POSITIVE_INFINITY },
      { date: '2026-01-03', trimp: -50 },
    ]);

    expect(series).toHaveLength(3);
    for (const point of series) {
      expect(point.ctl).toBe(0);
      expect(point.atl).toBe(0);
      expect(point.tsb).toBe(0);
    }
  });

  it('vérifie l’identité tsb = ctl - atl sur tous les points', () => {
    const series = computeLoadSeries([
      { date: '2026-01-01', trimp: 120 },
      { date: '2026-01-04', trimp: 90 },
      { date: '2026-01-09', trimp: 200 },
    ]);

    expect(series).toHaveLength(9);
    for (const point of series) {
      expect(point.tsb).toBeCloseTo(point.ctl - point.atl, 12);
    }
  });
});
