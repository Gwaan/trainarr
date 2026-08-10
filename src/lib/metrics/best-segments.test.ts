import { describe, expect, it } from 'vitest';

import { BEST_SEGMENT_TARGETS_M, computeBestSegments } from './best-segments';

/** Séance à 1 Hz : `t = 0..count-1`, distance cumulée depuis une vitesse. */
function run(count: number, speedAt: (second: number) => number) {
  const time: number[] = [];
  const distance: number[] = [];
  let cumulated = 0;
  for (let second = 0; second < count; second += 1) {
    time.push(second);
    distance.push(cumulated);
    cumulated += speedAt(second);
  }
  return { time, distance };
}

/** Temps du segment de la distance cible, `null` s'il n'a pas été calculé. */
function timeOf(segments: { targetM: number; timeS: number }[], targetM: number): number | null {
  return segments.find((segment) => segment.targetM === targetM)?.timeS ?? null;
}

describe('computeBestSegments', () => {
  it('rend les distances de référence attendues', () => {
    expect(BEST_SEGMENT_TARGETS_M).toEqual([400, 1000, 1609.34, 5000, 10000, 21097.5]);
  });

  it('mesure chaque cible à allure constante', () => {
    // 4 m/s pendant 1 000 s : 3 996 m au total.
    const { time, distance } = run(1000, () => 4);
    const segments = computeBestSegments(distance, time);

    expect(segments.map((segment) => segment.targetM)).toEqual([400, 1000, 1609.34]);
    expect(timeOf(segments, 400)).toBeCloseTo(100, 9);
    expect(timeOf(segments, 1000)).toBeCloseTo(250, 9);
    expect(timeOf(segments, 1609.34)).toBeCloseTo(402.335, 9);
    // 4 m/s = 250 s/km, quelle que soit la cible.
    for (const segment of segments) {
      expect(segment.paceSecPerKm).toBeCloseTo(250, 9);
    }
  });

  it('trouve la portion la plus rapide, pas la première venue', () => {
    // 500 s à 3 m/s, 200 s à 5 m/s (soit exactement 1 000 m), puis 300 s à 3 m/s.
    const { time, distance } = run(1000, (second) => (second >= 500 && second < 700 ? 5 : 3));
    const segments = computeBestSegments(distance, time);

    expect(timeOf(segments, 1000)).toBeCloseTo(200, 6);
  });

  it('interpole les bornes au lieu de mesurer la distance suivante', () => {
    // Points toutes les 10 s à 3,3 m/s : 33 m entre deux points. Sans
    // interpolation, le « 1 000 m » serait en réalité un 1 023 m (310 s).
    const time: number[] = [];
    const distance: number[] = [];
    for (let point = 0; point < 100; point += 1) {
      time.push(point * 10);
      distance.push(point * 33);
    }

    const segments = computeBestSegments(distance, time);
    expect(timeOf(segments, 1000)).toBeCloseTo(1000 / 3.3, 6);
  });

  it('compte le temps écoulé, pauses comprises', () => {
    // 200 m couverts en 50 s, une minute d'arrêt, puis 200 m en 50 s : le
    // record de 400 m dure 160 s, pas les 100 s de temps en mouvement.
    const time: number[] = [];
    const distance: number[] = [];
    for (let second = 0; second <= 50; second += 1) {
      time.push(second);
      distance.push(4 * second);
    }
    time.push(110);
    distance.push(200);
    for (let second = 111; second <= 160; second += 1) {
      time.push(second);
      distance.push(200 + 4 * (second - 110));
    }

    const segments = computeBestSegments(distance, time);
    expect(segments.map((segment) => segment.targetM)).toEqual([400]);
    expect(timeOf(segments, 400)).toBeCloseTo(160, 9);
  });

  it('écarte les reculs du cumul de distance', () => {
    // Saut GPS : le cumul retombe à 0 sur un point. Laissée passer, la fenêtre
    // [396 m → 0 m → 404 m] annoncerait 400 m en une seconde ; ramenée au
    // maximum vu, elle offrirait un palier menteur et un 400 m en 99 s.
    const { time, distance } = run(200, () => 4);
    distance[100] = 0;

    const segments = computeBestSegments(distance, time);
    expect(timeOf(segments, 400)).toBeCloseTo(100, 9);
  });

  it('ne se laisse pas raccourcir par un canal de distance clairsemé', () => {
    // Distance écrite une fois toutes les 6 s (24 m à 4 m/s) sur un axe à 1 Hz.
    // Reporter la dernière distance connue sur les points muets ferait partir la
    // fenêtre cinq secondes trop tard : 400 m en 95 s, allure jamais courue.
    const time: number[] = [];
    const distance: (number | null)[] = [];
    for (let second = 0; second < 400; second += 1) {
      time.push(second);
      distance.push(second % 6 === 0 ? 4 * second : null);
    }

    const segments = computeBestSegments(distance, time);
    expect(timeOf(segments, 400)).toBeCloseTo(100, 6);
    expect(timeOf(segments, 1000)).toBeCloseTo(250, 6);
  });

  it('écarte les points sans instant exploitable', () => {
    const { time, distance } = run(200, () => 4);
    const holed: (number | null)[] = [...time];
    holed[50] = null;

    const segments = computeBestSegments(distance, holed);
    expect(timeOf(segments, 400)).toBeCloseTo(100, 9);
  });

  it('ignore un axe des temps qui recule', () => {
    const { time, distance } = run(200, () => 4);
    time[100] = 10; // horodatage aberrant

    const segments = computeBestSegments(distance, time);
    expect(timeOf(segments, 400)).toBeCloseTo(100, 9);
  });

  it('ne retient pas une cible plus longue que la séance', () => {
    const { time, distance } = run(200, () => 4); // 796 m

    expect(computeBestSegments(distance, time).map((segment) => segment.targetM)).toEqual([400]);
  });

  it('rend un tableau vide quand rien n’est calculable', () => {
    expect(computeBestSegments([], [])).toEqual([]);
    expect(computeBestSegments([0, 100, 300], [0, 30, 90])).toEqual([]);
    expect(computeBestSegments([null, null], [0, 1])).toEqual([]);
    expect(computeBestSegments([0, 500], [null, null])).toEqual([]);
    // Une séance sur tapis roulant à l'arrêt : la distance ne bouge pas.
    expect(computeBestSegments([100, 100, 100], [0, 1, 2])).toEqual([]);
  });
});
