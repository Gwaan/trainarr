import { describe, expect, it } from 'vitest';

import {
  InvalidRacePerformanceError,
  REFERENCE_DISTANCES,
  REPETITION_FRACTION_ANCHORS,
  REPETITION_HALF_WIDTH,
  VDOT_ZONE_FRACTIONS,
  estimateVdot,
  paceSecPerKmAtVdotFraction,
  repetitionFractionsAtVdot,
  trainingPacesFromRace,
  vdotFromRace,
  type PaceZone,
  type TrainingPaces,
} from './vdot';

describe('estimateVdot', () => {
  /**
   * Références croisées avec les tables publiées de Daniels : VDOT 50 correspond
   * à 5 000 m en 19:57 et à 10 km en 41:21. L'implémentation doit retomber sur
   * 50 (± 1) pour ces deux performances.
   */
  it('retrouve VDOT 50 sur les performances de référence de la table Daniels', () => {
    expect(estimateVdot({ distanceM: 5000, movingTimeS: 19 * 60 + 57 })).toBeCloseTo(50, 0);
    expect(estimateVdot({ distanceM: 10_000, movingTimeS: 41 * 60 + 21 })).toBeCloseTo(50, 0);
  });

  it('calcule les valeurs attendues sur des efforts ronds', () => {
    // v = 250 m/min → VO2 = 47.4645 ; t = 20 min → pct = 0.952989 → 49.806
    expect(estimateVdot({ distanceM: 5000, movingTimeS: 20 * 60 })).toBeCloseTo(49.806, 3);
    // v = 250 m/min → VO2 = 47.4645 ; t = 40 min → pct = 0.913762 → 51.944
    expect(estimateVdot({ distanceM: 10_000, movingTimeS: 40 * 60 })).toBeCloseTo(51.944, 3);
    // Marathon en 3 h.
    expect(estimateVdot({ distanceM: 42_195, movingTimeS: 3 * 3600 })).toBeCloseTo(53.528, 3);
  });

  it('croît quand la performance s’améliore à distance égale', () => {
    const slower = estimateVdot({ distanceM: 10_000, movingTimeS: 45 * 60 });
    const faster = estimateVdot({ distanceM: 10_000, movingTimeS: 38 * 60 });

    expect(slower).not.toBeNull();
    expect(faster).not.toBeNull();
    expect(faster!).toBeGreaterThan(slower!);
  });

  it('donne un VDOT cohérent entre distances pour un même niveau', () => {
    // 5 km 20:00 et 10 km 41:35 sont deux performances de niveau très proche.
    const fiveK = estimateVdot({ distanceM: 5000, movingTimeS: 20 * 60 })!;
    const tenK = estimateVdot({ distanceM: 10_000, movingTimeS: 41 * 60 + 35 })!;

    expect(Math.abs(fiveK - tenK)).toBeLessThan(1);
  });

  it('renvoie null en dessous de 1500 m (hors domaine du modèle)', () => {
    expect(estimateVdot({ distanceM: 1499, movingTimeS: 6 * 60 })).toBeNull();
    expect(estimateVdot({ distanceM: 800, movingTimeS: 5 * 60 })).toBeNull();
    // La borne elle-même reste calculable.
    expect(estimateVdot({ distanceM: 1500, movingTimeS: 5 * 60 })).not.toBeNull();
  });

  it('renvoie null en dessous de 4 minutes (hors domaine du modèle)', () => {
    expect(estimateVdot({ distanceM: 1500, movingTimeS: 239 })).toBeNull();
    expect(estimateVdot({ distanceM: 1500, movingTimeS: 240 })).not.toBeNull();
  });

  it('renvoie null hors de la plage physiologiquement plausible [20, 90]', () => {
    // 1500 m en 12 min → VDOT ≈ 19.97, sous la borne basse.
    expect(estimateVdot({ distanceM: 1500, movingTimeS: 12 * 60 })).toBeNull();
    // Une marche de 5 km en 1 h → VDOT ≈ 12.7.
    expect(estimateVdot({ distanceM: 5000, movingTimeS: 3600 })).toBeNull();
    // Une distance GPS aberrante sur une durée courte → au-dessus de 90.
    expect(estimateVdot({ distanceM: 20_000, movingTimeS: 20 * 60 })).toBeNull();
  });

  it.each([
    ['distance nulle', { distanceM: 0, movingTimeS: 1200 }],
    ['distance négative', { distanceM: -5000, movingTimeS: 1200 }],
    ['durée nulle', { distanceM: 5000, movingTimeS: 0 }],
    ['durée négative', { distanceM: 5000, movingTimeS: -1200 }],
    ['distance NaN', { distanceM: Number.NaN, movingTimeS: 1200 }],
    ['durée NaN', { distanceM: 5000, movingTimeS: Number.NaN }],
    ['distance infinie', { distanceM: Number.POSITIVE_INFINITY, movingTimeS: 1200 }],
    ['durée infinie', { distanceM: 5000, movingTimeS: Number.POSITIVE_INFINITY }],
  ])('renvoie null pour une entrée invalide (%s)', (_label, effort) => {
    expect(estimateVdot(effort)).toBeNull();
  });
});

/**
 * Points d'ancrage relevés dans les tables publiées de Daniels, convertis en
 * s/km. Les colonnes de la table sont imprimées en min/mile (1 mile =
 * 1609.344 m) sauf M, qui est l'allure du chrono marathon équivalent.
 *
 * Sources des lignes VDOT 40 et VDOT 50 :
 *  - https://www.brenoamelo.com/blog/vdot-pace-chart-printable (E, T, I)
 *  - https://www.brenoamelo.com/blog/jack-daniels-vdot-explained (créneaux)
 *  - https://therunninggenie.com/vdot-calculator (créneaux)
 */
const METERS_PER_MILE = 1609.344;
const perMile = (min: number, sec: number) => ((min * 60 + sec) / METERS_PER_MILE) * 1000;

/** Chronos équivalents publiés pour VDOT 40 et VDOT 50, en secondes. */
const REFERENCE_RACES = {
  40: { '5k': 24 * 60 + 8, '10k': 50 * 60 + 3, half: 110 * 60 + 59, marathon: 229 * 60 + 45 },
  50: { '5k': 19 * 60 + 57, '10k': 41 * 60 + 21, half: 91 * 60 + 35, marathon: 190 * 60 + 49 },
} as const;

/**
 * Chronos 5 km publiés des quatre lignes de table qui servent d'ancrage. Les
 * lignes basses (VDOT 30 et 35) n'ont longtemps eu aucun test : la table
 * n'était vérifiée qu'à VDOT 40 et 50, ce qui a laissé la bande R dériver sans
 * bruit sur tout le bas du spectre — celui où court l'utilisatrice de l'appli.
 * Seule la colonne 5 km est relevée pour ces deux lignes : c'est l'ancre la plus
 * fiable du modèle (effort de 15 à 50 min) et il en faut une seule pour
 * atteindre la ligne.
 */
const REFERENCE_5K = {
  30: 30 * 60 + 41,
  35: 26 * 60 + 59,
  40: REFERENCE_RACES[40]['5k'],
  50: REFERENCE_RACES[50]['5k'],
} as const;

/** Allures de la table, en s/km. */
const TABLE_PACES = {
  40: {
    easyFast: perMile(9, 50),
    easySlow: perMile(10, 52),
    marathon: (3 * 3600 + 49 * 60 + 45) / 42.195,
    threshold: perMile(8, 12),
    interval: perMile(7, 31),
    repetition: 106 / 0.4, // 400 m en 1:46
  },
  50: {
    easyFast: perMile(8, 14),
    easySlow: perMile(9, 7),
    marathon: (3 * 3600 + 10 * 60 + 49) / 42.195,
    threshold: perMile(6, 51),
    interval: perMile(6, 16),
    repetition: 87 / 0.4, // 400 m en 1:27
  },
} as const;

/**
 * Lignes basses de la table (VDOT 30 et 35). Trois colonnes seulement : la
 * borne rapide de E, T et I. La borne lente de E et la colonne M ne sont pas
 * relevées sur ces deux lignes — on n'ancre que ce qu'on a lu, jamais une valeur
 * reconstituée.
 *
 * La colonne R n'y figure pas non plus, et c'est délibéré : R est vérifiée par
 * son *milieu de bande* aux trois points de contrôle du calibrage (30, 40, 50),
 * cf. le test dédié plus bas. La ligne VDOT 35 y échapperait de toute façon —
 * son 400 m publié (1:55) implique 108,5 % de VO2max, hors de la tendance de ses
 * voisines (104,6 % à 30, 105,0 % à 40, 107,2 % à 50).
 */
const LOW_TABLE_PACES = {
  30: {
    easyFast: perMile(12, 19),
    threshold: perMile(10, 18),
    interval: perMile(9, 28),
  },
  35: {
    easyFast: perMile(10, 56),
    threshold: perMile(9, 7),
    interval: perMile(8, 22),
  },
} as const;

/**
 * Allures R publiées (temps au 400 m de la table) aux trois points de contrôle
 * du calibrage de la bande de répétitions, en s/km.
 */
const TABLE_REPETITION_PACES = {
  30: 134 / 0.4, // 400 m en 2:14 → 5:35/km
  40: 106 / 0.4, // 400 m en 1:46 → 4:25/km
  50: 87 / 0.4, //  400 m en 1:27 → 3:38/km
} as const;

describe('vdotFromRace', () => {
  it.each([
    ['5k', 40],
    ['10k', 40],
    ['half', 40],
    ['marathon', 40],
    ['5k', 50],
    ['10k', 50],
    ['half', 50],
    ['marathon', 50],
  ] as const)(
    'retrouve VDOT %s sur le chrono équivalent publié (%s)',
    (distance, expectedVdot) => {
      const distanceM = REFERENCE_DISTANCES[distance];
      const timeS = REFERENCE_RACES[expectedVdot][distance];

      // Les chronos de la table sont imprimés à la seconde : ±0,1 de VDOT.
      expect(Math.abs(vdotFromRace(distanceM, timeS) - expectedVdot)).toBeLessThanOrEqual(0.1);
    },
  );

  it.each([30, 35, 40, 50] as const)(
    'retrouve VDOT %s sur le 5 km équivalent publié',
    (expectedVdot) => {
      const vdot = vdotFromRace(REFERENCE_DISTANCES['5k'], REFERENCE_5K[expectedVdot]);

      expect(Math.abs(vdot - expectedVdot)).toBeLessThanOrEqual(0.1);
    },
  );

  it('couvre chaque distance de référence sans lever', () => {
    for (const distanceM of Object.values(REFERENCE_DISTANCES)) {
      // 4 min/km : plausible sur les quatre distances.
      expect(vdotFromRace(distanceM, (distanceM / 1000) * 240)).toBeGreaterThan(0);
    }
  });

  it('croît quand le chrono s’améliore à distance égale', () => {
    const times = [24 * 60, 22 * 60, 20 * 60, 18 * 60];
    const vdots = times.map((t) => vdotFromRace(REFERENCE_DISTANCES['5k'], t));

    for (let i = 1; i < vdots.length; i += 1) {
      expect(vdots[i]!).toBeGreaterThan(vdots[i - 1]!);
    }
  });

  it('est déterministe', () => {
    expect(vdotFromRace(5000, 1200)).toBe(vdotFromRace(5000, 1200));
  });

  it.each([
    ['distance nulle', 0, 1200],
    ['distance négative', -5000, 1200],
    ['distance NaN', Number.NaN, 1200],
    ['distance infinie', Number.POSITIVE_INFINITY, 1200],
    ['temps nul', 5000, 0],
    ['temps négatif', 5000, -1200],
    ['temps NaN', 5000, Number.NaN],
    ['temps infini', 5000, Number.POSITIVE_INFINITY],
  ])('lève InvalidRacePerformanceError (%s)', (_label, distanceM, timeS) => {
    expect(() => vdotFromRace(distanceM, timeS)).toThrow(InvalidRacePerformanceError);
  });

  it('lève sur une vitesse implausible (erreur de saisie)', () => {
    // 5 km en 8 min → 10.4 m/s, plus rapide que le record du monde.
    expect(() => vdotFromRace(5000, 8 * 60)).toThrow(InvalidRacePerformanceError);
    // 5 km en 2 h → 0.69 m/s, ce n'est pas une course.
    expect(() => vdotFromRace(5000, 2 * 3600)).toThrow(InvalidRacePerformanceError);
  });

  it('lève hors de la plage de VDOT plausible, comme estimateVdot', () => {
    // 5 km en 12 min → 6.94 m/s, sous le plafond de vitesse : seule la borne de
    // VDOT (90.1) écarte ce chrono, plus rapide que le record du monde.
    expect(() => vdotFromRace(REFERENCE_DISTANCES['5k'], 12 * 60)).toThrow(
      InvalidRacePerformanceError,
    );
    // Marathon en 7 h → VDOT 18.4, sous la borne basse.
    expect(() => vdotFromRace(REFERENCE_DISTANCES.marathon, 7 * 3600)).toThrow(
      InvalidRacePerformanceError,
    );
  });

  it('accepte les chronos lents mais réels des grandes distances', () => {
    // Marathon en 5 h et 6 h, semi en 3 h : trois chronos de finisher que
    // l'ancien plancher de 2 m/s (marathon > 5 h 51, semi > 2 h 55) refusait.
    expect(() => vdotFromRace(REFERENCE_DISTANCES.marathon, 5 * 3600)).not.toThrow();
    expect(() => vdotFromRace(REFERENCE_DISTANCES.marathon, 6 * 3600)).not.toThrow();
    expect(() => vdotFromRace(REFERENCE_DISTANCES.half, 3 * 3600)).not.toThrow();
  });
});

describe('trainingPacesFromRace', () => {
  const ZONES = ['easy', 'marathon', 'threshold', 'interval', 'repetition'] as const;

  /** Tolérance de calibrage sur les allures de la table publiée, en s/km. */
  const TOLERANCE_S_PER_KM = 3;

  /**
   * Calibrage : les allures ponctuelles de la table sont reproduites à ±3 s/km
   * par les fractions retenues (E 70 % et 62 %, M 81 %, T 88 %, I 98 %).
   * Écart maximal constaté : 1,6 s/km sur la borne lente de E, dont la fraction
   * exacte est 61,6 % — arrondie à 62 % pour ne pas surajuster à une table
   * elle-même imprimée à la seconde près.
   */
  it.each([
    [40, 'easyFast', 0.7],
    [40, 'easySlow', 0.62],
    [40, 'marathon', 0.81],
    [40, 'threshold', 0.88],
    [40, 'interval', 0.98],
    [40, 'repetition', 1.05],
    [50, 'easyFast', 0.7],
    [50, 'easySlow', 0.62],
    [50, 'marathon', 0.81],
    [50, 'threshold', 0.88],
    [50, 'interval', 0.98],
  ] as const)('reproduit la table VDOT %s (%s) à ±3 s/km', (vdot, key, fraction) => {
    const expected = TABLE_PACES[vdot][key];

    expect(Math.abs(paceSecPerKmAtVdotFraction(vdot, fraction) - expected)).toBeLessThanOrEqual(
      TOLERANCE_S_PER_KM,
    );
  });

  /**
   * Le bas de la table (VDOT 30 et 35), longtemps absent des ancrages. Les
   * fractions fixes E/T/I y tombent juste sans le moindre ajustement — c'est ce
   * qui a permis d'imputer la dérive constatée à la seule bande R.
   */
  it.each([
    [30, 'easyFast', 0.7],
    [30, 'threshold', 0.88],
    [30, 'interval', 0.98],
    [35, 'easyFast', 0.7],
    [35, 'threshold', 0.88],
    [35, 'interval', 0.98],
  ] as const)('reproduit la table VDOT %s (%s) à ±3 s/km', (vdot, key, fraction) => {
    const expected = LOW_TABLE_PACES[vdot][key];

    expect(Math.abs(paceSecPerKmAtVdotFraction(vdot, fraction) - expected)).toBeLessThanOrEqual(
      TOLERANCE_S_PER_KM,
    );
  });

  /**
   * **Le milieu de la bande R**, aux trois points de contrôle de son calibrage.
   *
   * C'est le milieu qui compte, pas les bornes : `zoneMidPace`
   * (`src/lib/ai/plan-schema.ts`) en fait la cible affichée et imposée d'une
   * séance de répétitions. Avec l'ancienne bande fixe 105-110 %, il sortait
   * 7 s/km trop rapide à VDOT 30 et 5 s/km trop rapide à VDOT 40 — invisible
   * tant que rien n'ancrait le bas de la table.
   */
  it.each([30, 40, 50] as const)(
    'pose le milieu de la bande R sur l’allure publiée à VDOT %s (±3 s/km)',
    (vdot) => {
      const paces = trainingPacesFromRace(REFERENCE_DISTANCES['5k'], REFERENCE_5K[vdot]);
      const mid = (paces.repetition.minSecPerKm + paces.repetition.maxSecPerKm) / 2;

      expect(Math.abs(mid - TABLE_REPETITION_PACES[vdot])).toBeLessThanOrEqual(
        TOLERANCE_S_PER_KM,
      );
    },
  );

  /**
   * Chaque allure publiée tombe dans le créneau calculé. C'est le contrôle qui
   * vaut pour R à VDOT 50 : la table imprime un 400 m en 1:27 (≈ 107 % de
   * VDOT), arrondi au demi-seconde près sur la piste — il tombe dans 105-110 %
   * sans coïncider avec une borne.
   */
  it.each([40, 50] as const)('encadre les allures publiées de la table VDOT %s', (vdot) => {
    const paces = trainingPacesFromRace(REFERENCE_DISTANCES['10k'], REFERENCE_RACES[vdot]['10k']);
    const table = TABLE_PACES[vdot];
    const contains = (zone: PaceZone, pace: number) =>
      pace >= zone.minSecPerKm - TOLERANCE_S_PER_KM &&
      pace <= zone.maxSecPerKm + TOLERANCE_S_PER_KM;

    expect(contains(paces.easy, table.easyFast)).toBe(true);
    expect(contains(paces.easy, table.easySlow)).toBe(true);
    expect(contains(paces.marathon, table.marathon)).toBe(true);
    expect(contains(paces.threshold, table.threshold)).toBe(true);
    expect(contains(paces.interval, table.interval)).toBe(true);
    expect(contains(paces.repetition, table.repetition)).toBe(true);
  });

  it('renvoie le VDOT du chrono et des allures entières', () => {
    const paces = trainingPacesFromRace(REFERENCE_DISTANCES['5k'], 20 * 60);

    expect(paces.vdot).toBe(vdotFromRace(REFERENCE_DISTANCES['5k'], 20 * 60));
    for (const zone of ZONES) {
      expect(Number.isInteger(paces[zone].minSecPerKm)).toBe(true);
      expect(Number.isInteger(paces[zone].maxSecPerKm)).toBe(true);
    }
  });

  it('ordonne chaque créneau (borne rapide ≤ borne lente)', () => {
    const paces = trainingPacesFromRace(REFERENCE_DISTANCES['10k'], 45 * 60);

    for (const zone of ZONES) {
      expect(paces[zone].minSecPerKm).toBeLessThanOrEqual(paces[zone].maxSecPerKm);
    }
  });

  it('ordonne les créneaux du plus lent au plus rapide (E > M > T > I > R)', () => {
    const paces = trainingPacesFromRace(REFERENCE_DISTANCES['10k'], 45 * 60);

    expect(paces.easy.minSecPerKm).toBeGreaterThan(paces.marathon.minSecPerKm);
    expect(paces.marathon.minSecPerKm).toBeGreaterThan(paces.threshold.minSecPerKm);
    expect(paces.threshold.minSecPerKm).toBeGreaterThan(paces.interval.minSecPerKm);
    expect(paces.interval.minSecPerKm).toBeGreaterThan(paces.repetition.minSecPerKm);
  });

  it('conserve le chevauchement M/T des bandes publiées', () => {
    // Hérité de Daniels (M 75-84 %, T 83-88 %) : la borne rapide du créneau
    // marathon est plus intense que la borne lente du seuil, donc plus rapide en
    // allure. Figé ici pour qu'un resserrement des bandes soit un choix
    // conscient, jamais un effet de bord (cf. `VDOT_ZONE_FRACTIONS`).
    expect(VDOT_ZONE_FRACTIONS.marathon.fast).toBeGreaterThan(
      VDOT_ZONE_FRACTIONS.threshold.slow,
    );

    const paces = trainingPacesFromRace(REFERENCE_DISTANCES['10k'], 45 * 60);
    expect(paces.marathon.minSecPerKm).toBeLessThan(paces.threshold.maxSecPerKm);
  });

  it('accélère toutes les allures quand le chrono s’améliore', () => {
    const slower = trainingPacesFromRace(REFERENCE_DISTANCES['10k'], 50 * 60);
    const faster = trainingPacesFromRace(REFERENCE_DISTANCES['10k'], 42 * 60);

    expect(faster.vdot).toBeGreaterThan(slower.vdot);
    for (const zone of ZONES) {
      expect(faster[zone].minSecPerKm).toBeLessThan(slower[zone].minSecPerKm);
      expect(faster[zone].maxSecPerKm).toBeLessThan(slower[zone].maxSecPerKm);
    }
  });

  it('donne des allures cohérentes depuis chaque distance de référence', () => {
    // Les quatre chronos équivalents VDOT 50 doivent produire la même table.
    const tables: TrainingPaces[] = (
      Object.keys(REFERENCE_DISTANCES) as (keyof typeof REFERENCE_DISTANCES)[]
    ).map((d) => trainingPacesFromRace(REFERENCE_DISTANCES[d], REFERENCE_RACES[50][d]));

    for (const table of tables) {
      expect(table.vdot).toBeCloseTo(50, 1);
      for (const zone of ZONES) {
        expect(
          Math.abs(table[zone].minSecPerKm - tables[0]![zone].minSecPerKm),
        ).toBeLessThanOrEqual(TOLERANCE_S_PER_KM);
      }
    }
  });

  it('propage la validation de vdotFromRace', () => {
    expect(() => trainingPacesFromRace(5000, 8 * 60)).toThrow(InvalidRacePerformanceError);
    expect(() => trainingPacesFromRace(0, 1200)).toThrow(InvalidRacePerformanceError);
  });
});

describe('repetitionFractionsAtVdot', () => {
  it('passe par les fractions publiées à chaque point d’ancrage', () => {
    for (const { vdot, fraction } of REPETITION_FRACTION_ANCHORS) {
      const { slow, fast } = repetitionFractionsAtVdot(vdot);

      expect((slow + fast) / 2).toBeCloseTo(fraction, 10);
    }
  });

  it('garde une bande de largeur constante, plus rapide que le créneau I', () => {
    for (const vdot of [25, 30, 35, 40, 45, 50, 60]) {
      const { slow, fast } = repetitionFractionsAtVdot(vdot);

      expect(fast - slow).toBeCloseTo(2 * REPETITION_HALF_WIDTH, 10);
      expect(slow).toBeGreaterThan(VDOT_ZONE_FRACTIONS.interval.fast);
    }
  });

  /**
   * Clamp plutôt qu'extrapolation hors du domaine mesuré : prolonger la pente
   * 40 → 50 donnerait 111,6 % à VDOT 70, un chiffre que la table ne dit nulle
   * part. La fonction reste continue en 30 et en 50.
   */
  it('clampe aux bornes du domaine mesuré [30, 50]', () => {
    expect(repetitionFractionsAtVdot(20)).toEqual(repetitionFractionsAtVdot(30));
    expect(repetitionFractionsAtVdot(29.9)).toEqual(repetitionFractionsAtVdot(30));
    expect(repetitionFractionsAtVdot(70)).toEqual(repetitionFractionsAtVdot(50));
    expect(repetitionFractionsAtVdot(50.1)).toEqual(repetitionFractionsAtVdot(50));
  });

  it('ne décroît jamais quand le VDOT monte', () => {
    let previous = repetitionFractionsAtVdot(20);

    for (let vdot = 20.5; vdot <= 70; vdot += 0.5) {
      const current = repetitionFractionsAtVdot(vdot);

      expect(current.slow).toBeGreaterThanOrEqual(previous.slow);
      expect(current.fast).toBeGreaterThanOrEqual(previous.fast);
      previous = current;
    }
  });
});
