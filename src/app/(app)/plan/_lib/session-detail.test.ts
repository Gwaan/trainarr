import { describe, expect, it } from 'vitest';

import type { PlanSessionDto } from '@/data/plans';
import { PLAN_STEP_ROLES, type PlanSessionSteps, type PlanStep } from '@/lib/plan-steps/schema';

import {
  PLAN_STEP_ROLE_LABELS,
  PLAN_STEP_ROLE_STYLES,
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

  it('rend des battements dès que la FC max est connue', () => {
    // C'est ce qui se surveille au poignet : « Z2 » ne dit rien à qui court.
    expect(formatStepTarget(step({ hrZone: 2 }), 184)).toBe('120–145 bpm');
  });

  it('retombe sur le rang de zone quand rien n’est calculable', () => {
    expect(formatStepTarget(step({ hrZone: 2 }), null)).toBe('Z2');
    // Zone sans créneau de prescription déclaré : rien n'est inventé.
    expect(formatStepTarget(step({ hrZone: 4 }), 184)).toBe('Z4');
  });

  it('rend null quand l’étape n’a pas de cible', () => {
    expect(formatStepTarget(step())).toBeNull();
  });
});

/**
 * L'affichage d'une séance d'endurance prescrite en fréquence cardiaque.
 *
 * La règle, décidée avec l'athlète : **la cible FC en premier, l'allure en
 * indication**. C'est la FC qu'on suit en courant ; l'allure ne sert plus qu'à
 * situer le temps que la séance prendra, et le `~` le dit.
 */
describe('séance prescrite en fréquence cardiaque', () => {
  /** Un footing de 7 km prescrit en zone 2, avec son allure indicative. */
  const easy = session({
    kind: 'Endurance fondamentale',
    title: 'Footing en endurance',
    volumeM: 7000,
    durationS: 3000,
    targetPaceSecPerKm: 428,
    steps: [{ repeat: 1, steps: [step({ distanceM: 7000, hrZone: 2 })] }],
  });

  it('annonce la cible FC avant l’allure sur la ligne repliée', () => {
    expect(planSessionSummary(easy, 184)).toEqual([
      '7 km',
      '50 min',
      '120–145 bpm',
      '~7:08/km',
    ]);
  });

  it('nomme l’allure « indicative » dans le récapitulatif, cible FC devant', () => {
    expect(planSessionDetail(easy, 184).totals).toEqual([
      { label: 'Distance', value: '7 km' },
      { label: 'Durée', value: '50 min' },
      { label: 'Cible FC', value: '120–145 bpm' },
      { label: 'Allure indicative', value: '~7:08/km' },
    ]);
  });

  it('garde l’allure cible telle quelle sans FC max — le repli', () => {
    expect(planSessionSummary(easy, null)).toEqual(['7 km', '50 min', '@ 7:08/km']);
    expect(planSessionDetail(easy, null).totals).toEqual([
      { label: 'Distance', value: '7 km' },
      { label: 'Durée', value: '50 min' },
      { label: 'Allure cible', value: '7:08/km' },
    ]);
  });

  it('n’annonce aucune cible FC de séance quand les étapes n’en partagent pas une', () => {
    // Une sortie longue spécifique : son corps est en FC, son bloc à allure
    // objectif reste en allure. Aucune cible unique à annoncer — chaque étape
    // dit la sienne.
    const mixed = session({
      volumeM: 12000,
      targetPaceSecPerKm: 428,
      steps: [
        { repeat: 1, steps: [step({ distanceM: 9000, hrZone: 2 })] },
        {
          repeat: 1,
          steps: [step({ distanceM: 3000, paceMinSecPerKm: 295, paceMaxSecPerKm: 320 })],
        },
      ],
    });

    expect(planSessionSummary(mixed, 184)).toEqual(['12 km', '@ 7:08/km']);
  });

  it('ignore les étapes qui ne sont pas du corps de séance', () => {
    // Échauffement et récupération n'ont pas voix au chapitre : la cible de la
    // séance est celle de sa course.
    const withEnvelope = session({
      volumeM: 8000,
      steps: [
        { repeat: 1, steps: [step({ role: 'warmup', distanceM: 1000 })] },
        { repeat: 1, steps: [step({ distanceM: 7000, hrZone: 2 })] },
      ],
    });

    expect(planSessionSummary(withEnvelope, 184)).toEqual(['8 km', '120–145 bpm']);
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
      { role: 'warmup', label: 'Échauffement', value: '15 min souple' },
      { role: 'cooldown', label: 'Retour au calme', value: '10 min footing' },
    ]);
    expect(detail.isEmpty).toBe(false);
  });

  it('se déclare vide quand il n’y a ni déroulé ni consigne', () => {
    // Le volume seul est déjà sur la ligne repliée : rien à déplier.
    expect(planSessionDetail(session({ volumeM: 10_000 })).isEmpty).toBe(true);
  });

  it('rattache le texte libre de récupération au rôle d’étape correspondant', () => {
    // `recovery` (colonne) et `recover` (rôle d'étape) ne portent pas le même
    // nom : c'est le rôle qui décide de la couleur de la brique.
    expect(planSessionDetail(session({ recovery: '400 m en trottinant' })).notes).toEqual([
      { role: 'recover', label: 'Récupération', value: '400 m en trottinant' },
    ]);
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

describe('PLAN_STEP_ROLE_STYLES', () => {
  it('donne à chaque rôle sa couleur — tokens du système, aucun hex', () => {
    expect(PLAN_STEP_ROLE_STYLES).toEqual({
      warmup: { rail: 'bg-positive', label: 'text-positive' },
      run: { rail: 'bg-accent', label: 'text-accent' },
      recover: { rail: 'bg-chart-cadence', label: 'text-chart-cadence' },
      cooldown: { rail: 'bg-chart-stride', label: 'text-chart-stride' },
    });
  });

  it('ne pose la couleur que sur le rail et le libellé, jamais en fond', () => {
    // La refonte visuelle tient à ça : aucun aplat de fond teinté sous une
    // étape (`bg-<token>/10`), sinon on revient aux briques d'avant.
    for (const style of Object.values(PLAN_STEP_ROLE_STYLES)) {
      expect(style.rail).toMatch(/^bg-[a-z-]+$/);
      expect(style.label).toMatch(/^text-[a-z-]+$/);
    }
  });

  it('couvre tous les rôles du contrat, sans teinte partagée', () => {
    expect(Object.keys(PLAN_STEP_ROLE_STYLES).sort()).toEqual([...PLAN_STEP_ROLES].sort());

    const labels = Object.values(PLAN_STEP_ROLE_STYLES).map((style) => style.label);
    expect(new Set(labels).size).toBe(PLAN_STEP_ROLES.length);
  });
});
