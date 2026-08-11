import { describe, expect, it } from 'vitest';

import type { TrainingSnapshotDto } from '@/data/coach-context';
import { trainingPacesFromRace } from '@/lib/metrics/vdot';
import type { PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

import {
  formatCivilDate,
  formatClockTime,
  formatDaysAgo,
  formatDistanceKm,
  formatDuration,
  formatWeeklySessionBudgets,
  formatWeeklyVolumeTargets,
  formatIsoDay,
  formatNumber,
  formatPace,
  formatPaceRange,
  formatPlanSteps,
  formatSignedPercent,
  formatTrainingPaces,
  formatTrainingSnapshot,
} from './format';

/** Une étape complète : le contrat porte ses sept clés, `null` pour absent. */
function step(role: PlanStepRole, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role,
    distanceM: null,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
    ...overrides,
  };
}

describe('formatNumber', () => {
  it('arrondit et rend la virgule décimale française', () => {
    expect(formatNumber(52.34, 1)).toBe('52,3');
    expect(formatNumber(52.36, 1)).toBe('52,4');
    expect(formatNumber(-8.4)).toBe('-8');
  });
});

describe('formatPace', () => {
  it('rend `m:ss/km`, secondes toujours sur deux chiffres', () => {
    expect(formatPace(258)).toBe('4:18/km');
    expect(formatPace(305)).toBe('5:05/km');
    expect(formatPace(300.4)).toBe('5:00/km');
  });
});

describe('formatDistanceKm', () => {
  it('rend des kilomètres au dixième', () => {
    expect(formatDistanceKm(18_240)).toBe('18,2 km');
    expect(formatDistanceKm(1_609.34)).toBe('1,6 km');
  });
});

describe('formatDuration', () => {
  it('choisit son unité selon la durée', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(2_880)).toBe('48 min');
    expect(formatDuration(3_900)).toBe('1 h 05');
  });
});

describe('formatIsoDay', () => {
  it('nomme les jours ISO, lundi = 1', () => {
    expect(formatIsoDay(1)).toBe('lundi');
    expect(formatIsoDay(7)).toBe('dimanche');
  });

  it('ne prétend pas nommer un jour hors bornes', () => {
    expect(formatIsoDay(9)).toBe('jour 9');
  });
});

describe('formatCivilDate', () => {
  it('rend la date en toutes lettres, sans décalage de fuseau', () => {
    expect(formatCivilDate('2026-08-17')).toBe('lundi 17 août 2026');
    expect(formatCivilDate('2026-01-01')).toBe('jeudi 1 janvier 2026');
  });
});

describe('formatSignedPercent', () => {
  it('porte toujours le signe : il est le sens de la mesure', () => {
    expect(formatSignedPercent(4.21)).toBe('+4,2 %');
    expect(formatSignedPercent(-1.5)).toBe('-1,5 %');
  });
});

describe('formatDaysAgo', () => {
  it('situe la sortie dans le passé', () => {
    expect(formatDaysAgo('2026-08-11', '2026-08-11')).toBe("aujourd'hui");
    expect(formatDaysAgo('2026-08-10', '2026-08-11')).toBe('hier');
    expect(formatDaysAgo('2026-07-30', '2026-08-11')).toBe('il y a 12 jours');
  });
});

describe('formatPlanSteps', () => {
  it('rend une séance de qualité sur une ligne, répétitions comprises', () => {
    const text = formatPlanSteps([
      { repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] },
      {
        repeat: 6,
        steps: [
          step('run', { distanceM: 400, paceMinSecPerKm: 220, paceMaxSecPerKm: 220 }),
          step('recover', { durationS: 90 }),
        ],
      },
      { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
    ]);

    expect(text).toBe(
      'échauffement 900 s @ Z2 + 6 × (400 m @ 3:40/km + récup 90 s) + retour au calme 600 s',
    );
  });

  it('rend une fourchette d’allure sans répéter l’unité', () => {
    const text = formatPlanSteps([
      { repeat: 3, steps: [step('run', { distanceM: 2_000, paceMinSecPerKm: 240, paceMaxSecPerKm: 250 })] },
    ]);

    expect(text).toBe('3 × (2000 m @ 4:00–4:10/km)');
  });

  it('rend les mesures dans les unités du contrat : mètres et secondes, sans virgule', () => {
    // Le modèle relit ce déroulé pour réécrire la séance : `2,0 km` recopié tel
    // quel dans `steps` produirait une sortie hors schéma.
    expect(formatPlanSteps([{ repeat: 1, steps: [step('recover', { durationS: 45 })] }])).toBe(
      'récup 45 s',
    );
    expect(formatPlanSteps([{ repeat: 1, steps: [step('recover', { durationS: 90 })] }])).toBe(
      'récup 90 s',
    );
    expect(formatPlanSteps([{ repeat: 1, steps: [step('run', { durationS: 150 })] }])).toBe('150 s');
    expect(formatPlanSteps([{ repeat: 1, steps: [step('run', { distanceM: 10_000 })] }])).toBe(
      '10000 m',
    );
  });

  it('n’annonce aucune cible quand l’étape n’en porte pas', () => {
    expect(formatPlanSteps([{ repeat: 1, steps: [step('run', { distanceM: 400 })] }])).toBe('400 m');
  });
});

const SNAPSHOT: TrainingSnapshotDto = {
  today: '2026-08-11',
  profile: { ageYears: 36, sex: 'female', maxHrBpm: 188, restingHrBpm: 48, weightKg: 62 },
  fitness: { ctl: 52.4, atl: 61.2, tsb: -8.8 },
  vo2max: 48.62,
  weeks: [
    { startsOn: '2026-07-20', distanceKm: 42.15, movingTimeS: 13_500, sessions: 4 },
    { startsOn: '2026-07-27', distanceKm: 0, movingTimeS: 0, sessions: 0 },
  ],
  recentAvgPaceSecPerKm: 324,
};

describe('formatTrainingSnapshot', () => {
  it('rend les chiffres clés, profil compris', () => {
    const text = formatTrainingSnapshot(SNAPSHOT);

    expect(text).toContain('36 ans');
    expect(text).toContain('FC max 188 bpm');
    expect(text).toContain('CTL 52 · ATL 61 · TSB -9');
    expect(text).toContain('VO2max estimée : 48,6');
    expect(text).toContain('semaine du 2026-07-20 : 42,1 km · 3 h 45 · 4 séances');
    expect(text).toContain('semaine du 2026-07-27 : 0,0 km · 0 s · 0 séance');
    expect(text).toContain('5:24/km');
  });

  it("dit ce qui n'est pas calculable au lieu de l'omettre ou de l'inventer", () => {
    const text = formatTrainingSnapshot({
      today: '2026-08-11',
      profile: {},
      fitness: null,
      vo2max: null,
      weeks: [],
      recentAvgPaceSecPerKm: null,
    });

    expect(text).toContain('Profil : non renseigné.');
    expect(text).toContain('Charge (CTL/ATL/TSB) : non calculable');
    expect(text).toContain('VO2max estimée : non calculable.');
    expect(text).toContain('Allure de référence : inconnue');
    expect(text).not.toContain('null');
  });

  it('ne mentionne pas un champ de profil absent', () => {
    const text = formatTrainingSnapshot({ ...SNAPSHOT, profile: { maxHrBpm: 188 } });

    expect(text).toBe(
      [
        'Profil : FC max 188 bpm.',
        'Charge : CTL 52 · ATL 61 · TSB -9.',
        'VO2max estimée : 48,6.',
        'Volume de course des dernières semaines :',
        '- semaine du 2026-07-20 : 42,1 km · 3 h 45 · 4 séances',
        '- semaine du 2026-07-27 : 0,0 km · 0 s · 0 séance',
        'Allure moyenne des dernières sorties : 5:24/km.',
      ].join('\n'),
    );
  });

  /**
   * L'ancre parasite diagnostiquée en production : le modèle calait les allures
   * d'un plan sur cette moyenne d'entraînement lente au lieu d'appliquer la
   * table VDOT. Les prompts de plan qui portent une table la retirent donc.
   */
  it('retire l’allure moyenne des dernières sorties à la demande', () => {
    const text = formatTrainingSnapshot(SNAPSHOT, { withRecentPace: false });

    expect(text).not.toContain('Allure moyenne des dernières sorties');
    // Et rien d'autre ne bouge : la charge et les volumes calent les séances.
    expect(text).toContain('CTL 52 · ATL 61 · TSB -9');
    expect(text).toContain('semaine du 2026-07-20 : 42,1 km · 3 h 45 · 4 séances');
  });

  it('retire aussi la ligne quand il n’y a pas d’allure connue', () => {
    // Sans cela, un contexte censé n'en rien dire annoncerait quand même une
    // « allure de référence », inconnue mais présente.
    const text = formatTrainingSnapshot(
      { ...SNAPSHOT, recentAvgPaceSecPerKm: null },
      { withRecentPace: false },
    );

    expect(text).not.toContain('Allure de référence');
  });

  it('garde la ligne par défaut : le feedback la commente', () => {
    expect(formatTrainingSnapshot(SNAPSHOT, {})).toContain(
      'Allure moyenne des dernières sorties : 5:24/km.',
    );
  });
});

describe('formatClockTime', () => {
  it('écrit un chrono comme une montre : mm:ss, hh:mm:ss au-delà de l’heure', () => {
    expect(formatClockTime(2_910)).toBe('48:30');
    expect(formatClockTime(90)).toBe('1:30');
    expect(formatClockTime(6_720)).toBe('1:52:00');
    expect(formatClockTime(14_112)).toBe('3:55:12');
  });
});

describe('formatTrainingPaces', () => {
  /** 10 km en 48:30 — la table que `lib/metrics/vdot` calcule pour ce chrono. */
  const paces = trainingPacesFromRace(10_000, 2_910);

  it('donne la table complète, chrono et VDOT en tête', () => {
    expect(formatTrainingPaces(paces, { distance: '10k', timeS: 2_910 })).toBe(
      [
        'Chrono de référence : 10 km en 48:30 → VDOT 41,5.',
        '- E (endurance fondamentale, sortie longue) : 5:56–6:32/km',
        '- M (allure marathon, allure objectif) : 5:08–5:37/km',
        '- T (seuil) : 4:57–5:11/km',
        '- I (VMA) : 4:28–4:39/km',
        '- R (répétitions courtes) : 4:08–4:17/km',
      ].join('\n'),
    );
  });

  it('nomme la distance en toutes lettres, pas par sa clé', () => {
    const semi = formatTrainingPaces(trainingPacesFromRace(21_097.5, 6_720), {
      distance: 'half',
      timeS: 6_720,
    });

    expect(semi).toContain('Chrono de référence : semi-marathon en 1:52:00');
    expect(semi).not.toContain('half');
  });
});

describe('formatPaceRange', () => {
  it('ne répète pas l’unité sur une plage, et la tait sur une allure unique', () => {
    expect(formatPaceRange({ minSecPerKm: 300, maxSecPerKm: 320 })).toBe('5:00–5:20/km');
    expect(formatPaceRange({ minSecPerKm: 300, maxSecPerKm: 300 })).toBe('5:00/km');
  });
});

describe('formatWeeklySessionBudgets', () => {
  /** 7:30/km : les kilomètres et les minutes se lisent l'un dans l'autre. */
  const EASY_PACE = 450;

  /** Les lignes de semaines, sans l'en-tête qui les introduit. */
  function rows(text: string): string[] {
    return text.split('\n').slice(1);
  }

  it('tient une semaine sur une ligne, groupée par type de séance', () => {
    const text = formatWeeklySessionBudgets(
      [
        {
          weekNumber: 1,
          targetKm: 27.2,
          sessions: [
            { role: 'long', km: 8 },
            { role: 'quality', km: 4.5 },
            { role: 'easy', km: 3.4 },
            { role: 'easy', km: 3.4 },
            { role: 'easy', km: 3.4 },
            { role: 'easy', km: 3.5 },
          ],
        },
      ],
      6,
      EASY_PACE,
    );

    // Un chiffre par groupe, pas une ligne par séance : c'est ce qui rend la
    // décomposition payable sur seize semaines.
    expect(rows(text)).toEqual([
      'S1 (~27,2 km) : SL sam ~8,0 km ≈ 1 h 00 · qualité ~4,5 km · 4 footings ~3,4 km ≈ 26 min',
    ]);
  });

  it('écrit le compte au pluriel seulement, et nomme le jour de la sortie longue', () => {
    const text = formatWeeklySessionBudgets(
      [
        {
          weekNumber: 7,
          targetKm: 20,
          sessions: [
            { role: 'long', km: 9 },
            { role: 'quality', km: 4 },
            { role: 'quality', km: 4 },
            { role: 'easy', km: 3 },
          ],
        },
      ],
      3,
      EASY_PACE,
    );

    expect(rows(text)).toEqual([
      'S7 (~20,0 km) : SL mer ~9,0 km ≈ 1 h 08 · 2 qualité ~4,0 km · footing ~3,0 km ≈ 23 min',
    ]);
  });

  /**
   * La durée d'une séance de qualité tient à sa structure — échauffement, blocs,
   * récupérations, retour au calme —, pas à son kilométrage : la convertir à
   * l'allure d'endurance annoncerait un tiers du temps réel.
   */
  it('ne convertit pas le groupe de qualité en minutes', () => {
    const text = formatWeeklySessionBudgets(
      [{ weekNumber: 1, targetKm: 20, sessions: [{ role: 'quality', km: 4.5 }] }],
      7,
      EASY_PACE,
    );

    expect(rows(text)).toEqual(['S1 (~20,0 km) : qualité ~4,5 km']);
  });

  it('n’écrit pas les groupes vides', () => {
    const text = formatWeeklySessionBudgets(
      [{ weekNumber: 2, targetKm: 10, sessions: [{ role: 'long', km: 6 }, { role: 'easy', km: 4 }] }],
      7,
      EASY_PACE,
    );

    expect(rows(text)).toEqual([
      'S2 (~10,0 km) : SL dim ~6,0 km ≈ 45 min · footing ~4,0 km ≈ 30 min',
    ]);
  });

  it('convertit à l’allure qu’on lui donne, pas à une allure supposée', () => {
    const text = formatWeeklySessionBudgets(
      [{ weekNumber: 1, targetKm: 10, sessions: [{ role: 'easy', km: 10 }] }],
      7,
      // 6:00/km : les mêmes 10 km valent 1 h 00, pas 1 h 15.
      360,
    );

    expect(rows(text)).toEqual(['S1 (~10,0 km) : footing ~10,0 km ≈ 1 h 00']);
  });

  it('dit que ces chiffres tombent sur la cible, pour qu’ils servent de départ', () => {
    const text = formatWeeklySessionBudgets(
      [{ weekNumber: 1, targetKm: 10, sessions: [{ role: 'long', km: 10 }] }],
      7,
      EASY_PACE,
    );

    const header = text.split('\n')[0];
    expect(header).toContain('ces chiffres tombent exactement sur la cible');
    // Et que les durées ne sont pas décoratives : c'est la longueur à écrire.
    expect(header).toContain('même si elles te paraissent courtes');
  });
});

describe('formatWeeklyVolumeTargets', () => {
  /** La ligne des chiffres, sans la consigne qui la suit. */
  function cells(text: string): string {
    return text.split('\n')[0];
  }

  it('tient toutes les semaines sur une ligne, kilomètres et temps', () => {
    expect(
      cells(
        formatWeeklyVolumeTargets([
          { targetKm: 14, targetMinutes: 116 },
          { targetKm: 15.4, targetMinutes: 124 },
        ]),
      ),
    ).toBe('Volumes hebdomadaires cibles (à ±10 %) : S1 ~14,0 km (≈1 h 56) · S2 ~15,4 km (≈2 h 04)');
  });

  it('imprime le dixième à toutes les distances, jamais l’entier', () => {
    // Le planificateur ne laisse qu'un dixième de marge sous ses plafonds : une
    // cible de 23,9 km imprimée « 24 km » et recopiée telle quelle fait refuser
    // le plan le plus obéissant qui soit (cf. le balayage de `plan-schema.test`).
    expect(formatWeeklyVolumeTargets([{ targetKm: 23.9, targetMinutes: 143 }])).toContain(
      'S1 ~23,9 km',
    );
    expect(formatWeeklyVolumeTargets([{ targetKm: 4.4, targetMinutes: 35 }])).toContain(
      'S1 ~4,4 km (≈35 min)',
    );
  });

  it('annonce la tolérance comme un filet, pas comme un espace de liberté', () => {
    expect(formatWeeklyVolumeTargets([{ targetKm: 14, targetMinutes: 116 }])).toContain(
      'Vise CHAQUE cible au plus près — la tolérance de ±10 % est un filet, pas un espace de liberté',
    );
  });

  it('numérote dans la numérotation du plan entier, pas dans celle de la tranche', () => {
    const line = formatWeeklyVolumeTargets(
      [
        { targetKm: 45, targetMinutes: 270 },
        { targetKm: 48, targetMinutes: 288 },
      ],
      7,
    );

    expect(line).toContain('S7 ~45,0 km');
    expect(line).toContain('S8 ~48,0 km');
  });
});
