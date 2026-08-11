import { describe, expect, it } from 'vitest';

import type { PlanSessionDto } from '@/data/plans';
import type { PlanSessionSteps, PlanStep } from '@/lib/plan-steps/schema';

import {
  PLAN_STEP_ROLE_LABELS,
  formatStepDistance,
  formatStepDuration,
  formatStepMeasure,
  formatStepTarget,
  planSessionDetail,
  planSessionSummary,
  planSessionTotals,
} from './session-detail';

/** Étape minimale : sans mesure ni cible, à compléter par le test. */
function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role: 'run',
    distanceM: null,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
    ...overrides,
  };
}

function session(overrides: Partial<PlanSessionDto> = {}): PlanSessionDto {
  return {
    id: 1,
    scheduledOn: '2026-08-18',
    kind: 'Endurance',
    title: 'Footing',
    warmup: null,
    recovery: null,
    cooldown: null,
    targetPaceSecPerKm: null,
    volumeM: null,
    durationS: null,
    steps: null,
    completedActivityId: null,
    ...overrides,
  };
}

describe('formatStepDistance', () => {
  it('reste en mètres sous le kilomètre', () => {
    expect(formatStepDistance(800)).toBe('800 m');
    expect(formatStepDistance(400)).toBe('400 m');
  });

  it('passe en kilomètres sans décimale inutile', () => {
    expect(formatStepDistance(1000)).toBe('1 km');
    expect(formatStepDistance(2000)).toBe('2 km');
    expect(formatStepDistance(2400)).toBe('2,4 km');
    expect(formatStepDistance(2450)).toBe('2,45 km');
  });
});

describe('formatStepDuration', () => {
  it('garde les secondes pour les durées courtes non rondes', () => {
    expect(formatStepDuration(45)).toBe('45 s');
    expect(formatStepDuration(90)).toBe('90 s');
  });

  it('affiche les minutes rondes en minutes', () => {
    expect(formatStepDuration(60)).toBe('1 min');
    expect(formatStepDuration(720)).toBe('12 min');
  });

  it('passe au chrono au-delà de dix minutes non rondes', () => {
    expect(formatStepDuration(750)).toBe('12:30');
    expect(formatStepDuration(3930)).toBe('1:05:30');
  });

  it('rend les longues durées rondes en heures', () => {
    expect(formatStepDuration(3900)).toBe('1 h 05');
  });
});

describe('formatStepMeasure', () => {
  it('rend la mesure portée par l’étape, distance ou durée', () => {
    expect(formatStepMeasure(step({ distanceM: 800 }))).toBe('800 m');
    expect(formatStepMeasure(step({ durationS: 90 }))).toBe('90 s');
  });

  it('rend null quand l’étape n’en porte aucune', () => {
    expect(formatStepMeasure(step())).toBeNull();
  });
});

describe('formatStepTarget', () => {
  it('rend une fourchette d’allure bornée par l’unité', () => {
    expect(
      formatStepTarget(step({ paceMinSecPerKm: 265, paceMaxSecPerKm: 275 })),
    ).toBe('4:25–4:35/km');
  });

  it('réduit une fourchette plate à une allure unique', () => {
    expect(
      formatStepTarget(step({ paceMinSecPerKm: 270, paceMaxSecPerKm: 270 })),
    ).toBe('4:30/km');
  });

  it('rend la zone cardiaque quand c’est elle la cible', () => {
    expect(formatStepTarget(step({ hrZone: 2 }))).toBe('Z2');
  });

  it('rend null quand l’étape n’a pas de cible', () => {
    expect(formatStepTarget(step())).toBeNull();
  });
});

describe('planSessionTotals', () => {
  const steps: PlanSessionSteps = [
    { repeat: 1, steps: [step({ role: 'warmup', distanceM: 2000 })] },
    { repeat: 3, steps: [step({ distanceM: 1000 })] },
  ];

  it('somme le déroulé quand le plan n’annonce rien', () => {
    expect(planSessionTotals(session({ steps }))).toEqual({
      distanceM: 5000,
      durationS: null,
    });
  });

  it('laisse la priorité au volume annoncé par le plan', () => {
    expect(planSessionTotals(session({ steps, volumeM: 6000 })).distanceM).toBe(6000);
  });

  it('n’invente rien quand les unités des étapes se mélangent', () => {
    const mixed: PlanSessionSteps = [
      { repeat: 1, steps: [step({ distanceM: 2000 }), step({ durationS: 120 })] },
    ];

    expect(planSessionTotals(session({ steps: mixed }))).toEqual({
      distanceM: null,
      durationS: null,
    });
  });
});

describe('planSessionSummary', () => {
  it('assemble ce qui est connu, dans l’ordre distance / durée / allure', () => {
    expect(
      planSessionSummary(
        session({ volumeM: 8400, durationS: 2700, targetPaceSecPerKm: 270 }),
      ),
    ).toEqual(['8,4 km', '45 min', '@ 4:30/km']);
  });

  it('rend une liste vide quand la séance ne chiffre rien', () => {
    expect(planSessionSummary(session())).toEqual([]);
  });
});

describe('planSessionDetail', () => {
  it('reprend les blocs dans l’ordre, répétitions comprises', () => {
    const detail = planSessionDetail(
      session({
        steps: [
          { repeat: 1, steps: [step({ role: 'warmup', distanceM: 2000, hrZone: 2 })] },
          {
            repeat: 6,
            steps: [
              step({
                distanceM: 800,
                paceMinSecPerKm: 225,
                paceMaxSecPerKm: 230,
                note: 'relâchée sur le haut du corps',
              }),
              step({ role: 'recover', durationS: 90 }),
            ],
          },
        ],
      }),
    );

    expect(detail.blocks).toEqual([
      {
        repeat: 1,
        steps: [
          {
            role: 'warmup',
            roleLabel: 'Échauffement',
            measure: '2 km',
            target: 'Z2',
            note: null,
          },
        ],
      },
      {
        repeat: 6,
        steps: [
          {
            role: 'run',
            roleLabel: 'Course',
            measure: '800 m',
            target: '3:45–3:50/km',
            note: 'relâchée sur le haut du corps',
          },
          {
            role: 'recover',
            roleLabel: 'Récupération',
            measure: '90 s',
            target: null,
            note: null,
          },
        ],
      },
    ]);
    expect(detail.isEmpty).toBe(false);
  });

  it('calcule les totaux du déroulé et l’allure cible annoncée', () => {
    const detail = planSessionDetail(
      session({
        targetPaceSecPerKm: 270,
        steps: [{ repeat: 2, steps: [step({ distanceM: 3000 })] }],
      }),
    );

    expect(detail.totals).toEqual([
      { label: 'Distance', value: '6 km' },
      { label: 'Allure cible', value: '4:30/km' },
    ]);
  });

  it('rend les textes libres des séances sans déroulé, dans l’ordre', () => {
    const detail = planSessionDetail(
      session({ warmup: '15 min souple', cooldown: '10 min footing' }),
    );

    expect(detail.blocks).toEqual([]);
    expect(detail.notes).toEqual([
      { label: 'Échauffement', value: '15 min souple' },
      { label: 'Retour au calme', value: '10 min footing' },
    ]);
    expect(detail.isEmpty).toBe(false);
  });

  it('se déclare vide quand il n’y a ni déroulé ni consigne', () => {
    // Le volume seul est déjà sur la ligne repliée : rien à déplier.
    expect(planSessionDetail(session({ volumeM: 10_000 })).isEmpty).toBe(true);
  });

  it('couvre les quatre rôles du schéma', () => {
    expect(Object.values(PLAN_STEP_ROLE_LABELS)).toEqual([
      'Échauffement',
      'Course',
      'Récupération',
      'Retour au calme',
    ]);
  });
});
