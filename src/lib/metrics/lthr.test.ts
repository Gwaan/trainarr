import { describe, expect, it } from 'vitest';

import {
  HR_KINETICS_LAG_S,
  LTHR_BOUNDS,
  LTHR_MIN_SESSIONS,
  LTHR_PLATEAU_MIN_S,
  LTHR_REPROPOSE_DELTA_BPM,
  LTHR_SUGGESTION_DELTA_BPM,
  THRESHOLD_BLOCK_MIN_S,
  TIME_TRIAL_TAIL_S,
  blockPlateauHrBpm,
  lthrCandidate,
  lthrSuggestion,
  medianLthrBpm,
  timeTrialLthrBpm,
} from './lthr';

/**
 * Série à 1 Hz de `[0, durationS]`, FC donnée par une fonction du temps —
 * `null` pour « la ceinture n'a rien dit à cet instant ».
 */
function series(
  durationS: number,
  hrAt: (second: number) => number | null,
  stepS = 1,
): { time: number[]; hr: (number | null)[] } {
  const time: number[] = [];
  const hr: (number | null)[] = [];
  for (let second = 0; second <= durationS; second += stepS) {
    time.push(second);
    hr.push(hrAt(second));
  }
  return { time, hr };
}

describe('blockPlateauHrBpm', () => {
  it('ne mesure que la seconde moitié du bloc — la première est une montée en régime', () => {
    // Un bloc de 10 min : le cœur monte de 140 à 172 pendant les 4 premières
    // minutes, puis tient son plateau. La moyenne du bloc entier donnerait 163 ;
    // seule la seconde moitié décrit l'intensité tenue.
    const { time, hr } = series(600, (second) => (second < 240 ? 140 : 172));

    expect(blockPlateauHrBpm(hr, time, { fromS: 0, toS: 600 })).toBe(172);
  });

  it('mesure bien un plateau réel, sans le raboter', () => {
    const { time, hr } = series(600, () => 168);

    expect(blockPlateauHrBpm(hr, time, { fromS: 0, toS: 600 })).toBe(168);
  });

  it('trouve le bloc là où il est, pas au début de la séance', () => {
    // Échauffement à 130 pendant 10 min, bloc de 10 min à 170, retour au calme.
    const { time, hr } = series(1_800, (second) => {
      if (second < 600) return 130;
      if (second < 1_200) return 170;
      return 125;
    });

    expect(blockPlateauHrBpm(hr, time, { fromS: 600, toS: 1_200 })).toBe(170);
  });

  it('refuse un bloc trop court pour porter un plateau', () => {
    const { time, hr } = series(THRESHOLD_BLOCK_MIN_S - 1, () => 170);

    expect(
      blockPlateauHrBpm(hr, time, { fromS: 0, toS: THRESHOLD_BLOCK_MIN_S - 1 }),
    ).toBeNull();
    // Le plancher lui-même passe : c'est une borne incluse.
    const long = series(THRESHOLD_BLOCK_MIN_S, () => 170);
    expect(
      blockPlateauHrBpm(long.hr, long.time, { fromS: 0, toS: THRESHOLD_BLOCK_MIN_S }),
    ).toBe(170);
  });

  it('rend la moitié mesurée au moins aussi longue que le plancher de plateau', () => {
    // La règle de la seconde moitié et le plancher de bloc sont liés : un bloc
    // au plancher livre exactement `LTHR_PLATEAU_MIN_S` de mesure.
    expect(THRESHOLD_BLOCK_MIN_S / 2).toBeGreaterThanOrEqual(LTHR_PLATEAU_MIN_S);
    // Et la seconde moitié dépasse toujours le temps de montée en régime.
    expect(THRESHOLD_BLOCK_MIN_S / 2).toBeGreaterThan(HR_KINETICS_LAG_S);
  });

  it('refuse un bloc sans la moindre mesure cardiaque', () => {
    const { time, hr } = series(600, () => null);

    expect(blockPlateauHrBpm(hr, time, { fromS: 0, toS: 600 })).toBeNull();
  });

  it('refuse une seconde moitié trop mal couverte — ceinture qui décroche', () => {
    // La ceinture lâche à mi-bloc et ne reparle que 100 s : la moyenne ne
    // décrirait plus la moitié mesurée mais ce fragment-là.
    const { time, hr } = series(600, (second) => {
      if (second < 300) return 150;
      return second < 400 ? 170 : null;
    });

    expect(blockPlateauHrBpm(hr, time, { fromS: 0, toS: 600 })).toBeNull();
  });

  it('accepte un canal clairsemé : une mesure toutes les dix secondes couvre le bloc', () => {
    // Le sous-axe des mesures a un pas de 10 s, pas de trou : la couverture est
    // pleine, et compter les points n'aurait rien changé au résultat.
    const { time, hr } = series(600, () => 171, 10);

    expect(blockPlateauHrBpm(hr, time, { fromS: 0, toS: 600 })).toBe(171);
  });

  it('pondère par le temps, pas par le nombre de points', () => {
    // Seconde moitié : 100 s à 160 bpm mesurées chaque seconde (101 points),
    // puis 200 s à 180 bpm mesurées une seconde sur deux (100 points). Compter
    // les points donnerait 170 — les deux paquets pèsent pareil ; le temps dit
    // 173, parce que le second dure deux fois plus longtemps.
    const time: number[] = [];
    const hr: (number | null)[] = [];
    for (let second = 0; second <= 400; second += 1) {
      time.push(second);
      hr.push(second < 300 ? 140 : 160);
    }
    for (let second = 402; second <= 600; second += 2) {
      time.push(second);
      hr.push(180);
    }

    expect(blockPlateauHrBpm(hr, time, { fromS: 0, toS: 600 })).toBe(173);
  });

  it('refuse une fenêtre absurde plutôt que d’en tirer un nombre', () => {
    const { time, hr } = series(600, () => 170);

    expect(blockPlateauHrBpm(hr, time, { fromS: 600, toS: 0 })).toBeNull();
    expect(blockPlateauHrBpm(hr, time, { fromS: 0, toS: Number.NaN })).toBeNull();
  });
});

describe('timeTrialLthrBpm', () => {
  it('retient les 20 dernières minutes d’un effort plus long — protocole Friel', () => {
    // 27 min d'effort : la FC monte pendant 7 min, puis tient 176. La fenêtre
    // des 20 dernières minutes ne voit que le plateau.
    const { time, hr } = series(1_620, (second) => (second < 420 ? 150 : 176));

    expect(timeTrialLthrBpm(hr, time, { fromS: 0, toS: 1_620 })).toBe(176);
  });

  it('retient tout l’effort sauf sa montée en régime quand il dure 20 min ou moins', () => {
    // 20 min pile : la fenêtre des 20 dernières minutes couvrirait la montée en
    // régime initiale, qui pèse un sixième du total et tirerait la moyenne vers
    // le bas. Les trois premières minutes sont donc écartées.
    const { time, hr } = series(TIME_TRIAL_TAIL_S, (second) =>
      second < HR_KINETICS_LAG_S ? 140 : 178,
    );

    expect(timeTrialLthrBpm(hr, time, { fromS: 0, toS: TIME_TRIAL_TAIL_S })).toBe(178);
  });

  it('mesure l’effort là où il est, pas depuis le départ de la séance', () => {
    // Échauffement de 10 min à 130, puis 22 min à fond à 174.
    const { time, hr } = series(2_000, (second) => (second < 600 ? 130 : 174));

    expect(timeTrialLthrBpm(hr, time, { fromS: 600, toS: 1_920 })).toBe(174);
  });

  it('refuse un effort trop court pour montrer un plateau', () => {
    // 6 min : une fois la montée en régime retranchée, il reste 3 min — sous le
    // plancher de plateau.
    const { time, hr } = series(360, () => 180);

    expect(timeTrialLthrBpm(hr, time, { fromS: 0, toS: 360 })).toBeNull();
    // Juste au-dessus du plancher, en revanche, ça passe.
    const enough = series(HR_KINETICS_LAG_S + LTHR_PLATEAU_MIN_S, () => 180);
    expect(
      timeTrialLthrBpm(enough.hr, enough.time, {
        fromS: 0,
        toS: HR_KINETICS_LAG_S + LTHR_PLATEAU_MIN_S,
      }),
    ).toBe(180);
  });

  it('refuse un effort sans fréquence cardiaque, et une fenêtre vide', () => {
    const { time, hr } = series(1_620, () => null);

    expect(timeTrialLthrBpm(hr, time, { fromS: 0, toS: 1_620 })).toBeNull();
    expect(timeTrialLthrBpm([], [], { fromS: 0, toS: 1_620 })).toBeNull();
    expect(timeTrialLthrBpm(hr, time, { fromS: 100, toS: 100 })).toBeNull();
  });
});

describe('medianLthrBpm', () => {
  it('rend la médiane, pas la moyenne : une séance par forte chaleur ne pèse pas double', () => {
    // 168, 170, 172 et une séance aberrante à 190 : la moyenne dirait 175.
    expect(medianLthrBpm([168, 170, 172, 190])).toBe(171);
  });

  it('arrondit au battement sur un nombre pair de mesures', () => {
    expect(medianLthrBpm([168, 171, 172, 174])).toBe(172); // (171 + 172) / 2 = 171,5
  });

  it('ne dépend pas de l’ordre des mesures', () => {
    expect(medianLthrBpm([172, 168, 170])).toBe(medianLthrBpm([168, 170, 172]));
  });

  it('refuse de conclure sous trois séances — un bloc isolé n’est pas un seuil', () => {
    expect(medianLthrBpm([170, 172])).toBeNull();
    expect(medianLthrBpm([])).toBeNull();
    expect(medianLthrBpm(Array.from({ length: LTHR_MIN_SESSIONS }, () => 170))).toBe(170);
  });

  it('écarte les valeurs qui ne sont pas des fréquences', () => {
    expect(medianLthrBpm([170, 172, 0, Number.NaN])).toBeNull();
  });
});

describe('lthrCandidate', () => {
  it('fait primer la médiane des blocs sur le test, et cite quand même le test', () => {
    const candidate = lthrCandidate({ blockValues: [170, 172, 174], timeTrialBpm: 180 });

    expect(candidate).toEqual({
      bpm: 172,
      source: 'threshold-blocks',
      blocksBpm: 172,
      sessionCount: 3,
      timeTrialBpm: 180,
    });
  });

  it('retombe sur le test tant qu’il n’y a pas assez de séances de seuil', () => {
    const candidate = lthrCandidate({ blockValues: [170, 172], timeTrialBpm: 176 });

    expect(candidate).toMatchObject({ bpm: 176, source: 'time-trial', blocksBpm: null });
    // Les séances déjà mesurées sont comptées, même si elles ne suffisent pas.
    expect(candidate?.sessionCount).toBe(2);
  });

  it('ne rend rien quand rien n’a été mesuré', () => {
    expect(lthrCandidate({ blockValues: [], timeTrialBpm: null })).toBeNull();
    expect(lthrCandidate({ blockValues: [170], timeTrialBpm: 0 })).toBeNull();
  });
});

describe('lthrSuggestion', () => {
  const MEASURED = { blockValues: [170, 172, 174], timeTrialBpm: null } as const;

  it('propose la première mesure quand le profil n’en porte aucune', () => {
    expect(
      lthrSuggestion({ ...MEASURED, profileBpm: null, maxHrBpm: 190, dismissedBpm: null }),
    ).toMatchObject({ bpm: 172, source: 'threshold-blocks' });
  });

  it('se tait tant que l’écart au profil reste dans le bruit de la mesure', () => {
    for (let profileBpm = 172 - (LTHR_SUGGESTION_DELTA_BPM - 1); profileBpm <= 172 + (LTHR_SUGGESTION_DELTA_BPM - 1); profileBpm += 1) {
      expect(
        lthrSuggestion({ ...MEASURED, profileBpm, maxHrBpm: 190, dismissedBpm: null }),
      ).toBeNull();
    }
  });

  it('propose dans les deux sens : un seuil monte avec la forme et redescend sans', () => {
    expect(
      lthrSuggestion({ ...MEASURED, profileBpm: 165, maxHrBpm: 190, dismissedBpm: null }),
    ).not.toBeNull();
    expect(
      lthrSuggestion({ ...MEASURED, profileBpm: 179, maxHrBpm: 190, dismissedBpm: null }),
    ).not.toBeNull();
  });

  it('ne repropose pas une valeur écartée, mais repropose ce qui s’en éloigne', () => {
    expect(
      lthrSuggestion({ ...MEASURED, profileBpm: null, maxHrBpm: 190, dismissedBpm: 172 }),
    ).toBeNull();
    expect(
      lthrSuggestion({
        ...MEASURED,
        profileBpm: null,
        maxHrBpm: 190,
        dismissedBpm: 172 + LTHR_REPROPOSE_DELTA_BPM,
      }),
    ).not.toBeNull();
  });

  it('refuse un seuil au-dessus de la FC max — ce n’est pas un seuil', () => {
    expect(
      lthrSuggestion({
        blockValues: [188, 190, 192],
        timeTrialBpm: null,
        profileBpm: null,
        maxHrBpm: 190,
        dismissedBpm: null,
      }),
    ).toBeNull();
  });

  it('refuse une valeur hors des bornes de plausibilité', () => {
    const below = LTHR_BOUNDS.min - 1;
    expect(
      lthrSuggestion({
        blockValues: [below, below, below],
        timeTrialBpm: null,
        profileBpm: null,
        maxHrBpm: null,
        dismissedBpm: null,
      }),
    ).toBeNull();
  });

  it('ne propose rien quand aucune séance n’a mesuré de seuil', () => {
    expect(
      lthrSuggestion({
        blockValues: [],
        timeTrialBpm: null,
        profileBpm: 172,
        maxHrBpm: 190,
        dismissedBpm: null,
      }),
    ).toBeNull();
  });
});
