import { describe, expect, it } from 'vitest';

import { EASY_HR_BANDS, EASY_HR_ZONE, PRESCRIBED_HR_ZONES } from '@/lib/metrics/hr-targets';
import { stepsToIntervalsSyntax } from '@/lib/plan-steps/intervals-syntax';
import { flattenSteps } from '@/lib/plan-steps/schema';

import type { PlanPhase } from './phases';
import {
  easySessionSteps,
  longRunFinishSteps,
  spreadEasyDistances,
  STRIDE_RESERVE_M,
  weeklyEasyVariation,
  type EasyVariation,
} from './variations';

/*
 * Les cas que le squelette ne peut pas atteindre lui-même — les bornes du
 * rééquilibrage, surtout. `skeleton.test.ts` éprouve les variations telles que
 * l'utilisatrice les recevra ; ce fichier-ci éprouve les arêtes.
 */

/**
 * Ce qu'un déroulé impute au budget kilométrique de sa séance, en mètres.
 *
 * Une étape chronométrée n'a pas de distance : elle compte pour la réserve que
 * le module lui met de côté ({@link STRIDE_RESERVE_M}), qui est un **majorant**
 * de ce qu'elle couvrira réellement. C'est cette somme-là qui doit retomber sur
 * la distance déclarée — la couverture réelle, elle, passe en dessous, et c'est
 * exactement ce que `imposedDistanceKm` demande.
 */
function coveredM(steps: ReturnType<typeof easySessionSteps>): number {
  return flattenSteps(steps ?? []).reduce(
    (sum, step) => sum + (step.distanceM ?? STRIDE_RESERVE_M),
    0,
  );
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

  it('rend compte de la distance déclarée, au mètre près', () => {
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

  /**
   * La règle du module : la mesure suit l'intention. Une tranche de footing se
   * prescrit en mètres, une accélération au chrono — et rien ne porte les deux,
   * ce que le contrat d'étapes refuserait de toute façon.
   */
  it('mesure chaque étape par son intention, et n’écrit aucune allure', () => {
    for (const variation of VARIATIONS) {
      for (const step of flattenSteps(easySessionSteps(variation, 8.3) ?? [])) {
        const timed = variation !== 'progressive' && step.role === 'run' && step.distanceM === null;
        expect(step.durationS, variation).toBe(timed ? 20 : null);
        expect(step.distanceM === null, variation).toBe(timed);
        expect(step.paceMinSecPerKm, variation).toBeNull();
        expect(step.paceMaxSecPerKm, variation).toBeNull();
        expect(step.hrZone, variation).toBeNull();
        expect(step.note?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Le reproche, textuel : « sur les plans tu dis "courir pendant 20 secondes à
   * telle allure", tu mets une pace avec une distance — mais intervals gère les
   * durées aussi ». La ligne droite valait `90mtr` sur la montre pendant que sa
   * consigne annonçait vingt secondes ; elle part désormais en `20s`, et plus
   * rien du déroulé ne réclame de mètres pour une accélération.
   */
  it('prescrit la ligne droite au chrono, jusque dans la syntaxe intervals.icu', () => {
    const syntax = stepsToIntervalsSyntax(easySessionSteps('strides', 8) ?? []);
    const stride = syntax.split('\n').find((line) => line.includes('Ligne droite'));

    expect(stride).toBeDefined();
    expect(stride).toContain(' 20s');
    expect(stride).not.toContain('mtr');
    // Et la consigne ne redit plus la mesure : une seule source par fait.
    expect(stride).not.toContain('20 s');
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
    expect(uphill[1].steps[0].durationS).toBe(flat[1].steps[0].durationS);
    expect(uphill[1].steps[1].distanceM).toBe(flat[1].steps[1].distanceM);
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

  /**
   * « 8,64 km puis 2,16 km » est sorti en production : le découpage 80/20 ne
   * ramenait pas ses étapes sur la grille des 100 m, contrairement à toutes les
   * autres variations. Un centième de kilomètre ne se court pas.
   */
  it('pose ses deux segments sur la centaine de mètres', () => {
    for (let meters = 6_000; meters <= 35_000; meters += 100) {
      const steps = flattenSteps(longRunFinishSteps('build', 3, meters / 1_000) ?? []);
      for (const step of steps) {
        expect((step.distanceM ?? 0) % 100, `${meters} m`).toBe(0);
      }
      // La fin garde son cinquième, au demi-cran de grille près : c'est tout
      // ce que l'arrondi peut lui coûter.
      expect(Math.abs((steps[1].distanceM ?? 0) - meters * 0.2), `${meters} m`).toBeLessThanOrEqual(
        50,
      );
    }
  });

  /**
   * Le défaut que la grille ne réparait pas : la fin appuyée portait **la même**
   * cible que les 80 % qui la précèdent (124–150 bpm de part et d'autre), donc
   * rien de discernable sur la montre. Elle vise désormais le haut de la plage
   * d'endurance — sans en sortir : le 80/20 du plan ne bouge pas.
   */
  it('vise le haut de la plage d’endurance sur sa fin, et elle seule', () => {
    const steps = flattenSteps(longRunFinishSteps('build', 3, 14) ?? []);

    expect(steps[0].hrPercentMin).toBeNull();
    expect(steps[0].hrPercentMax).toBeNull();
    expect(steps[1].hrPercentMin).toBe(EASY_HR_BANDS.high.minPercentOfMax);
    expect(steps[1].hrPercentMax).toBe(EASY_HR_BANDS.high.maxPercentOfMax);
  });
});

/**
 * Le contrat que ces sous-créneaux ne doivent jamais rompre : ils **précisent**
 * la plage d'endurance, ils n'en sortent pas. Une bande qui déborderait
 * déplacerait la répartition d'intensité du plan sans que rien ne le dise.
 */
describe('les sous-créneaux restent dans la plage d’endurance', () => {
  it('n’écrit aucune borne hors de 65–79 % de FC max', () => {
    const easy = PRESCRIBED_HR_ZONES[EASY_HR_ZONE];
    const steps = [
      ...flattenSteps(easySessionSteps('progressive', 9) ?? []),
      ...flattenSteps(longRunFinishSteps('build', 3, 18) ?? []),
    ];

    const banded = steps.filter((step) => step.hrPercentMin != null);
    expect(banded.length).toBeGreaterThan(0);

    for (const step of banded) {
      expect(step.hrPercentMin).toBeGreaterThanOrEqual(easy?.minPercentOfMax ?? 0);
      expect(step.hrPercentMax).toBeLessThanOrEqual(easy?.maxPercentOfMax ?? 0);
      expect(step.hrPercentMin ?? 0).toBeLessThan(step.hrPercentMax ?? 0);
    }
  });

  it('monte le progressif du bas vers le haut de la plage', () => {
    const steps = flattenSteps(easySessionSteps('progressive', 9) ?? []);

    // Trois tranches de course : la première n'est plus un échauffement sans
    // cible, elle pèse 40 % de la séance.
    expect(steps.map((step) => step.role)).toEqual(['run', 'run', 'run']);
    expect(steps.map((step) => step.hrPercentMin)).toEqual([65, 70, 74]);
    expect(steps.map((step) => step.hrPercentMax)).toEqual([71, 75, 79]);
  });

  it('ne pose aucune bande sur les lignes droites : trop courtes pour une FC', () => {
    for (const variation of ['strides', 'hillStrides'] as const) {
      for (const step of flattenSteps(easySessionSteps(variation, 8) ?? [])) {
        expect(step.hrPercentMin, variation).toBeNull();
        expect(step.hrPercentMax, variation).toBeNull();
      }
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
