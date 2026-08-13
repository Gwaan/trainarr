import { describe, expect, it } from 'vitest';

import { PLAN_OUTPUT_BOUNDS } from '@/lib/ai/plan-schema';
import { flattenSteps, type PlanSessionSteps, type PlanStep } from '@/lib/plan-steps/schema';

import type { QualityZone } from './quality';
import { qualitySessionTitle } from './quality-title';

/** Une étape mesurée en distance, comme le modèle et le repli en écrivent. */
function step(role: PlanStep['role'], distanceM: number): PlanStep {
  return {
    role,
    distanceM,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
  };
}

/** Une séance enveloppée : échauffement, corps, retour au calme. */
function session(...body: PlanSessionSteps): PlanSessionSteps {
  return [
    { repeat: 1, steps: [step('warmup', 1_500)] },
    ...body,
    { repeat: 1, steps: [step('cooldown', 1_000)] },
  ];
}

describe('qualitySessionTitle', () => {
  it('annonce un format répété tel qu’il est écrit', () => {
    expect(
      qualitySessionTitle(
        'threshold',
        session({ repeat: 3, steps: [step('run', 1_000), step('recover', 200)] }),
      ),
    ).toBe('Seuil en 3 × 1 km');

    expect(
      qualitySessionTitle(
        'interval',
        session({ repeat: 4, steps: [step('run', 400), step('recover', 400)] }),
      ),
    ).toBe('VMA en 4 × 400 m');

    expect(
      qualitySessionTitle(
        'repetition',
        session({ repeat: 8, steps: [step('run', 200), step('recover', 300)] }),
      ),
    ).toBe('Répétitions en 8 × 200 m');

    expect(
      qualitySessionTitle(
        'marathon',
        session({ repeat: 2, steps: [step('run', 3_000), step('recover', 200)] }),
      ),
    ).toBe('Allure objectif en 2 × 3 km');
  });

  it('énumère les formats quand la séance en porte plusieurs', () => {
    expect(
      qualitySessionTitle(
        'threshold',
        session(
          { repeat: 3, steps: [step('run', 1_500), step('recover', 300)] },
          { repeat: 1, steps: [step('run', 1_000)] },
        ),
      ),
    ).toBe('Seuil en 3 × 1,5 km + 1 km');
  });

  it('dit « en continu » sur un effort unique', () => {
    expect(qualitySessionTitle('threshold', session({ repeat: 1, steps: [step('run', 3_000)] }))).toBe(
      'Seuil en continu 3 km',
    );
  });

  /**
   * Le défaut de production, et la seule chose que ce module existe pour rendre
   * impossible : « Seuil en 3 × 1,5 km + 1 × 1,0 km » sur une séance de 5 km
   * qui ne portait que **deux** efforts. Le titre annonçait 5,5 km d'effort
   * dans une séance de 5 km.
   */
  it('ne peut pas annoncer plus d’efforts que le déroulé n’en contient', () => {
    const steps = session({
      repeat: 1,
      steps: [step('run', 1_500), step('recover', 200), step('run', 1_000)],
    });

    expect(qualitySessionTitle('threshold', steps)).toBe('Seuil en 1,5 km + 1 km');
  });

  /**
   * La propriété générale, sur toutes les formes que ce projet écrit : ce que le
   * titre énumère fait exactement la distance d'effort du déroulé.
   */
  it('annonce exactement la distance d’effort du déroulé', () => {
    const cases: PlanSessionSteps[] = [
      session({ repeat: 3, steps: [step('run', 1_000), step('recover', 200)] }),
      session({ repeat: 6, steps: [step('run', 800), step('recover', 400)] }),
      session(
        { repeat: 3, steps: [step('run', 1_500), step('recover', 300)] },
        { repeat: 1, steps: [step('run', 1_000)] },
      ),
      session({ repeat: 1, steps: [step('run', 2_400)] }),
    ];

    for (const steps of cases) {
      const title = qualitySessionTitle('threshold', steps);
      const effortM = flattenSteps(steps)
        .filter((candidate) => candidate.role === 'run')
        .reduce((sum, candidate) => sum + (candidate.distanceM ?? 0), 0);

      // Le titre relu : `3 × 1,5 km + 1 km` se réévalue en mètres.
      const announcedM = title
        .replace(/^[^0-9]*/u, '')
        .split(' + ')
        .reduce((sum, group) => {
          const [, count, value, unit] = /^(?:(\d+) × )?([\d,]+) (km|m)$/u.exec(group) ?? [];
          const meters = Number(value.replace(',', '.')) * (unit === 'km' ? 1_000 : 1);
          return sum + Number(count ?? 1) * meters;
        }, 0);

      expect(announcedM, title).toBe(effortM);
    }
  });

  it('retombe sur le titre de la zone quand le déroulé ne se résume pas', () => {
    // Aucun effort mesuré en distance : rien à énumérer.
    expect(
      qualitySessionTitle('threshold', [
        { repeat: 1, steps: [step('warmup', 1_500)] },
        { repeat: 1, steps: [step('cooldown', 1_000)] },
      ]),
    ).toBe('Séance de seuil');

    // Quatre formats : ce n'est plus un titre, c'est un déroulé recopié.
    expect(
      qualitySessionTitle(
        'interval',
        session(
          { repeat: 1, steps: [step('run', 1_200)] },
          { repeat: 1, steps: [step('run', 1_000)] },
          { repeat: 1, steps: [step('run', 800)] },
          { repeat: 1, steps: [step('run', 600)] },
        ),
      ),
    ).toBe('Séance de VMA');
  });

  it('ne nomme aucune zone qu’il ne connaît pas', () => {
    expect(qualitySessionTitle('sprint' as QualityZone, session({ repeat: 1, steps: [step('run', 2_000)] }))).toBe(
      'Séance de qualité',
    );
  });

  it('tient dans les bornes du contrat de sortie, quoi qu’il arrive', () => {
    for (const zone of ['threshold', 'interval', 'repetition', 'marathon'] as const) {
      for (let reps = 1; reps <= 20; reps += 1) {
        for (const effortM of [90, 200, 999, 1_000, 1_250, 3_333, 12_000]) {
          const title = qualitySessionTitle(
            zone,
            session({ repeat: reps, steps: [step('run', effortM), step('recover', 200)] }),
          );
          expect(title.length, title).toBeGreaterThan(0);
          expect(title.length, title).toBeLessThanOrEqual(PLAN_OUTPUT_BOUNDS.titleChars);
        }
      }
    }
  });
});
