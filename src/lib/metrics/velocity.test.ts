import { describe, expect, it } from 'vitest';

import { deriveVelocity } from './velocity';

describe('deriveVelocity', () => {
  it('rend la vitesse moyenne de chaque intervalle mesuré', () => {
    const time = [0, 1, 2, 3];
    const distance = [0, 4, 8, 14];

    expect(deriveVelocity(distance, time)).toEqual([null, 4, 4, 6]);
  });

  it('laisse le premier point à null : aucun intervalle ne le précède', () => {
    expect(deriveVelocity([100, 104], [0, 1])).toEqual([null, 4]);
  });

  it('étale la moyenne sur un intervalle clairsemé, sans rien inventer entre-temps', () => {
    // Distance mesurée un point sur trois : la vitesse n'existe qu'aux index
    // mesurés, et vaut la moyenne des 3 s écoulées.
    const time = [0, 1, 2, 3, 4, 5, 6];
    const distance = [0, null, null, 12, null, null, 24];

    expect(deriveVelocity(distance, time)).toEqual([null, null, null, 4, null, null, 4]);
  });

  it('calcule le plafond de trou sur la cadence du canal distance, pas sur l’axe', () => {
    // Distance écrite un point sur cinq sur un axe à 1 Hz : 5 s d'écart entre
    // deux mesures est la cadence normale de ce canal, pas un trou.
    const time = Array.from({ length: 16 }, (_, index) => index);
    const distance = time.map((instant) => (instant % 5 === 0 ? instant * 3 : null));

    const velocity = deriveVelocity(distance, time);

    expect(velocity.filter((value) => value !== null)).toEqual([3, 3, 3]);
  });

  it('rend null au point de reprise après un trou d’enregistrement', () => {
    // Auto-pause : 60 s à 3 m/s, puis 300 s pendant lesquelles la montre n'écrit
    // rien et le GPS dérive de 5 m, puis reprise à 3 m/s. La moyenne de
    // l'intervalle de pause vaudrait 0,017 m/s — du temps que personne n'a couru.
    const time = [...Array.from({ length: 61 }, (_, index) => index), 360, 361, 362];
    const distance = [...Array.from({ length: 61 }, (_, index) => index * 3), 185, 188, 191];

    const velocity = deriveVelocity(distance, time);

    expect(velocity[60]).toBe(3);
    expect(velocity[61]).toBeNull();
    expect(velocity[62]).toBe(3);
    expect(velocity[63]).toBe(3);
  });

  it('refuse un intervalle sans durée ou dont la distance recule', () => {
    // Horodatage dupliqué, puis remise à zéro du cumul.
    expect(deriveVelocity([0, 4, 4, 1], [0, 1, 1, 2])).toEqual([null, 4, null, null]);
  });

  it('ignore les valeurs non finies comme des trous', () => {
    expect(deriveVelocity([0, Number.NaN, 8], [0, 1, 2])).toEqual([null, null, 4]);
  });

  it('rend un tableau de la longueur de « distance », même sans axe complet', () => {
    expect(deriveVelocity([0, 4, 8], [0, 1])).toEqual([null, 4, null]);
    expect(deriveVelocity([], [])).toEqual([]);
  });
});
