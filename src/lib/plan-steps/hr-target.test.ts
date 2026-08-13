import { describe, expect, it } from 'vitest';

import { EASY_HR_BANDS, EASY_HR_ZONE } from '@/lib/metrics/hr-targets';

import { stepHrPercentBand, stepHrTargetBpm } from './hr-target';
import type { PlanStep } from './schema';

/** Une étape de course, toutes clés présentes — la forme que le contrat impose. */
function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role: 'run',
    distanceM: 3_000,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    hrPercentMin: null,
    hrPercentMax: null,
    note: null,
    ...overrides,
  };
}

describe('stepHrPercentBand', () => {
  it('rend les deux bornes quand elles sont là', () => {
    expect(stepHrPercentBand(step({ hrPercentMin: 74, hrPercentMax: 79 }))).toEqual({
      minPercentOfMax: 74,
      maxPercentOfMax: 79,
    });
  });

  /**
   * Les plans écrits avant l'existence de ces clés ne les portent pas : relues
   * depuis la colonne `jsonb`, elles valent `undefined`, pas `null`. Un test
   * `!== null` les prendrait pour des bornes et rendrait `NaN` de battements.
   */
  it('ne prend pas une clé absente pour une borne — les plans déjà en base', () => {
    const legacy = { ...step(), hrPercentMin: undefined, hrPercentMax: undefined };

    expect(stepHrPercentBand(legacy)).toBeNull();
    expect(stepHrTargetBpm({ ...legacy, hrZone: EASY_HR_ZONE }, 184)).toEqual({
      minBpm: 120,
      maxBpm: 145,
    });
  });

  it('exige les deux bornes ensemble', () => {
    expect(stepHrPercentBand(step({ hrPercentMin: 74 }))).toBeNull();
    expect(stepHrPercentBand(step({ hrPercentMax: 79 }))).toBeNull();
  });
});

describe('stepHrTargetBpm', () => {
  it('résout un rang de zone comme avant', () => {
    expect(stepHrTargetBpm(step({ hrZone: EASY_HR_ZONE }), 184)).toEqual({
      minBpm: 120,
      maxBpm: 145,
    });
  });

  /**
   * Le défaut que le sous-créneau répare : la fin appuyée d'une sortie longue
   * portait exactement la cible du reste du parcours.
   */
  it('laisse le sous-créneau primer sur le rang qu’il précise', () => {
    const finish = step({
      hrZone: EASY_HR_ZONE,
      hrPercentMin: EASY_HR_BANDS.high.minPercentOfMax,
      hrPercentMax: EASY_HR_BANDS.high.maxPercentOfMax,
    });

    expect(stepHrTargetBpm(finish, 184)).toEqual({ minBpm: 136, maxBpm: 145 });
    expect(stepHrTargetBpm(step({ hrZone: EASY_HR_ZONE }), 184)).toEqual({
      minBpm: 120,
      maxBpm: 145,
    });
  });

  it('prescrit sur la seule bande, sans rang — le régime sans table d’allures', () => {
    expect(stepHrTargetBpm(step({ hrPercentMin: 65, hrPercentMax: 71 }), 184)).toEqual({
      minBpm: 120,
      maxBpm: 131,
    });
  });

  it('ne rend rien sur une étape sans cible cardiaque, ou sans FC max', () => {
    expect(stepHrTargetBpm(step(), 184)).toBeNull();
    expect(stepHrTargetBpm(step({ hrZone: EASY_HR_ZONE }), null)).toBeNull();
    // Une zone sans créneau de prescription déclaré : rien d'inventé.
    expect(stepHrTargetBpm(step({ hrZone: 4 }), 184)).toBeNull();
  });
});
