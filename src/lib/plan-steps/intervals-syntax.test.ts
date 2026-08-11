import { describe, expect, it } from 'vitest';

import { stepsToIntervalsSyntax } from './intervals-syntax';
import { planSessionStepsSchema, type PlanSessionSteps, type PlanStep } from './schema';

/** Étape neutre : chaque test ne surcharge que ce qu'il éprouve. */
function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role: 'run',
    distanceM: 2_000,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
    ...overrides,
  };
}

/** Une séance d'un seul bloc non répété, pour éprouver une étape isolée. */
function serializeOne(overrides: Partial<PlanStep> = {}): string {
  return stepsToIntervalsSyntax([{ repeat: 1, steps: [step(overrides)] }]);
}

describe('stepsToIntervalsSyntax — intitulés', () => {
  it('nomme chaque rôle en français ASCII', () => {
    expect(serializeOne({ role: 'warmup' })).toBe('- Echauffement 2km');
    expect(serializeOne({ role: 'run' })).toBe('- Course 2km');
    expect(serializeOne({ role: 'recover' })).toBe('- Recuperation 2km');
    expect(serializeOne({ role: 'cooldown' })).toBe('- Retour au calme 2km');
  });

  it("prolonge l'intitulé de la note, devant la mesure", () => {
    expect(serializeOne({ role: 'recover', note: 'trot très souple' })).toBe(
      '- Recuperation - trot très souple 2km',
    );
  });

  it('écrase les retours à la ligne d’une note : une étape tient sur une ligne', () => {
    // Le schéma l'impose désormais, mais ce sérialiseur reçoit aussi des `steps`
    // écrits en base avant cette contrainte — une seconde ligne y deviendrait
    // une étape fantôme, et une ligne vide découperait un bloc répété.
    expect(serializeOne({ note: 'ligne1\nligne2\n\n2 km' })).toBe(
      '- Course - ligne1 ligne2 2 km 2km',
    );
  });

  it('retombe sur le seul intitulé quand la note ne porte que des blancs', () => {
    expect(serializeOne({ note: ' \n ' })).toBe('- Course 2km');
  });
});

describe('stepsToIntervalsSyntax — mesures', () => {
  it('écrit les kilomètres ronds en km', () => {
    expect(serializeOne({ distanceM: 2_000 })).toBe('- Course 2km');
    expect(serializeOne({ distanceM: 12_000 })).toBe('- Course 12km');
  });

  it("écrit toute autre distance en mètres — jamais `m`, qui vaut minutes", () => {
    expect(serializeOne({ distanceM: 400 })).toBe('- Course 400mtr');
    expect(serializeOne({ distanceM: 1_500 })).toBe('- Course 1500mtr');
    // Un mètre décimal n'existe pas dans la syntaxe : arrondi, pas de troncature.
    expect(serializeOne({ distanceM: 400.6 })).toBe('- Course 401mtr');
  });

  it('écrit les durées en minutes et secondes', () => {
    const duration = (durationS: number): string => serializeOne({ distanceM: null, durationS });

    expect(duration(600)).toBe('- Course 10m');
    expect(duration(45)).toBe('- Course 45s');
    expect(duration(90)).toBe('- Course 1m30s');
    expect(duration(3_600)).toBe('- Course 60m');
  });
});

describe('stepsToIntervalsSyntax — cibles', () => {
  it('rend une allure unique en valeur absolue', () => {
    expect(serializeOne({ paceMinSecPerKm: 270, paceMaxSecPerKm: 270 })).toBe(
      '- Course 2km 4:30/km Pace',
    );
  });

  it('rend une fourchette bornée, la plus rapide en premier', () => {
    expect(serializeOne({ paceMinSecPerKm: 265, paceMaxSecPerKm: 275 })).toBe(
      '- Course 2km 4:25-4:35/km Pace',
    );
  });

  it('rend une zone cardiaque', () => {
    expect(serializeOne({ role: 'warmup', distanceM: null, durationS: 900, hrZone: 2 })).toBe(
      '- Echauffement 15m Z2 HR',
    );
  });

  it("n'invente aucune intensité quand l'étape n'en porte pas", () => {
    expect(serializeOne({ distanceM: null, durationS: 2_700 })).toBe('- Course 45m');
  });
});

describe('stepsToIntervalsSyntax — blocs', () => {
  it('rend un bloc non répété à plat, sans `1x` ni ligne vide', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 1,
        steps: [
          step({ role: 'warmup', distanceM: null, durationS: 900, hrZone: 2 }),
          step({ role: 'cooldown', distanceM: null, durationS: 600, hrZone: 1 }),
        ],
      },
    ];

    expect(stepsToIntervalsSyntax(steps)).toBe(
      ['- Echauffement 15m Z2 HR', '- Retour au calme 10m Z1 HR'].join('\n'),
    );
  });

  it('encadre un bloc répété de lignes vides', () => {
    const steps: PlanSessionSteps = [
      { repeat: 1, steps: [step({ role: 'warmup', distanceM: null, durationS: 900, hrZone: 2 })] },
      {
        repeat: 3,
        steps: [
          step({ distanceM: 800, paceMinSecPerKm: 230, paceMaxSecPerKm: 240 }),
          step({ role: 'recover', distanceM: 400, note: 'trot' }),
        ],
      },
      {
        repeat: 1,
        steps: [step({ role: 'cooldown', distanceM: null, durationS: 600, hrZone: 1 })],
      },
    ];

    expect(stepsToIntervalsSyntax(steps)).toBe(
      [
        '- Echauffement 15m Z2 HR',
        '',
        '3x',
        '- Course 800mtr 3:50-4:00/km Pace',
        '- Recuperation - trot 400mtr',
        '',
        '- Retour au calme 10m Z1 HR',
      ].join('\n'),
    );
  });

  it('ne commence ni ne termine par une ligne vide quand un bloc répété est aux bords', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 4,
        steps: [step({ distanceM: 1_000, paceMinSecPerKm: 250, paceMaxSecPerKm: 250 })],
      },
    ];

    expect(stepsToIntervalsSyntax(steps)).toBe(['4x', '- Course 1km 4:10/km Pace'].join('\n'));
  });

  it('sépare deux blocs répétés consécutifs par une seule ligne vide', () => {
    const steps: PlanSessionSteps = [
      { repeat: 2, steps: [step({ distanceM: 1_000 })] },
      { repeat: 3, steps: [step({ distanceM: 400 })] },
    ];

    expect(stepsToIntervalsSyntax(steps)).toBe(
      ['2x', '- Course 1km', '', '3x', '- Course 400mtr'].join('\n'),
    );
  });
});

describe('stepsToIntervalsSyntax — séance complète', () => {
  it('sérialise un fractionné du monde réel', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 1,
        steps: [
          step({
            role: 'warmup',
            distanceM: null,
            durationS: 900,
            hrZone: 2,
            note: 'très souple',
          }),
        ],
      },
      {
        repeat: 6,
        steps: [
          step({ distanceM: 800, paceMinSecPerKm: 235, paceMaxSecPerKm: 245 }),
          step({ role: 'recover', distanceM: null, durationS: 90, note: 'trot' }),
        ],
      },
      {
        repeat: 1,
        steps: [step({ role: 'cooldown', distanceM: null, durationS: 600, hrZone: 1 })],
      },
    ];

    // La séance est bien valide au regard du schéma : la sérialisation ne
    // s'éprouve que sur des entrées que le DAL accepterait d'écrire.
    expect(planSessionStepsSchema.safeParse(steps).success).toBe(true);

    expect(stepsToIntervalsSyntax(steps)).toBe(
      [
        '- Echauffement - très souple 15m Z2 HR',
        '',
        '6x',
        '- Course 800mtr 3:55-4:05/km Pace',
        '- Recuperation - trot 1m30s',
        '',
        '- Retour au calme 10m Z1 HR',
      ].join('\n'),
    );
  });
});
