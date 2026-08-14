import { describe, expect, it } from 'vitest';

import { longestEffortDistanceM } from './threshold-block';
import type { PlanSessionSteps, PlanStep, PlanStepRole } from './schema';

function step(role: PlanStepRole, distanceM: number | null, durationS: number | null = null): PlanStep {
  return {
    role,
    distanceM,
    durationS,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
  };
}

/** « 2 km d'échauffement, 3 × 2 km avec 800 m de récup, 1,5 km de retour au calme ». */
const THRESHOLD: PlanSessionSteps = [
  { repeat: 1, steps: [step('warmup', 2_000)] },
  { repeat: 3, steps: [step('run', 2_000), step('recover', 800)] },
  { repeat: 1, steps: [step('cooldown', 1_500)] },
];

describe('longestEffortDistanceM', () => {
  it('rend la longueur d’une répétition, pas le volume total du bloc', () => {
    // Trois fois 2 km font 6 km d'effort ; ce qu'on va chercher dans la trace,
    // c'est **une** répétition.
    expect(longestEffortDistanceM(THRESHOLD)).toBe(2_000);
  });

  it('ignore l’échauffement, les récupérations et le retour au calme', () => {
    // L'échauffement (2 km) est plus long qu'une répétition sur une séance
    // courte : le retenir ferait mesurer la FC d'un footing.
    const shortReps: PlanSessionSteps = [
      { repeat: 1, steps: [step('warmup', 3_000)] },
      { repeat: 4, steps: [step('run', 1_200), step('recover', 600)] },
      { repeat: 1, steps: [step('cooldown', 2_500)] },
    ];

    expect(longestEffortDistanceM(shortReps)).toBe(1_200);
  });

  it('retient le plus long effort d’une séance mixte', () => {
    // C'est lui qui a eu le temps d'installer un plateau cardiaque.
    const mixed: PlanSessionSteps = [
      { repeat: 1, steps: [step('run', 3_000)] },
      { repeat: 2, steps: [step('run', 1_000), step('recover', 400)] },
    ];

    expect(longestEffortDistanceM(mixed)).toBe(3_000);
  });

  it('rend null sur un effort mesuré en durée — rien n’est deviné', () => {
    const timed: PlanSessionSteps = [
      { repeat: 1, steps: [step('warmup', 2_000)] },
      { repeat: 3, steps: [step('run', null, 600), step('recover', null, 180)] },
    ];

    expect(longestEffortDistanceM(timed)).toBeNull();
  });

  it('rend null quand la séance ne porte aucun effort', () => {
    const easy: PlanSessionSteps = [{ repeat: 1, steps: [step('warmup', 8_000)] }];

    expect(longestEffortDistanceM(easy)).toBeNull();
    expect(longestEffortDistanceM([])).toBeNull();
  });
});
