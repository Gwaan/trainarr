import { describe, expect, it } from 'vitest';

import type { TrainingSnapshotDto } from '@/data/coach-context';
import type { PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

import {
  formatCivilDate,
  formatDaysAgo,
  formatDistanceKm,
  formatDuration,
  formatIsoDay,
  formatNumber,
  formatPace,
  formatPlanSteps,
  formatSignedPercent,
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
});
