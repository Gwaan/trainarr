import { describe, expect, it } from 'vitest';

import { flattenSteps } from '@/lib/plan-steps/schema';

import type { PlanPhase } from './phases';
import {
  easySessionSteps,
  longRunFinishSteps,
  spreadEasyDistances,
  weeklyEasyVariation,
  type EasyVariation,
} from './variations';

/*
 * Les cas que le squelette ne peut pas atteindre lui-même — les bornes du
 * rééquilibrage, surtout. `skeleton.test.ts` éprouve les variations telles que
 * l'utilisatrice les recevra ; ce fichier-ci éprouve les arêtes.
 */

/** La couverture d'un déroulé, en mètres — la seule mesure qui compte en aval. */
function coveredM(steps: ReturnType<typeof easySessionSteps>): number {
  return flattenSteps(steps ?? []).reduce((sum, step) => sum + (step.distanceM ?? 0), 0);
}

describe('weeklyEasyVariation', () => {
  const PHASES: PlanPhase[] = ['partial', 'base', 'build', 'specific', 'taper', 'race'];

  it('ne varie rien sur une semaine entamée, un affûtage ou une semaine de course', () => {
    for (const phase of ['partial', 'taper', 'race'] as const) {
      for (let weekNumber = 1; weekNumber <= 8; weekNumber += 1) {
        expect(weeklyEasyVariation(phase, weekNumber, 2).variation, `${phase} S${weekNumber}`).toBe(
          'plain',
        );
      }
    }
  });

  it('alterne lignes droites et côtes courtes en phase de base', () => {
    expect(weeklyEasyVariation('base', 1, 2)).toEqual({ variation: 'strides', index: 0 });
    expect(weeklyEasyVariation('base', 2, 2)).toEqual({ variation: 'hillStrides', index: 0 });
    expect(weeklyEasyVariation('base', 3, 2)).toEqual({ variation: 'strides', index: 0 });
  });

  it('alterne lignes droites et footing progressif en développement et en spécificité', () => {
    for (const phase of ['build', 'specific'] as const) {
      expect(weeklyEasyVariation(phase, 7, 2)).toEqual({ variation: 'strides', index: 0 });
      // Le progressif prend le dernier footing de la semaine, jamais le premier.
      expect(weeklyEasyVariation(phase, 8, 3)).toEqual({ variation: 'progressive', index: 2 });
    }
  });

  it('ne désigne aucun footing quand la semaine n’en porte pas', () => {
    for (const phase of PHASES) {
      expect(weeklyEasyVariation(phase, 4, 0).variation, phase).toBe('plain');
    }
  });
});

describe('easySessionSteps', () => {
  const VARIATIONS: EasyVariation[] = ['strides', 'hillStrides', 'progressive'];

  it('n’écrit aucun déroulé sur un footing trop court pour en porter un', () => {
    for (const variation of VARIATIONS) {
      expect(easySessionSteps(variation, 4.9), variation).toBeUndefined();
    }
    expect(easySessionSteps('plain', 12)).toBeUndefined();
  });

  it('couvre exactement la distance déclarée, au mètre près', () => {
    for (const variation of VARIATIONS) {
      // Toutes les distances du dixième de km, de 5 à 20 km : c'est le domaine
      // que les budgets hebdomadaires produisent.
      for (let meters = 5_000; meters <= 20_000; meters += 100) {
        const steps = easySessionSteps(variation, meters / 1_000);
        expect(steps, `${variation} ${meters} m`).toBeDefined();
        expect(coveredM(steps), `${variation} ${meters} m`).toBe(meters);
      }
    }
  });

  it('ne mesure aucune étape en durée, et n’écrit aucune allure', () => {
    for (const variation of VARIATIONS) {
      for (const step of flattenSteps(easySessionSteps(variation, 8.3) ?? [])) {
        expect(step.durationS, variation).toBeNull();
        expect(step.distanceM, variation).not.toBeNull();
        expect(step.paceMinSecPerKm, variation).toBeNull();
        expect(step.paceMaxSecPerKm, variation).toBeNull();
        expect(step.hrZone, variation).toBeNull();
        expect(step.note?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('garde 4 à 6 lignes droites quelle que soit la longueur du footing', () => {
    for (let meters = 5_000; meters <= 25_000; meters += 100) {
      const blocks = easySessionSteps('strides', meters / 1_000) ?? [];
      expect(blocks[1].repeat, `${meters} m`).toBeGreaterThanOrEqual(4);
      expect(blocks[1].repeat, `${meters} m`).toBeLessThanOrEqual(6);
      // Le corps du footing reste très majoritaire : la section d'accélérations
      // est une fin de séance.
      expect((blocks[0].steps[0].distanceM ?? 0) / meters, `${meters} m`).toBeGreaterThan(0.8);
    }
  });

  it('distingue les côtes des lignes droites par la note, jamais par la structure', () => {
    const flat = easySessionSteps('strides', 8) ?? [];
    const uphill = easySessionSteps('hillStrides', 8) ?? [];

    expect(uphill.map((block) => block.repeat)).toEqual(flat.map((block) => block.repeat));
    expect(uphill[1].steps[0].distanceM).toBe(flat[1].steps[0].distanceM);
    expect(uphill[1].steps[0].note).toContain('côte');
    expect(flat[1].steps[0].note).not.toContain('côte');
  });
});

describe('longRunFinishSteps', () => {
  it('ne sort qu’une semaine sur trois, en développement et en spécificité', () => {
    for (const phase of ['partial', 'base', 'taper', 'race'] as const) {
      for (let weekNumber = 1; weekNumber <= 9; weekNumber += 1) {
        expect(longRunFinishSteps(phase, weekNumber, 14), `${phase} S${weekNumber}`).toBeUndefined();
      }
    }

    for (const phase of ['build', 'specific'] as const) {
      const weeks = [1, 2, 3, 4, 5, 6].filter(
        (weekNumber) => longRunFinishSteps(phase, weekNumber, 14) !== undefined,
      );
      expect(weeks, phase).toEqual([3, 6]);
    }
  });

  it('renonce sur une sortie longue trop courte pour être découpée', () => {
    expect(longRunFinishSteps('build', 3, 5.9)).toBeUndefined();
    expect(longRunFinishSteps('build', 3, 6)).toBeDefined();
  });

  it('couvre exactement la distance déclarée, au mètre près', () => {
    for (let meters = 6_000; meters <= 35_000; meters += 100) {
      expect(coveredM(longRunFinishSteps('build', 3, meters / 1_000)), `${meters} m`).toBe(meters);
    }
  });
});

describe('spreadEasyDistances', () => {
  it('laisse un footing seul tranquille : il n’a personne à qui céder', () => {
    expect(spreadEasyDistances([6.7], 0, 12)).toEqual([6.7]);
    expect(spreadEasyDistances([], 0, 12)).toEqual([]);
  });

  it('déplace un dixième de la distance du footing enrichi vers l’autre', () => {
    expect(spreadEasyDistances([6.7, 6.7], 0, 12)).toEqual([6, 7.4]);
    // Le donneur peut être le dernier : c'est le premier qui reçoit.
    expect(spreadEasyDistances([6.7, 6.7], 1, 12)).toEqual([7.4, 6]);
  });

  it('ne touche pas aux footings du milieu', () => {
    expect(spreadEasyDistances([5, 4, 4], 0, 12)).toEqual([4.5, 4, 4.5]);
  });

  it('conserve la somme au dixième près', () => {
    for (const kms of [
      [6.7, 6.7],
      [3.1, 3.2],
      [8.4, 7.9, 6.2],
      [0.6, 0.6],
    ]) {
      for (let shortIndex = 0; shortIndex < kms.length; shortIndex += 1) {
        const before = kms.reduce((sum, km) => sum + km, 0);
        const after = spreadEasyDistances(kms, shortIndex, 20).reduce((sum, km) => sum + km, 0);
        expect(after, `${kms.join('/')} depuis ${shortIndex}`).toBeCloseTo(before, 6);
      }
    }
  });

  /*
   * Les deux bornes qui protègent la validation : la sortie longue reste la
   * séance la plus longue de sa semaine, et aucun footing ne descend sous la
   * plus petite distance que le contrat de sortie autorise (0,5 km).
   */
  it('ne fait jamais dépasser le plafond de la sortie longue', () => {
    expect(spreadEasyDistances([6.7, 6.7], 0, 6.9)).toEqual([6.5, 6.9]);
    // Plafond déjà atteint : rien ne bouge plutôt qu'une semaine invalide.
    expect(spreadEasyDistances([6.7, 6.7], 0, 6.7)).toEqual([6.7, 6.7]);
  });

  it('ne fait jamais descendre un footing sous la plus petite distance du contrat', () => {
    expect(spreadEasyDistances([0.5, 0.5], 0, 4)).toEqual([0.5, 0.5]);
    expect(spreadEasyDistances([0.6, 0.6], 0, 4)).toEqual([0.5, 0.7]);
  });
});
