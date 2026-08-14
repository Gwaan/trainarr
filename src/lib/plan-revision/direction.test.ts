import { describe, expect, it } from 'vitest';

import {
  PLAN_REVISION_NEUTRAL_BAND,
  planRevisionDirection,
  planRevisionTotals,
  type PlanRevisionTotals,
} from './direction';

const EASY = 'Endurance fondamentale';
const THRESHOLD = 'Seuil';
const INTERVAL = 'VMA courte · piste';
const LONG = 'Sortie longue';

describe('planRevisionTotals', () => {
  it('somme les volumes annoncés, en kilomètres', () => {
    expect(
      planRevisionTotals([
        { kind: EASY, volumeM: 8_000 },
        { kind: LONG, volumeM: 14_500 },
      ]),
    ).toEqual({ volumeKm: 22.5, intensityKm: 0 });
  });

  it("compte à part les kilomètres des séances de qualité", () => {
    expect(
      planRevisionTotals([
        { kind: EASY, volumeM: 8_000 },
        { kind: THRESHOLD, volumeM: 10_000 },
        { kind: INTERVAL, volumeM: 12_000 },
      ]),
    ).toEqual({ volumeKm: 30, intensityKm: 22 });
  });

  it('ignore une séance sans volume déclaré plutôt que de la compter à zéro', () => {
    expect(
      planRevisionTotals([
        { kind: EASY, volumeM: null },
        { kind: THRESHOLD, volumeM: 9_000 },
      ]),
    ).toEqual({ volumeKm: 9, intensityKm: 9 });
  });

  it('ne compte rien sur une fenêtre vide', () => {
    expect(planRevisionTotals([])).toEqual({ volumeKm: 0, intensityKm: 0 });
  });

  it("range une sortie longue spécifique en endurance, comme le reste de l'appli", () => {
    // Le motif d'intensité est celui de `plan-schema` : « spécifique » se range
    // en allure course, pas en qualité — deux définitions auraient divergé.
    expect(planRevisionTotals([{ kind: 'Sortie longue spécifique', volumeM: 20_000 }])).toEqual({
      volumeKm: 20,
      intensityKm: 0,
    });
  });
});

/** Une fenêtre décrite par ses deux totaux. */
function totals(volumeKm: number, intensityKm: number): PlanRevisionTotals {
  return { volumeKm, intensityKm };
}

describe('planRevisionDirection', () => {
  it('lit une hausse de volume comme une hausse de charge', () => {
    expect(planRevisionDirection(totals(40, 8), totals(46, 8))).toBe('increase');
  });

  it('lit une baisse de volume comme une baisse de charge', () => {
    expect(planRevisionDirection(totals(42, 8), totals(36, 8))).toBe('decrease');
  });

  it('ne bouge pas dans la bande de neutralité', () => {
    // 40 → 40,7 : +1,75 %, sous les 2 % — l'écart d'un arrondi de séance.
    expect(planRevisionDirection(totals(40, 8), totals(40.7, 8))).toBe('neutral');
    expect(planRevisionDirection(totals(40, 8), totals(39.3, 8))).toBe('neutral');
  });

  it('tranche juste au-delà de la bande', () => {
    const above = 40 * (1 + PLAN_REVISION_NEUTRAL_BAND) + 0.01;
    const below = 40 * (1 - PLAN_REVISION_NEUTRAL_BAND) - 0.01;
    expect(planRevisionDirection(totals(40, 8), totals(above, 8))).toBe('increase');
    expect(planRevisionDirection(totals(40, 8), totals(below, 8))).toBe('decrease');
  });

  it("laisse l'intensité départager quand le kilométrage ne bouge pas", () => {
    expect(planRevisionDirection(totals(40, 6), totals(40, 9))).toBe('increase');
    expect(planRevisionDirection(totals(40, 9), totals(40, 6))).toBe('decrease');
  });

  it("laisse le volume primer sur l'intensité quand les deux bougent en sens contraire", () => {
    // Moins de kilomètres, plus de qualité : c'est le volume que l'athlète
    // ressent en premier, et c'est lui qui nomme la révision.
    expect(planRevisionDirection(totals(50, 6), totals(40, 9))).toBe('decrease');
  });

  it('appelle « ajustement » une réécriture qui ne change aucun des deux totaux', () => {
    expect(planRevisionDirection(totals(40, 8), totals(40, 8))).toBe('neutral');
  });

  it("compte comme une hausse l'apparition d'un volume là où il n'y en avait aucun", () => {
    expect(planRevisionDirection(totals(0, 0), totals(30, 6))).toBe('increase');
    expect(planRevisionDirection(totals(40, 0), totals(40, 5))).toBe('increase');
  });

  it("ne compte pas comme une baisse une fenêtre vide des deux côtés", () => {
    expect(planRevisionDirection(totals(0, 0), totals(0, 0))).toBe('neutral');
  });

  it('compte comme une baisse la disparition de tout le volume', () => {
    expect(planRevisionDirection(totals(40, 8), totals(0, 0))).toBe('decrease');
  });
});
