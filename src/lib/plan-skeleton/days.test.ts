import { describe, expect, it } from 'vitest';

import { placeSessionDays, type SessionDayPlacement } from './days';

const DAYS_PER_WEEK = 7;

function circularGap(day: number, other: number): number {
  const gap = Math.abs(day - other);
  return Math.min(gap, DAYS_PER_WEEK - gap);
}

/** Tous les jours posés, rôles confondus. */
function allDays(placement: SessionDayPlacement): number[] {
  return [
    ...(placement.longRunDay === null ? [] : [placement.longRunDay]),
    ...placement.qualityDays,
    ...placement.easyDays,
  ].sort((left, right) => left - right);
}

/** Le plus petit écart entre deux jours durs — l'infini quand il n'y en a qu'un. */
function smallestHardGap(placement: SessionDayPlacement): number {
  const hard = [
    ...(placement.longRunDay === null ? [] : [placement.longRunDay]),
    ...placement.qualityDays,
  ];
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < hard.length; index += 1) {
    for (let other = index + 1; other < hard.length; other += 1) {
      smallest = Math.min(smallest, circularGap(hard[index], hard[other]));
    }
  }
  return smallest;
}

describe('placeSessionDays', () => {
  it('pose les qualités le mardi et le jeudi derrière une sortie longue du samedi', () => {
    const placement = placeSessionDays({
      sessionsPerWeek: 5,
      longRunDay: 6,
      qualityCount: 2,
      fromDay: 1,
      toDay: 7,
    });

    expect(placement.longRunDay).toBe(6);
    expect(placement.qualityDays).toEqual([2, 4]);
  });

  it('pose exactement le nombre de séances demandé, un jour chacune', () => {
    for (let sessionsPerWeek = 1; sessionsPerWeek <= 7; sessionsPerWeek += 1) {
      const placement = placeSessionDays({
        sessionsPerWeek,
        longRunDay: 7,
        qualityCount: Math.min(2, Math.max(0, sessionsPerWeek - 2)),
        fromDay: 1,
        toDay: 7,
      });
      const days = allDays(placement);
      expect(days, `${sessionsPerWeek} séances`).toHaveLength(sessionsPerWeek);
      expect(new Set(days).size, `${sessionsPerWeek} séances`).toBe(sessionsPerWeek);
    }
  });

  /*
   * La règle de fond : deux séances dures ne s'enchaînent pas. Elle tient sur
   * toute semaine pleine, jusqu'à sept séances — les footings, eux, peuvent
   * s'accoler à ce qu'ils veulent.
   */
  it('n’enchaîne jamais deux jours durs sur une semaine pleine', () => {
    for (let sessionsPerWeek = 3; sessionsPerWeek <= 7; sessionsPerWeek += 1) {
      for (let longRunDay = 1; longRunDay <= 7; longRunDay += 1) {
        for (const qualityCount of [1, 2]) {
          const placement = placeSessionDays({
            sessionsPerWeek,
            longRunDay,
            qualityCount,
            fromDay: 1,
            toDay: 7,
          });
          expect(
            smallestHardGap(placement),
            `${sessionsPerWeek} séances, sortie longue jour ${longRunDay}, ${qualityCount} qualité(s)`,
          ).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  /*
   * Le cas type que le déroulé glouton ratait : il posait une qualité le
   * lendemain de la sortie longue alors que la semaine offrait mieux.
   */
  it('n’accole pas une qualité à la sortie longue quand un autre placement l’évite', () => {
    const placement = placeSessionDays({
      sessionsPerWeek: 5,
      longRunDay: 3,
      qualityCount: 2,
      fromDay: 3,
      toDay: 7,
    });

    expect(placement.longRunDay).toBe(3);
    // Le glouton posait [4, 6] — le mercredi de la sortie longue suivi du jeudi.
    expect(placement.qualityDays).toEqual([5, 7]);
    expect(smallestHardGap(placement)).toBeGreaterThanOrEqual(2);
  });

  /*
   * L'optimalité, prouvée par force brute sur toute la grille.
   *
   * Le déroulé glouton d'avant ne l'atteignait pas : sur les 1 372 cellules,
   * 22 accolaient deux jours durs alors qu'un autre placement les espaçait tous
   * — toutes avec une reprise en cours de semaine, donc hors de ce que
   * `buildPlanSkeleton` produit aujourd'hui, mais `placeSessionDays` est
   * exporté. Le test énumère ce que le module énumère, et vérifie qu'il n'existe
   * aucun placement strictement mieux espacé.
   */
  it('pose les jours de qualité au mieux possible, pas au mieux pas à pas', () => {
    /** Toutes les façons de choisir `count` jours parmi `free`. */
    const combinations = (free: readonly number[], count: number): number[][] => {
      if (count <= 0) return [[]];
      const out: number[][] = [];
      for (let index = 0; index <= free.length - count; index += 1) {
        for (const rest of combinations(free.slice(index + 1), count - 1)) {
          out.push([free[index], ...rest]);
        }
      }
      return out;
    };

    const smallestGap = (days: readonly number[]): number => {
      let smallest = Number.POSITIVE_INFINITY;
      for (let index = 0; index < days.length; index += 1) {
        for (let other = index + 1; other < days.length; other += 1) {
          smallest = Math.min(smallest, circularGap(days[index], days[other]));
        }
      }
      return smallest;
    };

    for (let sessionsPerWeek = 1; sessionsPerWeek <= 7; sessionsPerWeek += 1) {
      for (let longRunDay = 1; longRunDay <= 7; longRunDay += 1) {
        for (let fromDay = 1; fromDay <= 7; fromDay += 1) {
          for (let qualityCount = 0; qualityCount <= 3; qualityCount += 1) {
            const where = `${sessionsPerWeek} séances, sortie longue jour ${longRunDay}, reprise jour ${fromDay}, ${qualityCount} qualité(s)`;
            const placement = placeSessionDays({
              sessionsPerWeek,
              longRunDay,
              qualityCount,
              fromDay,
              toDay: 7,
            });

            const free: number[] = [];
            for (let day = fromDay; day <= DAYS_PER_WEEK; day += 1) free.push(day);
            const sessionCount = Math.min(sessionsPerWeek, free.length);
            const anchor = placement.longRunDay === null ? [] : [placement.longRunDay];
            const pool = free.filter((day) => !anchor.includes(day));
            const wanted = Math.min(qualityCount, Math.max(0, sessionCount - anchor.length));

            // Le module en pose bien autant qu'il pouvait en poser.
            expect(placement.qualityDays.length, where).toBe(Math.min(wanted, pool.length));

            const best = combinations(pool, Math.min(wanted, pool.length)).reduce(
              (widest, candidate) => Math.max(widest, smallestGap([...anchor, ...candidate])),
              -1,
            );
            expect(smallestGap([...anchor, ...placement.qualityDays]), where).toBe(best);
          }
        }
      }
    }
  });

  it('est déterministe : mêmes paramètres, même semaine', () => {
    for (let sessionsPerWeek = 1; sessionsPerWeek <= 7; sessionsPerWeek += 1) {
      for (let longRunDay = 1; longRunDay <= 7; longRunDay += 1) {
        for (let fromDay = 1; fromDay <= 7; fromDay += 1) {
          const params = { sessionsPerWeek, longRunDay, qualityCount: 2, fromDay, toDay: 7 };
          expect(placeSessionDays(params)).toEqual(placeSessionDays(params));
        }
      }
    }
  });

  describe('sur une première semaine entamée', () => {
    it('ne place jamais de séance avant le jour de reprise', () => {
      for (let fromDay = 1; fromDay <= 7; fromDay += 1) {
        for (let longRunDay = 1; longRunDay <= 7; longRunDay += 1) {
          const placement = placeSessionDays({
            sessionsPerWeek: 6,
            longRunDay,
            qualityCount: 2,
            fromDay,
            toDay: 7,
          });
          for (const day of allDays(placement)) {
            expect(day, `reprise jour ${fromDay}`).toBeGreaterThanOrEqual(fromDay);
          }
        }
      }
    });

    it('plafonne le nombre de séances aux jours qui restent', () => {
      const placement = placeSessionDays({
        sessionsPerWeek: 6,
        longRunDay: 7,
        qualityCount: 2,
        fromDay: 5,
        toDay: 7,
      });
      expect(allDays(placement)).toEqual([5, 6, 7]);
    });

    it('renonce à la sortie longue quand son jour est déjà passé', () => {
      const placement = placeSessionDays({
        sessionsPerWeek: 4,
        longRunDay: 2,
        qualityCount: 0,
        fromDay: 4,
        toDay: 7,
      });
      expect(placement.longRunDay).toBeNull();
      expect(placement.easyDays).toEqual([4, 5, 6, 7]);
    });

    it('garde la sortie longue quand son jour est encore devant', () => {
      const placement = placeSessionDays({
        sessionsPerWeek: 3,
        longRunDay: 7,
        qualityCount: 0,
        fromDay: 5,
        toDay: 7,
      });
      expect(placement.longRunDay).toBe(7);
      expect(placement.easyDays).toEqual([5, 6]);
    });
  });

  /*
   * La semaine de course : le jour J ferme la semaine.
   *
   * Sans cette borne, mesuré sur un marathon un lundi à 6 séances, la semaine de
   * course portait 5 séances et 23,3 km **après** la course, dont une le
   * lendemain de l'épreuve. La borne est symétrique de celle du jour de reprise,
   * et se lit dans la même fenêtre `[fromDay, toDay]`.
   */
  describe('sur la semaine de la course', () => {
    it('ne place jamais de séance après le jour J', () => {
      for (let toDay = 1; toDay <= 7; toDay += 1) {
        const placement = placeSessionDays({
          sessionsPerWeek: 6,
          longRunDay: toDay,
          qualityCount: 0,
          fromDay: 1,
          toDay,
        });
        for (const day of allDays(placement)) {
          expect(day, `jour J ${toDay}`).toBeLessThanOrEqual(toDay);
        }
        // Le jour J lui-même reste porté : c'est la course.
        expect(placement.longRunDay, `jour J ${toDay}`).toBe(toDay);
      }
    });

    it('plafonne le nombre de séances aux jours qui précèdent le jour J', () => {
      const placement = placeSessionDays({
        sessionsPerWeek: 6,
        longRunDay: 3,
        qualityCount: 0,
        fromDay: 1,
        toDay: 3,
      });
      expect(allDays(placement)).toEqual([1, 2, 3]);
    });
  });

  it('ne place rien quand aucune séance n’est demandée', () => {
    expect(placeSessionDays({ sessionsPerWeek: 0, longRunDay: 7, qualityCount: 2, fromDay: 1, toDay: 7 }))
      .toEqual({ longRunDay: null, qualityDays: [], easyDays: [] });
  });
});
