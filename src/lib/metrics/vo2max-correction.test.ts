import { describe, expect, it } from 'vitest';

import { estimateVdot } from './vdot';
import { estimateEffectiveVo2max } from './vo2max';
import {
  VO2MAX_CORRECTION_FACTOR_BOUNDS,
  computeVo2maxCorrection,
  isPlausibleCorrectionFactor,
  type RaceCalibrationInput,
} from './vo2max-correction';

/**
 * Le facteur correctif est un **rapport de deux calculs déjà testés** : ce
 * fichier vérifie la mécanique qui les compare (le maximum, les bornes, les
 * causes d'indisponibilité, la primauté du manuel), pas les deux formules — qui
 * ont leurs propres tests dans `./vdot` et `./vo2max`.
 *
 * D'où les attentes exprimées **contre les fonctions sources** partout où c'est
 * un rapport qui est en jeu : réécrire les valeurs à la main ne prouverait que
 * la capacité de l'auteur à recopier, et figerait un chiffre qu'une correction
 * légitime des formules ferait échouer sans qu'il y ait de bug ici.
 */

const MAX_HR = 195;

/** Un 10 km couru à FC réaliste : le cas nominal. */
function race(overrides: Partial<RaceCalibrationInput> = {}): RaceCalibrationInput {
  return {
    raceId: 1,
    racedOn: '2026-04-12',
    name: '10 km de Bordeaux',
    distanceM: 10_000,
    timeS: 2_700,
    avgHrBpm: 178,
    ...overrides,
  };
}

/** Le rapport attendu pour une course, recalculé depuis les deux sources. */
function expectedFactor(input: RaceCalibrationInput, maxHrBpm = MAX_HR): number {
  // Les mêmes entrées des deux côtés, dénivelé compris : c'est le contrat du
  // rapport, et l'écrire ici évite qu'un défaut d'un seul côté passe pour une
  // valeur attendue.
  const timeVo2max = estimateVdot({
    distanceM: input.distanceM,
    movingTimeS: input.timeS,
    elevation: input.elevation ?? null,
  });
  const hrVo2max = estimateEffectiveVo2max({
    distanceM: input.distanceM,
    movingTimeS: input.timeS,
    avgHrBpm: input.avgHrBpm,
    maxHrBpm,
    elevation: input.elevation ?? null,
  });

  if (timeVo2max === null || hrVo2max === null) {
    throw new Error('La course de test devait produire deux estimations.');
  }
  return timeVo2max / hrVo2max;
}

describe('computeVo2maxCorrection — sans course', () => {
  it('vaut 1, et le dit : il n’y a rien à recaler', () => {
    const correction = computeVo2maxCorrection({ races: [], maxHrBpm: MAX_HR });

    expect(correction.factor).toBe(1);
    expect(correction.source).toBe('default');
    expect(correction.automatic.calibratedOn).toBeNull();
    expect(correction.automatic.unavailable).toBe('no-race');
  });

  it('distingue « pas de course » de « des courses, mais aucune avec FC »', () => {
    const correction = computeVo2maxCorrection({
      races: [race({ avgHrBpm: null }), race({ raceId: 2, avgHrBpm: null })],
      maxHrBpm: MAX_HR,
    });

    expect(correction.factor).toBe(1);
    expect(correction.automatic.unavailable).toBe('no-race-with-heart-rate');
    expect(correction.automatic.races.map((entry) => entry.status)).toEqual([
      'no-heart-rate',
      'no-heart-rate',
    ]);
  });

  it('garde la VO₂max au chrono d’une course sans FC : elle est connue, elle ne calibre juste pas', () => {
    const [entry] = computeVo2maxCorrection({
      races: [race({ avgHrBpm: null })],
      maxHrBpm: MAX_HR,
    }).automatic.races;

    expect(entry.timeVo2max).not.toBeNull();
    expect(entry.hrVo2max).toBeNull();
    expect(entry.factor).toBeNull();
  });
});

describe('computeVo2maxCorrection — calibration', () => {
  it('rend le rapport des deux estimations, et la course qui l’a produit', () => {
    const nominal = race();
    const correction = computeVo2maxCorrection({ races: [nominal], maxHrBpm: MAX_HR });

    expect(correction.source).toBe('race');
    expect(correction.factor).toBeCloseTo(expectedFactor(nominal), 10);
    expect(correction.automatic.calibratedOn?.raceId).toBe(1);
    expect(correction.automatic.calibratedOn?.name).toBe('10 km de Bordeaux');
    expect(correction.automatic.unavailable).toBeNull();
  });

  it('expose les deux VO₂max comparées — un « 1,11 » sans origine est inexploitable', () => {
    const calibration = computeVo2maxCorrection({ races: [race()], maxHrBpm: MAX_HR }).automatic
      .calibratedOn;

    expect(calibration).not.toBeNull();
    expect(calibration!.timeVo2max).toBeCloseTo(
      estimateVdot({ distanceM: 10_000, movingTimeS: 2_700 })!,
      10,
    );
    expect(calibration!.hrVo2max).toBeCloseTo(
      estimateEffectiveVo2max({
        distanceM: 10_000,
        movingTimeS: 2_700,
        avgHrBpm: 178,
        maxHrBpm: MAX_HR,
      })!,
      10,
    );
    expect(calibration!.factor).toBeCloseTo(
      calibration!.timeVo2max! / calibration!.hrVo2max!,
      10,
    );
  });

  it('retient le maximum, pas la moyenne ni la dernière', () => {
    // La même course, courue à deux FC : celle qui tourne le plus haut lit le
    // plus bas par la FC, donc produit le rapport le plus grand.
    const lowHr = race({ raceId: 1, avgHrBpm: 168 });
    const highHr = race({ raceId: 2, racedOn: '2026-06-01', avgHrBpm: 188 });

    const correction = computeVo2maxCorrection({
      races: [lowHr, highHr],
      maxHrBpm: MAX_HR,
    });

    expect(expectedFactor(highHr)).toBeGreaterThan(expectedFactor(lowHr));
    expect(correction.automatic.calibratedOn?.raceId).toBe(2);
    expect(correction.factor).toBeCloseTo(expectedFactor(highHr), 10);
  });

  it('n’injecte pas le facteur dans son propre dénominateur', () => {
    // Le calcul serait circulaire : la VO₂max par la FC d'une course doit être
    // la valeur **non recalée**, exactement celle qu'`estimateEffectiveVo2max`
    // rend sans facteur.
    const calibration = computeVo2maxCorrection({
      races: [race()],
      maxHrBpm: MAX_HR,
      manualFactor: 1.3,
    }).automatic.calibratedOn;

    expect(calibration!.hrVo2max).toBeCloseTo(
      estimateEffectiveVo2max({
        distanceM: 10_000,
        movingTimeS: 2_700,
        avgHrBpm: 178,
        maxHrBpm: MAX_HR,
      })!,
      10,
    );
  });

  it('applique la correction d’altitude aux deux estimations comparées', () => {
    const hilly = race({ elevation: { gainM: 220, lossM: 220 } });
    const greif = { ascentCoefM: 2, descentCoefM: -1 };

    const calibration = computeVo2maxCorrection({
      races: [hilly],
      maxHrBpm: MAX_HR,
      elevationCorrection: greif,
    }).automatic.calibratedOn;

    // Le dénivelé va au numérateur **comme** au dénominateur : c'est ce qui le
    // fait sortir du rapport. Ne le donner qu'à l'un des deux (la première
    // version le réservait au dénominateur) l'y faisait entrer, et tirait le
    // facteur d'autant plus bas que la course était vallonnée.
    expect(calibration!.timeVo2max).toBeCloseTo(
      estimateVdot({
        distanceM: hilly.distanceM,
        movingTimeS: hilly.timeS,
        elevation: hilly.elevation,
        elevationCorrection: greif,
      })!,
      10,
    );
    expect(calibration!.hrVo2max).toBeCloseTo(
      estimateEffectiveVo2max({
        distanceM: hilly.distanceM,
        movingTimeS: hilly.timeS,
        avgHrBpm: hilly.avgHrBpm,
        maxHrBpm: MAX_HR,
        elevation: hilly.elevation,
        elevationCorrection: greif,
      })!,
      10,
    );
  });

  it('ne bouge presque pas quand le terrain change, une fois corrigé des deux côtés', () => {
    // Le cas chiffré de la revue : semi de 21,1 km en 2 h, D+ 600 / D− 600,
    // FC moyenne 160 pour 195 de FC max. Distance équivalente de Greif :
    // 21 100 + 2 × 600 − 1 × 600 = 21 700 m.
    //
    // Numérateur 37,8 / dénominateur 44,3 → **0,853**. C'est le chiffre de
    // non-régression : avec la correction au seul dénominateur, le numérateur
    // tombait à 36,4 et le facteur à 0,823 — 3,4 % plus bas, soit ≈ 1,3 point de
    // VO₂max à 40, et toujours dans le même sens.
    const trail = race({
      distanceM: 21_100,
      timeS: 7_200,
      avgHrBpm: 160,
      elevation: { gainM: 600, lossM: 600 },
    });

    const correction = computeVo2maxCorrection({
      races: [trail],
      maxHrBpm: MAX_HR,
      elevationCorrection: { ascentCoefM: 2, descentCoefM: -1 },
    });

    expect(correction.automatic.calibratedOn?.timeVo2max).toBeCloseTo(37.8, 1);
    expect(correction.automatic.calibratedOn?.hrVo2max).toBeCloseTo(44.3, 1);
    expect(correction.factor).toBeCloseTo(0.853, 3);
  });

  it('juge la représentativité sur la distance courue, jamais sur l’équivalente', () => {
    // 1 400 m de côte : Greif les compte 2 600 (1 400 + 2 × 600), mais l'effort
    // reste sous le plancher de 1 500 m des deux côtés du rapport. Une bosse
    // n'allonge pas une séance.
    const shortClimb = race({
      distanceM: 1_400,
      timeS: 600,
      elevation: { gainM: 600, lossM: 0 },
    });

    const correction = computeVo2maxCorrection({
      races: [shortClimb],
      maxHrBpm: MAX_HR,
      elevationCorrection: { ascentCoefM: 2, descentCoefM: -1 },
    });

    expect(correction.automatic.races[0].timeVo2max).toBeNull();
    expect(correction.automatic.races[0].hrVo2max).toBeNull();
    expect(correction.automatic.races[0].status).toBe('not-computable');
  });
});

describe('computeVo2maxCorrection — bornes', () => {
  it('borne la plage à [0,70 ; 1,40], symétrique en rapport', () => {
    expect(VO2MAX_CORRECTION_FACTOR_BOUNDS).toEqual({ min: 0.7, max: 1.4 });
    // Un facteur et son inverse doivent être également suspects : les bornes
    // sont symétriques *en rapport*, à moins de deux centièmes près.
    expect(
      Math.abs(1 / VO2MAX_CORRECTION_FACTOR_BOUNDS.max - VO2MAX_CORRECTION_FACTOR_BOUNDS.min),
    ).toBeLessThan(0.02);
    expect(isPlausibleCorrectionFactor(1.128)).toBe(true);
    expect(isPlausibleCorrectionFactor(3)).toBe(false);
    expect(isPlausibleCorrectionFactor(Number.NaN)).toBe(false);
  });

  it('écarte une course dont la ceinture a lu trop bas, sans la taire', () => {
    // 10 km en 45:00 à 120 bpm pour 195 de FC max : la FC sous-lue gonfle la
    // VO₂max par la FC, le rapport tombe vers 0,55.
    const broken = race({ timeS: 2_700, avgHrBpm: 120 });
    const correction = computeVo2maxCorrection({ races: [broken], maxHrBpm: MAX_HR });

    const [entry] = correction.automatic.races;
    expect(entry.status).toBe('out-of-bounds');
    // Le rapport reste lisible : c'est ce qui permet d'expliquer le rejet.
    expect(entry.factor).not.toBeNull();
    expect(entry.factor!).toBeLessThan(VO2MAX_CORRECTION_FACTOR_BOUNDS.min);

    expect(correction.factor).toBe(1);
    expect(correction.automatic.unavailable).toBe('no-usable-race');
  });

  it('écarte la course aberrante du maximum au lieu de la ramener à la borne', () => {
    // C'est tout l'enjeu de la sémantique du maximum : ramenée à 1,40, la
    // course cassée dominerait encore la course saine. Écartée, elle rend la
    // main.
    const nominal = race({ raceId: 1 });
    const broken = race({ raceId: 2, avgHrBpm: 120 });

    const correction = computeVo2maxCorrection({
      races: [nominal, broken],
      maxHrBpm: MAX_HR,
    });

    expect(correction.automatic.calibratedOn?.raceId).toBe(1);
    expect(correction.factor).toBeCloseTo(expectedFactor(nominal), 10);
  });

  it('ne triple jamais les VO₂max sur un chrono saisi en minutes', () => {
    // 10 km « en 45 » compris comme 45 secondes : la vitesse sort du domaine de
    // Daniels & Gilbert, la course ne produit aucune estimation au chrono.
    const typo = race({ timeS: 45 });
    const correction = computeVo2maxCorrection({ races: [typo], maxHrBpm: MAX_HR });

    expect(correction.automatic.races[0].status).toBe('not-computable');
    expect(correction.factor).toBe(1);
  });

  it('ne calibre pas sur un effort trop court pour le modèle', () => {
    const sprint = race({ distanceM: 800, timeS: 150 });

    expect(
      computeVo2maxCorrection({ races: [sprint], maxHrBpm: MAX_HR }).automatic.races[0].status,
    ).toBe('not-computable');
  });

  it('ne calibre pas sans FC max au profil : il n’y a pas de dénominateur', () => {
    const correction = computeVo2maxCorrection({ races: [race()], maxHrBpm: null });

    expect(correction.automatic.races[0].hrVo2max).toBeNull();
    expect(correction.automatic.races[0].status).toBe('not-computable');
    expect(correction.factor).toBe(1);
  });
});

describe('computeVo2maxCorrection — facteur manuel', () => {
  it('prend le pas sur l’automatique, sans l’effacer', () => {
    const correction = computeVo2maxCorrection({
      races: [race()],
      maxHrBpm: MAX_HR,
      manualFactor: 1.05,
    });

    expect(correction.factor).toBe(1.05);
    expect(correction.source).toBe('manual');
    expect(correction.manualFactor).toBe(1.05);
    // Ce qu'il écrase reste lisible : sans ça, l'écran de réglage ne pourrait
    // pas montrer ce que l'athlète remplace.
    expect(correction.automatic.factor).toBeCloseTo(expectedFactor(race()), 10);
    expect(correction.automatic.calibratedOn?.raceId).toBe(1);
  });

  it('s’applique même sans aucune course', () => {
    const correction = computeVo2maxCorrection({
      races: [],
      maxHrBpm: MAX_HR,
      manualFactor: 0.95,
    });

    expect(correction.factor).toBe(0.95);
    expect(correction.source).toBe('manual');
    expect(correction.automatic.unavailable).toBe('no-race');
  });

  it.each([
    ['hors bornes', 3],
    ['nul', 0],
    ['NaN', Number.NaN],
  ])('ignore un facteur manuel %s et retombe sur le calcul', (_label, manualFactor) => {
    const correction = computeVo2maxCorrection({
      races: [race()],
      maxHrBpm: MAX_HR,
      manualFactor,
    });

    expect(correction.source).toBe('race');
    expect(correction.manualFactor).toBeNull();
    expect(correction.factor).toBeCloseTo(expectedFactor(race()), 10);
  });

  it('traite `null` comme « automatique », jamais comme 1', () => {
    const correction = computeVo2maxCorrection({
      races: [race()],
      maxHrBpm: MAX_HR,
      manualFactor: null,
    });

    expect(correction.source).toBe('race');
    expect(correction.factor).not.toBe(1);
  });
});
