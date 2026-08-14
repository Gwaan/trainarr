import { describe, expect, it } from 'vitest';

import {
  RESTING_HR_MIN_SAMPLE,
  RESTING_HR_REPROPOSE_DELTA_BPM,
  RESTING_HR_SUGGESTION_DELTA_BPM,
  medianRestingHrBpm,
  restingHrSuggestionBpm,
  type RestingHrSuggestionInput,
} from './resting-hr';

const BOUNDS = { min: 25, max: 100 };

/** Une entrée complète, dont chaque test ne change que ce qu'il éprouve. */
function input(overrides: Partial<RestingHrSuggestionInput> = {}): RestingHrSuggestionInput {
  return {
    values: [46, 47, 47, 48, 49],
    profileBpm: 55,
    maxHrBpm: 188,
    dismissedBpm: null,
    bounds: BOUNDS,
    ...overrides,
  };
}

describe('medianRestingHrBpm', () => {
  it('rend la valeur centrale d’un nombre impair de nuits', () => {
    expect(medianRestingHrBpm([52, 47, 49, 48, 51])).toBe(49);
  });

  it('moyenne les deux valeurs centrales d’un nombre pair, arrondies au battement', () => {
    // 47 et 48 au centre : 47,5 → 48.
    expect(medianRestingHrBpm([44, 47, 48, 52, 46, 49])).toBe(48);
  });

  it('résiste à une nuit aberrante — c’est toute la raison d’être de la médiane', () => {
    const normales = [47, 48, 47, 49, 48];
    expect(medianRestingHrBpm(normales)).toBe(48);
    // Une seule nuit à 72 (fièvre, verre de vin, ceinture qui décroche) ne
    // déplace pas la médiane. Une moyenne, elle, passerait à 51,8.
    expect(medianRestingHrBpm([...normales, 72])).toBe(48);
  });

  it('ne rend rien sous le nombre minimal de nuits', () => {
    const values = Array.from({ length: RESTING_HR_MIN_SAMPLE - 1 }, () => 48);
    expect(medianRestingHrBpm(values)).toBeNull();
    expect(medianRestingHrBpm([...values, 48])).toBe(48);
  });

  it('ne modifie pas la série qu’on lui passe', () => {
    const values = [52, 47, 49, 48, 51];
    medianRestingHrBpm(values);
    expect(values).toEqual([52, 47, 49, 48, 51]);
  });
});

describe('restingHrSuggestionBpm — les deux sens', () => {
  it('propose une baisse quand la médiane descend sous le profil', () => {
    expect(restingHrSuggestionBpm(input({ values: [46, 47, 47, 48, 49], profileBpm: 55 }))).toBe(47);
  });

  it('propose une hausse quand la médiane remonte au-dessus du profil', () => {
    // La différence avec la FC max, qui ne se propose jamais à la baisse : une
    // FC de repos qui remonte est une information, pas un défaut de mesure.
    expect(restingHrSuggestionBpm(input({ values: [56, 57, 58, 58, 60], profileBpm: 50 }))).toBe(58);
  });

  it('ne propose rien sous le seuil d’écart, dans un sens comme dans l’autre', () => {
    const justeEnDessous = RESTING_HR_SUGGESTION_DELTA_BPM - 1;
    expect(
      restingHrSuggestionBpm(input({ values: [48, 48, 48, 48, 48], profileBpm: 48 + justeEnDessous })),
    ).toBeNull();
    expect(
      restingHrSuggestionBpm(input({ values: [48, 48, 48, 48, 48], profileBpm: 48 - justeEnDessous })),
    ).toBeNull();
  });

  it('propose à l’écart exact du seuil', () => {
    expect(
      restingHrSuggestionBpm(
        input({ values: [48, 48, 48, 48, 48], profileBpm: 48 + RESTING_HR_SUGGESTION_DELTA_BPM }),
      ),
    ).toBe(48);
  });

  it('propose la première médiane fiable quand le profil n’a pas de FC de repos', () => {
    expect(restingHrSuggestionBpm(input({ profileBpm: null }))).toBe(47);
  });
});

describe('restingHrSuggestionBpm — ce qu’il ne propose jamais', () => {
  it('ne propose rien sans assez de nuits mesurées', () => {
    expect(restingHrSuggestionBpm(input({ values: [40, 41] }))).toBeNull();
  });

  it('ne propose rien hors des bornes du profil : le formulaire le refuserait', () => {
    expect(
      restingHrSuggestionBpm(input({ values: [20, 21, 22, 22, 23], profileBpm: 55 })),
    ).toBeNull();
    expect(
      restingHrSuggestionBpm(input({ values: [110, 112, 113, 114, 115], profileBpm: 55 })),
    ).toBeNull();
  });

  it('ne propose jamais une valeur qui atteindrait la FC max : la réserve deviendrait nulle', () => {
    expect(
      restingHrSuggestionBpm(
        input({ values: [95, 96, 96, 97, 98], profileBpm: 55, maxHrBpm: 96, bounds: BOUNDS }),
      ),
    ).toBeNull();
  });

  it('accepte une médiane sous une FC max absente : rien à contredire', () => {
    expect(restingHrSuggestionBpm(input({ maxHrBpm: null }))).toBe(47);
  });
});

describe('restingHrSuggestionBpm — le refus', () => {
  it('ne repropose pas la valeur écartée', () => {
    expect(restingHrSuggestionBpm(input({ dismissedBpm: 47 }))).toBeNull();
  });

  it('ne repropose pas une valeur trop proche de celle écartée', () => {
    const proche = 47 + RESTING_HR_REPROPOSE_DELTA_BPM - 1;
    expect(restingHrSuggestionBpm(input({ dismissedBpm: proche }))).toBeNull();
  });

  it('repropose dès que la médiane s’écarte assez de la valeur écartée', () => {
    // Un seuil directionnel — la mécanique de la FC max — aurait enterré cette
    // proposition-là : elle est du même côté que celle qui a été refusée.
    expect(
      restingHrSuggestionBpm(input({ dismissedBpm: 47 + RESTING_HR_REPROPOSE_DELTA_BPM })),
    ).toBe(47);
  });

  it('repropose dans l’autre sens aussi', () => {
    expect(
      restingHrSuggestionBpm(
        input({ values: [56, 57, 58, 58, 60], profileBpm: 50, dismissedBpm: 47 }),
      ),
    ).toBe(58);
  });
});
