import { describe, expect, it } from 'vitest';

import type { TrainingPaces } from '@/lib/metrics/vdot';
import type { PlanSessionSteps, PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

import {
  PLAN_OUTPUT_BOUNDS,
  isMarathonGoal,
  mapPlanWeeksToSessions,
  planJsonSchema,
  planOutputSchema,
  planUpdateJsonSchema,
  planUpdateOutputSchema,
  taperWeekCount,
  validatePlanBusinessRules,
  type PlanExpectations,
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

const EXPECTED: PlanExpectations = { scope: 'creation', weeks: 2, sessionsPerWeek: 3, longRunDay: 7 };

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
    const weeks = [week([3, 5, 7], [10, 8, 10]), week([2, 4, 7], [8, 8, 14])];

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

    // Le classement des séances est abandonné, faute d'unité commune ; il reste
    // la distance manquante, sans laquelle aucun volume hebdomadaire n'existe.
    expect(validatePlanBusinessRules(weeks, EXPECTED)).toEqual([
      'Volumes hebdomadaires invérifiables : chaque séance déclare sa distance `distanceKm`, ' +
        'footings et récupérations compris — il en manque semaine 1.',
    ]);
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

  /**
   * Le garde-fou dur des allures : le prompt *demande* de dériver les allures de
   * l'allure récente de l'athlète, il ne peut pas l'imposer. Un 10:00/km prescrit
   * à une coureuse qui court en 5:30/km est passé en production.
   */
  describe('corridor de plausibilité des allures', () => {
    /** 5:30/km — corridor dérivé : 3:40/km (330 − 110) à 7:40/km (330 + 130). */
    const REFERENCE = 330;
    const conforming = week([2, 4, 7], [8, 10, 18]);

    /** Une semaine conforme dont la séance du jeudi porte les allures éprouvées. */
    function weekWith(tested: Partial<PlanWeekOutput['sessions'][number]>): PlanWeekOutput {
      return {
        sessions: [
          session(2, { distanceKm: 8 }),
          session(4, { kind: 'Seuil', title: '4 × 8 min', distanceKm: 10, ...tested }),
          session(7, { kind: 'Sortie longue', title: '16 km', distanceKm: 16 }),
        ],
      };
    }

    /** Un déroulé de séance de qualité complet, dont l'effort porte l'allure donnée. */
    function stepsAtPace(fast: number, slow = fast): PlanSessionSteps {
      return [
        { repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] },
        {
          repeat: 4,
          steps: [
            step('run', { durationS: 480, paceMinSecPerKm: fast, paceMaxSecPerKm: slow }),
            step('recover', { durationS: 120 }),
          ],
        },
        { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
      ];
    }

    it('relève une allure d’étape hors du corridor, et rappelle la fourchette', () => {
      const violations = validatePlanBusinessRules(
        [weekWith({ steps: stepsAtPace(600) }), conforming],
        EXPECTED,
        { referencePaceSecPerKm: REFERENCE },
      );

      expect(violations).toEqual([
        'Semaine 1, séance du jeudi (Seuil) : allure 10:00/km hors de la fourchette plausible ' +
          "[3:40/km – 7:40/km] dérivée de l'allure récente de l'athlète (5:30/km).",
      ]);
    });

    it('relève une allure de séance hors du corridor', () => {
      // Kind sans exigence de déroulé : c'est bien le `targetPaceSecPerKm` seul
      // qui est jugé.
      const violations = validatePlanBusinessRules(
        [weekWith({ kind: 'Endurance fondamentale', targetPaceSecPerKm: 200 }), conforming],
        EXPECTED,
        { referencePaceSecPerKm: REFERENCE },
      );

      expect(violations).toEqual([
        'Semaine 1, séance du jeudi (Endurance fondamentale) : allure 3:20/km hors de la fourchette plausible ' +
          "[3:40/km – 7:40/km] dérivée de l'allure récente de l'athlète (5:30/km).",
      ]);
    });

    it('ne relève rien quand les allures prescrites tiennent dans le corridor', () => {
      const weeks = [
        weekWith({ targetPaceSecPerKm: 300, steps: stepsAtPace(285, 300) }),
        conforming,
      ];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { referencePaceSecPerKm: REFERENCE })).toEqual([]);
    });

    it('inclut les bornes exactes du corridor', () => {
      const onBounds = [weekWith({ steps: stepsAtPace(220, 460) }), conforming];
      expect(validatePlanBusinessRules(onBounds, EXPECTED, { referencePaceSecPerKm: REFERENCE })).toEqual([]);

      // Une seconde au-delà, de chaque côté.
      expect(
        validatePlanBusinessRules([weekWith({ steps: stepsAtPace(219) }), conforming], EXPECTED, { referencePaceSecPerKm: REFERENCE }),
      ).toHaveLength(1);
      expect(
        validatePlanBusinessRules([weekWith({ steps: stepsAtPace(461) }), conforming], EXPECTED, { referencePaceSecPerKm: REFERENCE }),
      ).toHaveLength(1);
    });

    it('ne relève qu’une ligne par séance, même quand toutes ses allures dérapent', () => {
      const weeks = [
        weekWith({ targetPaceSecPerKm: 600, steps: stepsAtPace(620, 640) }),
        conforming,
      ];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { referencePaceSecPerKm: REFERENCE })).toHaveLength(1);
    });

    it('juge les allures même quand la semaine perd sa sortie longue', () => {
      // Comme pour le déroulé : la règle de sortie longue sort de la semaine par
      // `return`, les allures doivent avoir été jugées avant.
      const weeks: PlanWeekOutput[] = [
        {
          sessions: [
            session(2, { distanceKm: 8 }),
            session(4, { kind: 'Seuil', distanceKm: 10, steps: stepsAtPace(600) }),
            session(5, { distanceKm: 16 }),
          ],
        },
        conforming,
      ];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { referencePaceSecPerKm: REFERENCE }).join(' ')).toContain(
        'hors de la fourchette plausible',
      );
    });

    it('ne juge aucune allure sans référence : le plan cible alors des zones FC', () => {
      const weeks = [
        weekWith({ targetPaceSecPerKm: 900, steps: stepsAtPace(120, 880) }),
        conforming,
      ];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { referencePaceSecPerKm: null })).toEqual([]);
      // Référence omise : le contrôle n'existe pas non plus.
      expect(validatePlanBusinessRules(weeks, EXPECTED)).toEqual([]);
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

/**
 * La table d'allures d'un 10 km en 48:30 (VDOT ≈ 44,8), écrite en dur : les
 * valeurs viennent de `lib/metrics/vdot`, mais les figer ici garde le message de
 * violation lisible dans le test — c'est lui que le modèle recevra.
 *
 * Corridor attendu : [répétitions − 10 s, endurance + 60 s] = [3:45/km – 7:10/km].
 */
const PACES: TrainingPaces = {
  vdot: 44.8,
  easy: { minSecPerKm: 335, maxSecPerKm: 370 },
  marathon: { minSecPerKm: 295, maxSecPerKm: 320 },
  threshold: { minSecPerKm: 280, maxSecPerKm: 292 },
  interval: { minSecPerKm: 252, maxSecPerKm: 265 },
  repetition: { minSecPerKm: 235, maxSecPerKm: 245 },
};

/**
 * Le corridor **calculé** : quand l'athlète a donné un chrono, les allures ne se
 * dérivent plus d'une moyenne d'entraînement, elles sortent de la table. Le
 * corridor se resserre d'autant, et le message cite la table pour que le modèle
 * sache où rentrer.
 */
describe('validatePlanBusinessRules — corridor VDOT', () => {
  const conforming = week([2, 4, 7], [8, 10, 18]);

  function weekWith(tested: Partial<PlanWeekOutput['sessions'][number]>): PlanWeekOutput {
    return {
      sessions: [
        session(2, { distanceKm: 8 }),
        session(4, { kind: 'Seuil', title: '4 × 8 min', distanceKm: 10, ...tested }),
        session(7, { kind: 'Sortie longue', title: '16 km', distanceKm: 16 }),
      ],
    };
  }

  function stepsAtPace(fast: number, slow = fast): PlanSessionSteps {
    return [
      { repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] },
      {
        repeat: 4,
        steps: [
          step('run', { durationS: 480, paceMinSecPerKm: fast, paceMaxSecPerKm: slow }),
          step('recover', { durationS: 120 }),
        ],
      },
      { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
    ];
  }

  it('accepte les allures de la table, du seuil à la récupération trottée', () => {
    const weeks = [
      weekWith({ targetPaceSecPerKm: 285, steps: stepsAtPace(280, 292) }),
      conforming,
    ];

    expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toEqual([]);
  });

  it('relève une allure plus rapide que les répétitions, table à l’appui', () => {
    const violations = validatePlanBusinessRules(
      [weekWith({ steps: stepsAtPace(220) }), conforming],
      EXPECTED,
      { paces: PACES },
    );

    expect(violations).toEqual([
      'Semaine 1, séance du jeudi (Seuil) : allure 3:40/km hors de la fourchette plausible ' +
        "[3:45/km – 7:10/km] de ta table d'allures calculée (E 5:35–6:10/km, T 4:40–4:52/km, " +
        'I 4:12–4:25/km, R 3:55–4:05/km), récupérations comprises.',
    ]);
  });

  it('inclut les bornes exactes du corridor calculé', () => {
    const onBounds = [weekWith({ steps: stepsAtPace(225, 430) }), conforming];
    expect(validatePlanBusinessRules(onBounds, EXPECTED, { paces: PACES })).toEqual([]);

    // Une seconde au-delà, de chaque côté.
    expect(
      validatePlanBusinessRules([weekWith({ steps: stepsAtPace(224) }), conforming], EXPECTED, {
        paces: PACES,
      }),
    ).toHaveLength(1);
    expect(
      validatePlanBusinessRules([weekWith({ steps: stepsAtPace(431) }), conforming], EXPECTED, {
        paces: PACES,
      }),
    ).toHaveLength(1);
  });

  it('prime sur l’allure récente quand les deux sont connues', () => {
    // 7:30/km : dans le corridor large dérivé de 5:30/km, hors de la table.
    const weeks = [
      weekWith({ kind: 'Endurance fondamentale', targetPaceSecPerKm: 450 }),
      conforming,
    ];

    expect(
      validatePlanBusinessRules(weeks, EXPECTED, { referencePaceSecPerKm: 330, paces: PACES }),
    ).toHaveLength(1);
    expect(
      validatePlanBusinessRules(weeks, EXPECTED, { referencePaceSecPerKm: 330 }),
    ).toEqual([]);
  });

  /**
   * Le prompt imposé dit « récupérations plus lentes que E.max, ou sans cible »,
   * sans borne. Le corridor doit dire la même chose, sans quoi une consigne du
   * prompt produit une violation — et une génération de plusieurs minutes est
   * relancée pour un trot parfaitement légitime.
   */
  describe('récupérations', () => {
    /** Un déroulé de qualité dont la seule variable est l'allure de la récupération. */
    function stepsRecoveringAt(pace: number): PlanSessionSteps {
      return [
        { repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] },
        {
          repeat: 4,
          steps: [
            step('run', { durationS: 480, paceMinSecPerKm: 280, paceMaxSecPerKm: 292 }),
            step('recover', { durationS: 120, paceMinSecPerKm: pace, paceMaxSecPerKm: pace }),
          ],
        },
        { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
      ];
    }

    it('accepte une récupération bien plus lente que l’endurance', () => {
      // 8:15/km : au-delà de la borne lente (7:10/km), et c'est exactement ce que
      // le prompt autorise — jusqu'à la portion marchée d'un débutant.
      const weeks = [weekWith({ steps: stepsRecoveringAt(495) }), conforming];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toEqual([]);
    });

    it('refuse malgré tout une récupération plus rapide que les répétitions', () => {
      // La dispense ne vaut que du côté lent : une « récupération » à 3:20/km
      // n'en est pas une.
      const weeks = [weekWith({ steps: stepsRecoveringAt(200) }), conforming];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toHaveLength(1);
    });

    it('refuse toujours une étape d’effort trop lente', () => {
      const weeks = [weekWith({ steps: stepsAtPace(495) }), conforming];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toHaveLength(1);
    });

    it('dispense aussi la récupération du corridor de repli', () => {
      // Sans table, le corridor dérivé de 5:30/km s'arrête à 7:40/km : la
      // récupération n'y est pas plus bornée.
      const weeks = [weekWith({ steps: stepsRecoveringAt(600) }), conforming];

      expect(
        validatePlanBusinessRules(weeks, EXPECTED, { referencePaceSecPerKm: 330 }),
      ).toEqual([]);
    });
  });

  /**
   * Les lignes droites du prompt débutant (« 6 à 8 × 30 s à 1 min vite ») se
   * courent plus vite que des répétitions calibrées sur 200 à 400 m. Les refuser
   * reviendrait à refuser une séance que le prompt vient de prescrire.
   */
  describe('accélérations courtes', () => {
    /** Une séance de qualité dont le bloc d'effort porte la mesure et l'allure données. */
    function stepsSprinting(measure: Partial<PlanStep>, pace: number): PlanSessionSteps {
      return [
        { repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] },
        {
          repeat: 6,
          steps: [
            step('run', { ...measure, paceMinSecPerKm: pace, paceMaxSecPerKm: pace }),
            step('recover', { durationS: 90 }),
          ],
        },
        { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
      ];
    }

    it('accepte une ligne droite de 45 s plus rapide que les répétitions', () => {
      const weeks = [weekWith({ steps: stepsSprinting({ durationS: 45 }, 200) }), conforming];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toEqual([]);
    });

    it('accepte de même une accélération mesurée en mètres', () => {
      const weeks = [weekWith({ steps: stepsSprinting({ distanceM: 150 }, 200) }), conforming];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toEqual([]);
    });

    it('refuse la même allure sur un effort qui n’est plus court', () => {
      // 90 s : au-delà de l'accélération, une allure plus rapide que R est une
      // erreur de plan.
      const weeks = [weekWith({ steps: stepsSprinting({ durationS: 90 }, 200) }), conforming];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toHaveLength(1);
    });

    it('garde la borne lente sur une étape courte', () => {
      // La dispense ne joue que du côté rapide : 10:00/km sur 45 s reste une
      // aberration.
      const weeks = [weekWith({ steps: stepsSprinting({ durationS: 45 }, 600) }), conforming];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toHaveLength(1);
    });
  });
});

/**
 * La progression du volume — la moitié « entraîneur » de la validation.
 *
 * Ce que ces tests protègent : le plan qui a motivé la règle, douze semaines au
 * même volume avec des séances interchangeables, ne doit plus pouvoir passer.
 */
describe('validatePlanBusinessRules — progression du volume', () => {
  /** Une semaine de trois séances, sortie longue le dimanche (la plus longue). */
  function volumeWeek(easy: number, quality: number, longRun: number): PlanWeekOutput {
    return week([2, 4, 7], [easy, quality, longRun]);
  }

  /** Semaines de 30, 32, 34… km, toutes conformes aux règles autres que celle éprouvée. */
  const W = {
    30: volumeWeek(10, 10, 10),
    31: volumeWeek(10, 10, 11),
    32: volumeWeek(10, 10, 12),
    33: volumeWeek(11, 10, 12),
    34: volumeWeek(11, 11, 12),
    36: volumeWeek(12, 11, 13),
    38: volumeWeek(13, 12, 13),
    27: volumeWeek(9, 9, 9),
    28: volumeWeek(9, 9, 10),
    29: volumeWeek(9, 9, 11),
    25: volumeWeek(8, 8, 9),
    22: volumeWeek(7, 7, 8),
    21: volumeWeek(7, 7, 7),
    26: volumeWeek(8, 8, 10),
    19: volumeWeek(6, 6, 7),
  } as const;

  /** Les attentes d'un objectif libre de `weeks` semaines. */
  function free(weeks: number): PlanExpectations {
    return { scope: 'creation', weeks, sessionsPerWeek: 3, longRunDay: 7 };
  }

  /** Les mêmes, pour une course (donc avec affûtage). */
  function race(weeks: number, isMarathon = false): PlanExpectations {
    return { ...free(weeks), race: { isMarathon } };
  }

  /** Une course, jugée sur la **fenêtre restante** d'un plan déjà écrit. */
  function adjustment(weeks: number, isMarathon = false): PlanExpectations {
    return { ...race(weeks, isMarathon), scope: 'adjustment' };
  }

  describe('hausse hebdomadaire', () => {
    it('accepte une hausse de 12 % pile', () => {
      // 25 → 28 km : exactement le plafond, et le plafond est admis.
      expect(validatePlanBusinessRules([W[25], W[28]], free(2))).toEqual([]);
    });

    it('relève la première hausse qui le dépasse, chiffres à l’appui', () => {
      expect(validatePlanBusinessRules([W[25], W[29]], free(2))).toEqual([
        'Semaine 2 : 29,0 km après 25,0 km, soit 16,0 % de hausse. Le volume ne monte jamais de ' +
          "plus de 12,0 % d'une semaine à l'autre — 28,0 km au plus ici.",
      ]);
    });

    it('annonce un plafond que la règle accepte, à l’unité affichée', () => {
      // 29,8 × 1,12 = 33,376 : « 33,4 km au plus » serait refusé par la règle qui
      // l'annonce. Le plafond s'arrondit donc au dixième inférieur.
      const start = volumeWeek(9.9, 9.9, 10);

      expect(validatePlanBusinessRules([start, W[34]], free(2))).toEqual([
        'Semaine 2 : 34,0 km après 29,8 km, soit 14,1 % de hausse. Le volume ne monte jamais de ' +
          "plus de 12,0 % d'une semaine à l'autre — 33,3 km au plus ici.",
      ]);

      // Et le chiffre annoncé satisfait bien la règle.
      expect(validatePlanBusinessRules([start, volumeWeek(11, 11, 11.3)], free(2))).toEqual([]);
    });

    it('laisse toujours redescendre le volume', () => {
      expect(validatePlanBusinessRules([W[34], W[25]], free(2))).toEqual([]);
    });

    it('ne compare rien à une première semaine entamée, amputée par construction', () => {
      // 22 → 34 km, soit +55 % : la première semaine ne portait que trois jours.
      const started = week([5, 7], [10, 12]);

      expect(
        validatePlanBusinessRules([started, W[34]], { ...free(2), firstWeekFromDay: 5 }),
      ).toEqual([]);
    });
  });

  describe('semaine allégée', () => {
    it('ne relève rien quand une semaine sur quatre redescend', () => {
      expect(
        validatePlanBusinessRules([W[30], W[32], W[34], W[27], W[29], W[31]], free(6)),
      ).toEqual([]);
    });

    it('relève quatre semaines de suite sans respiration, une seule fois', () => {
      const violations = validatePlanBusinessRules(
        [W[27], W[29], W[31], W[33], W[36], W[38]],
        free(6),
      );

      expect(violations).toEqual([
        'Semaines 1 à 4 : quatre semaines de suite sans semaine allégée. ' +
          "L'une d'elles doit redescendre à 85,0 % ou moins du volume de la semaine précédente.",
      ]);
    });

    it('accepte une baisse à 85 % pile', () => {
      // 40 → 34 km : exactement 85 %, la semaine compte pour allégée.
      const weeks = [W[30], W[32], volumeWeek(13, 13, 14), W[34], W[36], W[38]];

      expect(validatePlanBusinessRules(weeks, free(6)).join(' ')).not.toContain('sans semaine allégée');
    });

    it('ne s’applique pas sous six semaines', () => {
      expect(validatePlanBusinessRules([W[27], W[29], W[31], W[33], W[34]], free(5))).toEqual([]);
    });

    it('ne s’applique pas quand l’affûtage ne laisse que quatre semaines de développement', () => {
      // 6 semaines dont 2 d'affûtage : exiger une semaine allégée dans les
      // quatre restantes gaspillerait le quart du bloc, l'affûtage suit déjà.
      expect(
        validatePlanBusinessRules([W[27], W[29], W[31], W[33], W[29], W[21]], race(6)),
      ).toEqual([]);
    });
  });

  describe('anti-plat', () => {
    it('relève un plan qui ne monte jamais', () => {
      expect(validatePlanBusinessRules([W[30], W[30], W[30], W[30], W[30]], free(5))).toEqual([
        'Plan trop plat : la semaine la plus chargée hors affûtage (30,0 km) doit dépasser ' +
          "d'au moins 10,0 % la première semaine pleine (30,0 km), soit 33,0 km au minimum.",
      ]);
    });

    it('accepte un pic à 110 % pile de la première semaine pleine', () => {
      expect(validatePlanBusinessRules([W[30], W[31], W[32], W[33], W[30]], free(5))).toEqual([]);
    });

    it('ne s’applique pas à un plan de quatre semaines', () => {
      expect(validatePlanBusinessRules([W[30], W[30], W[30], W[30]], free(4))).toEqual([]);
    });

    it('annonce un plancher que la règle accepte, à l’unité affichée', () => {
      // 30,4 × 1,1 = 33,44 : « 33,4 km au minimum » serait refusé par la règle
      // qui l'annonce. Le plancher s'arrondit donc au dixième supérieur.
      const flat = volumeWeek(10, 10, 10.4);

      expect(validatePlanBusinessRules([flat, flat, flat, flat, flat], free(5))).toEqual([
        'Plan trop plat : la semaine la plus chargée hors affûtage (30,4 km) doit dépasser ' +
          "d'au moins 10,0 % la première semaine pleine (30,4 km), soit 33,5 km au minimum.",
      ]);

      // Et le chiffre annoncé satisfait bien la règle.
      const weeks = [flat, W[31], W[32], volumeWeek(11, 11, 11.5), W[30]];
      expect(validatePlanBusinessRules(weeks, free(5))).toEqual([]);
    });

    it('mesure le pic hors affûtage, et part de la première semaine pleine', () => {
      // Le pic se lit sur les semaines de développement, et la semaine 1
      // entamée — 22 km en trois jours — ne sert pas de repère.
      const weeks = [week([5, 7], [10, 12]), W[30], W[31], W[32], W[33], W[27], W[21]];

      expect(
        validatePlanBusinessRules(weeks, { ...race(7), firstWeekFromDay: 5 }),
      ).toEqual([]);
    });

    /**
     * Six semaines de course, dont deux d'affûtage : quatre semaines de
     * développement, le minimum pour que l'anti-plat laisse un choix. Le même
     * plan est jugé à la création et sur une fenêtre restante — seule la portée
     * change.
     */
    const fourBuildWeeks = [W[30], W[30], W[30], W[30], W[29], W[19]];

    it('ne juge pas la platitude d’une fenêtre restante d’ajustement', () => {
      // Le cas reproduit : un marathon ajusté à quelques semaines de la course.
      // Exiger un pic supérieur à sa première semaine reviendrait à demander de
      // monter le volume en plein affûtage.
      expect(validatePlanBusinessRules(fourBuildWeeks, adjustment(6, true))).toEqual([]);
    });

    it('la juge sur le même plan à la création', () => {
      expect(validatePlanBusinessRules(fourBuildWeeks, race(6))).toEqual([
        'Plan trop plat : la semaine la plus chargée hors affûtage (30,0 km) doit dépasser ' +
          "d'au moins 10,0 % la première semaine pleine (30,0 km), soit 33,0 km au minimum.",
      ]);
    });

    it('laisse les autres règles de volume actives à l’ajustement', () => {
      // Une hausse de 16 % reste une hausse de 16 %, fenêtre restante ou pas.
      const weeks = [W[25], W[29], W[31], W[33], W[29], W[19]];

      expect(validatePlanBusinessRules(weeks, adjustment(6))).toEqual([
        'Semaine 2 : 29,0 km après 25,0 km, soit 16,0 % de hausse. Le volume ne monte jamais de ' +
          "plus de 12,0 % d'une semaine à l'autre — 28,0 km au plus ici.",
      ]);
    });

    it('ne s’applique pas à trois semaines de développement', () => {
      // Cinq semaines dont deux d'affûtage : deux transitions seulement pour
      // porter la montée, soit un pic enfermé entre 110 % (anti-plat) et 125 %
      // (deux hausses de 12 %) de la première semaine. La bande ne s'ouvre
      // vraiment qu'à quatre semaines de développement.
      expect(validatePlanBusinessRules([W[30], W[30], W[30], W[29], W[19]], race(5))).toEqual([]);
    });
  });

  describe('affûtage', () => {
    it('ne relève rien sur un affûtage strictement décroissant', () => {
      expect(
        validatePlanBusinessRules([W[30], W[32], W[34], W[36], W[30], W[22]], race(6)),
      ).toEqual([]);
    });

    it('relève une semaine d’affûtage qui ne descend pas', () => {
      const violations = validatePlanBusinessRules(
        [W[30], W[32], W[34], W[36], W[38], W[22]],
        race(6),
      );

      expect(violations).toContain(
        'Semaine 5 (affûtage) : 38,0 km, autant ou plus que la semaine 4 (36,0 km) — ' +
          "pendant l'affûtage, le volume baisse strictement chaque semaine.",
      );
    });

    it('relève une semaine de course trop chargée par rapport au pic', () => {
      const violations = validatePlanBusinessRules(
        [W[30], W[32], W[34], W[36], W[30], W[26]],
        race(6),
      );

      expect(violations).toEqual([
        'Semaine 6 (semaine de course) : 26,0 km, soit 72,2 % du pic (36,0 km) — elle reste sous ' +
          '65,0 % du pic, 23,4 km au plus.',
      ]);
    });

    it('donne trois semaines d’affûtage à un marathon, deux au reste', () => {
      // Semaine 6 monte encore : c'est une faute pour un marathon (elle est déjà
      // dans l'affûtage), pas pour un semi.
      const weeks = [W[27], W[29], W[31], W[33], W[36], W[38], W[30], W[22]];

      expect(validatePlanBusinessRules(weeks, race(8, true)).join(' ')).toContain(
        'Semaine 6 (affûtage)',
      );
      expect(validatePlanBusinessRules(weeks, race(8)).join(' ')).not.toContain('affûtage');
    });

    it('n’exige aucun affûtage d’un objectif libre', () => {
      expect(
        validatePlanBusinessRules([W[30], W[32], W[34], W[36], W[38]], free(5)),
      ).toEqual([]);
    });
  });

  describe('poids de la sortie longue', () => {
    it('relève une sortie longue trop courte pour sa semaine', () => {
      // 5 km sur 41 : la « sortie longue » n'en est pas une.
      const weeks = [week([2, 4, 7], [18, 18, 5])];

      expect(validatePlanBusinessRules(weeks, free(1))).toContain(
        'Semaine 1 : la sortie longue fait 5,0 km pour 41,0 km dans la semaine (12,2 %) — elle doit ' +
          'peser entre 20,0 % et 53,3 % du volume hebdomadaire.',
      );
    });

    it('tolère une sortie longue de 47 % sur une semaine de trois séances', () => {
      // Trois séances équilibrées en donnent déjà 33 % : plafonner à 40 % ferait
      // constater une faute que l'arithmétique impose.
      expect(validatePlanBusinessRules([week([2, 4, 7], [8, 10, 16])], free(1))).toEqual([]);
    });

    it('applique bien 40 % dès quatre séances', () => {
      const weeks = [{ sessions: [
        session(2, { distanceKm: 8 }),
        session(3, { distanceKm: 8 }),
        session(5, { distanceKm: 8 }),
        session(7, { distanceKm: 18 }),
      ] }];

      expect(
        validatePlanBusinessRules(weeks, { scope: 'creation', weeks: 1, sessionsPerWeek: 4, longRunDay: 7 }),
      ).toContain(
        'Semaine 1 : la sortie longue fait 18,0 km pour 42,0 km dans la semaine (42,9 %) — elle ' +
          'doit peser entre 20,0 % et 40,0 % du volume hebdomadaire.',
      );
    });

    it('ne juge ni la semaine entamée ni les semaines d’affûtage', () => {
      // Semaine 1 amputée et semaine de course : leur sortie longue ne pèse plus
      // rien, et c'est normal.
      const weeks = [
        { sessions: [session(7, { distanceKm: 5 })] },
        W[30],
        W[32],
        { sessions: [session(2, { distanceKm: 8 }), session(4, { distanceKm: 8 }), session(7, { distanceKm: 4 })] },
      ];

      expect(
        validatePlanBusinessRules(weeks, { ...race(4), firstWeekFromDay: 5 }).join(' '),
      ).not.toContain('la sortie longue fait');
    });
  });

  describe('distances déclarées', () => {
    it('exige la distance de chaque séance, en une seule ligne pour tout le plan', () => {
      const weeks = [
        {
          sessions: [
            session(2, { durationMin: 45 }),
            session(4, { distanceKm: 10 }),
            session(7, { distanceKm: 12 }),
          ],
        },
        W[30],
        {
          sessions: [
            session(2, { durationMin: 45 }),
            session(4, { durationMin: 50 }),
            session(7, { durationMin: 90 }),
          ],
        },
      ];

      expect(validatePlanBusinessRules(weeks, free(3)).filter((violation) =>
        violation.startsWith('Volumes hebdomadaires'),
      )).toEqual([
        'Volumes hebdomadaires invérifiables : chaque séance déclare sa distance `distanceKm`, ' +
          'footings et récupérations compris — il en manque semaine 1, semaine 3.',
      ]);
    });

    it('ne relève aucune progression fantôme autour d’une semaine sans volume', () => {
      const blind: PlanWeekOutput = {
        sessions: [
          session(2, { durationMin: 45 }),
          session(4, { durationMin: 50 }),
          session(7, { durationMin: 90 }),
        ],
      };
      const weeks = [W[30], blind, W[34]];
      const violations = validatePlanBusinessRules(weeks, free(3));

      // Une seule ligne : la distance manquante. Ni hausse, ni baisse déduite
      // d'une somme partielle.
      expect(violations).toHaveLength(1);
    });
  });
});

describe('taperWeekCount', () => {
  it('ne compte aucune semaine d’affûtage sans course', () => {
    expect(taperWeekCount(12, null)).toBe(0);
    expect(taperWeekCount(12, undefined)).toBe(0);
  });

  it('donne deux semaines par défaut, trois à un marathon assez long', () => {
    expect(taperWeekCount(12, { isMarathon: false })).toBe(2);
    expect(taperWeekCount(12, { isMarathon: true })).toBe(3);
    // Sous huit semaines, un marathon n'a pas la place d'affûter trois semaines.
    expect(taperWeekCount(7, { isMarathon: true })).toBe(2);
    expect(taperWeekCount(8, { isMarathon: true })).toBe(3);
  });

  it('ne dépasse jamais la longueur du plan', () => {
    expect(taperWeekCount(1, { isMarathon: false })).toBe(1);
  });
});

describe('isMarathonGoal', () => {
  it('reconnaît un marathon, accents et casse compris', () => {
    expect(isMarathonGoal('Marathon de Paris')).toBe(true);
    expect(isMarathonGoal('mon premier marathon')).toBe(true);
  });

  it('ne prend pas un semi pour un marathon', () => {
    for (const goal of [
      'Semi-marathon de Nantes',
      'semi marathon',
      'Demi-marathon',
      'half marathon',
      // Graphies des pages d'inscription : le « 1/2 », et le trait d'union
      // insécable que produisent les traitements de texte.
      '1/2 marathon de Nantes',
      '1/2marathon',
      'semi‑marathon de Nantes',
    ]) {
      expect(isMarathonGoal(goal)).toBe(false);
    }
  });

  it('reste faux sur tout le reste', () => {
    expect(isMarathonGoal('10 km sous 50 min')).toBe(false);
  });
});
