import { describe, expect, it, vi } from 'vitest';

import {
  InvalidElevationCorrectionError,
  validateElevationCorrection,
} from './elevation-correction';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Bornes du réglage de correction d'altitude.
 *
 * La Server Action valide déjà avec Zod pour rendre un message par champ ; ce
 * contrôle-ci existe parce qu'elle n'est pas la seule porte d'entrée possible du
 * DAL. Un coefficient absurde ne doit pas pouvoir s'écrire, quel que soit
 * l'appelant.
 */
describe('validateElevationCorrection', () => {
  it('accepte les défauts de Runalyze', () => {
    expect(
      validateElevationCorrection({ enabled: true, ascentCoefM: 2, descentCoefM: -1 }),
    ).toEqual({ enabled: true, ascentCoefM: 2, descentCoefM: -1 });
  });

  it('arrondit au centième — c’est un réglage, pas une constante physique', () => {
    expect(
      validateElevationCorrection({ enabled: true, ascentCoefM: 2.4567, descentCoefM: -1.4321 }),
    ).toEqual({ enabled: true, ascentCoefM: 2.46, descentCoefM: -1.43 });
  });

  it('accepte zéro des deux côtés : ne corriger que dans un sens est un réglage', () => {
    expect(
      validateElevationCorrection({ enabled: true, ascentCoefM: 2, descentCoefM: 0 }),
    ).toMatchObject({ descentCoefM: 0 });
  });

  it('refuse une montée qui raccourcirait la course', () => {
    expect(() =>
      validateElevationCorrection({ enabled: true, ascentCoefM: -1, descentCoefM: -1 }),
    ).toThrowError(InvalidElevationCorrectionError);
  });

  it('refuse une descente qui la rallongerait', () => {
    expect(() =>
      validateElevationCorrection({ enabled: true, ascentCoefM: 2, descentCoefM: 1 }),
    ).toThrowError(InvalidElevationCorrectionError);
  });

  it.each([
    ['montée hors bornes', { enabled: true, ascentCoefM: 42, descentCoefM: -1 }],
    ['descente hors bornes', { enabled: true, ascentCoefM: 2, descentCoefM: -42 }],
    ['montée NaN', { enabled: true, ascentCoefM: Number.NaN, descentCoefM: -1 }],
    [
      'descente infinie',
      { enabled: true, ascentCoefM: 2, descentCoefM: Number.NEGATIVE_INFINITY },
    ],
  ])('refuse une valeur aberrante (%s)', (_label, input) => {
    expect(() => validateElevationCorrection(input)).toThrowError(
      InvalidElevationCorrectionError,
    );
  });

  it('nomme le champ fautif, pour que le formulaire place son message', () => {
    try {
      validateElevationCorrection({ enabled: true, ascentCoefM: 2, descentCoefM: 5 });
      expect.unreachable('la validation aurait dû refuser ce coefficient');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidElevationCorrectionError);
      expect((error as InvalidElevationCorrectionError).field).toBe('descentCoefM');
    }
  });

  it('ne juge pas les coefficients d’un réglage désactivé différemment', () => {
    // Décocher la case ne rend pas une valeur absurde acceptable : elle serait
    // relue telle quelle le jour où la case est recochée.
    expect(() =>
      validateElevationCorrection({ enabled: false, ascentCoefM: 99, descentCoefM: -1 }),
    ).toThrowError(InvalidElevationCorrectionError);
  });
});
