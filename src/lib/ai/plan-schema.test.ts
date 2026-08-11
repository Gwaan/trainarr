import { describe, expect, it } from 'vitest';

import {
  PLAN_OUTPUT_BOUNDS,
  mapPlanWeeksToSessions,
  planJsonSchema,
  planOutputSchema,
  planUpdateJsonSchema,
  planUpdateOutputSchema,
  validatePlanBusinessRules,
  type PlanWeekOutput,
} from './plan-schema';

/** Une séance minimale — chaque test n'en précise que ce qu'il éprouve. */
function session(day: number, overrides: Partial<PlanWeekOutput['sessions'][number]> = {}) {
  return { day, kind: 'Endurance', title: 'Footing', ...overrides };
}

/** Une semaine de `days.length` séances, une par jour donné. */
function week(days: number[], distancesKm?: number[]): PlanWeekOutput {
  return {
    sessions: days.map((day, index) =>
      distancesKm === undefined ? session(day) : session(day, { distanceKm: distancesKm[index] }),
    ),
  };
}

describe('planOutputSchema', () => {
  it('accepte une sortie minimale et laisse les champs facultatifs absents', () => {
    const parsed = planOutputSchema.parse({
      summary: 'Bloc de 2 semaines.',
      weeks: [week([3, 7]), week([3, 7])],
    });

    expect(parsed.weeks).toHaveLength(2);
    expect(parsed.weeks[0].sessions[0].distanceKm).toBeUndefined();
  });

  it('refuse un jour hors de la semaine ISO', () => {
    const result = planOutputSchema.safeParse({
      summary: 'x',
      weeks: [{ sessions: [session(8)] }],
    });

    expect(result.success).toBe(false);
  });

  it('refuse une allure cible aberrante', () => {
    const result = planOutputSchema.safeParse({
      summary: 'x',
      weeks: [{ sessions: [session(3, { targetPaceSecPerKm: 30 })] }],
    });

    expect(result.success).toBe(false);
  });

  it('refuse un résumé vide : il porte la logique du plan', () => {
    expect(planOutputSchema.safeParse({ summary: '', weeks: [week([7])] }).success).toBe(false);
  });
});

describe('planUpdateOutputSchema', () => {
  it('accepte une sortie sans `settings` : rien ne change côté réglages', () => {
    const parsed = planUpdateOutputSchema.parse({ summary: 'Ajusté.', weeks: [week([7])] });
    expect(parsed.settings).toBeUndefined();
  });

  it('accepte un patch partiel de réglages', () => {
    const parsed = planUpdateOutputSchema.parse({
      summary: 'Trois séances désormais.',
      settings: { sessionsPerWeek: 3 },
      weeks: [week([7])],
    });

    expect(parsed.settings).toEqual({ sessionsPerWeek: 3 });
  });
});

describe('JSON Schema', () => {
  it('interdit les propriétés inventées à tous les niveaux', () => {
    const json = JSON.stringify(planJsonSchema);
    expect(json).toContain('"additionalProperties":false');
    expect(planJsonSchema.required).toEqual(['summary', 'weeks']);
  });

  it('reste cohérent avec les bornes partagées par le schéma Zod', () => {
    const weeks = planJsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(weeks.weeks.maxItems).toBe(PLAN_OUTPUT_BOUNDS.weeksPerPlan.max);

    const update = planUpdateJsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(update.settings.additionalProperties).toBe(false);
    // `settings` reste facultatif : le modèle ne le rend que s'il change quelque chose.
    expect(planUpdateJsonSchema.required).toEqual(['summary', 'weeks']);
  });
});

describe('mapPlanWeeksToSessions', () => {
  it('date les séances par index de semaine et jour ISO', () => {
    const sessions = mapPlanWeeksToSessions([week([1, 7]), week([3])], '2026-08-17');

    expect(sessions.map((item) => item.scheduledOn)).toEqual([
      '2026-08-17',
      '2026-08-23',
      '2026-08-26',
    ]);
  });

  it('franchit les changements de mois et d’année', () => {
    const sessions = mapPlanWeeksToSessions([week([1]), week([1]), week([1])], '2026-12-21');

    expect(sessions.map((item) => item.scheduledOn)).toEqual([
      '2026-12-21',
      '2026-12-28',
      '2027-01-04',
    ]);
  });

  it('convertit les unités du coureur en unités de la base', () => {
    const sessions = mapPlanWeeksToSessions(
      [
        {
          sessions: [
            session(7, {
              distanceKm: 18.4,
              durationMin: 105,
              targetPaceSecPerKm: 330,
              warmup: '  15 min souple  ',
              cooldown: '',
            }),
          ],
        },
      ],
      '2026-08-17',
    );

    expect(sessions[0]).toEqual({
      scheduledOn: '2026-08-23',
      kind: 'Endurance',
      title: 'Footing',
      warmup: '15 min souple',
      recovery: null,
      cooldown: null,
      targetPaceSecPerKm: 330,
      volumeM: 18_400,
      durationS: 6_300,
    });
  });
});

const EXPECTED = { weeks: 2, sessionsPerWeek: 3, longRunDay: 7 };

describe('validatePlanBusinessRules', () => {
  it('ne relève rien sur un plan conforme', () => {
    const weeks = [week([2, 4, 7], [8, 10, 16]), week([2, 4, 7], [8, 10, 18])];

    expect(validatePlanBusinessRules(weeks, EXPECTED)).toEqual([]);
  });

  it('relève un nombre de semaines différent de celui demandé', () => {
    const violations = validatePlanBusinessRules([week([2, 4, 7], [8, 10, 16])], EXPECTED);

    expect(violations).toContain('Le plan doit compter exactement 2 semaines, il en compte 1.');
  });

  it('relève une semaine qui ne compte pas le bon nombre de séances', () => {
    const violations = validatePlanBusinessRules(
      [week([2, 7], [8, 16]), week([2, 4, 7], [8, 10, 18])],
      EXPECTED,
    );

    expect(violations).toContain('Semaine 1 : 2 séances au lieu des 3 demandées.');
  });

  it('relève deux séances le même jour', () => {
    const violations = validatePlanBusinessRules(
      [week([2, 2, 7], [8, 10, 16]), week([2, 4, 7], [8, 10, 18])],
      EXPECTED,
    );

    expect(violations).toContain('Semaine 1 : deux séances tombent le mardi, un seul jour chacune.');
  });

  it('relève une semaine sans sortie longue le jour imposé', () => {
    const violations = validatePlanBusinessRules(
      [week([2, 4, 6], [8, 10, 16]), week([2, 4, 7], [8, 10, 18])],
      EXPECTED,
    );

    expect(violations).toContain('Semaine 1 : aucune séance le dimanche, jour de la sortie longue.');
  });

  it('relève une sortie longue qui n’est pas la plus longue séance de sa semaine', () => {
    const violations = validatePlanBusinessRules(
      [week([2, 4, 7], [8, 22, 16]), week([2, 4, 7], [8, 10, 18])],
      EXPECTED,
    );

    expect(violations).toContain(
      'Semaine 1 : la séance la plus longue tombe le jeudi et non le dimanche, qui doit porter la sortie longue.',
    );
  });

  it('ne relève rien quand une autre séance égale la sortie longue sans la dépasser', () => {
    const weeks = [week([3, 5, 7], [10, 8, 10]), week([2, 4, 7], [8, 10, 18])];

    expect(validatePlanBusinessRules(weeks, EXPECTED)).toEqual([]);
  });

  it('relève un vrai maximum ailleurs, même quand la sortie longue le talonne', () => {
    const weeks = [week([3, 5, 7], [10.5, 8, 10]), week([2, 4, 7], [8, 10, 18])];

    expect(validatePlanBusinessRules(weeks, EXPECTED)).toContain(
      'Semaine 1 : la séance la plus longue tombe le mercredi et non le dimanche, qui doit porter la sortie longue.',
    );
  });

  it('compare les durées quand aucune séance ne porte de distance', () => {
    const weeks: PlanWeekOutput[] = [
      {
        sessions: [
          session(2, { durationMin: 45 }),
          session(4, { durationMin: 90 }),
          session(7, { durationMin: 60 }),
        ],
      },
      week([2, 4, 7], [8, 10, 18]),
    ];

    expect(validatePlanBusinessRules(weeks, EXPECTED)).toContain(
      'Semaine 1 : la séance la plus longue tombe le jeudi et non le dimanche, qui doit porter la sortie longue.',
    );
  });

  it('ne juge pas la plus longue séance quand les unités sont mélangées', () => {
    const weeks: PlanWeekOutput[] = [
      {
        sessions: [
          session(2, { distanceKm: 8 }),
          session(4, { durationMin: 90 }),
          session(7, { distanceKm: 16 }),
        ],
      },
      week([2, 4, 7], [8, 10, 18]),
    ];

    expect(validatePlanBusinessRules(weeks, EXPECTED)).toEqual([]);
  });

  describe('première semaine entamée', () => {
    const partial = { ...EXPECTED, firstWeekFromDay: 5 };

    it('accepte un compte réduit sur la semaine déjà commencée', () => {
      const weeks = [week([5, 7], [8, 16]), week([2, 4, 7], [8, 10, 18])];

      expect(validatePlanBusinessRules(weeks, partial)).toEqual([]);
    });

    it('refuse malgré tout de dépasser le nombre de séances hebdomadaire', () => {
      const weeks = [week([5, 6, 7, 7], [8, 9, 16, 4]), week([2, 4, 7], [8, 10, 18])];

      expect(validatePlanBusinessRules(weeks, partial)).toContain(
        'Semaine 1 (déjà entamée) : 4 séances, alors que le maximum est 3.',
      );
    });

    it('refuse une séance placée sur un jour déjà passé', () => {
      const weeks = [week([2, 7], [8, 16]), week([2, 4, 7], [8, 10, 18])];

      expect(validatePlanBusinessRules(weeks, partial)).toContain(
        'Semaine 1 : aucune séance avant vendredi, ces jours sont passés — la séance placée le mardi est à retirer.',
      );
    });

    it('n’exige plus la sortie longue si son jour est déjà passé', () => {
      const weeks = [week([6], [8]), week([2, 3, 5], [8, 18, 10])];

      expect(validatePlanBusinessRules(weeks, { ...partial, longRunDay: 3 })).toEqual([]);
    });

    it('exige toujours le compte plein sur les semaines suivantes', () => {
      const weeks = [week([5, 7], [8, 16]), week([2, 7], [8, 18])];

      expect(validatePlanBusinessRules(weeks, partial)).toEqual([
        'Semaine 2 : 2 séances au lieu des 3 demandées.',
      ]);
    });
  });
});
