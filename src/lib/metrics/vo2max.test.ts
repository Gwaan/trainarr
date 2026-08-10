import { describe, expect, it } from 'vitest';

import { estimateEffectiveVo2max } from './vo2max';

/**
 * Les valeurs attendues sont calculées à la main depuis la formule transcrite
 * dans `./vo2max` (source : `VO2maxCalculator.php` de Runalyze) :
 *
 *   v          = distanceM / (movingTimeS / 60)                    [m/min]
 *   fraction   = exp((avgHr / maxHr − 1.00466) / 0.68725)
 *   v100       = v / fraction
 *   VO2max     = −4.6 + 0.182258·v100 + 0.000104·v100²
 */
describe('estimateEffectiveVo2max', () => {
  it('retombe sur le cas de référence du test unitaire de Runalyze', () => {
    /*
     * `VO2maxCalculatorTest::testCalculationForSimpleActivityAtExpectedHeartRate` :
     * 10 km en 2481 s à 190 bpm pour une FC max de 200 doit donner ≈ 50 (± 0.5),
     * c'est-à-dire la même valeur que le VDOT « par le temps » de cette
     * performance — la FC de 95 % confirmant qu'elle a bien été courue à fond.
     *
     * Détail : v = 241.83797 ; fraction = exp(−0.05466 / 0.68725) = 0.9235463 ;
     * v100 = 261.85799 → VO2max = 50.2570.
     */
    const value = estimateEffectiveVo2max({
      distanceM: 10_000,
      movingTimeS: 2481,
      avgHrBpm: 190,
      maxHrBpm: 200,
    });

    expect(value).toBeCloseTo(50.257, 3);
    expect(Math.abs(value! - 50)).toBeLessThan(0.5);
  });

  it('corrige un footing facile au lieu de le prendre pour un effort maximal', () => {
    /*
     * Le bug qui a motivé ce module : 10 km/h à 65 % de FC max.
     * v = 166.66667 ; fraction = exp(−0.35466 / 0.68725) = 0.5968695 ;
     * v100 = 279.23468 → VO2max = 54.4018.
     */
    expect(
      estimateEffectiveVo2max({
        distanceM: 10_000,
        movingTimeS: 3_600,
        avgHrBpm: 130,
        maxHrBpm: 200,
      }),
    ).toBeCloseTo(54.402, 3);
  });

  it('calcule les valeurs attendues sur d’autres allures rondes', () => {
    // 12 km/h à 75 % : v = 200 ; fraction = 0.6903550 ; v100 = 289.70601.
    expect(
      estimateEffectiveVo2max({
        distanceM: 12_000,
        movingTimeS: 3_600,
        avgHrBpm: 150,
        maxHrBpm: 200,
      }),
    ).toBeCloseTo(56.930, 3);

    // 15 km/h pendant 20 min à 90 % : v = 250 ; fraction = 0.8587408 ; v100 = 291.12392.
    expect(
      estimateEffectiveVo2max({
        distanceM: 5_000,
        movingTimeS: 1_200,
        avgHrBpm: 180,
        maxHrBpm: 200,
      }),
    ).toBeCloseTo(57.274, 3);
  });

  it('donne une estimation stable quand la même forme s’exprime à deux intensités', () => {
    // Même coureur, footing puis tempo : les deux estimations doivent se tenir.
    const easy = estimateEffectiveVo2max({
      distanceM: 12_000,
      movingTimeS: 3_600,
      avgHrBpm: 150,
      maxHrBpm: 200,
    })!;
    const tempo = estimateEffectiveVo2max({
      distanceM: 5_000,
      movingTimeS: 1_200,
      avgHrBpm: 180,
      maxHrBpm: 200,
    })!;

    expect(Math.abs(easy - tempo)).toBeLessThan(1);
  });

  it('monte quand la même allure est tenue à FC plus basse', () => {
    const base = { distanceM: 10_000, movingTimeS: 2_700, maxHrBpm: 200 };
    const fresher = estimateEffectiveVo2max({ ...base, avgHrBpm: 150 })!;
    const strained = estimateEffectiveVo2max({ ...base, avgHrBpm: 175 })!;

    expect(fresher).toBeGreaterThan(strained);
  });

  it('renvoie null sans fréquence cardiaque, la correction en dépendant', () => {
    const base = { distanceM: 10_000, movingTimeS: 3_600 };

    expect(estimateEffectiveVo2max({ ...base, avgHrBpm: null, maxHrBpm: 200 })).toBeNull();
    expect(estimateEffectiveVo2max({ ...base, avgHrBpm: 130, maxHrBpm: null })).toBeNull();
    expect(estimateEffectiveVo2max({ ...base, avgHrBpm: null, maxHrBpm: null })).toBeNull();
  });

  it('renvoie null quand le rapport FC moyenne / FC max sort de [0.5, 1]', () => {
    const base = { distanceM: 10_000, movingTimeS: 3_000, maxHrBpm: 200 };

    // 99 bpm sur 200 → 0.495 : sous la borne.
    expect(estimateEffectiveVo2max({ ...base, avgHrBpm: 99 })).toBeNull();
    // 201 bpm sur 200 → 1.005 : FC max du profil dépassée, donnée incohérente.
    expect(estimateEffectiveVo2max({ ...base, avgHrBpm: 201 })).toBeNull();
    // Les bornes elles-mêmes restent calculables.
    expect(estimateEffectiveVo2max({ ...base, avgHrBpm: 100 })).not.toBeNull();
    expect(estimateEffectiveVo2max({ ...base, avgHrBpm: 200 })).not.toBeNull();
  });

  it('renvoie null sur un effort trop court pour être représentatif', () => {
    expect(
      estimateEffectiveVo2max({
        distanceM: 1_499,
        movingTimeS: 600,
        avgHrBpm: 150,
        maxHrBpm: 200,
      }),
    ).toBeNull();
    expect(
      estimateEffectiveVo2max({
        distanceM: 1_500,
        movingTimeS: 600,
        avgHrBpm: 150,
        maxHrBpm: 200,
      }),
    ).not.toBeNull();

    /*
     * Borne de durée, testée sur un 1500 m à 95 % de FC max — le seul profil
     * d'effort qui tienne en 4 min sans sortir de la plage plausible :
     * v = 375 ; fraction = 0.9235463 ; v100 = 406.04354 → 86.5513.
     */
    expect(
      estimateEffectiveVo2max({
        distanceM: 1_500,
        movingTimeS: 239,
        avgHrBpm: 190,
        maxHrBpm: 200,
      }),
    ).toBeNull();
    expect(
      estimateEffectiveVo2max({
        distanceM: 1_500,
        movingTimeS: 240,
        avgHrBpm: 190,
        maxHrBpm: 200,
      }),
    ).toBeCloseTo(86.551, 3);
  });

  it('renvoie null hors de la plage physiologiquement plausible [20, 90]', () => {
    /*
     * Marche de 5 km en 1 h à 75 % de FC max : v = 83.33333 ; v100 = 120.71084
     * → 18.916, sous la borne basse (c'est une marche, pas une course).
     */
    expect(
      estimateEffectiveVo2max({
        distanceM: 5_000,
        movingTimeS: 3_600,
        avgHrBpm: 150,
        maxHrBpm: 200,
      }),
    ).toBeNull();

    /*
     * Distance GPS aberrante : 10 km en 25 min à 50 % de FC max.
     * v = 400 ; fraction = 0.4798326 ; v100 = 833.62402 → 219.61.
     */
    expect(
      estimateEffectiveVo2max({
        distanceM: 10_000,
        movingTimeS: 1_500,
        avgHrBpm: 100,
        maxHrBpm: 200,
      }),
    ).toBeNull();
  });

  it.each([
    ['distance nulle', { distanceM: 0, movingTimeS: 3_000, avgHrBpm: 150, maxHrBpm: 200 }],
    ['distance négative', { distanceM: -10_000, movingTimeS: 3_000, avgHrBpm: 150, maxHrBpm: 200 }],
    ['durée nulle', { distanceM: 10_000, movingTimeS: 0, avgHrBpm: 150, maxHrBpm: 200 }],
    ['durée négative', { distanceM: 10_000, movingTimeS: -3_000, avgHrBpm: 150, maxHrBpm: 200 }],
    ['distance NaN', { distanceM: Number.NaN, movingTimeS: 3_000, avgHrBpm: 150, maxHrBpm: 200 }],
    ['durée NaN', { distanceM: 10_000, movingTimeS: Number.NaN, avgHrBpm: 150, maxHrBpm: 200 }],
    ['FC NaN', { distanceM: 10_000, movingTimeS: 3_000, avgHrBpm: Number.NaN, maxHrBpm: 200 }],
    ['FC max NaN', { distanceM: 10_000, movingTimeS: 3_000, avgHrBpm: 150, maxHrBpm: Number.NaN }],
    [
      'distance infinie',
      { distanceM: Number.POSITIVE_INFINITY, movingTimeS: 3_000, avgHrBpm: 150, maxHrBpm: 200 },
    ],
    [
      'durée infinie',
      { distanceM: 10_000, movingTimeS: Number.POSITIVE_INFINITY, avgHrBpm: 150, maxHrBpm: 200 },
    ],
    [
      'FC infinie',
      { distanceM: 10_000, movingTimeS: 3_000, avgHrBpm: Number.POSITIVE_INFINITY, maxHrBpm: 200 },
    ],
    [
      'FC max infinie',
      { distanceM: 10_000, movingTimeS: 3_000, avgHrBpm: 150, maxHrBpm: Number.POSITIVE_INFINITY },
    ],
    ['FC nulle', { distanceM: 10_000, movingTimeS: 3_000, avgHrBpm: 0, maxHrBpm: 200 }],
    ['FC max nulle', { distanceM: 10_000, movingTimeS: 3_000, avgHrBpm: 150, maxHrBpm: 0 }],
    ['FC max négative', { distanceM: 10_000, movingTimeS: 3_000, avgHrBpm: 150, maxHrBpm: -200 }],
  ])('renvoie null pour une entrée invalide (%s)', (_label, input) => {
    expect(estimateEffectiveVo2max(input)).toBeNull();
  });
});
