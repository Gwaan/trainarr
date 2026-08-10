import { describe, expect, it } from 'vitest';

import { cappedSampleDurationsS, sampleDurationCapS, weightedMean } from './series';

describe('sampleDurationCapS', () => {
  it('vaut trois pas médians', () => {
    expect(sampleDurationCapS([0, 1, 2, 3, 4])).toBe(3);
    expect(sampleDurationCapS([0, 5, 10, 15])).toBe(15);
  });

  it('ignore le trou pour établir le pas de référence', () => {
    // Un seul trou de 300 s au milieu d'une série à 1 Hz ne déplace pas la
    // médiane : le plafond reste celui de l'échantillonnage réel.
    const time = [0, 1, 2, 3, 303, 304, 305, 306];
    expect(sampleDurationCapS(time)).toBe(3);
  });

  it('ne descend jamais sous la seconde', () => {
    expect(sampleDurationCapS([0, 0.1, 0.2, 0.3])).toBe(1);
    expect(sampleDurationCapS([])).toBe(1);
    expect(sampleDurationCapS([0, 0, 0])).toBe(1);
  });
});

describe('cappedSampleDurationsS', () => {
  it('somme exactement la durée écoulée quand rien n’est plafonné', () => {
    const time = [0, 1, 2, 3, 4, 5];
    const durations = cappedSampleDurationsS(time);

    expect(durations.reduce((sum, value) => sum + value, 0)).toBe(5);
  });

  it('donne un demi-intervalle aux extrémités et la demi-somme au milieu', () => {
    expect(cappedSampleDurationsS([0, 2, 6])).toEqual([1, 3, 2]);
  });

  it('attribue la durée réelle à un point isolé par un échantillonnage large', () => {
    // Le plafond est relatif à la série : à 60 s de pas, 60 s est le régime
    // normal, pas un trou.
    const durations = cappedSampleDurationsS([0, 60, 120]);
    expect(durations[1]).toBe(60);
  });

  it('n’attribue à personne le temps d’un trou d’enregistrement', () => {
    // Auto-pause de 300 s dans une série à 1 Hz : la règle du point milieu
    // seule donnait 150,5 s à chacun des deux points qui l'encadrent.
    const time = [0, 1, 2, 3, 303, 304, 305, 306];
    const durations = cappedSampleDurationsS(time);

    expect(durations[3]).toBe(3);
    expect(durations[4]).toBe(3);
    // 6 s enregistrées + le plafond consenti aux deux bords, loin des 306 s
    // écoulées.
    expect(durations.reduce((sum, value) => sum + value, 0)).toBe(11);
  });

  it('ne rend aucune durée pour une série vide ou d’un seul point', () => {
    expect(cappedSampleDurationsS([])).toEqual([]);
    expect(cappedSampleDurationsS([42])).toEqual([0]);
  });

  it('neutralise un intervalle non monotone plutôt que de retrancher du temps', () => {
    const durations = cappedSampleDurationsS([0, 10, 5, 20]);
    expect(durations.every((value) => value >= 0)).toBe(true);
  });
});

describe('weightedMean', () => {
  it('pondère par la durée, pas par le nombre de points', () => {
    // 10 pendant 1 s puis 20 pendant 9 s : la moyenne temporelle est 19.
    const mean = weightedMean([10, 20], [1, 9], 0, 2);
    expect(mean).toBe(19);
  });

  it('ignore les valeurs non finies', () => {
    expect(weightedMean([10, Number.NaN, 20], [1, 1, 1], 0, 3)).toBe(15);
  });

  it('retombe sur la moyenne arithmétique si le poids total est nul', () => {
    expect(weightedMean([10, 20], [0, 0], 0, 2)).toBe(15);
  });

  it('rend null sur une plage vide', () => {
    expect(weightedMean([10, 20], [1, 1], 1, 1)).toBeNull();
  });
});
