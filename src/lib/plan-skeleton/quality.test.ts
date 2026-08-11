import { describe, expect, it } from 'vitest';

import { sessionPaceZone } from '@/lib/ai/plan-schema';

import type { PlanPhase } from './phases';
import { goalFamily, qualityZones, QUALITY_ZONE_KINDS, type QualityZone } from './quality';

const ZONES: QualityZone[] = ['threshold', 'interval', 'repetition', 'marathon'];

describe('QUALITY_ZONE_KINDS', () => {
  /*
   * Le test qui compte : ces libellés voyagent jusqu'au post-traitement des
   * allures, qui les reclasse par expression régulière. Un libellé que
   * `sessionPaceZone` ne reconnaît pas retombe en endurance — une VMA prescrite à
   * l'allure d'un footing, sans que rien ne le signale.
   */
  it('donne des `kind` que `sessionPaceZone` reclasse dans leur propre zone', () => {
    for (const zone of ZONES) {
      expect(sessionPaceZone(QUALITY_ZONE_KINDS[zone]), QUALITY_ZONE_KINDS[zone]).toBe(zone);
    }
  });

  it('écrit ses libellés en français, lisibles tels quels dans l’UI', () => {
    expect(QUALITY_ZONE_KINDS).toEqual({
      threshold: 'Seuil',
      interval: 'VMA',
      repetition: 'Répétitions',
      marathon: 'Spécifique allure course',
    });
  });
});

describe('goalFamily', () => {
  it('range les distances entre les repères officiels', () => {
    expect(goalFamily(5)).toBe('fiveK');
    expect(goalFamily(7.4)).toBe('fiveK');
    expect(goalFamily(10)).toBe('tenK');
    expect(goalFamily(14.9)).toBe('tenK');
    expect(goalFamily(21.0975)).toBe('half');
    expect(goalFamily(29.9)).toBe('half');
    expect(goalFamily(42.195)).toBe('marathon');
  });

  it('traite un objectif non chiffré comme un 10 km', () => {
    expect(goalFamily(null)).toBe('tenK');
  });
});

describe('qualityZones', () => {
  it('ne programme aucune qualité sur une semaine entamée ni sur la semaine de course', () => {
    for (const goal of [null, 5, 10, 21.0975, 42.195]) {
      expect(qualityZones('partial', goal)).toEqual([]);
      expect(qualityZones('race', goal)).toEqual([]);
    }
  });

  it('ne fait que des répétitions en base, quelle que soit la course', () => {
    for (const goal of [null, 5, 10, 21.0975, 42.195]) {
      expect(qualityZones('base', goal)).toEqual(['repetition']);
    }
  });

  it('travaille la filière de la course en développement', () => {
    expect(qualityZones('build', 5)).toEqual(['repetition', 'interval']);
    expect(qualityZones('build', 10)).toEqual(['interval', 'threshold']);
    expect(qualityZones('build', 21.0975)).toEqual(['threshold', 'interval']);
    expect(qualityZones('build', 42.195)).toEqual(['marathon', 'threshold']);
  });

  it('converge vers l’allure de la course en spécificité', () => {
    expect(qualityZones('specific', 5)).toEqual(['interval', 'marathon']);
    expect(qualityZones('specific', 10)).toEqual(['threshold', 'marathon']);
    expect(qualityZones('specific', 21.0975)).toEqual(['threshold', 'marathon']);
    expect(qualityZones('specific', 42.195)).toEqual(['marathon', 'threshold']);
  });

  it('n’ouvre qu’une zone pendant l’affûtage', () => {
    for (const goal of [null, 5, 10, 21.0975, 42.195]) {
      expect(qualityZones('taper', goal)).toHaveLength(1);
    }
    expect(qualityZones('taper', 42.195)).toEqual(['marathon']);
  });

  it('rend une copie : la grille n’est pas modifiable par ses appelants', () => {
    const zones = qualityZones('build', 10);
    zones.push('repetition');
    expect(qualityZones('build', 10)).toEqual(['interval', 'threshold']);
  });

  it('ne rend que des zones d’intensité, jamais l’endurance', () => {
    const phases: PlanPhase[] = ['partial', 'base', 'build', 'specific', 'taper', 'race'];
    for (const phase of phases) {
      for (const goal of [null, 5, 10, 21.0975, 42.195]) {
        for (const zone of qualityZones(phase, goal)) {
          expect(ZONES).toContain(zone);
        }
      }
    }
  });
});
