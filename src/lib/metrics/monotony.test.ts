import { describe, expect, it } from 'vitest';

import { shiftCivilDate } from '@/lib/dates/civil';

import type { DailyTrimp } from './load';
import { computeMonotonySeries } from './monotony';

/** Semaine dense à partir du 1er janvier 2026 (un jeudi, sans importance ici). */
const week = (trimps: readonly number[], from = '2026-01-01'): DailyTrimp[] =>
  trimps.map((trimp, index) => ({ date: shiftCivilDate(from, index), trimp }));

/** Dernier point d'une semaine de sept jours : le seul dont la fenêtre est pleine. */
const lastOfWeek = (trimps: readonly number[]) => computeMonotonySeries(week(trimps)).at(-1)!;

describe('computeMonotonySeries', () => {
  it('renvoie un tableau vide pour une entrée vide', () => {
    expect(computeMonotonySeries([])).toEqual([]);
  });

  /**
   * Semaine alternée dur / repos : [0, 100, 0, 100, 0, 100, 0].
   *
   * charge = 300 ; moyenne = 300/7
   * écarts : quatre fois −300/7, trois fois +400/7
   * Σ écarts² = 4·(300/7)² + 3·(400/7)² = (360 000 + 480 000)/49 = 840 000/49
   * variance de population = 840 000/343
   * monotonie² = (90 000/49) / (840 000/343) = 3/4  →  monotonie = √3/2
   * contrainte = 300 · √3/2
   */
  it('calcule la monotonie et la contrainte d’une semaine alternée', () => {
    const point = lastOfWeek([0, 100, 0, 100, 0, 100, 0]);

    expect(point.date).toBe('2026-01-07');
    expect(point.weeklyLoad).toBeCloseTo(300, 10);
    expect(point.monotony).toBeCloseTo(Math.sqrt(3) / 2, 10); // 0.8660254
    expect(point.strain).toBeCloseTo(300 * (Math.sqrt(3) / 2), 10); // 259.80762
  });

  /**
   * Le choix conventionnel, rendu visible : sur la même semaine, l'écart-type
   * d'échantillon (÷ n−1) donnerait monotonie² = 90 000/140 000 = 9/14, soit
   * 3/√14 ≈ 0,8018 au lieu de √3/2 ≈ 0,8660 — 8 % plus bas. C'est bien la
   * convention de population qui est implémentée (cf. l'en-tête du module).
   */
  it('utilise l’écart-type de population, pas celui d’échantillon', () => {
    const point = lastOfWeek([0, 100, 0, 100, 0, 100, 0]);

    expect(point.monotony).toBeCloseTo(Math.sqrt(3) / 2, 10);
    expect(point.monotony).not.toBeCloseTo(3 / Math.sqrt(14), 3);
  });

  /**
   * Une seule séance dans la semaine : [0, 0, 0, 0, 0, 0, 700].
   *
   * charge = 700 ; moyenne = 100
   * Σ écarts² = 6·100² + 600² = 420 000 ; variance = 60 000
   * monotonie² = 100² / 60 000 = 1/6  →  monotonie = 1/√6 ≈ 0,40825
   */
  it('calcule une monotonie basse quand toute la charge tient sur un jour', () => {
    const point = lastOfWeek([0, 0, 0, 0, 0, 0, 700]);

    expect(point.weeklyLoad).toBeCloseTo(700, 10);
    expect(point.monotony).toBeCloseTo(1 / Math.sqrt(6), 10);
    expect(point.strain).toBeCloseTo(700 / Math.sqrt(6), 10); // 285.77380
  });

  /**
   * La semaine que la métrique existe pour dénoncer : sept jours quasi
   * identiques, [100 ×6, 101].
   *
   * charge = 701 ; moyenne = 701/7
   * écarts : six fois −1/7, une fois +6/7 → Σ écarts² = (6 + 36)/49 = 6/7
   * variance = 6/49 → écart-type = √6/7
   * monotonie = (701/7) / (√6/7) = 701/√6 ≈ 286,2
   */
  it('rend une monotonie très élevée pour une semaine sans variété', () => {
    const point = lastOfWeek([100, 100, 100, 100, 100, 100, 101]);

    expect(point.weeklyLoad).toBeCloseTo(701, 10);
    expect(point.monotony).toBeCloseTo(701 / Math.sqrt(6), 8);
    expect(point.strain).toBeCloseTo((701 * 701) / Math.sqrt(6), 4);
  });

  /**
   * À charge hebdomadaire strictement égale (490), la semaine uniforme doit
   * ressortir bien plus monotone que la semaine polarisée. C'est tout l'objet de
   * la métrique : elle ne mesure pas un volume.
   */
  it('sépare deux semaines de même charge selon leur alternance', () => {
    // [60, 70, 70, 70, 70, 80, 70] : moyenne 70, Σ écarts² = 200,
    // variance = 200/7 → monotonie = 70 / √(200/7) ≈ 13,10.
    const uniform = lastOfWeek([60, 70, 70, 70, 70, 80, 70]);
    // [0, 140, 0, 140, 0, 140, 70] : moyenne 70, Σ écarts² = 6·70² = 29 400,
    // variance = 4200 → monotonie = 70 / √4200 ≈ 1,08.
    const polarized = lastOfWeek([0, 140, 0, 140, 0, 140, 70]);

    expect(uniform.weeklyLoad).toBeCloseTo(490, 10);
    expect(polarized.weeklyLoad).toBeCloseTo(490, 10);
    expect(uniform.monotony).toBeCloseTo(70 / Math.sqrt(200 / 7), 10); // 13.0958
    expect(polarized.monotony).toBeCloseTo(70 / Math.sqrt(4200), 10); // 1.08012
    expect(uniform.monotony!).toBeGreaterThan(polarized.monotony! * 10);
  });

  it('rend null quand les sept jours sont rigoureusement identiques', () => {
    const point = lastOfWeek([50, 50, 50, 50, 50, 50, 50]);

    expect(point.weeklyLoad).toBeCloseTo(350, 10);
    expect(point.monotony).toBeNull();
    expect(point.strain).toBeNull();
  });

  it('rend null pour une semaine entièrement au repos, jamais l’infini', () => {
    const point = lastOfWeek([0, 0, 0, 0, 0, 0, 0]);

    expect(point.weeklyLoad).toBe(0);
    expect(point.monotony).toBeNull();
    expect(point.strain).toBeNull();
  });

  it('rend null tant que la fenêtre de sept jours n’est pas pleine', () => {
    const series = computeMonotonySeries(week([10, 20, 30, 40, 50, 60, 70]));

    expect(series).toHaveLength(7);
    for (const point of series.slice(0, 6)) {
      expect(point.monotony).toBeNull();
      expect(point.strain).toBeNull();
    }
    expect(series[6]!.monotony).not.toBeNull();

    // `weeklyLoad` reste rendu sur une fenêtre incomplète : c'est la somme des
    // jours disponibles (10, puis 10+20, …), mécaniquement sous-estimée.
    expect(series.map((point) => point.weeklyLoad)).toEqual([10, 30, 60, 100, 150, 210, 280]);
  });

  it('n’a aucun point complet sur une série de moins de sept jours', () => {
    const series = computeMonotonySeries(week([10, 20, 30, 40, 50, 60]));

    expect(series).toHaveLength(6);
    expect(series.every((point) => point.monotony === null)).toBe(true);
  });

  it('fait glisser la fenêtre sur les sept derniers jours, pas depuis le début', () => {
    // Huit jours : le point du 8 ne doit plus voir la charge du 1er.
    const series = computeMonotonySeries(week([700, 0, 0, 0, 0, 0, 0, 700]));

    expect(series).toHaveLength(8);
    // Fenêtre du 7 : [700, 0, 0, 0, 0, 0, 0] → 1/√6 (cf. le cas à séance unique).
    expect(series[6]!.weeklyLoad).toBeCloseTo(700, 10);
    expect(series[6]!.monotony).toBeCloseTo(1 / Math.sqrt(6), 10);
    // Fenêtre du 8 : [0, 0, 0, 0, 0, 0, 700] → même forme, même monotonie.
    expect(series[7]!.weeklyLoad).toBeCloseTo(700, 10);
    expect(series[7]!.monotony).toBeCloseTo(1 / Math.sqrt(6), 10);
  });

  it('densifie les jours manquants entre deux séances', () => {
    const series = computeMonotonySeries([
      { date: '2026-01-01', trimp: 100 },
      { date: '2026-01-08', trimp: 100 },
    ]);

    expect(series.map((point) => point.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
    ]);

    // Fenêtre du 7 : [100, 0, 0, 0, 0, 0, 0] → une seule séance dans la semaine.
    expect(series[6]!.weeklyLoad).toBeCloseTo(100, 10);
    expect(series[6]!.monotony).toBeCloseTo(1 / Math.sqrt(6), 10);
  });

  it('trie l’entrée et rend des dates croissantes', () => {
    const series = computeMonotonySeries([
      { date: '2026-03-03', trimp: 40 },
      { date: '2026-03-01', trimp: 100 },
      { date: '2026-03-02', trimp: 60 },
    ]);

    expect(series.map((point) => point.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(series.map((point) => point.weeklyLoad)).toEqual([100, 160, 200]);
  });

  it('somme les séances d’une même journée', () => {
    const doubled = computeMonotonySeries([
      ...week([0, 100, 0, 100, 0, 100, 0]),
      { date: '2026-01-02', trimp: 40 },
    ]).at(-1)!;
    const merged = lastOfWeek([0, 140, 0, 100, 0, 100, 0]);

    expect(doubled.weeklyLoad).toBeCloseTo(340, 10);
    expect(doubled.monotony).toBeCloseTo(merged.monotony!, 10);
  });

  it('traverse les frontières de mois et les années bissextiles', () => {
    const series = computeMonotonySeries([
      { date: '2028-02-27', trimp: 30 },
      { date: '2028-03-01', trimp: 30 },
    ]);

    expect(series.map((point) => point.date)).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('ignore les entrées dont la date n’est pas une date calendaire', () => {
    expect(computeMonotonySeries([{ date: 'pas-une-date', trimp: 100 }])).toEqual([]);
    expect(computeMonotonySeries([{ date: '2026-02-30', trimp: 100 }])).toEqual([]);
    expect(computeMonotonySeries([{ date: '2026-1-1', trimp: 100 }])).toEqual([]);

    const series = computeMonotonySeries([
      { date: '2026-01-01', trimp: 100 },
      { date: '2026-13-01', trimp: 999 },
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]!.weeklyLoad).toBe(100);
  });

  it('compte 0 pour une charge non finie ou négative', () => {
    const series = computeMonotonySeries(
      week([Number.NaN, 100, Number.POSITIVE_INFINITY, -50, 0, 0, 0]),
    );
    const point = series.at(-1)!;

    // Charges ramenées à [0, 100, 0, 0, 0, 0, 0] : une séance unique, 1/√6.
    expect(point.weeklyLoad).toBe(100);
    expect(point.monotony).toBeCloseTo(1 / Math.sqrt(6), 10);
    expect(point.strain).toBeCloseTo(100 / Math.sqrt(6), 10);
  });

  it('vérifie l’identité contrainte = charge × monotonie sur tous les points', () => {
    const series = computeMonotonySeries(week([30, 0, 120, 45, 0, 60, 200, 0, 90, 150]));

    expect(series).toHaveLength(10);
    for (const point of series) {
      if (point.monotony === null) {
        expect(point.strain).toBeNull();
        continue;
      }
      expect(point.strain).toBeCloseTo(point.weeklyLoad * point.monotony, 10);
    }
  });

  it('ne rend que des valeurs finies', () => {
    const series = computeMonotonySeries(week([0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0]));

    for (const point of series) {
      expect(Number.isFinite(point.weeklyLoad)).toBe(true);
      if (point.monotony !== null) expect(Number.isFinite(point.monotony)).toBe(true);
      if (point.strain !== null) expect(Number.isFinite(point.strain)).toBe(true);
    }
  });
});
