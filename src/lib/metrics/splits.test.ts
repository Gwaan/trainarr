import { describe, expect, it } from 'vitest';

import { FULL_SPLIT_TOLERANCE_M, computeSplits, isPartialSplit } from './splits';

/**
 * Séance 1 Hz à vitesse constante : `count` points, `speed` m/s, distance
 * cumulée décalée de `offset` (le stream FIT ne repart pas de zéro).
 */
function steady(count: number, speed: number, offset = 0) {
  const time: number[] = [];
  const distance: number[] = [];
  for (let second = 0; second < count; second += 1) {
    time.push(second);
    distance.push(offset + second * speed);
  }
  return { time, distance };
}

/** Remplace par `null` toutes les valeurs dont l'index n'est pas multiple de `every`. */
function thin<T>(values: readonly T[], every: number): (T | null)[] {
  return values.map((value, index) => (index % every === 0 ? value : null));
}

describe('computeSplits — canaux clairsemés', () => {
  it('découpe au kilomètre sur les seules distances mesurées', () => {
    const { time, distance } = steady(651, 4);
    const dense = computeSplits(distance, time);
    // Distance écrite un point sur cinq : les bornes tombent au même endroit,
    // l'interpolation portant sur deux mesures réelles.
    const sparse = computeSplits(thin(distance, 5), time);

    expect(sparse.map((split) => split.km)).toEqual([1, 2, 3]);
    expect(sparse.map((split) => split.distanceM)).toEqual(
      dense.map((split) => split.distanceM),
    );
    for (const [index, split] of sparse.entries()) {
      expect(split.paceSecPerKm).toBeCloseTo(dense[index].paceSecPerKm, 6);
    }
  });

  it('moyenne la FC sur les seuls points où elle parle, sans décaler les splits', () => {
    const { time, distance } = steady(651, 4);
    // FC un point sur 4, 140 bpm sur le premier km puis 160.
    const hr = thin(
      time.map((second) => (second < 250 ? 140 : 160)),
      4,
    );

    const splits = computeSplits(distance, time, hr);

    expect(splits.map((split) => split.km)).toEqual([1, 2, 3]);
    expect(splits.map((split) => split.avgHrBpm)).toEqual([140, 160, 160]);
  });

  it('rend une FC de split à null quand aucun de ses points n’en porte', () => {
    const { time, distance } = steady(651, 4);
    // La ceinture ne parle que sur le premier kilomètre.
    const hr = time.map((second) => (second < 250 ? 140 : null));

    expect(computeSplits(distance, time, hr).map((split) => split.avgHrBpm)).toEqual([
      140,
      null,
      null,
    ]);
  });

  it('cumule le D+ en sautant les points sans altitude', () => {
    const { time, distance } = steady(651, 4);
    const altitude = thin(
      time.map((second) => (second < 250 ? 100 : 105)),
      4,
    );

    expect(computeSplits(distance, time, undefined, altitude).map((s) => s.elevationGainM)).toEqual(
      [0, 5, 0],
    );
  });

  it('n’impute pas au km 1 ce qui précède la première distance mesurée', () => {
    // 60 s d'attente au départ sans fix GPS, à 90 bpm et 100 m d'altitude, puis
    // 1 000 m courus à 160 bpm en 250 s, 10 m plus haut. Le km 1 ne commence
    // qu'au premier fix : moyenner depuis l'index 0 affichait 147 bpm.
    const time: number[] = [];
    const distance: (number | null)[] = [];
    const hr: number[] = [];
    const altitude: number[] = [];
    for (let second = 0; second <= 311; second += 1) {
      time.push(second);
      distance.push(second < 61 ? null : (second - 61) * 4);
      hr.push(second < 61 ? 90 : 160);
      altitude.push(second < 61 ? 100 : 110);
    }

    const splits = computeSplits(distance, time, hr, altitude);

    expect(splits.map((split) => split.km)).toEqual([1]);
    expect(splits[0].timeS).toBeCloseTo(250, 6);
    expect(splits[0].avgHrBpm).toBe(160);
    // La marche de +10 m est franchie avant le premier fix : hors trace.
    expect(splits[0].elevationGainM).toBe(0);
  });

  it('n’impute pas au reliquat ce qui suit la dernière distance mesurée', () => {
    // GPS perdu à 1 200 m : 100 s de points encore horodatés, à 190 bpm et
    // 50 m plus haut, qui n'appartiennent à aucun kilomètre.
    const time: number[] = [];
    const distance: (number | null)[] = [];
    const hr: number[] = [];
    const altitude: number[] = [];
    for (let second = 0; second <= 400; second += 1) {
      time.push(second);
      distance.push(second <= 300 ? second * 4 : null);
      hr.push(second <= 300 ? 150 : 190);
      altitude.push(second <= 300 ? 100 : 150);
    }

    const splits = computeSplits(distance, time, hr, altitude);

    expect(splits.map((split) => split.km)).toEqual([1, 2]);
    expect(splits[1].distanceM).toBe(200);
    expect(splits[1].timeS).toBeCloseTo(50, 6);
    expect(splits.map((split) => split.avgHrBpm)).toEqual([150, 150]);
    expect(splits.map((split) => split.elevationGainM)).toEqual([0, 0]);
  });

  it('laisse un point porter plusieurs bornes kilométriques', () => {
    // Distance mesurée trois fois seulement : 0 m, 2 500 m (t = 500 s) et
    // 3 000 m (t = 600 s). Les bornes des km 1 et 2 tombent toutes deux dans le
    // segment 0 → 2 500 : le km 2 n'a aucun échantillon propre. Consommer le
    // point de mesure à chaque borne faisait pointer le km 2 sur le segment
    // suivant — son temps venait d'un segment, sa FC de l'autre.
    const time: number[] = [];
    const distance: (number | null)[] = [];
    const hr: number[] = [];
    for (let second = 0; second <= 600; second += 1) {
      time.push(second);
      distance.push(second === 0 ? 0 : second === 500 ? 2500 : second === 600 ? 3000 : null);
      hr.push(second < 500 ? 140 : 180);
    }

    const splits = computeSplits(distance, time, hr);

    expect(splits.map((split) => split.km)).toEqual([1, 2, 3]);
    expect(splits.map((split) => split.distanceM)).toEqual([1000, 1000, 1000]);
    // 2 500 m en 500 s : les deux premières bornes sont interpolées à 5 m/s.
    expect(splits.map((split) => split.timeS)).toEqual([200, 200, 200]);
    // Tranche vide pour le km 2 : aucune FC ne lui appartient en propre.
    expect(splits.map((split) => split.avgHrBpm)).toEqual([140, null, 180]);
  });

  it('pondère la FC par le temps quand la cadence change en cours de split', () => {
    // 1 000 m en 250 s. FC à 140 bpm mesurée à 1 Hz sur la première moitié,
    // 160 bpm un point sur trois sur la seconde. Le temps est partagé à parts
    // égales : la moyenne vaut 150, pas 145 (biais du comptage de points).
    const { time, distance } = steady(251, 4);
    const hr = time.map((second) => {
      if (second < 125) return 140;
      return (second - 125) % 3 === 0 ? 160 : null;
    });

    const splits = computeSplits(distance, time, hr);

    expect(splits.map((split) => split.km)).toEqual([1]);
    expect(splits[0].avgHrBpm).toBe(150);
  });
});

describe('computeSplits', () => {
  it('découpe au kilomètre et rend un dernier split partiel', () => {
    // 4 m/s pendant 650 s = 2 600 m.
    const { time, distance } = steady(651, 4);
    const splits = computeSplits(distance, time);

    expect(splits.map((split) => split.km)).toEqual([1, 2, 3]);
    expect(splits.map((split) => split.distanceM)).toEqual([1000, 1000, 600]);
    expect(splits.map((split) => split.timeS)).toEqual([250, 250, 150]);
    expect(splits.map((split) => split.paceSecPerKm)).toEqual([250, 250, 250]);
  });

  it('interpole l’instant de franchissement entre les deux points encadrants', () => {
    // 3 m/s : la borne des 1 000 m tombe à 333,33 s, entre 999 m (333 s) et
    // 1 002 m (334 s). Retenir 334 s décalerait tous les splits.
    const { time, distance } = steady(400, 3);
    const splits = computeSplits(distance, time);

    expect(splits[0].timeS).toBeCloseTo(1000 / 3, 9);
    expect(splits[0].paceSecPerKm).toBeCloseTo(1000 / 3, 9);
  });

  it('compte les kilomètres depuis le premier point de la série', () => {
    // Cumul FIT démarrant à 420 m (points de tête rognés par le parseur).
    const { time, distance } = steady(651, 4, 420);
    const splits = computeSplits(distance, time);

    expect(splits.map((split) => split.km)).toEqual([1, 2, 3]);
    expect(splits[0].timeS).toBe(250);
  });

  it('n’émet un dernier split partiel qu’à partir de 100 m', () => {
    const short = steady(263, 4); // 1 048 m → reliquat de 48 m
    expect(computeSplits(short.distance, short.time).map((split) => split.km)).toEqual([1]);

    const long = steady(276, 4); // 1 100 m → reliquat de 100 m
    const splits = computeSplits(long.distance, long.time);
    expect(splits.map((split) => split.km)).toEqual([1, 2]);
    expect(splits[1].distanceM).toBe(100);
  });

  it('rend un unique split partiel sous le kilomètre', () => {
    const { time, distance } = steady(126, 4); // 500 m
    const splits = computeSplits(distance, time);

    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({ km: 1, distanceM: 500, timeS: 125 });
  });

  it('moyenne la FC par split', () => {
    const { time, distance } = steady(651, 4);
    const hr = distance.map((_, index) => (index < 250 ? 140 : index < 500 ? 160 : 150));

    const splits = computeSplits(distance, time, hr);
    expect(splits.map((split) => split.avgHrBpm)).toEqual([140, 160, 150]);
  });

  it('laisse la FC à null sans stream de FC', () => {
    const { time, distance } = steady(651, 4);
    expect(computeSplits(distance, time).map((split) => split.avgHrBpm)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('attribue le D+ au split où la montée a lieu', () => {
    const { time, distance } = steady(651, 4);
    const altitude = distance.map((_, index) => (index < 250 ? 100 : 105));

    const splits = computeSplits(distance, time, undefined, altitude);
    expect(splits.map((split) => split.elevationGainM)).toEqual([0, 5, 0]);
  });

  it('filtre le bruit altimétrique sous le seuil', () => {
    const { time, distance } = steady(651, 4);
    // Oscillation de ±0,4 m : 650 variations positives, 0 m de dénivelé réel.
    const altitude = distance.map((_, index) => 100 + (index % 2) * 0.4);

    const splits = computeSplits(distance, time, undefined, altitude);
    for (const split of splits) {
      expect(split.elevationGainM).toBe(0);
    }
  });

  it('cumule une montée continue malgré le seuil', () => {
    const { time, distance } = steady(651, 4);
    const altitude = distance.map((_, index) => 100 + index * 0.02); // +13 m

    const splits = computeSplits(distance, time, undefined, altitude);
    const total = splits.reduce((sum, split) => sum + (split.elevationGainM ?? 0), 0);

    // Le seuil de 1 m ne fait perdre que le reliquat en cours au dernier point.
    expect(total).toBeGreaterThan(11.9);
    expect(total).toBeLessThan(13.001);
  });

  it('laisse le D+ à null sans stream d’altitude', () => {
    const { time, distance } = steady(651, 4);
    expect(computeSplits(distance, time).map((split) => split.elevationGainM)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('ignore un stream annexe désaligné plutôt que de décaler les mesures', () => {
    const { time, distance } = steady(651, 4);
    const truncatedHr = new Array<number>(100).fill(150);

    expect(computeSplits(distance, time, truncatedHr).map((split) => split.avgHrBpm)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('ne compte pas une auto-pause dans le temps du kilomètre', () => {
    // 4 m/s (4:10/km) régulier, coupé d'une pause de 300 s au milieu du km 2 :
    // le temps écoulé entre les deux bornes vaut 551 s, soit 9:11/km affichés
    // pour un kilomètre réellement couru en 4:10 — et en contradiction avec la
    // tuile « Durée » de la séance, qui montre le temps en mouvement.
    const time: number[] = [];
    const distance: number[] = [];
    for (let second = 0; second <= 312; second += 1) {
      time.push(second);
      distance.push(second * 4);
    }
    // Reprise 300 s plus tard, au même point kilométrique (1 248 m).
    for (let second = 613; second <= 801; second += 1) {
      time.push(second);
      distance.push(1248 + (second - 613) * 4);
    }

    const splits = computeSplits(distance, time);

    expect(splits.map((split) => split.km)).toEqual([1, 2]);
    expect(splits[0].timeS).toBe(250);
    // 250 s de course + le plafond consenti au trou (3 s), pas 550.
    expect(splits[1].timeS).toBeCloseTo(253, 6);
    expect(splits[1].paceSecPerKm).toBeCloseTo(253, 6);
  });

  it('n’impute pas le reliquat écarté au dernier kilomètre complet', () => {
    // 2 088 m : le reliquat de 88 m est sous le seuil d'affichage, donc écarté.
    // Il ne doit pas pour autant entrer dans le km 2 — un sprint final à
    // 180 bpm et +10 m y remontait la FC à 152 bpm et le D+ à 10 m.
    const { time, distance } = steady(523, 4); // 0 → 2 088 m
    const hr = distance.map((meters) => (meters >= 2000 ? 180 : 150));
    const altitude = distance.map((meters) => (meters >= 2000 ? 110 : 100));

    const splits = computeSplits(distance, time, hr, altitude);

    expect(splits.map((split) => split.km)).toEqual([1, 2]);
    expect(splits.map((split) => split.avgHrBpm)).toEqual([150, 150]);
    expect(splits.map((split) => split.elevationGainM)).toEqual([0, 0]);
    expect(splits[1].timeS).toBe(250);
  });

  it('partage un seul seuil de kilomètre plein avec l’affichage', () => {
    // 995 m n'est pas un kilomètre : le tableau doit afficher sa distance.
    expect(isPartialSplit(995)).toBe(true);
    expect(isPartialSplit(1000)).toBe(false);
    expect(isPartialSplit(1000 - FULL_SPLIT_TOLERANCE_M / 2)).toBe(false);
  });

  it('rend une liste vide sur des séries inexploitables', () => {
    expect(computeSplits([], [])).toEqual([]);
    expect(computeSplits([0], [0])).toEqual([]);
    expect(computeSplits([0, 0, 0], [0, 1, 2])).toEqual([]);
    // Une seule distance mesurée : aucun intervalle exploitable.
    expect(computeSplits([0, null, null], [0, 1, 2])).toEqual([]);
    expect(computeSplits([null, null], [0, 1])).toEqual([]);
    // 80 m : pas même un split partiel.
    const tiny = steady(21, 4);
    expect(computeSplits(tiny.distance, tiny.time)).toEqual([]);
  });
});
