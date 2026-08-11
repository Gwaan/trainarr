import { describe, expect, it } from 'vitest';

import type { PlanSessionSteps, PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

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

/** Une étape normalisée, telle qu'elle sort du schéma : sept clés, `null` pour absent. */
function step(role: PlanStepRole, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role,
    distanceM: null,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
    ...overrides,
  };
}

/** Le déroulé type d'une séance de qualité : échauffement, blocs, retour au calme. */
function qualitySteps(overrides: { warmup?: boolean; cooldown?: boolean; recover?: boolean } = {}) {
  const { warmup = true, cooldown = true, recover = true } = overrides;
  const effort = step('run', { durationS: 480, paceMinSecPerKm: 300, paceMaxSecPerKm: 310 });

  return [
    ...(warmup ? [{ repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] }] : []),
    { repeat: 4, steps: recover ? [effort, step('recover', { durationS: 120 })] : [effort] },
    ...(cooldown ? [{ repeat: 1, steps: [step('cooldown', { durationS: 600 })] }] : []),
  ] satisfies PlanSessionSteps;
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

describe('planOutputSchema — déroulé structuré', () => {
  /** Le déroulé tel que le modèle l'écrit : les champs sans valeur sont absents. */
  function parseSteps(steps: unknown) {
    return planOutputSchema.safeParse({
      summary: 'x',
      weeks: [{ sessions: [{ day: 3, kind: 'Seuil', title: '3 × 8 min', steps }] }],
    });
  }

  it('accepte un déroulé et le normalise : clés absentes à `null`, `repeat` à 1', () => {
    const result = parseSteps([
      { steps: [{ role: 'warmup', durationS: 900, hrZone: 2 }] },
      {
        repeat: 4,
        steps: [
          { role: 'run', distanceM: 1_000, paceMinSecPerKm: 300, paceMaxSecPerKm: 310 },
          { role: 'recover', durationS: 120, note: '  trot souple  ' },
        ],
      },
    ]);

    expect(result.success).toBe(true);
    const parsed = result.data?.weeks[0].sessions[0].steps;
    expect(parsed?.[0]).toEqual({
      repeat: 1,
      steps: [
        {
          role: 'warmup',
          distanceM: null,
          durationS: 900,
          paceMinSecPerKm: null,
          paceMaxSecPerKm: null,
          hrZone: 2,
          note: null,
        },
      ],
    });
    expect(parsed?.[1].repeat).toBe(4);
    expect(parsed?.[1].steps[1].note).toBe('trot souple');
  });

  it('laisse `steps` absent sur une séance qui n’en porte pas', () => {
    const parsed = planOutputSchema.parse({ summary: 'x', weeks: [week([7])] });

    expect(parsed.weeks[0].sessions[0].steps).toBeUndefined();
  });

  it('arrondit les valeurs entières que le contrat exige', () => {
    const result = parseSteps([{ steps: [{ role: 'run', durationS: 150.4 }] }]);

    expect(result.data?.weeks[0].sessions[0].steps?.[0].steps[0].durationS).toBe(150);
  });

  it('refuse une étape qui porte ses deux mesures', () => {
    expect(parseSteps([{ steps: [{ role: 'run', distanceM: 1_000, durationS: 300 }] }]).success).toBe(
      false,
    );
  });

  it('refuse une étape sans aucune mesure', () => {
    expect(parseSteps([{ steps: [{ role: 'run', hrZone: 3 }] }]).success).toBe(false);
  });

  it('normalise une borne unique en allure unique (constaté en prod : le modèle n’en écrit qu’une)', () => {
    const min = parseSteps([{ steps: [{ role: 'run', distanceM: 1_000, paceMinSecPerKm: 300 }] }]);
    const minStep = min.data?.weeks[0].sessions[0].steps?.[0].steps[0];
    expect(minStep?.paceMinSecPerKm).toBe(300);
    expect(minStep?.paceMaxSecPerKm).toBe(300);

    const max = parseSteps([{ steps: [{ role: 'run', distanceM: 1_000, paceMaxSecPerKm: 310 }] }]);
    const maxStep = max.data?.weeks[0].sessions[0].steps?.[0].steps[0];
    expect(maxStep?.paceMinSecPerKm).toBe(310);
    expect(maxStep?.paceMaxSecPerKm).toBe(310);
  });

  it('remet à l’endroit des bornes d’allure inversées', () => {
    const result = parseSteps([
      { steps: [{ role: 'run', distanceM: 1_000, paceMinSecPerKm: 320, paceMaxSecPerKm: 300 }] },
    ]);

    const step = result.data?.weeks[0].sessions[0].steps?.[0].steps[0];
    expect(step?.paceMinSecPerKm).toBe(300);
    expect(step?.paceMaxSecPerKm).toBe(320);
  });

  it('refuse une allure et une zone cardiaque sur la même étape', () => {
    expect(
      parseSteps([
        {
          steps: [
            { role: 'run', distanceM: 1_000, paceMinSecPerKm: 300, paceMaxSecPerKm: 310, hrZone: 4 },
          ],
        },
      ]).success,
    ).toBe(false);
  });

  it('refuse une zone cardiaque hors des cinq zones du projet', () => {
    expect(parseSteps([{ steps: [{ role: 'run', durationS: 600, hrZone: 6 }] }]).success).toBe(false);
  });

  it('refuse une allure aberrante, un rôle inventé et un bloc vide', () => {
    expect(
      parseSteps([
        { steps: [{ role: 'run', distanceM: 400, paceMinSecPerKm: 30, paceMaxSecPerKm: 30 }] },
      ]).success,
    ).toBe(false);
    expect(parseSteps([{ steps: [{ role: 'sprint', distanceM: 400 }] }]).success).toBe(false);
    expect(parseSteps([{ steps: [] }]).success).toBe(false);
  });

  it('refuse un nombre de répétitions hors bornes', () => {
    expect(parseSteps([{ repeat: 0, steps: [{ role: 'run', distanceM: 400 }] }]).success).toBe(false);
    expect(parseSteps([{ repeat: 21, steps: [{ role: 'run', distanceM: 400 }] }]).success).toBe(
      false,
    );
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

  it('déclare le déroulé sans type nullable, comme le reste du fichier', () => {
    const json = JSON.stringify(planJsonSchema);

    // Un bloc exige ses étapes, une étape exige son rôle ; tout le reste est
    // facultatif par absence — c'est ce que la conversion GBNF traduit.
    expect(json).toContain('"required":["steps"]');
    expect(json).toContain('"required":["role"]');
    expect(json).toContain('"enum":["warmup","run","recover","cooldown"]');
    expect(json).not.toContain('null');
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
      steps: null,
    });
  });

  it('transmet le déroulé au DAL tel quel — c’est lui qui en dérive volume et durée', () => {
    const steps = qualitySteps();
    const sessions = mapPlanWeeksToSessions(
      [{ sessions: [session(4, { kind: 'Seuil', steps })] }],
      '2026-08-17',
    );

    expect(sessions[0].steps).toEqual(steps);
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

  describe('déroulé des séances', () => {
    /** Une semaine conforme dont la séance du jeudi est celle qu'on éprouve. */
    function weekWith(quality: Partial<PlanWeekOutput['sessions'][number]>): PlanWeekOutput {
      return {
        sessions: [
          session(2, { distanceKm: 8 }),
          session(4, { kind: 'Seuil', title: '4 × 8 min', distanceKm: 10, ...quality }),
          session(7, { kind: 'Sortie longue', title: '16 km', distanceKm: 16 }),
        ],
      };
    }

    const conforming = week([2, 4, 7], [8, 10, 18]);

    it('ne relève rien sur une séance de qualité complète', () => {
      expect(
        validatePlanBusinessRules([weekWith({ steps: qualitySteps() }), conforming], EXPECTED),
      ).toEqual([]);
    });

    it('relève une séance d’intensité livrée sans déroulé', () => {
      const violations = validatePlanBusinessRules([weekWith({}), conforming], EXPECTED);

      expect(violations).toContain(
        "Semaine 1, séance du jeudi (Seuil) : une séance de qualité exige un déroulé `steps` — échauffement, blocs d'effort avec leurs récupérations, retour au calme.",
      );
    });

    it('relève une séance dure sans échauffement, et sans retour au calme', () => {
      const violations = validatePlanBusinessRules(
        [
          weekWith({
            kind: 'VMA',
            title: '5 × 3 min',
            steps: qualitySteps({ warmup: false, cooldown: false }),
          }),
          conforming,
        ],
        EXPECTED,
      );

      expect(violations).toContain(
        'Semaine 1, séance du jeudi (VMA) : aucun échauffement — commence par une étape `warmup` de 10 à 20 min avant les efforts.',
      );
      expect(violations).toContain(
        'Semaine 1, séance du jeudi (VMA) : aucun retour au calme — termine par une étape `cooldown` de 5 à 10 min.',
      );
    });

    it('reconnaît le vocabulaire des séances de qualité, accents compris', () => {
      for (const kind of ['Côtes', 'Fractionné', 'VMA · piste', 'Répétitions courtes']) {
        expect(
          validatePlanBusinessRules([weekWith({ kind }), conforming], EXPECTED).join(' '),
        ).toContain('exige un déroulé');
      }
    });

    it('ne réclame pas de déroulé à une sortie longue spécifique', () => {
      // Libellé que le prompt encourage : une sortie longue avec un bloc à
      // allure objectif reste une séance d'endurance, pas une séance de qualité.
      const weeks: PlanWeekOutput[] = [
        {
          sessions: [
            session(2, { distanceKm: 8 }),
            session(4, { kind: 'Endurance fondamentale', distanceKm: 10 }),
            session(7, { kind: 'Sortie longue spécifique', title: '18 km', distanceKm: 18 }),
          ],
        },
        conforming,
      ];

      expect(validatePlanBusinessRules(weeks, EXPECTED)).toEqual([]);
    });

    it('relève un bloc répété sans étape de récupération', () => {
      const violations = validatePlanBusinessRules(
        [weekWith({ steps: qualitySteps({ recover: false }) }), conforming],
        EXPECTED,
      );

      expect(violations).toContain(
        "Semaine 1, séance du jeudi (Seuil) : le bloc répété 4 fois n'a pas de récupération — chaque passage porte son effort ET son étape `recover`.",
      );
    });

    it('ne réclame ni échauffement ni déroulé à une séance facile', () => {
      const easy: PlanWeekOutput = {
        sessions: [
          session(2, { distanceKm: 8 }),
          session(4, { kind: 'Endurance fondamentale', distanceKm: 10 }),
          session(7, { kind: 'Sortie longue', title: '16 km', distanceKm: 16 }),
        ],
      };

      expect(validatePlanBusinessRules([easy, conforming], EXPECTED)).toEqual([]);
    });

    it('juge le déroulé même quand la semaine perd sa sortie longue', () => {
      // La règle de sortie longue sort de la semaine par `return` : les étapes
      // doivent avoir été jugées avant.
      const weeks: PlanWeekOutput[] = [
        { sessions: [session(2, { distanceKm: 8 }), session(4, { kind: 'Seuil', distanceKm: 10 }), session(5, { distanceKm: 16 })] },
        conforming,
      ];
      const violations = validatePlanBusinessRules(weeks, EXPECTED);

      expect(violations).toContain('Semaine 1 : aucune séance le dimanche, jour de la sortie longue.');
      expect(violations.join(' ')).toContain('exige un déroulé');
    });
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
