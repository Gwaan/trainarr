import { describe, expect, it } from 'vitest';

import { elevationChange, elevationMoves, ELEVATION_NOISE_THRESHOLD_M } from './elevation';
import { computeSplits } from './splits';

/**
 * Le dénivelé lu dans un flux d'altitude.
 *
 * L'invariant qui compte ici n'est pas le filtre lui-même mais son **unicité** :
 * le résumé d'une séance et le tableau de ses splits doivent compter les mêmes
 * mètres. Le dernier test le vérifie en confrontant les deux chemins sur la même
 * série — c'est la régression qui rendrait la fonctionnalité pire que le tiret
 * qu'elle remplace.
 */

describe('elevationMoves', () => {
  it('filtre le bruit de faible amplitude', () => {
    // ±40 cm autour de 100 m : l'oscillation d'un altimètre barométrique au
    // repos. Rien ne franchit le seuil, rien n'est retenu.
    const altitude = [100, 100.4, 99.6, 100.3, 99.7, 100.2];

    expect(elevationMoves(altitude)).toEqual([]);
  });

  it('retient une montée réelle, dans un seul mouvement quand elle est franche', () => {
    expect(elevationMoves([100, 103])).toEqual([{ index: 1, deltaM: 3 }]);
  });

  it('accumule une pente douce au lieu de la perdre', () => {
    // 30 cm par point sur 3 m de montée : aucun pas ne franchit le seuil, mais
    // le repère reste le dernier point **retenu** — la montée est donc comptée,
    // par paliers de 1,2 m. Comparer chaque point à son prédécesseur n'aurait
    // rien retenu du tout.
    const altitude = Array.from({ length: 11 }, (_, index) => 100 + index * 0.3);

    const total = elevationMoves(altitude).reduce((sum, move) => sum + move.deltaM, 0);
    // 2,4 et non 3 : les 60 cm de queue n'ont pas franchi le seuil depuis le
    // dernier repère. C'est le prix du filtre, et il est symétrique — le bruit
    // ne rentre pas, la queue d'une vraie montée sort.
    expect(total).toBeCloseTo(2.4, 6);
  });

  it('compte les descentes, signées', () => {
    expect(elevationMoves([100, 96, 99])).toEqual([
      { index: 1, deltaM: -4 },
      { index: 2, deltaM: 3 },
    ]);
  });

  it('saute les `null` sans décaler les index', () => {
    // Canal clairsemé : le capteur n'a rien dit aux index 1 et 2. La variation
    // est constatée à l'index 3, celui de l'axe commun à tous les canaux.
    expect(elevationMoves([100, null, null, 105])).toEqual([{ index: 3, deltaM: 5 }]);
  });

  it('borne le balayage aux index demandés', () => {
    const altitude = [100, 110, 120, 130];

    // `[1, 3)` : le premier point retenu sert de repère, la seule variation
    // comptée est celle de 110 à 120.
    expect(elevationMoves(altitude, 1, 3)).toEqual([{ index: 2, deltaM: 10 }]);
  });

  it('exclut les valeurs non finies plutôt que de les propager', () => {
    expect(elevationMoves([100, Number.NaN, 104])).toEqual([{ index: 2, deltaM: 4 }]);
  });

  it('n’ouvre le seuil qu’à partir de sa valeur, pas en dessous', () => {
    const justUnder = ELEVATION_NOISE_THRESHOLD_M - 0.01;

    expect(elevationMoves([100, 100 + justUnder])).toEqual([]);
    expect(elevationMoves([100, 100 + ELEVATION_NOISE_THRESHOLD_M])).toHaveLength(1);
  });
});

describe('elevationChange', () => {
  it('rend les deux sens, la perte en amplitude positive', () => {
    expect(elevationChange([100, 110, 104])).toEqual({ gainM: 10, lossM: 6 });
  });

  it('rend zéro sur un vrai plat — c’est une mesure', () => {
    expect(elevationChange([100, 100.2, 99.9, 100.1])).toEqual({ gainM: 0, lossM: 0 });
  });

  it('rend `null` sous deux mesures exploitables — ce n’est pas un plat', () => {
    // La nuance décide de ce qui est écrit en base : `NULL` (l'écran garde son
    // tiret) plutôt qu'un zéro inventé.
    expect(elevationChange([])).toBeNull();
    expect(elevationChange([100])).toBeNull();
    expect(elevationChange([null, null, 100, null])).toBeNull();
  });

  it('ne déduit jamais la perte du gain', () => {
    // Une montée sèche, sans redescente enregistrée : la perte vaut zéro, elle
    // n'est pas recopiée du gain sous prétexte que la sortie « devait » boucler.
    expect(elevationChange([100, 130])).toEqual({ gainM: 30, lossM: 0 });
  });
});

describe('accord avec les splits', () => {
  it('somme des D+ par kilomètre = D+ total de la séance', () => {
    // Trois kilomètres à 1 point tous les 100 m, avec du relief et du bruit :
    // une montée à cheval sur la borne du km 1, une descente, un faux plat.
    const points = 31;
    const distance = Array.from({ length: points }, (_, index) => index * 100);
    const time = Array.from({ length: points }, (_, index) => index * 30);
    const altitude = distance.map((metres, index) => {
      const profile = metres < 1_500 ? metres / 100 : (3_000 - metres) / 100;
      // Bruit sous le seuil : il ne doit apparaître d'aucun des deux côtés.
      return 100 + profile + (index % 2 === 0 ? 0.3 : -0.3);
    });

    const splits = computeSplits(distance, time, undefined, altitude);
    const perSplit = splits.reduce((sum, split) => sum + (split.elevationGainM ?? 0), 0);

    // Les deux chemins balaient la même série : le total doit coïncider. Le
    // balayage des splits s'arrête à la dernière borne kilométrique, qui est ici
    // le dernier point — les deux couvrent donc exactement la même tranche.
    expect(perSplit).toBeCloseTo(elevationChange(altitude)?.gainM ?? -1, 6);
  });
});
