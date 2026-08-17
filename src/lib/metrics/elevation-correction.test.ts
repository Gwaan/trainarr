import { describe, expect, it } from 'vitest';

import {
  correctedDistanceM,
  DEFAULT_ASCENT_COEF_M,
  DEFAULT_DESCENT_COEF_M,
} from './elevation-correction';

/**
 * Correction d'altitude de la distance — formule de Peter Greif.
 *
 * Deux propriétés sont éprouvées ici, et la seconde compte autant que la
 * première : la formule elle-même, et **le refus de corriger** quand le
 * dénivelé est inconnu. Corriger avec un dénivelé supposé nul reviendrait à
 * dire « c'était plat » d'une séance dont on ne sait rien.
 */

const GREIF = { ascentCoefM: DEFAULT_ASCENT_COEF_M, descentCoefM: DEFAULT_DESCENT_COEF_M };

describe('correctedDistanceM', () => {
  it('applique les défauts de Runalyze : +2 par mètre monté, −1 par mètre descendu', () => {
    // La séance de référence du 15/08/2026, courue en boucle : 32 m de D+ et
    // autant de D−. 2 910 + 2×32 − 1×32 = 2 942.
    expect(correctedDistanceM(2_910, { gainM: 32, lossM: 32 }, GREIF)).toBe(2_942);
  });

  it('honore des coefficients réglés autrement', () => {
    expect(
      correctedDistanceM(1_000, { gainM: 100, lossM: 50 }, { ascentCoefM: 4, descentCoefM: -2 }),
    ).toBe(1_300);
  });

  it('ne corrige pas quand la correction est désactivée', () => {
    expect(correctedDistanceM(2_910, { gainM: 32, lossM: 32 }, null)).toBeNull();
  });

  it('ne corrige pas quand le dénivelé est inconnu, d’un côté ou de l’autre', () => {
    // Un D− inconnu ne se déduit pas du D+ : supposer une boucle serait inventer
    // une donnée, et une sortie point à point ne boucle pas.
    expect(correctedDistanceM(2_910, { gainM: 32, lossM: null }, GREIF)).toBeNull();
    expect(correctedDistanceM(2_910, { gainM: null, lossM: 32 }, GREIF)).toBeNull();
    expect(correctedDistanceM(2_910, null, GREIF)).toBeNull();
  });

  it('rend une correction nulle sur un vrai plat mesuré', () => {
    // Distinct du cas précédent : ici le dénivelé est **connu** et vaut zéro.
    expect(correctedDistanceM(2_910, { gainM: 0, lossM: 0 }, GREIF)).toBe(2_910);
  });

  it('refuse les valeurs qui ne sont pas des dénivelés', () => {
    expect(correctedDistanceM(2_910, { gainM: -5, lossM: 0 }, GREIF)).toBeNull();
    expect(correctedDistanceM(2_910, { gainM: 0, lossM: -5 }, GREIF)).toBeNull();
    expect(correctedDistanceM(2_910, { gainM: Number.NaN, lossM: 0 }, GREIF)).toBeNull();
    expect(correctedDistanceM(Number.NaN, { gainM: 0, lossM: 0 }, GREIF)).toBeNull();
  });

  it('refuse une distance corrigée qui tomberait à zéro ou en dessous', () => {
    // Théorique avec les bornes en vigueur, mais une vitesse négative n'aurait
    // aucun rattrapage en aval.
    expect(
      correctedDistanceM(1_000, { gainM: 0, lossM: 2_000 }, { ascentCoefM: 2, descentCoefM: -1 }),
    ).toBeNull();
  });
});
