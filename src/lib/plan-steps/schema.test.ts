import { describe, expect, it } from 'vitest';

import {
  flattenSteps,
  planSessionStepsSchema,
  sessionStepsTotals,
  type PlanSessionSteps,
  type PlanStep,
} from './schema';

/** Étape neutre : chaque test ne surcharge que ce qu'il éprouve. */
function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role: 'run',
    distanceM: 2_000,
    durationS: null,
    paceMinSecPerKm: 270,
    paceMaxSecPerKm: 280,
    hrZone: null,
    note: null,
    ...overrides,
  };
}

/** « 1 km d'échauffement, puis 3 × (2 km à 4:30–4:40 + 2 min de récup) ». */
const SESSION: PlanSessionSteps = [
  {
    repeat: 1,
    steps: [
      step({ role: 'warmup', distanceM: 1_000, paceMinSecPerKm: 330, paceMaxSecPerKm: 360 }),
    ],
  },
  {
    repeat: 3,
    steps: [
      step(),
      step({
        role: 'recover',
        distanceM: null,
        durationS: 120,
        paceMinSecPerKm: null,
        paceMaxSecPerKm: null,
        note: 'trot très souple',
      }),
    ],
  },
];

describe('planSessionStepsSchema', () => {
  it('accepte une séance d’intervalles complète', () => {
    expect(planSessionStepsSchema.safeParse(SESSION).success).toBe(true);
  });

  it('retire les clés inconnues plutôt que de les stocker', () => {
    const parsed = planSessionStepsSchema.parse([
      { repeat: 1, steps: [{ ...step(), watts: 320 }] },
    ]);

    expect(parsed[0].steps[0]).not.toHaveProperty('watts');
  });

  it('refuse une étape sans aucune mesure', () => {
    expect(
      planSessionStepsSchema.safeParse([{ repeat: 1, steps: [step({ distanceM: null })] }]).success,
    ).toBe(false);
  });

  it('refuse une étape mesurée à la fois en distance et en durée', () => {
    expect(
      planSessionStepsSchema.safeParse([{ repeat: 1, steps: [step({ durationS: 600 })] }]).success,
    ).toBe(false);
  });

  it('refuse une mesure nulle, négative ou hors d’échelle', () => {
    const refused = [
      step({ distanceM: 0 }),
      step({ distanceM: -1_000 }),
      step({ distanceM: 100_001 }),
      step({ distanceM: null, durationS: 0 }),
      step({ distanceM: null, durationS: 21_601 }),
      // Une durée s'exprime en secondes entières.
      step({ distanceM: null, durationS: 90.5 }),
    ];

    for (const invalid of refused) {
      expect(planSessionStepsSchema.safeParse([{ repeat: 1, steps: [invalid] }]).success).toBe(
        false,
      );
    }
  });

  it('exige les deux bornes d’allure, ou aucune', () => {
    expect(
      planSessionStepsSchema.safeParse([{ repeat: 1, steps: [step({ paceMaxSecPerKm: null })] }])
        .success,
    ).toBe(false);
    expect(
      planSessionStepsSchema.safeParse([{ repeat: 1, steps: [step({ paceMinSecPerKm: null })] }])
        .success,
    ).toBe(false);
  });

  it('accepte une allure unique (bornes égales) et refuse des bornes inversées', () => {
    expect(
      planSessionStepsSchema.safeParse([
        { repeat: 1, steps: [step({ paceMinSecPerKm: 270, paceMaxSecPerKm: 270 })] },
      ]).success,
    ).toBe(true);
    expect(
      planSessionStepsSchema.safeParse([
        { repeat: 1, steps: [step({ paceMinSecPerKm: 290, paceMaxSecPerKm: 270 })] },
      ]).success,
    ).toBe(false);
  });

  it('refuse une allure invraisemblable', () => {
    expect(
      planSessionStepsSchema.safeParse([
        { repeat: 1, steps: [step({ paceMinSecPerKm: 110, paceMaxSecPerKm: 120 })] },
      ]).success,
    ).toBe(false);
    expect(
      planSessionStepsSchema.safeParse([
        { repeat: 1, steps: [step({ paceMinSecPerKm: 700, paceMaxSecPerKm: 721 })] },
      ]).success,
    ).toBe(false);
  });

  it('refuse une étape ciblant à la fois une allure et une zone cardiaque', () => {
    expect(
      planSessionStepsSchema.safeParse([{ repeat: 1, steps: [step({ hrZone: 2 })] }]).success,
    ).toBe(false);
  });

  it('accepte une étape sans aucune cible', () => {
    expect(
      planSessionStepsSchema.safeParse([
        { repeat: 1, steps: [step({ paceMinSecPerKm: null, paceMaxSecPerKm: null })] },
      ]).success,
    ).toBe(true);
  });

  it('borne la zone cardiaque aux zones 1 à 5, en entier', () => {
    const withZone = (hrZone: number): PlanStep =>
      step({ hrZone, paceMinSecPerKm: null, paceMaxSecPerKm: null });

    expect(planSessionStepsSchema.safeParse([{ repeat: 1, steps: [withZone(1)] }]).success).toBe(
      true,
    );
    expect(planSessionStepsSchema.safeParse([{ repeat: 1, steps: [withZone(5)] }]).success).toBe(
      true,
    );
    expect(planSessionStepsSchema.safeParse([{ repeat: 1, steps: [withZone(0)] }]).success).toBe(
      false,
    );
    expect(planSessionStepsSchema.safeParse([{ repeat: 1, steps: [withZone(6)] }]).success).toBe(
      false,
    );
    expect(planSessionStepsSchema.safeParse([{ repeat: 1, steps: [withZone(2.5)] }]).success).toBe(
      false,
    );
  });

  it('refuse un rôle inconnu et une note vide', () => {
    expect(
      planSessionStepsSchema.safeParse([{ repeat: 1, steps: [{ ...step(), role: 'sprint' }] }])
        .success,
    ).toBe(false);
    expect(
      planSessionStepsSchema.safeParse([{ repeat: 1, steps: [step({ note: '' })] }]).success,
    ).toBe(false);
  });

  it('ramène une note sur une seule ligne, blancs écrasés', () => {
    // Un retour à la ligne ouvrirait une fausse étape à l'export intervals.icu,
    // et une ligne vide y découperait un bloc répété en deux.
    const parsed = planSessionStepsSchema.parse([
      { repeat: 1, steps: [step({ note: '  ligne1\nligne2\n\n2 km   souple ' })] },
    ]);

    expect(parsed[0].steps[0].note).toBe('ligne1 ligne2 2 km souple');
  });

  it('refuse une note qui ne contient que des blancs', () => {
    expect(
      planSessionStepsSchema.safeParse([{ repeat: 1, steps: [step({ note: ' \n ' })] }]).success,
    ).toBe(false);
  });

  it('borne les répétitions à 1..20, en entier', () => {
    expect(planSessionStepsSchema.safeParse([{ repeat: 0, steps: [step()] }]).success).toBe(false);
    expect(planSessionStepsSchema.safeParse([{ repeat: 21, steps: [step()] }]).success).toBe(false);
    expect(planSessionStepsSchema.safeParse([{ repeat: 1.5, steps: [step()] }]).success).toBe(
      false,
    );
  });

  it('exige au moins une étape par bloc, et au moins un bloc', () => {
    expect(planSessionStepsSchema.safeParse([{ repeat: 1, steps: [] }]).success).toBe(false);
    expect(planSessionStepsSchema.safeParse([]).success).toBe(false);
  });

  it('refuse une répétition imbriquée déguisée en étape', () => {
    expect(
      planSessionStepsSchema.safeParse([
        { repeat: 2, steps: [{ repeat: 3, steps: [step()] }] },
      ]).success,
    ).toBe(false);
  });
});

describe('flattenSteps', () => {
  it('déroule chaque bloc autant de fois qu’il se répète, dans l’ordre', () => {
    const flattened = flattenSteps(SESSION);

    expect(flattened).toHaveLength(7);
    expect(flattened.map((entry) => entry.role)).toEqual([
      'warmup',
      'run',
      'recover',
      'run',
      'recover',
      'run',
      'recover',
    ]);
  });

  it('laisse un bloc non répété tel quel', () => {
    expect(flattenSteps([{ repeat: 1, steps: [step(), step()] }])).toHaveLength(2);
  });
});

describe('sessionStepsTotals', () => {
  it('somme les distances en tenant compte des répétitions', () => {
    const totals = sessionStepsTotals([
      { repeat: 1, steps: [step({ distanceM: 1_000 })] },
      { repeat: 3, steps: [step({ distanceM: 2_000 }), step({ distanceM: 400 })] },
    ]);

    expect(totals.distanceM).toBe(8_200);
    expect(totals.durationS).toBeNull();
  });

  it('somme les durées de la même façon', () => {
    const runFor = (durationS: number): PlanStep => step({ distanceM: null, durationS });
    const totals = sessionStepsTotals([
      { repeat: 1, steps: [runFor(600)] },
      { repeat: 4, steps: [runFor(180), runFor(90)] },
    ]);

    expect(totals.durationS).toBe(1_680);
    expect(totals.distanceM).toBeNull();
  });

  it('ne totalise rien dès qu’une étape est mesurée dans l’autre unité', () => {
    // Le cas courant : 2 km d'effort, 2 min de récup. Ni la distance ni la durée
    // ne se déduisent sans supposer une allure — donc les deux sont `null`.
    expect(sessionStepsTotals(SESSION)).toEqual({ distanceM: null, durationS: null });
  });

  it('n’expose pas les artefacts de sommation des flottants', () => {
    const totals = sessionStepsTotals([
      { repeat: 3, steps: [step({ distanceM: 1_609.34 })] },
    ]);

    expect(totals.distanceM).toBe(4_828.02);
  });
});
