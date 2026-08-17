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

/**
 * Correction d'altitude (Greif), branchée sur la distance.
 *
 * La séance de référence est celle qui a motivé tout ce travail : 2 910 m en
 * 19:57 à 158 bpm pour une FC max de 195, courue en boucle avec 32 m de D+ (donc
 * autant de D−). Sans correction elle vaut 34,6 ; Runalyze, qui l'applique par
 * défaut, en donne 35,1.
 */
describe('estimateEffectiveVo2max — correction d’altitude', () => {
  const REFERENCE = {
    distanceM: 2_910,
    movingTimeS: 1_197,
    avgHrBpm: 158,
    maxHrBpm: 195,
  } as const;

  const GREIF = { ascentCoefM: 2, descentCoefM: -1 };

  it('rend la valeur non corrigée quand rien n’est fourni', () => {
    // Le comportement d'avant la correction, inchangé pour tout appelant qui ne
    // sait rien du dénivelé.
    expect(estimateEffectiveVo2max(REFERENCE)).toBeCloseTo(34.57, 2);
  });

  it('retrouve la valeur de Runalyze sur la séance de référence', () => {
    // 2 910 + 2×32 − 1×32 = 2 942 m équivalents ; v100 passe de 193,55 à
    // 195,68 m/min.
    expect(
      estimateEffectiveVo2max({
        ...REFERENCE,
        elevation: { gainM: 32, lossM: 32 },
        elevationCorrection: GREIF,
      }),
    ).toBeCloseTo(35.05, 2);
  });

  it('ne corrige pas quand un des deux sens du dénivelé manque', () => {
    // Et surtout : la valeur reste **celle d'avant**, pas une correction nulle.
    expect(
      estimateEffectiveVo2max({
        ...REFERENCE,
        elevation: { gainM: 32, lossM: null },
        elevationCorrection: GREIF,
      }),
    ).toBeCloseTo(34.57, 2);
  });

  it('ne corrige pas quand l’athlète a désactivé le réglage', () => {
    expect(
      estimateEffectiveVo2max({
        ...REFERENCE,
        elevation: { gainM: 32, lossM: 32 },
        elevationCorrection: null,
      }),
    ).toBeCloseTo(34.57, 2);
  });

  it('mesure le seuil de représentativité sur la distance réellement courue', () => {
    // 1 400 m de côte deviendraient 2 000 m corrigés — mais c'est bien 1 400 m
    // qui ont été courus, et l'effort reste trop court pour porter une
    // estimation. La correction ne doit pas servir de passe-droit.
    expect(
      estimateEffectiveVo2max({
        distanceM: 1_400,
        movingTimeS: 600,
        avgHrBpm: 158,
        maxHrBpm: 195,
        elevation: { gainM: 300, lossM: 0 },
        elevationCorrection: GREIF,
      }),
    ).toBeNull();
  });
});

/**
 * Facteur correctif individuel, et **l'ordre** dans lequel il intervient.
 *
 * Le calcul du facteur lui-même vit dans `./vo2max-correction` ; ce qui se
 * vérifie ici, c'est son application : après le contrôle de plausibilité, pas
 * avant.
 */
describe('estimateEffectiveVo2max — facteur correctif', () => {
  const REFERENCE = {
    distanceM: 2_910,
    movingTimeS: 1_197,
    avgHrBpm: 158,
    maxHrBpm: 195,
  } as const;

  it('multiplie la valeur estimée', () => {
    // 34,57 × 1,128 — le rapport mesuré entre Trainarr et Runalyze sur cette
    // séance, une fois la correction d'altitude mise de côté.
    expect(
      estimateEffectiveVo2max({ ...REFERENCE, correctionFactor: 1.128 }),
    ).toBeCloseTo(34.57 * 1.128, 2);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['nul', 0],
    ['négatif', -1.1],
    ['NaN', Number.NaN],
  ])('rend la valeur non recalée quand le facteur est %s', (_label, correctionFactor) => {
    expect(estimateEffectiveVo2max({ ...REFERENCE, correctionFactor })).toBeCloseTo(34.57, 2);
  });

  it('s’applique après le contrôle de plausibilité, jamais avant', () => {
    /*
     * Le cas qui décide de l'ordre : une mesure valide tout en haut de la
     * plage. 10 km en 35:00 à 150 bpm pour une FC max de 200 (v = 285,71 ;
     * fraction = 0,6903550 ; v100 = 413,86) donne ≈ 88,6 — dans [20, 90], donc
     * une séance parfaitement lisible. Corrigée d'un facteur crédible, elle
     * dépasse 90.
     *
     * Testée sur la valeur corrigée, la borne rendrait `null` : la séance
     * disparaîtrait du graphe **et** de la moyenne à 30 jours au seul motif
     * qu'une calibration individuelle l'a poussée d'un point. C'est pire que
     * d'afficher une valeur haute — d'où l'ordre retenu.
     */
    const effort = {
      distanceM: 10_000,
      movingTimeS: 2_100,
      avgHrBpm: 150,
      maxHrBpm: 200,
    } as const;

    const raw = estimateEffectiveVo2max(effort);
    expect(raw).not.toBeNull();
    expect(raw!).toBeGreaterThan(85);
    expect(raw!).toBeLessThan(90);

    const corrected = estimateEffectiveVo2max({ ...effort, correctionFactor: 1.128 });
    expect(corrected).not.toBeNull();
    expect(corrected!).toBeGreaterThan(90);
    expect(corrected!).toBeCloseTo(raw! * 1.128, 6);
  });

  it('ne repêche pas une mesure aberrante qu’un facteur ramènerait dans la plage', () => {
    /*
     * L'ordre a une contrepartie, et elle est voulue : une mesure hors plage
     * reste écartée même si le facteur l'y ramènerait. 10 km en 33:00 à 150 bpm
     * pour 200 de FC max donne ≈ 95,4 — refusé —, et 0,7 × 95,4 ≈ 66,8 serait
     * pourtant dans la plage. Ce qui est jugé, c'est la mesure : le recalage ne
     * rend pas crédible une donnée qui ne l'était pas.
     */
    const effort = {
      distanceM: 10_000,
      movingTimeS: 1_980,
      avgHrBpm: 150,
      maxHrBpm: 200,
    } as const;

    expect(estimateEffectiveVo2max(effort)).toBeNull();
    expect(estimateEffectiveVo2max({ ...effort, correctionFactor: 0.7 })).toBeNull();
  });
});
