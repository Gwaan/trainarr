import { describe, expect, it } from 'vitest';

import type { PlanSessionSteps, PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

import type { QualityZone } from './quality';
import { qualityEffortCapKm, QUALITY_EFFORT_CAPS, sessionEffortKm, sessionEffortM } from './quality-load';

/*
 * Deux choses à prouver, et elles ne se recouvrent pas.
 *
 * 1. **Le plafond** : la part du volume hebdomadaire, le plafond absolu quand il
 *    existe, et le plus petit des deux quand les deux existent.
 * 2. **Le volume d'effort** : ce qui compte dedans, et surtout ce qui n'y compte
 *    pas. C'est la définition qui porte la règle — un compteur qui inclurait les
 *    récupérations plafonnerait des séances parfaitement dosées, et un compteur
 *    qui oublierait les répétitions en laisserait passer six fois trop.
 */

/** Une étape mesurée en distance, avec ou sans consigne. */
function step(role: PlanStepRole, distanceM: number, note: string | null = null): PlanStep {
  return {
    role,
    distanceM,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    hrPercentMin: null,
    hrPercentMax: null,
    note,
  };
}

describe('qualityEffortCapKm', () => {
  it('rend la part du volume hebdomadaire de chaque zone', () => {
    // 40 km de semaine : 5 % en répétitions, 8 % en VMA, 10 % au seuil.
    expect(qualityEffortCapKm('repetition', 40)).toBeCloseTo(2, 6);
    expect(qualityEffortCapKm('interval', 40)).toBeCloseTo(3.2, 6);
    expect(qualityEffortCapKm('threshold', 40)).toBeCloseTo(4, 6);
  });

  it('garde le plus petit de la part et de l’absolu', () => {
    // À 200 km de semaine, la part autoriserait 10 km de répétitions et 16 de
    // VMA : ce ne sont plus des séances, ce sont des courses.
    expect(qualityEffortCapKm('repetition', 200)).toBe(8);
    expect(qualityEffortCapKm('interval', 200)).toBe(10);
    // Le seuil n'a pas d'absolu : sa part continue de croître.
    expect(qualityEffortCapKm('threshold', 200)).toBeCloseTo(20, 6);
  });

  /*
   * Daniels borne bien la séance à allure marathon, mais en absolu (de l'ordre
   * de 110 minutes) et non en part du volume hebdomadaire — un ordre de grandeur
   * qui ne mordrait jamais sur un créneau de cette appli. On n'invente donc pas
   * de part : la zone reste bornée par le budget de son créneau, comme avant.
   */
  it('ne plafonne pas la zone spécifique allure course', () => {
    expect(QUALITY_EFFORT_CAPS.marathon).toBeNull();
    expect(qualityEffortCapKm('marathon', 40)).toBeNull();
    expect(qualityEffortCapKm('marathon', 200)).toBeNull();
  });

  it('ne rend jamais un plafond négatif', () => {
    expect(qualityEffortCapKm('threshold', 0)).toBe(0);
    expect(qualityEffortCapKm('threshold', -10)).toBe(0);
  });
});

describe('sessionEffortM', () => {
  /** Le déroulé de référence : 1,5 km + 3 × (1,5 km + 300 m) + 1,1 km = 8 km. */
  const SESSION: PlanSessionSteps = [
    { repeat: 1, steps: [step('warmup', 1_500)] },
    { repeat: 3, steps: [step('run', 1_500), step('recover', 300)] },
    { repeat: 1, steps: [step('cooldown', 1_100)] },
  ];

  it('compte les efforts, répétitions comprises', () => {
    expect(sessionEffortM('threshold', SESSION)).toBe(4_500);
    expect(sessionEffortKm('threshold', SESSION)).toBe(4.5);
  });

  it('n’y compte ni l’enveloppe ni les récupérations', () => {
    // La séance totalise 8 km ; son volume d'effort en fait 4,5. C'est toute la
    // distinction que la règle porte.
    expect(sessionEffortM('threshold', SESSION)).toBeLessThan(8_000);
    expect(sessionEffortM('threshold', [{ repeat: 1, steps: [step('warmup', 4_000)] }])).toBe(0);
    expect(sessionEffortM('threshold', [{ repeat: 6, steps: [step('recover', 400)] }])).toBe(0);
    expect(sessionEffortM('threshold', [{ repeat: 1, steps: [step('cooldown', 2_000)] }])).toBe(0);
  });

  /*
   * Le point délicat, et celui pour lequel `stepNotePaceZone` est exporté :
   * `applyImposedPaces` relit la note d'une étape pour lui poser un créneau
   * d'allure **autre** que celui de sa séance. Un bloc noté « au seuil » dans une
   * séance de VMA ne se court pas à VMA, et le compter dans le volume de VMA
   * serait faux — c'est même exactement le mécanisme par lequel une séance
   * pourrait contourner son plafond.
   */
  it('écarte les étapes qu’une note déplace vers une autre zone', () => {
    const mixed: PlanSessionSteps = [
      { repeat: 1, steps: [step('warmup', 1_500)] },
      { repeat: 4, steps: [step('run', 400, 'Effort à VMA, en contrôle'), step('recover', 400)] },
      { repeat: 1, steps: [step('run', 2_000, 'Tempo continu au seuil')] },
      { repeat: 1, steps: [step('cooldown', 1_000)] },
    ];

    // Vue de la séance de VMA : les 2 km de tempo ne sont pas de la VMA.
    expect(sessionEffortM('interval', mixed)).toBe(1_600);
    // Et ils ne sont pas non plus reportés ailleurs par ce compteur : il mesure
    // **une** zone, celle de la séance. Vue du seuil, seul le tempo compte —
    // la note de VMA n'en nomme aucun, donc ses étapes suivent la séance.
    expect(sessionEffortM('threshold', mixed)).toBe(3_600);
  });

  it('compte une note qui confirme la zone de la séance', () => {
    // Le déroulé déterministe écrit ces notes-là, et elles nomment le créneau de
    // la séance : elles doivent compter, pas être écartées.
    const noted: PlanSessionSteps = [
      { repeat: 3, steps: [step('run', 1_200, 'Effort au seuil, régulier et contrôlé')] },
    ];

    expect(sessionEffortM('threshold', noted)).toBe(3_600);
  });

  it('ignore une étape mesurée en durée, faute d’allure pour la convertir', () => {
    const timed: PlanSessionSteps = [
      {
        repeat: 2,
        steps: [
          { ...step('run', 0), distanceM: null, durationS: 180 },
          step('run', 500),
        ],
      },
    ];

    expect(sessionEffortM('interval', timed)).toBe(1_000);
  });

  it('rend zéro sur un déroulé vide', () => {
    for (const zone of ['threshold', 'interval', 'repetition', 'marathon'] as QualityZone[]) {
      expect(sessionEffortM(zone, []), zone).toBe(0);
    }
  });
});
