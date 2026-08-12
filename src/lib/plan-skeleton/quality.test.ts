import { describe, expect, it } from 'vitest';

import { sessionPaceZone } from '@/lib/ai/plan-schema';

import { PLAN_INTENTS, type PlanIntent } from './intent';
import type { PlanPhase } from './phases';
import { goalFamily, qualityZones, QUALITY_ZONE_KINDS, type QualityZone } from './quality';

const ZONES: QualityZone[] = ['threshold', 'interval', 'repetition', 'marathon'];

const PHASES: PlanPhase[] = ['partial', 'base', 'build', 'specific', 'taper', 'race'];

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

describe('qualityZones, préparation de course', () => {
  it('ne programme aucune qualité sur une semaine entamée ni sur la semaine de course', () => {
    for (const goal of [null, 5, 10, 21.0975, 42.195]) {
      expect(qualityZones('race', 'partial', goal)).toEqual([]);
      expect(qualityZones('race', 'race', goal)).toEqual([]);
    }
  });

  it('ne fait que des répétitions en base, quelle que soit la course', () => {
    for (const goal of [null, 5, 10, 21.0975, 42.195]) {
      expect(qualityZones('race', 'base', goal)).toEqual(['repetition']);
    }
  });

  it('travaille la filière de la course en développement', () => {
    expect(qualityZones('race', 'build', 5)).toEqual(['repetition', 'interval']);
    expect(qualityZones('race', 'build', 10)).toEqual(['interval', 'threshold']);
    expect(qualityZones('race', 'build', 21.0975)).toEqual(['threshold', 'interval']);
    expect(qualityZones('race', 'build', 42.195)).toEqual(['marathon', 'threshold']);
  });

  it('converge vers l’allure de la course en spécificité', () => {
    expect(qualityZones('race', 'specific', 5)).toEqual(['interval', 'marathon']);
    expect(qualityZones('race', 'specific', 10)).toEqual(['threshold', 'marathon']);
    expect(qualityZones('race', 'specific', 21.0975)).toEqual(['threshold', 'marathon']);
    expect(qualityZones('race', 'specific', 42.195)).toEqual(['marathon', 'threshold']);
  });

  it('n’ouvre qu’une zone pendant l’affûtage', () => {
    for (const goal of [null, 5, 10, 21.0975, 42.195]) {
      expect(qualityZones('race', 'taper', goal)).toHaveLength(1);
    }
    expect(qualityZones('race', 'taper', 42.195)).toEqual(['marathon']);
  });

  it('rend une copie : la grille n’est pas modifiable par ses appelants', () => {
    const zones = qualityZones('race', 'build', 10);
    zones.push('repetition');
    expect(qualityZones('race', 'build', 10)).toEqual(['interval', 'threshold']);
  });

  it('ne rend que des zones d’intensité, jamais l’endurance', () => {
    for (const intent of PLAN_INTENTS) {
      for (const phase of PHASES) {
        for (const goal of [null, 5, 10, 21.0975, 42.195]) {
          for (const zone of qualityZones(intent, phase, goal)) {
            expect(ZONES, `${intent} / ${phase}`).toContain(zone);
          }
        }
      }
    }
  });
});

/*
 * Les trois intentions sans course.
 *
 * Ce qu'elles ont en commun : **aucune zone `marathon`**, nulle part. « Spécifique
 * allure course » prescrit l'allure d'une épreuve, et il n'y en a pas — c'est le
 * titre absurde relevé en production sur un objectif libre, et c'est la première
 * chose que ces grilles corrigent.
 */
describe('qualityZones, hors préparation de course', () => {
  const DATELESS: PlanIntent[] = ['faster', 'weight_loss', 'return'];

  it('ne prescrit jamais l’allure d’une course qui n’existe pas', () => {
    for (const intent of DATELESS) {
      for (const phase of PHASES) {
        // Y compris quand l'appelant passe une distance : sans date, elle ne
        // désigne pas une allure de course à travailler.
        for (const goal of [null, 5, 10, 21.0975, 42.195]) {
          expect(qualityZones(intent, phase, goal), `${intent} / ${phase}`).not.toContain(
            'marathon',
          );
        }
      }
    }
  });

  it('ignore la distance d’objectif : la phase suffit à décider', () => {
    for (const intent of DATELESS) {
      for (const phase of PHASES) {
        const reference = qualityZones(intent, phase, null);
        for (const goal of [5, 10, 21.0975, 42.195]) {
          expect(qualityZones(intent, phase, goal), `${intent} / ${phase}`).toEqual(reference);
        }
      }
    }
  });

  /*
   * `faster` : le seuil d'abord (l'allure VDOT la plus fiable au niveau
   * récréatif, Scudamore 2017 ; l'ordre du bras gagnant de Filipas 2022), puis
   * la bascule pyramidale → polarisée en fin de cycle (Filipas 2022 ; Casado
   * 2022).
   */
  it('fait basculer une recherche de vitesse du seuil vers la VMA', () => {
    expect(qualityZones('faster', 'base', null)).toEqual(['repetition']);
    expect(qualityZones('faster', 'build', null)).toEqual(['threshold', 'interval']);
    expect(qualityZones('faster', 'specific', null)).toEqual(['interval', 'threshold']);
  });

  /*
   * `weight_loss` : une seule zone par phase, donc une seule séance dure par
   * semaine — et elle se justifie par la VO2max (Weeldreyer 2024), jamais par la
   * masse grasse (Keating 2017 ; Wewege 2017 ; Steele 2021 ; ACSM 2024 ; Viana
   * 2019 est rétractée).
   */
  it('ne donne qu’une zone par semaine à une perte de poids', () => {
    expect(qualityZones('weight_loss', 'base', null)).toEqual(['repetition']);
    expect(qualityZones('weight_loss', 'build', null)).toEqual(['interval']);
  });

  /* `return` : rien, nulle part — c'est la charge cumulée qu'on limite. */
  it('ne donne aucune séance dure à une reprise', () => {
    for (const phase of PHASES) {
      expect(qualityZones('return', phase, null), phase).toEqual([]);
    }
  });
});
