import { describe, expect, it } from 'vitest';

import {
  CALIBRATED_WINDOW_MIN,
  PREDICTED_DISTANCES,
  SPECULATIVE_FACTOR,
  predictedRaceTimeS,
  predictedRaces,
  predictionConfidence,
} from './race-prediction';
import { REFERENCE_DISTANCES, estimateVdot, vdotFromRace } from './vdot';

/**
 * Chronos équivalents publiés dans les tables de Daniels, en secondes — les
 * mêmes lignes que celles qui ancrent `vdot.test.ts`, où elles sont déjà
 * vérifiées dans le sens direct. Les reprendre ici ferme la boucle : le sens
 * inverse doit retomber sur les chronos dont le sens direct tire ces VDOT.
 */
const REFERENCE_RACES = {
  40: { '5k': 24 * 60 + 8, '10k': 50 * 60 + 3, half: 110 * 60 + 59, marathon: 229 * 60 + 45 },
  50: { '5k': 19 * 60 + 57, '10k': 41 * 60 + 21, half: 91 * 60 + 35, marathon: 190 * 60 + 49 },
} as const;

/** Colonne 5 km des lignes basses de la table, seule relevée pour VDOT 30 et 35. */
const REFERENCE_5K = {
  30: 30 * 60 + 41,
  35: 26 * 60 + 59,
  40: REFERENCE_RACES[40]['5k'],
  50: REFERENCE_RACES[50]['5k'],
} as const;

/**
 * Tolérance sur les chronos de table, en secondes. Elle ne mesure pas
 * l'imprécision du solveur (l'aller-retour ci-dessous le montre juste au
 * milliardième de seconde) mais celle de la **table** : ses lignes sont imprimées
 * pour un VDOT arrondi à l'entier, or ±0,05 de VDOT vaut déjà une dizaine de
 * secondes sur marathon (cf. les VDOT exacts relevés plus bas : 49,95 pour le
 * marathon « VDOT 50 »). L'écart observé culmine à 9,3 s, toujours sur marathon.
 */
const TABLE_TOLERANCE_S = 12;

/** Sur 5 km, la même table est fidèle à moins de 2 s : on serre. */
const TABLE_TOLERANCE_5K_S = 3;

describe('predictedRaceTimeS', () => {
  it.each([
    ['5k', 40],
    ['10k', 40],
    ['half', 40],
    ['marathon', 40],
    ['5k', 50],
    ['10k', 50],
    ['half', 50],
    ['marathon', 50],
  ] as const)('retrouve le chrono publié du %s à VDOT %s', (distance, vdot) => {
    const predicted = predictedRaceTimeS(vdot, REFERENCE_DISTANCES[distance]);

    expect(predicted).not.toBeNull();
    expect(Math.abs(predicted! - REFERENCE_RACES[vdot][distance])).toBeLessThanOrEqual(
      TABLE_TOLERANCE_S,
    );
  });

  it.each([30, 35, 40, 50] as const)('retrouve le 5 km publié à VDOT %s', (vdot) => {
    const predicted = predictedRaceTimeS(vdot, REFERENCE_DISTANCES['5k']);

    expect(predicted).not.toBeNull();
    expect(Math.abs(predicted! - REFERENCE_5K[vdot])).toBeLessThanOrEqual(TABLE_TOLERANCE_5K_S);
  });

  /**
   * L'ancrage le plus fort, parce qu'il ne dépend d'aucun arrondi de table : on
   * prend le VDOT *exact* du chrono publié, puis on redemande le chrono. Le
   * solveur doit rendre la seconde d'où il est parti.
   */
  it.each([
    ['5k', 40],
    ['10k', 40],
    ['half', 40],
    ['marathon', 40],
    ['5k', 50],
    ['10k', 50],
    ['half', 50],
    ['marathon', 50],
  ] as const)('rend exactement le chrono dont il a reçu le VDOT (%s, VDOT %s)', (distance, row) => {
    const distanceM = REFERENCE_DISTANCES[distance];
    const timeS = REFERENCE_RACES[row][distance];
    const exactVdot = vdotFromRace(distanceM, timeS);

    // Écart observé : moins de 10⁻⁹ s, la tolérance même de la bissection.
    expect(predictedRaceTimeS(exactVdot, distanceM)).toBeCloseTo(timeS, 6);
  });

  /**
   * Aller-retour dans l'autre sens, sur toute la plage plausible : le chrono
   * prédit, relu par `estimateVdot`, doit redonner le VDOT de départ. C'est
   * l'énoncé même de « fonction inverse ».
   *
   * Les bornes exactes 20 et 90 sont écartées de la grille, non par indulgence
   * mais parce que le résidu de bissection (10⁻¹⁰ de VDOT) tombe alors du mauvais
   * côté de la plage plausible et qu'`estimateVdot` refuse par construction. Que
   * les bornes soient bien *prédites*, elles, est vérifié séparément plus bas.
   */
  it.each([21, 25, 30, 40, 50, 60, 70, 80, 89])(
    'est l’inverse d’estimateVdot à VDOT %s sur les quatre distances',
    (vdot) => {
      for (const distance of PREDICTED_DISTANCES) {
        const distanceM = REFERENCE_DISTANCES[distance];
        const movingTimeS = predictedRaceTimeS(vdot, distanceM);

        expect(movingTimeS).not.toBeNull();
        expect(estimateVdot({ distanceM, movingTimeS: movingTimeS! })).toBeCloseTo(vdot, 8);
      }
    },
  );

  it('accélère quand le VDOT monte, à distance égale', () => {
    const times = [30, 40, 50, 60, 70].map(
      (vdot) => predictedRaceTimeS(vdot, REFERENCE_DISTANCES['10k'])!,
    );

    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]!).toBeLessThan(times[index - 1]!);
    }
  });

  it('allonge le chrono quand la distance grandit, à VDOT égal', () => {
    const times = PREDICTED_DISTANCES.map(
      (distance) => predictedRaceTimeS(45, REFERENCE_DISTANCES[distance])!,
    );

    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]!).toBeGreaterThan(times[index - 1]!);
    }
  });

  it('couvre toute la plage de VDOT plausible sur les distances prédites', () => {
    for (const vdot of [20, 90]) {
      for (const distance of PREDICTED_DISTANCES) {
        expect(predictedRaceTimeS(vdot, REFERENCE_DISTANCES[distance])).not.toBeNull();
      }
    }
  });

  it('renvoie null hors de la plage de VDOT plausible [20, 90]', () => {
    expect(predictedRaceTimeS(19.99, 10_000)).toBeNull();
    expect(predictedRaceTimeS(90.01, 10_000)).toBeNull();
    // Les bornes elles-mêmes restent calculables.
    expect(predictedRaceTimeS(20, 10_000)).not.toBeNull();
    expect(predictedRaceTimeS(90, 10_000)).not.toBeNull();
  });

  it('renvoie null en dessous de 1500 m, comme estimateVdot', () => {
    expect(predictedRaceTimeS(50, 1499)).toBeNull();
    expect(predictedRaceTimeS(50, 800)).toBeNull();
    // La borne du modèle reste calculable : 1500 m en 5:23,7 à VDOT 50.
    expect(predictedRaceTimeS(50, 1500)).toBeCloseTo(323.72, 2);
  });

  it('renvoie null quand la racine tomberait sous le plancher de 4 minutes', () => {
    // Sur 1500 m, 4 min pile correspond à VDOT 70,1 : au-delà, le chrono prédit
    // sortirait du domaine que le sens direct accepte, donc rien n'est rendu.
    expect(predictedRaceTimeS(70, 1500)).toBeCloseTo(240.3, 1);
    expect(predictedRaceTimeS(71, 1500)).toBeNull();
    expect(predictedRaceTimeS(90, 1500)).toBeNull();
  });

  it('renvoie null quand la racine dépasserait 8 heures', () => {
    // 100 km à VDOT 30 : plus de 8 h. Le modèle ne décrit pas l'ultra, il le dit
    // plutôt que d'extrapoler.
    expect(predictedRaceTimeS(30, 100_000)).toBeNull();
  });

  it.each([
    ['VDOT NaN', Number.NaN, 10_000],
    ['VDOT infini', Number.POSITIVE_INFINITY, 10_000],
    ['VDOT nul', 0, 10_000],
    ['VDOT négatif', -50, 10_000],
    ['distance NaN', 50, Number.NaN],
    ['distance infinie', 50, Number.POSITIVE_INFINITY],
    ['distance nulle', 50, 0],
    ['distance négative', 50, -10_000],
  ])('renvoie null pour une entrée invalide (%s)', (_label, vdot, distanceM) => {
    expect(predictedRaceTimeS(vdot, distanceM)).toBeNull();
  });

  it('est déterministe', () => {
    expect(predictedRaceTimeS(50, 10_000)).toBe(predictedRaceTimeS(50, 10_000));
  });
});

describe('predictionConfidence', () => {
  const minutes = (value: number) => value * 60;

  it('qualifie de calibrée une durée dans la fenêtre 15-50 min, bornes comprises', () => {
    expect(predictionConfidence(minutes(CALIBRATED_WINDOW_MIN.from))).toBe('calibrated');
    expect(predictionConfidence(minutes(CALIBRATED_WINDOW_MIN.to))).toBe('calibrated');
    expect(predictionConfidence(minutes(30))).toBe('calibrated');
  });

  it('qualifie d’extrapolée une durée hors fenêtre mais à moins d’un facteur 2', () => {
    // 14:59 et 50:01 : juste dehors.
    expect(predictionConfidence(minutes(15) - 1)).toBe('extrapolated');
    expect(predictionConfidence(minutes(50) + 1)).toBe('extrapolated');
    // Bornes du facteur 2 : 7 min 30 et 1 h 40, incluses.
    expect(predictionConfidence(minutes(CALIBRATED_WINDOW_MIN.from / SPECULATIVE_FACTOR))).toBe(
      'extrapolated',
    );
    expect(predictionConfidence(minutes(CALIBRATED_WINDOW_MIN.to * SPECULATIVE_FACTOR))).toBe(
      'extrapolated',
    );
  });

  it('qualifie de spéculative une durée au-delà du facteur 2', () => {
    // 1 h 40 + 1 s, et 7:29.
    expect(predictionConfidence(minutes(100) + 1)).toBe('speculative');
    expect(predictionConfidence(minutes(7.5) - 1)).toBe('speculative');
    expect(predictionConfidence(3 * 3600)).toBe('speculative');
  });

  it.each([
    ['NaN', Number.NaN],
    ['infini', Number.POSITIVE_INFINITY],
    ['zéro', 0],
    ['négatif', -600],
  ])('retient le niveau le plus prudent pour une durée qui n’en est pas une (%s)', (_l, timeS) => {
    expect(predictionConfidence(timeS)).toBe('speculative');
  });
});

describe('predictedRaces', () => {
  it('rend les quatre distances de route, dans l’ordre et aux mètres exacts', () => {
    const predictions = predictedRaces(50);

    expect(predictions.map((prediction) => prediction.distance)).toEqual([
      '5k',
      '10k',
      'half',
      'marathon',
    ]);
    expect(predictions.map((prediction) => prediction.distanceM)).toEqual([
      5000, 10_000, 21_097.5, 42_195,
    ]);
  });

  it('rend les mêmes chronos que predictedRaceTimeS', () => {
    for (const prediction of predictedRaces(42)) {
      expect(prediction.timeS).toBe(predictedRaceTimeS(42, prediction.distanceM));
    }
  });

  /**
   * Le cœur du sujet : le marathon n'est **jamais** une mesure. À VDOT 90 il est
   * encore prédit à 1 h 55, soit plus du double de la borne haute calibrée.
   */
  it.each([20, 30, 40, 50, 60, 70, 80, 90])(
    'annonce toute prédiction marathon comme spéculative (VDOT %s)',
    (vdot) => {
      const marathon = predictedRaces(vdot).find(
        (prediction) => prediction.distance === 'marathon',
      );

      expect(marathon).toBeDefined();
      expect(marathon!.confidence).toBe('speculative');
    },
  );

  it('reconnaît le 5 km comme calibré aux niveaux courants', () => {
    for (const vdot of [25, 30, 40, 50, 60]) {
      const fiveK = predictedRaces(vdot).find((prediction) => prediction.distance === '5k');

      expect(fiveK!.confidence).toBe('calibrated');
    }
  });

  it('dégrade la confiance à mesure que la distance s’allonge', () => {
    // VDOT 50 : 5 km 19:56 (calibré), 10 km 41:20 (calibré), semi 1 h 31
    // (extrapolé), marathon 3 h 11 (spéculatif).
    expect(predictedRaces(50).map((prediction) => prediction.confidence)).toEqual([
      'calibrated',
      'calibrated',
      'extrapolated',
      'speculative',
    ]);
  });

  it('renvoie un tableau vide pour un VDOT inexploitable', () => {
    expect(predictedRaces(Number.NaN)).toEqual([]);
    expect(predictedRaces(0)).toEqual([]);
    expect(predictedRaces(120)).toEqual([]);
  });

  /**
   * Pourquoi le 1 500 m ne figure pas dans {@link PREDICTED_DISTANCES} : le
   * modèle sait le calculer, mais sa propre échelle de confiance le désavoue à
   * tous les niveaux.
   */
  it('justifie l’absence du 1500 m : spéculatif dès VDOT 35, puis incalculable', () => {
    for (const vdot of [35, 40, 50, 60, 70]) {
      const timeS = predictedRaceTimeS(vdot, 1500);

      expect(timeS).not.toBeNull();
      expect(predictionConfidence(timeS!)).toBe('speculative');
    }

    // Plus haut, le chrono passerait sous les 4 min du modèle : rien à dire.
    expect(predictedRaceTimeS(71, 1500)).toBeNull();
    // Plus bas, il ne remonte qu'à « extrapolé » — 1500 m en 8:29 à VDOT 30.
    expect(predictionConfidence(predictedRaceTimeS(30, 1500)!)).toBe('extrapolated');
  });
});
