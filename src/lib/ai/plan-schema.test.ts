import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { TrainingPaces } from '@/lib/metrics/vdot';
import {
  planSessionStepsSchema,
  type PlanSessionSteps,
  type PlanStep,
  type PlanStepRole,
} from '@/lib/plan-steps/schema';

import type { SessionBudget } from './format';
import {
  PLAN_OUTPUT_BOUNDS,
  applyDerivedMeasures,
  applyImposedPaces,
  goalPaceSecPerKm,
  isMarathonGoal,
  sessionPaceZone,
  mapPlanWeeksToSessions,
  planInstructionJsonSchema,
  planInstructionOutputSchema,
  planReviewJsonSchema,
  planReviewOutputSchema,
  planWeeksPostProcessing,
  resolveWeeklyTimeBudget,
  taperWeekCount,
  validatePlanBusinessRules,
  weeklySessionBudgets,
  weeklyVolumeTargets,
  type PlanExpectations,
  type PlanWeekOutput,
  type WeeklyVolumeTarget,
  type WeeklyVolumeTargetsParams,
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
    hrPercentMin: null,
    hrPercentMax: null,
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

describe('planInstructionOutputSchema', () => {
  it('accepte une instruction qui ne change aucun réglage', () => {
    const parsed = planInstructionOutputSchema.parse({});
    expect(parsed.settings).toBeUndefined();
  });

  it('accepte un patch partiel de réglages', () => {
    const parsed = planInstructionOutputSchema.parse({ settings: { sessionsPerWeek: 3 } });
    expect(parsed.settings).toEqual({ sessionsPerWeek: 3 });
  });

  it('accepte un budget temps effacé : `null` lève la contrainte, il ne la tait pas', () => {
    const parsed = planInstructionOutputSchema.parse({ settings: { weeklyTimeMinutes: null } });
    expect(parsed.settings).toEqual({ weeklyTimeMinutes: null });
  });

  it('refuse un réglage hors bornes plutôt que de le rabattre', () => {
    expect(planInstructionOutputSchema.safeParse({ settings: { longRunDay: 8 } }).success).toBe(
      false,
    );
    expect(
      planInstructionOutputSchema.safeParse({ settings: { sessionsPerWeek: 0 } }).success,
    ).toBe(false);
  });

  it('ne laisse passer aucune semaine : le modèle n’en écrit plus', () => {
    // La grammaire ne propose pas la clé ; Zod l'écarte pour les providers qui
    // ne la suivent pas. Une semaine qui passerait ici pourrait être appliquée
    // telle quelle, sans être passée par le squelette ni par les règles de
    // volume — c'est exactement ce que l'inversion retire au modèle.
    expect(planInstructionOutputSchema.parse({ weeks: [week([7])] })).not.toHaveProperty('weeks');
  });
});

describe('planReviewOutputSchema', () => {
  it('accepte une révision qui ne change rien', () => {
    const parsed = planReviewOutputSchema.parse({
      decision: 'keep',
      reason: 'Les séances sont dans les cibles.',
    });

    expect(parsed).toEqual({ decision: 'keep', reason: 'Les séances sont dans les cibles.' });
  });

  it('écarte les réglages d’un « keep » : rien ne doit pouvoir être appliqué', () => {
    const parsed = planReviewOutputSchema.parse({
      decision: 'keep',
      reason: 'Rien à changer.',
      settings: { sessionsPerWeek: 3 },
    });

    expect(parsed).not.toHaveProperty('settings');
  });

  it('accepte un « adjust » sans réglages : l’appli recalcule seule les semaines', () => {
    const parsed = planReviewOutputSchema.parse({
      decision: 'adjust',
      reason: 'Charge trop élevée.',
    });

    expect(parsed).toEqual({ decision: 'adjust', reason: 'Charge trop élevée.' });
  });

  it('accepte un « adjust » avec un patch de réglages', () => {
    const parsed = planReviewOutputSchema.parse({
      decision: 'adjust',
      reason: 'Trois séances manquées : on repasse à 3 par semaine.',
      settings: { sessionsPerWeek: 3 },
    });

    expect(parsed).toMatchObject({ decision: 'adjust', settings: { sessionsPerWeek: 3 } });
  });

  it('ne laisse passer aucune semaine : une révision juge, elle n’écrit pas', () => {
    expect(
      planReviewOutputSchema.parse({
        decision: 'adjust',
        reason: 'Charge trop élevée.',
        weeks: [week([7])],
      }),
    ).not.toHaveProperty('weeks');
  });

  it('refuse une décision inventée', () => {
    expect(
      planReviewOutputSchema.safeParse({ decision: 'rewrite', reason: 'x' }).success,
    ).toBe(false);
  });
});

/**
 * Les trois états du budget temps dans un patch de réglages.
 *
 * La faille qu'ils ferment : une sortie qui élargit le budget était jugée contre
 * l'ancien, donc en violation à chaque tentative — l'ajustement était condamné
 * aux trois échecs.
 */
describe('resolveWeeklyTimeBudget', () => {
  it('reconduit le budget stocké quand la sortie ne porte pas de réglages', () => {
    expect(resolveWeeklyTimeBudget(undefined, 120)).toBe(120);
    expect(resolveWeeklyTimeBudget(undefined, null)).toBeNull();
  });

  it('reconduit le budget stocké quand le patch ne parle pas du temps', () => {
    expect(resolveWeeklyTimeBudget({ sessionsPerWeek: 4 }, 120)).toBe(120);
  });

  it('prend le budget que le patch déclare', () => {
    expect(resolveWeeklyTimeBudget({ weeklyTimeMinutes: 240 }, 120)).toBe(240);
    // Et il vaut aussi à la baisse : le patch fait foi, quel que soit le sens.
    expect(resolveWeeklyTimeBudget({ weeklyTimeMinutes: 90 }, 120)).toBe(90);
  });

  it('lève toute contrainte quand le patch efface le budget', () => {
    expect(resolveWeeklyTimeBudget({ weeklyTimeMinutes: null }, 120)).toBeNull();
  });
});

describe('JSON Schema', () => {
  it('interdit les propriétés inventées, et n’exige rien d’une instruction', () => {
    const json = JSON.stringify(planInstructionJsonSchema);
    expect(json).toContain('"additionalProperties":false');
    // Une consigne qui ne change aucun réglage durable est le cas nominal :
    // exiger la clé forcerait le modèle à inventer un nombre de séances.
    expect(planInstructionJsonSchema.required).toEqual([]);
  });

  it('ne propose aucune semaine ni au modèle d’instruction ni à celui de révision', () => {
    // Ce que la grammaire ne propose pas, le modèle ne peut pas l'écrire : c'est
    // la première des deux barrières qui lui retirent l'écriture des plans.
    expect(JSON.stringify(planInstructionJsonSchema)).not.toContain('weeks');
    expect(JSON.stringify(planReviewJsonSchema)).not.toContain('weeks');
  });

  it('déclare les réglages sans type nullable, comme le reste du fichier', () => {
    const json = JSON.stringify(planInstructionJsonSchema);
    // `weeklyTimeMinutes: null` (« plus de contrainte ») se traduit mal en GBNF :
    // l'omission dit déjà « inchangé », et Zod accepte le `null` d'un provider
    // hors grammaire.
    expect(json).not.toContain('null');
  });

  it('reste cohérent avec les bornes partagées par le schéma Zod', () => {
    const instruction = planInstructionJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const settings = instruction.settings.properties as Record<string, Record<string, unknown>>;

    expect(instruction.settings.additionalProperties).toBe(false);
    expect(settings.sessionsPerWeek.maximum).toBe(PLAN_OUTPUT_BOUNDS.sessionsPerWeek.max);
    expect(settings.longRunDay.maximum).toBe(PLAN_OUTPUT_BOUNDS.day.max);
    expect(settings.weeklyTimeMinutes.maximum).toBe(PLAN_OUTPUT_BOUNDS.weeklyTimeMinutes.max);
  });

  it('n’exige d’une révision que sa décision et sa raison', () => {
    // `settings` hors de `required` : c'est ce qui permet de conclure « keep »
    // sans rien patcher. Zod tient l'implication inverse.
    expect(planReviewJsonSchema.required).toEqual(['decision', 'reason']);

    const review = planReviewJsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(review.decision.enum).toEqual(['keep', 'adjust']);
    expect(review.reason.maxLength).toBe(PLAN_OUTPUT_BOUNDS.reasonChars);
    // Les réglages sont ceux d'une instruction, à la lettre.
    expect(review.settings).toBe(
      (planInstructionJsonSchema.properties as Record<string, unknown>).settings,
    );
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

  /*
   * La semaine de la course, quand la fenêtre en déclare une (`raceDay`).
   *
   * Elle se juge comme une **première semaine entamée**, et pour la même raison :
   * il y a des jours sur lesquels elle ne peut rien poser. Le jour J la ferme,
   * exactement comme le jour de reprise l'ouvre — donc un maximum de séances au
   * lieu d'un compte exact, et rien après le jour J.
   *
   * Ce que ça répare, mesuré avant : un marathon un lundi à 6 séances recevait
   * 5 séances et 23,3 km **après** la course, dont une le lendemain de l'épreuve.
   */
  describe('semaine de course', () => {
    /** Course le mercredi de la dernière semaine — un jour J qui ampute vraiment. */
    const WITH_RACE: PlanExpectations = { ...EXPECTED, raceDay: 3 };

    it('accepte une semaine de course qui porte moins de séances que le réglage', () => {
      // Deux séances au lieu de trois : la semaine s'arrête au mercredi, elle
      // n'a que trois jours à remplir et en garde un de repos avant le jour J.
      const weeks = [week([2, 4, 7], [8, 10, 16]), week([1, 3], [6, 12])];

      expect(validatePlanBusinessRules(weeks, WITH_RACE)).toEqual([]);
    });

    it('refuse une séance programmée après le jour J', () => {
      const weeks = [week([2, 4, 7], [8, 10, 16]), week([1, 3, 4], [6, 12, 8])];

      expect(validatePlanBusinessRules(weeks, WITH_RACE)).toContain(
        'Semaine 2 : aucune séance après le mercredi, jour de la course — la séance placée le jeudi est à retirer.',
      );
    });

    it('plafonne quand même son nombre de séances', () => {
      const weeks = [week([2, 4, 7], [8, 10, 16]), week([1, 2, 3], [4, 4, 12])];

      expect(
        validatePlanBusinessRules([weeks[0], { sessions: [...weeks[1].sessions, session(3)] }], {
          ...WITH_RACE,
          // Quatre séances sur une semaine qui n'en admet que trois.
          sessionsPerWeek: 3,
        }),
      ).toContain('Semaine 2 (semaine de course) : 4 séances, alors que le maximum est 3.');
    });

    /*
     * Le message, et lui seul : la course qui tombe le jour de sortie longue
     * habituel — un dimanche, le cas le plus fréquent — rendait `hardDay` égal à
     * `longRunDay`, et la violation parlait alors de « jour de la sortie
     * longue » sur la semaine de la course.
     */
    it('nomme la course même quand elle tombe le jour de sortie longue habituel', () => {
      const weeks = [week([2, 4, 7], [8, 10, 16]), week([1, 2, 4], [6, 6, 12])];

      expect(validatePlanBusinessRules(weeks, { ...EXPECTED, raceDay: 7 })).toContain(
        'Semaine 2 : aucune séance le dimanche, jour de la course.',
      );
    });
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

      // Une étape réclamée, jamais une longueur : la grammaire du modèle ne sait
      // écrire que des mètres, et lui demander « 10 à 20 min » était une consigne
      // qu'aucune sortie conforme ne pouvait honorer.
      expect(violations).toContain(
        'Semaine 1, séance du jeudi (VMA) : aucun échauffement — commence par une étape `warmup`.',
      );
      expect(violations).toContain(
        'Semaine 1, séance du jeudi (VMA) : aucun retour au calme — termine par une étape `cooldown`.',
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

  /**
   * Le corridor **ne juge que des allures** : une étape ciblée en fréquence
   * cardiaque n'en porte aucune, elle ne peut donc pas en sortir.
   *
   * C'est le comportement d'origine de `hrZone` (une étape en zone n'a jamais
   * eu de bornes d'allure à comparer), et c'est ce qui autorise l'endurance à
   * passer en FC sans toucher à cette règle. Le vérifier explicitement plutôt
   * que de le supposer : la prescription en FC en dépend entièrement.
   */
  describe('étape ciblée en fréquence cardiaque', () => {
    /** La semaine conforme, dont le footing du mardi est prescrit en zone 2. */
    function weekWithEasyInZone(
      overrides: Partial<PlanWeekOutput['sessions'][number]> = {},
    ): PlanWeekOutput {
      return {
        sessions: [
          session(2, {
            distanceKm: 8,
            steps: [{ repeat: 1, steps: [step('run', { distanceM: 8_000, hrZone: 2 })] }],
            ...overrides,
          }),
          session(4, { kind: 'Seuil', title: '4 × 8 min', distanceKm: 10, steps: stepsAtPace(286) }),
          session(7, { kind: 'Sortie longue', title: '16 km', distanceKm: 16 }),
        ],
      };
    }

    it('ne juge pas une étape sans allure — elle n’a rien à comparer', () => {
      const weeks = [weekWithEasyInZone(), conforming];

      expect(validatePlanBusinessRules(weeks, EXPECTED, { paces: PACES })).toEqual([]);
    });

    it('continue de juger la cible d’allure de la séance qui les porte', () => {
      // L'« allure indicative » d'une séance prescrite en FC reste une allure
      // prescrite : elle passe bien devant le corridor.
      const weeks = [weekWithEasyInZone({ targetPaceSecPerKm: 900 }), conforming];

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

  /**
   * Le budget temps déclaré — la contrainte de vie que rien ne vérifiait.
   *
   * Le plan qui a motivé la règle : 2 h par semaine déclarées, ~3 h 30
   * planifiées. Aucune règle de volume ne pouvait le voir, les durées n'étaient
   * comparées à rien.
   */
  describe('budget temps hebdomadaire', () => {
    /** Une semaine de trois séances, distances **et** durées déclarées. */
    function timedWeek(distancesKm: number[], durationsMin: number[]): PlanWeekOutput {
      return {
        sessions: [2, 4, 7].map((day, index) =>
          session(day, { distanceKm: distancesKm[index], durationMin: durationsMin[index] }),
        ),
      };
    }

    /** Une semaine qui tient largement dans deux heures. */
    const modest = timedWeek([3, 3, 5], [25, 25, 42]);

    it('relève la semaine qui déborde, budget et plafond en toutes lettres', () => {
      const weeks = [modest, timedWeek([3.3, 3.3, 5.5], [55, 55, 98])];

      expect(validatePlanBusinessRules(weeks, free(2), { weeklyTimeMinutes: 120 })).toEqual([
        "Semaine 2 : 3 h 28 d'entraînement pour un budget déclaré de 2 h 00 — " +
          'réduis distances ou séances (2 h 24 au plus, tolérance comprise).',
      ]);
    });

    it('tolère 20 % pile, et pas une minute de plus', () => {
      // 144 min pour un budget de 120 : la tolérance, exactement.
      expect(
        validatePlanBusinessRules([timedWeek([3, 3, 5], [48, 48, 48])], free(1), {
          weeklyTimeMinutes: 120,
        }),
      ).toEqual([]);

      expect(
        validatePlanBusinessRules([timedWeek([3, 3, 5], [48, 48, 49])], free(1), {
          weeklyTimeMinutes: 120,
        }),
      ).toHaveLength(1);
    });

    /**
     * Les deux bords de la tolérance, dans les termes de l'athlète : « 2 h par
     * semaine » est un ordre de grandeur au service d'un programme cohérent, pas
     * un couperet. Un quart d'heure de plus ne vaut pas une régénération de
     * plusieurs minutes ; une demi-heure, si.
     */
    it('laisse passer un débordement de 15 %, refuse à 25 %', () => {
      // 138 min pour 120 déclarées.
      expect(
        validatePlanBusinessRules([timedWeek([3, 3, 5], [46, 46, 46])], free(1), {
          weeklyTimeMinutes: 120,
        }),
      ).toEqual([]);

      // 150 min : ce n'est plus un arrondi, c'est une demi-heure qui n'existe pas.
      expect(
        validatePlanBusinessRules([timedWeek([3, 3, 5], [50, 50, 50])], free(1), {
          weeklyTimeMinutes: 120,
        }),
      ).toHaveLength(1);
    });

    it('ne contrôle rien sans budget déclaré', () => {
      const huge = timedWeek([3, 3, 5], [120, 120, 180]);
      expect(validatePlanBusinessRules([huge], free(1))).toEqual([]);
      expect(validatePlanBusinessRules([huge], free(1), { weeklyTimeMinutes: null })).toEqual([]);
    });

    it('ne contrôle pas une semaine dont une séance ne déclare pas sa durée', () => {
      // Une somme partielle ferait constater un budget respecté qui ne l'est
      // pas : mieux vaut ne pas juger.
      const partial: PlanWeekOutput = {
        sessions: [
          session(2, { distanceKm: 3, durationMin: 25 }),
          session(4, { distanceKm: 3 }),
          session(7, { distanceKm: 5, durationMin: 200 }),
        ],
      };

      expect(validatePlanBusinessRules([partial], free(1), { weeklyTimeMinutes: 120 })).toEqual([]);
    });

    it('ramène le budget au prorata des jours restants d’une première semaine entamée', () => {
      // Départ un jeudi : quatre jours restants, donc 4/7 de 2 h — la semaine
      // entamée n'ouvre pas un droit d'y tout concentrer.
      const started: PlanWeekOutput = {
        sessions: [
          session(5, { distanceKm: 4, durationMin: 35 }),
          session(7, { distanceKm: 6, durationMin: 55 }),
        ],
      };

      expect(
        validatePlanBusinessRules([started, modest], { ...free(2), firstWeekFromDay: 4 }, {
          weeklyTimeMinutes: 120,
        }),
      ).toEqual([
        "Semaine 1 (déjà entamée, 4 jours restants) : 1 h 30 d'entraînement pour un budget " +
          'déclaré de 2 h 00 ramené à 1 h 08 au prorata — réduis distances ou séances ' +
          '(1 h 22 au plus, tolérance comprise).',
      ]);
    });

    it('n’impose aucun budget à une semaine entamée de moins de quatre jours', () => {
      // Le défaut constaté : un ajustement lancé un samedi reprend le dimanche
      // (`firstWeekFromDay: 7`), et 2 h se prorataient en 17 min — quand la règle
      // de sortie longue exige une sortie longue ce dimanche-là. Aucune semaine
      // ne pouvait satisfaire les deux, et les trois tentatives étaient perdues
      // d'avance.
      const sunday: PlanWeekOutput = { sessions: [session(7, { distanceKm: 10, durationMin: 75 })] };

      expect(
        validatePlanBusinessRules([sunday, modest], { ...free(2), firstWeekFromDay: 7 }, {
          weeklyTimeMinutes: 120,
        }),
      ).toEqual([]);

      // Un jour de plus dans la semaine ne change rien : le seuil est à quatre.
      expect(
        validatePlanBusinessRules([sunday, modest], { ...free(2), firstWeekFromDay: 5 }, {
          weeklyTimeMinutes: 120,
        }),
      ).toEqual([]);
    });

    it('contrôle la semaine entamée dès le seuil de quatre jours, et pas en deçà', () => {
      // La bascule, au jour près, sur une même semaine de 1 h 30 : à quatre jours
      // restants le plafond vaut 1 h 22 et la semaine déborde ; à trois, il n'y a
      // plus de plafond du tout.
      const started: PlanWeekOutput = { sessions: [session(7, { distanceKm: 10, durationMin: 90 })] };

      expect(
        validatePlanBusinessRules([started, modest], { ...free(2), firstWeekFromDay: 4 }, {
          weeklyTimeMinutes: 120,
        }),
      ).toHaveLength(1);

      expect(
        validatePlanBusinessRules([started, modest], { ...free(2), firstWeekFromDay: 5 }, {
          weeklyTimeMinutes: 120,
        }),
      ).toEqual([]);
    });

    it('vaut aussi sur les semaines d’affûtage : c’est du temps, pas du volume', () => {
      // L'affûtage baisse le volume, pas forcément la durée déclarée : la
      // semaine de course reste soumise au budget.
      const weeks = [modest, timedWeek([2.8, 2.8, 4.5], [90, 90, 90])];

      expect(
        validatePlanBusinessRules(weeks, race(2), { weeklyTimeMinutes: 120 }).filter((violation) =>
          violation.includes('budget déclaré'),
        ),
      ).toEqual([
        "Semaine 2 : 4 h 30 d'entraînement pour un budget déclaré de 2 h 00 — " +
          'réduis distances ou séances (2 h 24 au plus, tolérance comprise).',
      ]);
    });
  });

  /**
   * L'ancrage du départ sur le volume réellement couru.
   *
   * Le plan qui a motivé la règle : 25 km la première semaine, chez une athlète
   * dont les quatre dernières semaines font 9 à 13,6 km.
   */
  describe('ancrage de la première semaine au volume réel récent', () => {
    it('relève un départ trop haut, avec les chiffres réels', () => {
      const start = volumeWeek(5, 5, 8);

      expect(
        validatePlanBusinessRules([start, start], free(2), { recentWeeklyKm: 13.6 }),
      ).toEqual([
        'Semaine 1 : 18,0 km pour une première semaine pleine — ta meilleure semaine récente ' +
          'fait 13,6 km ; la première semaine pleine reste sous 16,6 km.',
      ]);
    });

    it('accepte le plafond annoncé, à l’unité affichée', () => {
      // 13,6 + 3 = 16,6 km : le chiffre du message satisfait la règle qui
      // l'annonce (le `+3 km` l'emporte ici sur les +20 %, qui donneraient 16,3).
      const start = volumeWeek(5.3, 5.3, 6);

      expect(validatePlanBusinessRules([start, start], free(2), { recentWeeklyKm: 13.6 })).toEqual(
        [],
      );
    });

    it('n’étrangle pas les tout petits volumes : le `+3 km` l’emporte', () => {
      // 4 km récents : +20 % ne laisserait que 800 m de latitude, moins qu'une
      // séance. Le plancher additif ouvre à 7 km.
      const seven = volumeWeek(2, 2, 3);
      expect(validatePlanBusinessRules([seven, seven], free(2), { recentWeeklyKm: 4 })).toEqual([]);

      expect(
        validatePlanBusinessRules([volumeWeek(2, 2, 3.1), seven], free(2), { recentWeeklyKm: 4 }),
      ).toEqual([
        'Semaine 1 : 7,1 km pour une première semaine pleine — ta meilleure semaine récente ' +
          'fait 4,0 km ; la première semaine pleine reste sous 7,0 km.',
      ]);
    });

    it('juge la première semaine PLEINE, pas la semaine entamée du départ', () => {
      const started = week([5, 7], [4, 6]);

      expect(
        validatePlanBusinessRules([started, volumeWeek(5, 5, 8)], { ...free(2), firstWeekFromDay: 5 }, {
          recentWeeklyKm: 13.6,
        }),
      ).toEqual([
        'Semaine 2 : 18,0 km pour une première semaine pleine — ta meilleure semaine récente ' +
          'fait 13,6 km ; la première semaine pleine reste sous 16,6 km.',
      ]);
    });

    it('ne contrôle rien sans historique', () => {
      const start = volumeWeek(5, 5, 8);

      expect(validatePlanBusinessRules([start, start], free(2))).toEqual([]);
      expect(validatePlanBusinessRules([start, start], free(2), { recentWeeklyKm: null })).toEqual([]);
      expect(validatePlanBusinessRules([start, start], free(2), { recentWeeklyKm: 0 })).toEqual([]);
    });

    it('ne s’applique qu’aux créations : un plan en cours fait foi, pas son avant', () => {
      const start = volumeWeek(5, 5, 8);

      expect(
        validatePlanBusinessRules([start, start], { ...free(2), scope: 'adjustment' }, {
          recentWeeklyKm: 13.6,
        }),
      ).toEqual([]);
    });
  });

  /**
   * Budget serré et anti-plat : satisfaisables **ensemble**.
   *
   * Le cas qui a fait poser la question — 13 km récents, 2 h par semaine, une
   * athlète à ~8:20/km — donne un plafond de volume (~15,8 km) plus bas que ce
   * que la progression voudrait. Les deux règles ne se contredisent pourtant
   * pas : le budget est absolu, l'anti-plat relatif à une première semaine que
   * le modèle choisit. Aucune ne cède, c'est le départ qui descend.
   */
  describe('satisfaisabilité budget × progression', () => {
    /** Une semaine de trois séances chronométrées à 8:20/km — l'allure de l'athlète. */
    function slowWeek(distancesKm: number[]): PlanWeekOutput {
      return {
        sessions: [2, 4, 7].map((day, index) =>
          session(day, {
            distanceKm: distancesKm[index],
            durationMin: Math.round((distancesKm[index] * 500) / 60),
          }),
        ),
      };
    }

    const context = { weeklyTimeMinutes: 120, recentWeeklyKm: 13.6 };

    it('accepte un plan de 6 semaines qui part du volume réel et tient dans 2 h', () => {
      // 13 → 14,5 → 12 → 13,4 → 14,9 → 13 km : hausses sous 12 %, semaine
      // allégée en 3, pic à +14,6 %, départ sous le plafond, et 2 h 05 au pire.
      const weeks = [
        slowWeek([4, 4, 5]),
        slowWeek([4.5, 4.5, 5.5]),
        slowWeek([3.5, 3.5, 5]),
        slowWeek([4, 4, 5.4]),
        slowWeek([4.5, 4.5, 5.9]),
        slowWeek([4, 4, 5]),
      ];

      expect(validatePlanBusinessRules(weeks, free(6), context)).toEqual([]);
    });

    it('fait céder le départ, pas l’anti-plat, quand le budget plafonne le volume', () => {
      // Cinq semaines collées au plafond du budget (15,8 km, 2 h 12 pile) : le
      // budget est tenu, mais le plan ne monte plus. C'est l'anti-plat qui parle.
      const capped = slowWeek([5, 5, 5.8]);
      const violations = validatePlanBusinessRules([capped, capped, capped, capped, capped], free(5), context);

      expect(violations).toEqual([
        'Plan trop plat : la semaine la plus chargée hors affûtage (15,8 km) doit dépasser ' +
          "d'au moins 10,0 % la première semaine pleine (15,8 km), soit 17,4 km au minimum.",
      ]);

      // Et la réponse attendue du modèle — démarrer plus bas — satisfait tout.
      expect(
        validatePlanBusinessRules(
          [
            slowWeek([4, 4, 5]),
            slowWeek([4.5, 4.5, 5.5]),
            slowWeek([3.75, 3.75, 5]),
            slowWeek([4.25, 4.25, 5.5]),
            slowWeek([4, 4, 5]),
          ],
          free(5),
          context,
        ),
      ).toEqual([]);
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

describe('goalPaceSecPerKm', () => {
  it('dérive l’allure d’une distance connue et d’un temps, quelle qu’en soit l’écriture', () => {
    // 10 km en 50 min = 5:00/km, quelle que soit la façon de dire les 50 min.
    expect(goalPaceSecPerKm('10 km sous 50 min')).toBe(300);
    expect(goalPaceSecPerKm('Courir 10 km en 50:00')).toBe(300);
    expect(goalPaceSecPerKm('10km, objectif 50 minutes')).toBe(300);

    // 21,0975 km en 1 h 45 = 4:58,6/km, arrondi à la seconde.
    expect(goalPaceSecPerKm('Semi-marathon de Nantes en 1h45')).toBe(299);
    expect(goalPaceSecPerKm('semi en 1 h 45')).toBe(299);

    // 42,195 km en 3 h 30 et en 4 h pile.
    expect(goalPaceSecPerKm('Marathon de Paris en 3h30')).toBe(299);
    expect(goalPaceSecPerKm('marathon sous 4h')).toBe(341);
    expect(goalPaceSecPerKm('Marathon en 3:30:00')).toBe(299);

    expect(goalPaceSecPerKm('5 km en 25 min')).toBe(300);
  });

  it('ne prend pas le nom du semi pour celui du marathon', () => {
    // 1 h 45 sur un marathon donnerait 2:29/km : c'est le semi qui est visé.
    expect(goalPaceSecPerKm('1/2 marathon en 1h45')).toBe(299);
  });

  it('rend null quand une des deux moitiés manque', () => {
    expect(goalPaceSecPerKm('Marathon de Paris')).toBeNull();
    expect(goalPaceSecPerKm('reprendre le volume')).toBeNull();
    expect(goalPaceSecPerKm('courir 45 min sans marcher')).toBeNull();
    // Une distance hors des quatre reconnues : rien n'est deviné.
    expect(goalPaceSecPerKm('trail de 30 km en 3h30')).toBeNull();
    expect(goalPaceSecPerKm('15 km en 1h15')).toBeNull();
  });

  it('écarte ce qui ne ressemble pas à une allure de course à pied', () => {
    // 1:04/km et 36:00/km : une faute de saisie, pas un objectif.
    expect(goalPaceSecPerKm('marathon en 45 min')).toBeNull();
    expect(goalPaceSecPerKm('5 km en 3h')).toBeNull();
  });
});

describe('sessionPaceZone', () => {
  it('range chaque libellé de la typologie dans son créneau', () => {
    expect(sessionPaceZone('Endurance fondamentale')).toBe('easy');
    expect(sessionPaceZone('Footing')).toBe('easy');
    expect(sessionPaceZone('EF')).toBe('easy');
    expect(sessionPaceZone('Sortie longue')).toBe('easy');
    expect(sessionPaceZone('Récupération')).toBe('easy');
    expect(sessionPaceZone('Seuil')).toBe('threshold');
    expect(sessionPaceZone('Tempo')).toBe('threshold');
    expect(sessionPaceZone('VMA')).toBe('interval');
    expect(sessionPaceZone('Intervalles')).toBe('interval');
    expect(sessionPaceZone('Fractionné court')).toBe('interval');
    expect(sessionPaceZone('Séance sur piste')).toBe('interval');
    expect(sessionPaceZone('Répétitions')).toBe('repetition');
    expect(sessionPaceZone('Côtes')).toBe('repetition');
    expect(sessionPaceZone('Spécifique allure course')).toBe('marathon');
    expect(sessionPaceZone('Allure marathon')).toBe('marathon');
    expect(sessionPaceZone("Bloc à allure objectif")).toBe('marathon');
  });

  it('reconnaît accents et casse indifféremment', () => {
    expect(sessionPaceZone('COTES')).toBe('repetition');
    expect(sessionPaceZone('répétitions 400 m')).toBe('repetition');
    expect(sessionPaceZone('SEUIL')).toBe('threshold');
  });

  it('range en endurance ce qu’il ne reconnaît pas', () => {
    // Le pire cas d'un libellé inventé est une séance prescrite trop lente ;
    // c'est le sens conservateur, et la génération n'est jamais perdue pour ça.
    expect(sessionPaceZone('Séance mystère')).toBe('easy');
    expect(sessionPaceZone('')).toBe('easy');
  });

  it('tranche en faveur de l’endurance quand deux créneaux se disputent le libellé', () => {
    // Une sortie longue spécifique est une séance d'endurance avec un bloc à
    // allure objectif : la prescrire entièrement en M enverrait l'athlète courir
    // 18 km à l'allure de sa course.
    expect(sessionPaceZone('Sortie longue spécifique')).toBe('easy');
    expect(sessionPaceZone('Endurance avec bloc allure marathon')).toBe('easy');
  });

  it('range le jour J à l’allure de l’objectif, pas en endurance', () => {
    // « Course », « Compétition » et « Test 5 km » ne portent aucun motif
    // d'intensité : sans exception explicite, ils tombaient en E — soit 6:14/km
    // prescrits le jour d'un 10 km.
    expect(sessionPaceZone('Course')).toBe('marathon');
    expect(sessionPaceZone('Compétition')).toBe('marathon');
    expect(sessionPaceZone('Test 5 km')).toBe('marathon');
    expect(sessionPaceZone('Course objectif — 10 km')).toBe('marathon');
  });

  it('ne prend pas un mot qui contient « course » ou « test » pour un jour J', () => {
    // Les bornes de mot font tout le travail : sans elles, « parcours » suffirait
    // à faire courir une sortie longue à l'allure de la course.
    expect(sessionPaceZone('Sortie longue sur parcours vallonné')).toBe('easy');
    expect(sessionPaceZone('Côtes sur parcours vallonné')).toBe('repetition');
  });

  it('ne prend pas « effort » pour de l’endurance', () => {
    // La racine « ef » se retrouve dans « effort » comme dans « bref » : elle ne
    // vaut qu'isolée, sans quoi une séance d'intensité passerait en E.
    expect(sessionPaceZone('Effort au seuil')).toBe('threshold');
    expect(sessionPaceZone('Efforts courts sur piste')).toBe('interval');
  });
});

describe('applyImposedPaces', () => {
  /** Une séance de qualité dont le modèle a écrit les allures — toutes fausses. */
  const wrongPaceSteps: PlanSessionSteps = [
    { repeat: 1, steps: [step('warmup', { durationS: 900, paceMinSecPerKm: 700, paceMaxSecPerKm: 700 })] },
    {
      repeat: 4,
      steps: [
        step('run', { durationS: 480, paceMinSecPerKm: 660, paceMaxSecPerKm: 720 }),
        step('recover', { durationS: 120, paceMinSecPerKm: 700, paceMaxSecPerKm: 700 }),
      ],
    },
    { repeat: 1, steps: [step('cooldown', { durationS: 600, paceMinSecPerKm: 700, paceMaxSecPerKm: 700 })] },
  ];

  it('pose la cible de séance au milieu du créneau de son `kind`', () => {
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(2, { kind: 'Endurance', targetPaceSecPerKm: 720 }),
            session(3, { kind: 'Seuil' }),
            session(4, { kind: 'VMA' }),
            session(5, { kind: 'Côtes' }),
            session(6, { kind: 'Spécifique allure course' }),
            session(7, { kind: 'Séance mystère' }),
          ],
        },
      ],
      PACES,
    );

    expect(imposed.sessions.map((s) => s.targetPaceSecPerKm)).toEqual([
      353, // E, et les 12:00/km du modèle sont écrasés
      286, // T
      259, // I
      240, // R
      308, // M
      353, // libellé inconnu : E
    ]);
  });

  it('écrit chaque étape selon son rôle : effort au créneau, enveloppe en endurance', () => {
    const [imposed] = applyImposedPaces(
      [{ sessions: [session(4, { kind: 'Seuil', steps: wrongPaceSteps })] }],
      PACES,
    );
    const steps = imposed.sessions[0].steps ?? [];

    // Échauffement et retour au calme d'une séance de qualité : l'endurance —
    // l'écart avec le corps de séance est l'information, et elle est réelle.
    expect(steps[0].steps[0]).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 });
    expect(steps[2].steps[0]).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 });
    // L'effort : les bornes du créneau de la séance.
    expect(steps[1].steps[0]).toMatchObject({ paceMinSecPerKm: 280, paceMaxSecPerKm: 292 });
    // La récupération : aucune cible, la seule consigne qui vaille est « lent ».
    expect(steps[1].steps[1]).toMatchObject({ paceMinSecPerKm: null, paceMaxSecPerKm: null });
  });

  it('n’encadre pas une séance d’endurance : seul son corps porte la plage E', () => {
    // Constaté à l'écran : « Échauffement 1 km 7:57–8:43 · Course 9 km
    // 7:57–8:43 · Retour au calme 10 min 7:57–8:43 ». Trois fois la même plage
    // ne prescrit rien de plus qu'une fois, et donne l'impression d'un plan
    // bâclé — sur une séance E, l'enveloppe se court à l'intensité du corps.
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(7, {
              kind: 'Sortie longue',
              steps: [
                { repeat: 1, steps: [step('warmup', { distanceM: 1000 })] },
                { repeat: 1, steps: [step('run', { distanceM: 9000 })] },
                { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
              ],
            }),
          ],
        },
      ],
      PACES,
    );
    const blocks = imposed.sessions[0].steps ?? [];

    expect(blocks[0].steps[0]).toMatchObject({ paceMinSecPerKm: null, paceMaxSecPerKm: null });
    expect(blocks[1].steps[0]).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 });
    expect(blocks[2].steps[0]).toMatchObject({ paceMinSecPerKm: null, paceMaxSecPerKm: null });
    // La cible de séance, elle, ne bouge pas : c'est elle qui porte le créneau.
    expect(imposed.sessions[0].targetPaceSecPerKm).toBe(353);
  });

  it('donne au bloc d’effort le créneau de sa séance, pas un créneau fixe', () => {
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(4, { kind: 'VMA', steps: wrongPaceSteps }),
            session(5, { kind: 'Répétitions', steps: wrongPaceSteps }),
            session(6, { kind: 'Sortie longue', steps: wrongPaceSteps }),
          ],
        },
      ],
      PACES,
    );
    const effortOf = (index: number) => (imposed.sessions[index].steps ?? [])[1].steps[0];

    expect(effortOf(0)).toMatchObject({ paceMinSecPerKm: 252, paceMaxSecPerKm: 265 });
    expect(effortOf(1)).toMatchObject({ paceMinSecPerKm: 235, paceMaxSecPerKm: 245 });
    expect(effortOf(2)).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 });
  });

  it('honore le créneau que la note d’une étape réclame', () => {
    // La sortie longue reste une séance d'endurance — mais son bloc spécifique,
    // que le prompt encourage, ne doit pas être ramené en E avec le reste.
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(7, {
              kind: 'Sortie longue',
              steps: [
                { repeat: 1, steps: [step('run', { durationS: 2400 })] },
                { repeat: 1, steps: [step('run', { durationS: 1800, note: 'à allure objectif' })] },
                { repeat: 1, steps: [step('run', { durationS: 600, note: 'bloc au seuil' })] },
              ],
            }),
          ],
        },
      ],
      PACES,
    );
    const blocks = imposed.sessions[0].steps ?? [];

    expect(blocks[0].steps[0]).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 }); // E
    expect(blocks[1].steps[0]).toMatchObject({ paceMinSecPerKm: 295, paceMaxSecPerKm: 320 }); // M
    expect(blocks[2].steps[0]).toMatchObject({ paceMinSecPerKm: 280, paceMaxSecPerKm: 292 }); // T
    // La séance, elle, reste une sortie longue : sa cible ne bouge pas.
    expect(imposed.sessions[0].targetPaceSecPerKm).toBe(353);
  });

  describe('allure objectif dérivée du but chiffré', () => {
    /** Une sortie longue dont un seul bloc porte la note « allure objectif ». */
    const longRun = {
      sessions: [
        session(7, {
          kind: 'Sortie longue',
          steps: [
            { repeat: 1, steps: [step('run', { durationS: 2400 })] },
            { repeat: 1, steps: [step('run', { durationS: 1800, note: 'à allure objectif' })] },
          ],
        }),
      ],
    };

    /** L'allure posée sur le bloc spécifique, pour l'objectif donné. */
    function specificPace(goalText: string): { min: number | null; max: number | null } {
      const [imposed] = applyImposedPaces([longRun], PACES, goalPaceSecPerKm(goalText));
      const effort = (imposed.sessions[0].steps ?? [])[1].steps[0];
      return { min: effort.paceMinSecPerKm, max: effort.paceMaxSecPerKm };
    }

    it('pose l’allure de la course, et non la zone M, quand l’objectif est chiffré', () => {
      // 10 km sous 50 min = 5:00/km. La zone M de cette table (295–320) est 25 à
      // 35 s/km plus lente : sur une prépa 10 km, elle n'est pas l'allure de la
      // course.
      expect(specificPace('10 km sous 50 min')).toEqual({ min: 292, max: 308 });
    });

    it('retombe sur la zone M quand l’objectif ne porte pas de chiffre', () => {
      expect(specificPace('Marathon de Paris')).toEqual({ min: 295, max: 320 });
      expect(specificPace('reprendre le volume')).toEqual({ min: 295, max: 320 });
    });

    it('retombe sur la zone M quand l’allure demandée n’est pas plausible', () => {
      // 3:30/km sur un 10 km, quand la table plafonne les intervalles à 4:12/km :
      // l'objectif est hors de portée, le plan reste ancré sur les données.
      expect(specificPace('10 km sous 35 min')).toEqual({ min: 295, max: 320 });
      // 8:00/km : plus lent que l'endurance, ce n'est plus un bloc spécifique.
      expect(specificPace('10 km en 1h20')).toEqual({ min: 295, max: 320 });
    });

    it('ne déborde ni sur le reste de la séance ni sur les autres créneaux', () => {
      const [imposed] = applyImposedPaces([longRun], PACES, goalPaceSecPerKm('10 km sous 50 min'));
      const blocks = imposed.sessions[0].steps ?? [];

      // Le corps de la sortie longue reste en E, et la cible de séance aussi.
      expect(blocks[0].steps[0]).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 });
      expect(imposed.sessions[0].targetPaceSecPerKm).toBe(353);
    });
  });

  it('ne laisse pas la note d’une étape déborder de son rôle ni de la séance', () => {
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(4, {
              kind: 'Seuil',
              steps: [
                {
                  repeat: 1,
                  steps: [
                    step('warmup', { durationS: 900, note: 'avant le bloc à allure course' }),
                    step('run', { durationS: 480, note: 'régulier, sans accélérer' }),
                    step('recover', { durationS: 120, note: 'trot, allure de course interdite' }),
                  ],
                },
              ],
            }),
          ],
        },
      ],
      PACES,
    );
    const steps = (imposed.sessions[0].steps ?? [])[0].steps;

    // L'échauffement reste en E et la récupération sans cible, quoi que dise leur
    // note : seul le rôle `run` lit le créneau demandé.
    expect(steps[0]).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 });
    // Une note qui ne nomme aucun créneau laisse l'étape sur celui de sa séance.
    expect(steps[1]).toMatchObject({ paceMinSecPerKm: 280, paceMaxSecPerKm: 292 });
    expect(steps[2]).toMatchObject({ paceMinSecPerKm: null, paceMaxSecPerKm: null });
  });

  it('ne prescrit aucune allure à une séance de récupération', () => {
    // La doctrine du module : une récupération est plus lente que E.max, ou sans
    // cible. Le milieu de E en ferait un footing.
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(2, {
              kind: 'Récupération',
              steps: [{ repeat: 1, steps: [step('run', { durationS: 1800 })] }],
            }),
            session(3, {
              kind: 'Footing',
              steps: [{ repeat: 1, steps: [step('run', { durationS: 1800 })] }],
            }),
          ],
        },
      ],
      PACES,
    );

    expect(imposed.sessions[0].targetPaceSecPerKm).toBeUndefined();
    expect((imposed.sessions[0].steps ?? [])[0].steps[0]).toMatchObject({
      paceMinSecPerKm: null,
      paceMaxSecPerKm: null,
    });
    // Contre-cas : un footing, lui, reste prescrit en E de bout en bout.
    expect(imposed.sessions[1].targetPaceSecPerKm).toBe(353);
    expect((imposed.sessions[1].steps ?? [])[0].steps[0]).toMatchObject({
      paceMinSecPerKm: 335,
      paceMaxSecPerKm: 370,
    });
  });

  /*
   * Le **test chronométré** : un effort maximal libre. Aucune cible sur son
   * bloc d'effort — ni allure, ni fréquence cardiaque —, l'endurance sur son
   * enveloppe. C'est le contrat que `plan-skeleton/fitness-test.ts` suppose, et
   * il se joue entièrement ici.
   */
  it('ne prescrit aucune cible au bloc d’effort d’un test chronométré', () => {
    const testSession = session(3, {
      kind: 'Test 5 km',
      title: 'Test chronométré : 5 km à fond',
      distanceKm: 7.5,
      steps: [
        { repeat: 1, steps: [step('warmup', { distanceM: 1500 })] },
        { repeat: 1, steps: [step('run', { distanceM: 5000 })] },
        { repeat: 1, steps: [step('cooldown', { distanceM: 1000 })] },
      ],
    });

    // Avec FC max au profil : c'est le régime où l'endurance passe en zone
    // cardiaque, et où un test mal classé recevrait « reste en Z2 » sur un
    // effort maximal.
    const [imposed] = applyImposedPaces([{ sessions: [testSession] }], PACES, null, 184);
    const blocks = imposed.sessions[0].steps ?? [];

    // Ni cible de séance, ni allure, ni zone cardiaque sur l'effort.
    expect(imposed.sessions[0].targetPaceSecPerKm).toBeUndefined();
    expect(blocks[1].steps[0]).toMatchObject({
      paceMinSecPerKm: null,
      paceMaxSecPerKm: null,
      hrZone: null,
    });
    // L'échauffement et le retour au calme, eux, gardent l'endurance : ils se
    // courent, et l'athlète doit savoir à quelle allure.
    expect(blocks[0].steps[0]).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 });
    expect(blocks[2].steps[0]).toMatchObject({ paceMinSecPerKm: 335, paceMaxSecPerKm: 370 });
    // Et la distance déclarée ne bouge pas : le déroulé la couvre exactement.
    expect(imposed.sessions[0].distanceKm).toBe(7.5);
  });

  it('ne pose pas de cible de séance quand le déroulé ne cible qu’en fréquence cardiaque', () => {
    // Deux systèmes de cible pour une séance : « Allure cible 6:14/km » affichée à
    // côté d'étapes en Z2, dont personne n'a demandé la première.
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(4, {
              kind: 'Seuil',
              steps: [
                { repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] },
                {
                  repeat: 4,
                  steps: [
                    step('run', { durationS: 480, hrZone: 4 }),
                    step('recover', { durationS: 120 }),
                  ],
                },
              ],
            }),
          ],
        },
      ],
      PACES,
    );

    expect(imposed.sessions[0].targetPaceSecPerKm).toBeUndefined();
  });

  it('garde la cible de séance dès qu’une étape porte une allure', () => {
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(4, {
              kind: 'Seuil',
              steps: [
                {
                  repeat: 1,
                  steps: [
                    step('warmup', { durationS: 900, hrZone: 2 }),
                    step('run', { durationS: 480 }),
                  ],
                },
              ],
            }),
          ],
        },
      ],
      PACES,
    );

    expect(imposed.sessions[0].targetPaceSecPerKm).toBe(286);
  });

  it('conserve une zone cardiaque et ne lui ajoute pas d’allure', () => {
    // Une étape ne porte jamais les deux cibles : ce que le modèle a exprimé en
    // fréquence cardiaque n'est pas une allure fautive à corriger.
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(4, {
              kind: 'Seuil',
              steps: [
                {
                  repeat: 1,
                  steps: [
                    step('warmup', { durationS: 900, hrZone: 2 }),
                    step('run', { durationS: 480, hrZone: 4 }),
                  ],
                },
              ],
            }),
          ],
        },
      ],
      PACES,
    );

    expect((imposed.sessions[0].steps ?? [])[0].steps).toEqual([
      step('warmup', { durationS: 900, hrZone: 2 }),
      step('run', { durationS: 480, hrZone: 4 }),
    ]);
  });

  it('cible une étape que le modèle a laissée sans consigne', () => {
    // C'est tout l'objet du renversement : le modèle décrit la structure, et
    // l'appli remplit les allures — y compris celles qu'il n'a pas écrites.
    const [imposed] = applyImposedPaces(
      [
        {
          sessions: [
            session(4, {
              kind: 'VMA',
              steps: [{ repeat: 5, steps: [step('run', { durationS: 180 })] }],
            }),
          ],
        },
      ],
      PACES,
    );

    expect((imposed.sessions[0].steps ?? [])[0].steps[0]).toMatchObject({
      paceMinSecPerKm: 252,
      paceMaxSecPerKm: 265,
    });
  });

  it('ne touche à rien d’autre : distances, répétitions et notes', () => {
    const weeks: PlanWeekOutput[] = [
      {
        sessions: [
          session(4, {
            kind: 'Seuil',
            title: '4 × 8 min',
            distanceKm: 10.4,
            durationMin: 55,
            warmup: '15 min souple',
            steps: [
              {
                repeat: 4,
                steps: [step('run', { durationS: 480, note: 'régulier' }), step('recover', { durationS: 120 })],
              },
            ],
          }),
        ],
      },
    ];
    const [imposed] = applyImposedPaces(weeks, PACES);
    const session4 = imposed.sessions[0];

    expect(session4).toMatchObject({
      day: 4,
      kind: 'Seuil',
      title: '4 × 8 min',
      distanceKm: 10.4,
      // La durée, elle, est recalculée — et le déroulé, entièrement en durée, ne
      // couvre aucun des 10,4 km déclarés : c'est la distance qui l'emporte
      // (10,4 km au milieu du créneau T, 286 s/km, soit 50 min), et non les
      // 40 min des étapes ni les 55 min que le modèle avait écrites.
      durationMin: 50,
      warmup: '15 min souple',
    });
    expect((session4.steps ?? [])[0].repeat).toBe(4);
    expect((session4.steps ?? [])[0].steps[0].note).toBe('régulier');
    expect((session4.steps ?? [])[0].steps[0].durationS).toBe(480);
  });

  it('laisse une séance sans déroulé sans déroulé', () => {
    const [imposed] = applyImposedPaces([{ sessions: [session(2, { kind: 'Footing' })] }], PACES);

    expect(imposed.sessions[0].steps).toBeUndefined();
    expect(imposed.sessions[0].targetPaceSecPerKm).toBe(353);
  });

  /**
   * Une table d'allures **lente**, celle de l'athlète du constat de production :
   * E 7:57–8:43/km, soit un milieu à 8:20/km pile. C'est elle qui rend les
   * durées recalculées lisibles — 10 km n'y font pas une heure.
   */
  const SLOW_PACES: TrainingPaces = {
    vdot: 30.1,
    easy: { minSecPerKm: 477, maxSecPerKm: 523 },
    marathon: { minSecPerKm: 430, maxSecPerKm: 450 },
    threshold: { minSecPerKm: 400, maxSecPerKm: 420 },
    interval: { minSecPerKm: 370, maxSecPerKm: 390 },
    repetition: { minSecPerKm: 340, maxSecPerKm: 360 },
  };

  describe('durées recalculées', () => {
    /** La durée posée sur l'unique séance de l'unique semaine. */
    function durationOf(session: PlanWeekOutput['sessions'][number]): number | undefined {
      return applyImposedPaces([{ sessions: [session] }], SLOW_PACES)[0].sessions[0].durationMin;
    }

    it('recalcule une séance sans déroulé depuis sa distance et le créneau de son `kind`', () => {
      // Le défaut constaté à l'écran : « 10 km · 1 h 00 · @ 8:20/km », alors que
      // 10 km à 8:20/km font 1 h 23. Le modèle n'avait pas calculé cette heure.
      expect(durationOf(session(7, { kind: 'Sortie longue', distanceKm: 10, durationMin: 60 }))).toBe(
        83,
      );
    });

    it('somme le déroulé : durées telles quelles, distances converties à l’allure posée', () => {
      // Échauffement 2 km en E (500 s/km) = 1 000 s, corps 3 km au seuil
      // (410 s/km) = 1 230 s, retour au calme 600 s → 2 830 s, soit 47 min.
      const duration = durationOf(
        session(4, {
          kind: 'Seuil',
          durationMin: 90,
          steps: [
            { repeat: 1, steps: [step('warmup', { distanceM: 2000 })] },
            { repeat: 1, steps: [step('run', { distanceM: 3000 })] },
            { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
          ],
        }),
      );

      expect(duration).toBe(47);
    });

    it('mesure la séance entière quand le déroulé n’en décrit qu’un extrait', () => {
      // Le défaut constaté : le prompt demande une sortie longue dont le `steps`
      // ne décrit QUE le bloc à allure objectif. 18 km avec un seul bloc de 3 km
      // s'affichaient « 18 km · 18 min », et la semaine tombait à 138 min au lieu
      // de 260. Les 18 km au milieu du créneau E (500 s/km) font 150 min, et
      // c'est cette durée-là qui compte.
      const duration = durationOf(
        session(7, {
          kind: 'Sortie longue',
          distanceKm: 18,
          durationMin: 18,
          steps: [
            {
              repeat: 1,
              steps: [step('run', { distanceM: 3000, note: 'à allure objectif' })],
            },
          ],
        }),
      );

      expect(duration).toBe(150);
    });

    it('laisse le déroulé décider quand il couvre toute la distance déclarée', () => {
      // 3 km d'échauffement en E (500 s/km) + 4 km au seuil (410) + 3 km de
      // retour au calme en E = 4 640 s, soit 77 min — plus que les 68 min des
      // 10 km pris à l'allure du seuil, parce que l'enveloppe est plus lente.
      // Le déroulé complet est le calcul le plus fin : c'est lui qui l'emporte.
      const duration = durationOf(
        session(4, {
          kind: 'Seuil',
          distanceKm: 10,
          steps: [
            { repeat: 1, steps: [step('warmup', { distanceM: 3000 })] },
            { repeat: 1, steps: [step('run', { distanceM: 4000 })] },
            { repeat: 1, steps: [step('cooldown', { distanceM: 3000 })] },
          ],
        }),
      );

      expect(duration).toBe(77);
    });

    it('compte chaque passage d’un bloc répété', () => {
      // 600 s d'échauffement + 4 × (400 m à 350 s/km + 90 s de récup) = 1 520 s.
      const duration = durationOf(
        session(5, {
          kind: 'Répétitions',
          steps: [
            { repeat: 1, steps: [step('warmup', { durationS: 600 })] },
            {
              repeat: 4,
              steps: [step('run', { distanceM: 400 }), step('recover', { durationS: 90 })],
            },
          ],
        }),
      );

      expect(duration).toBe(25);
    });

    it('chronomètre une étape sans cible au créneau de sa séance', () => {
      // La récupération ne reçoit aucune allure (cf. `stepPaceZone`) : mesurée en
      // distance, elle se chronomètre au créneau de sa séance — 3 000 m + 400 m
      // au seuil (410 s/km) = 1 394 s, soit 23 min.
      const duration = durationOf(
        session(4, {
          kind: 'Seuil',
          steps: [
            {
              repeat: 1,
              steps: [step('run', { distanceM: 3000 }), step('recover', { distanceM: 400 })],
            },
          ],
        }),
      );

      expect(duration).toBe(23);
    });

    it('chronomètre une séance de récupération en endurance, faute de créneau', () => {
      // « Récupération » ne porte aucune cible : le repli est le milieu de E.
      expect(durationOf(session(3, { kind: 'Récupération', distanceKm: 3 }))).toBe(25);
    });

    it('laisse la durée du modèle quand rien ne permet de la calculer', () => {
      // Ni déroulé, ni distance : il n'y a rien à diviser, et inventer serait
      // exactement le défaut qu'on corrige.
      expect(durationOf(session(2, { kind: 'Footing', durationMin: 45 }))).toBe(45);
      expect(durationOf(session(2, { kind: 'Footing' }))).toBeUndefined();
    });

    it('rend le budget temps vérifiable : ce sont ces durées-là que la règle compte', () => {
      // Le défaut de production en entier : le modèle déclare 1 h 40 pour une
      // semaine de 16 km qu'il chiffre en réalité à 2 h 13. Sans recalcul, le
      // budget de 1 h 50 passait ; avec, il est relevé.
      const declared: PlanWeekOutput = {
        sessions: [
          session(2, { kind: 'Endurance fondamentale', distanceKm: 4, durationMin: 25 }),
          session(4, { kind: 'Endurance fondamentale', distanceKm: 4, durationMin: 25 }),
          session(7, { kind: 'Sortie longue', distanceKm: 8, durationMin: 50 }),
        ],
      };
      const expected: PlanExpectations = {
        scope: 'creation',
        weeks: 1,
        sessionsPerWeek: 3,
        longRunDay: 7,
      };

      expect(validatePlanBusinessRules([declared], expected, { weeklyTimeMinutes: 110 })).toEqual([]);

      expect(
        validatePlanBusinessRules(applyImposedPaces([declared], SLOW_PACES), expected, {
          weeklyTimeMinutes: 110,
        }),
      ).toEqual([
        "Semaine 1 : 2 h 13 d'entraînement pour un budget déclaré de 1 h 50 — " +
          'réduis distances ou séances (2 h 12 au plus, tolérance comprise).',
      ]);
    });
  });

  /**
   * Le défaut de production que ces distances-là corrigent : le modèle n'écrit
   * **jamais** `distanceKm` au niveau de la séance — systématique sur toutes les
   * générations d'une salve, reprises comprises. Sous grammaire GBNF, une
   * propriété facultative sautée ne se rattrape pas, et la règle « Volumes
   * hebdomadaires invérifiables » condamnait la boucle entière.
   */
  describe('distances dérivées du déroulé', () => {
    /** La distance posée sur l'unique séance de l'unique semaine. */
    function distanceOf(session: PlanWeekOutput['sessions'][number]): number | undefined {
      return applyImposedPaces([{ sessions: [session] }], SLOW_PACES)[0].sessions[0].distanceKm;
    }

    it('somme un déroulé entièrement en distance', () => {
      expect(
        distanceOf(
          session(4, {
            kind: 'Seuil',
            steps: [
              { repeat: 1, steps: [step('warmup', { distanceM: 2000 })] },
              { repeat: 3, steps: [step('run', { distanceM: 1000 }), step('recover', { distanceM: 400 })] },
              { repeat: 1, steps: [step('cooldown', { distanceM: 1000 })] },
            ],
          }),
        ),
      ).toBe(7.2);
    });

    it('convertit un déroulé entièrement en durée, allure par allure', () => {
      // Échauffement 900 s en Z2 (chronométré en E, 500 s/km) = 1,8 km ; corps
      // 4 × 480 s au seuil (410 s/km) = 4,68 km ; récupérations 4 × 120 s en E
      // = 0,96 km ; retour au calme 600 s en E = 1,2 km.
      expect(distanceOf(session(4, { kind: 'Seuil', steps: qualitySteps() }))).toBe(8.6);
    });

    it('additionne les deux quand le déroulé mélange distances et durées', () => {
      // 2 km d'échauffement, puis 2 × 600 s au seuil (410 s/km) = 2,93 km.
      expect(
        distanceOf(
          session(4, {
            kind: 'Seuil',
            steps: [
              { repeat: 1, steps: [step('warmup', { distanceM: 2000 })] },
              { repeat: 2, steps: [step('run', { durationS: 600 })] },
            ],
          }),
        ),
      ).toBe(4.9);
    });

    it('garde la distance du modèle quand le déroulé n’en décrit qu’un extrait', () => {
      // La sortie longue à bloc spécifique : 18 km dont un unique bloc de 3 km.
      // La distance déclarée dit la séance, le déroulé n'en dit qu'un morceau.
      expect(
        distanceOf(
          session(7, {
            kind: 'Sortie longue',
            distanceKm: 18,
            steps: [{ repeat: 1, steps: [step('run', { distanceM: 3000, note: 'allure objectif' })] }],
          }),
        ),
      ).toBe(18);
    });

    it('reprend la main quand la distance déclarée contredit le déroulé', () => {
      // 5 km déclarés pour un déroulé qui en couvre 7,2 : c'est le déroulé qui
      // sera couru, et c'est lui qui compte dans le volume de la semaine.
      expect(
        distanceOf(
          session(4, {
            kind: 'Seuil',
            distanceKm: 5,
            steps: [
              { repeat: 1, steps: [step('warmup', { distanceM: 2000 })] },
              { repeat: 3, steps: [step('run', { distanceM: 1000 }), step('recover', { distanceM: 400 })] },
              { repeat: 1, steps: [step('cooldown', { distanceM: 1000 })] },
            ],
          }),
        ),
      ).toBe(7.2);
    });

    it('ne compte pas deux fois : la durée reste celle du déroulé qui a donné la distance', () => {
      // 900 s + 4 × (480 + 120) s + 600 s = 3 900 s, soit 65 min — et surtout pas
      // les 8,6 km dérivés repassés à l'allure de la séance.
      const [imposed] = applyImposedPaces(
        [{ sessions: [session(4, { kind: 'Seuil', steps: qualitySteps() })] }],
        SLOW_PACES,
      );

      expect(imposed.sessions[0]).toMatchObject({ distanceKm: 8.6, durationMin: 65 });
    });

    it('laisse invérifiable ce qui n’est dérivable de rien', () => {
      // Ni déroulé, ni distance : la règle doit continuer de le dire, c'est le
      // seul cas où elle a encore quelque chose à reprocher au modèle.
      const week: PlanWeekOutput = {
        sessions: [
          session(2, { kind: 'Endurance fondamentale', distanceKm: 6 }),
          session(4, { kind: 'Endurance fondamentale' }),
          session(7, { kind: 'Sortie longue', distanceKm: 10 }),
        ],
      };

      expect(distanceOf(session(4, { kind: 'Endurance fondamentale' }))).toBeUndefined();
      expect(
        validatePlanBusinessRules(applyImposedPaces([week], SLOW_PACES), {
          scope: 'creation',
          weeks: 1,
          sessionsPerWeek: 3,
          longRunDay: 7,
        }),
      ).toEqual([
        'Volumes hebdomadaires invérifiables : chaque séance déclare sa distance `distanceKm`, ' +
          'footings et récupérations compris — il en manque semaine 1.',
      ]);
    });
  });

  it('est pure : les semaines reçues ne bougent pas', () => {
    const weeks: PlanWeekOutput[] = [
      { sessions: [session(4, { kind: 'Seuil', targetPaceSecPerKm: 720, steps: wrongPaceSteps })] },
    ];
    const before = structuredClone(weeks);

    applyImposedPaces(weeks, PACES);

    expect(weeks).toEqual(before);
  });
});

/**
 * L'endurance prescrite en **fréquence cardiaque**, quand le profil porte une
 * FC max.
 *
 * Le principe que chaque cas ci-dessous décline : **seule la cible change
 * d'unité**. Les mesures des étapes, les distances, les durées et le budget
 * temps ne bougent pas d'un mètre ni d'une seconde — c'est la condition pour
 * que la fonctionnalité soit un changement d'affichage de la consigne, et non
 * une réécriture du plan.
 */
describe('applyImposedPaces — endurance en fréquence cardiaque', () => {
  /** La FC max de l'athlète du projet : zone 2 = 120–145 bpm. */
  const MAX_HR = 184;

  /** Le déroulé d'un footing enrichi : mise en route, corps, lignes droites. */
  const easySteps: PlanSessionSteps = [
    { repeat: 1, steps: [step('run', { distanceM: 6_000, note: 'Souple' })] },
    { repeat: 4, steps: [step('run', { distanceM: 100, note: 'Ligne droite' })] },
  ];

  function imposeEasy(overrides = {}, maxHrBpm: number | null = MAX_HR) {
    const [imposed] = applyImposedPaces(
      [{ sessions: [session(2, { kind: 'Endurance fondamentale', ...overrides })] }],
      PACES,
      null,
      maxHrBpm,
    );
    return imposed.sessions[0];
  }

  /**
   * Le déroulé d'une marche/course de reprise, tel que `walkRunShape` l'écrit au
   * premier rang de la fenêtre : 9 × (200 m courus / 400 m marchés).
   */
  const walkRunSteps: PlanSessionSteps = [
    {
      repeat: 9,
      steps: [
        step('run', { distanceM: 200, note: 'Portion courue, souple' }),
        step('recover', { distanceM: 400, note: 'Marche, sans forcer' }),
      ],
    },
  ];

  it('pose la zone 2 sur le corps des séances faciles, à la place de l’allure', () => {
    const steps = imposeEasy({ steps: easySteps, distanceKm: 6.4 }).steps ?? [];

    expect(steps[0].steps[0]).toMatchObject({
      hrZone: 2,
      paceMinSecPerKm: null,
      paceMaxSecPerKm: null,
    });
  });

  /**
   * La contre-partie du principe : une **étape courte** garde son allure.
   *
   * Vingt secondes de ligne droite ne laissent pas à la FC le temps de monter en
   * zone 2 ; la cible arriverait après l'étape, et surtout elle contredirait la
   * consigne — « ligne droite » veut dire accélère, 120–145 bpm dirait ralentis.
   */
  it('laisse en allure les lignes droites d’un footing — la FC n’y monte pas', () => {
    const steps = imposeEasy({ steps: easySteps, distanceKm: 6.4 }).steps ?? [];

    expect(steps[1].steps[0]).toMatchObject({
      hrZone: null,
      paceMinSecPerKm: PACES.easy.minSecPerKm,
      paceMaxSecPerKm: PACES.easy.maxSecPerKm,
    });
  });

  it('laisse en allure les portions courues d’une marche/course', () => {
    const steps = imposeEasy({ steps: walkRunSteps, distanceKm: 5.4 }).steps ?? [];

    // 200 m courus : la portion est trop brève pour qu'une FC veuille dire
    // quelque chose — c'est le seuil d'étape courte du corridor, réutilisé tel
    // quel.
    expect(steps[0].steps[0]).toMatchObject({
      hrZone: null,
      paceMinSecPerKm: PACES.easy.minSecPerKm,
      paceMaxSecPerKm: PACES.easy.maxSecPerKm,
    });
    // La marche, elle, ne porte toujours aucune cible : ni allure, ni FC.
    expect(steps[0].steps[1]).toMatchObject({
      hrZone: null,
      paceMinSecPerKm: null,
      paceMaxSecPerKm: null,
    });
  });

  it('bascule bien en FC dès que l’étape est assez longue pour la porter', () => {
    // Le seuil est celui du corridor (60 s / 200 m) : 300 m courus, la FC a le
    // temps d'arriver — la fin de la rampe de marche/course y passe donc.
    const longer: PlanSessionSteps = [
      { repeat: 6, steps: [step('run', { distanceM: 300, note: 'Portion courue, souple' })] },
    ];

    expect(imposeEasy({ steps: longer, distanceKm: 1.8 }).steps?.[0].steps[0]).toMatchObject({
      hrZone: 2,
      paceMinSecPerKm: null,
    });
  });

  it('ne touche pas à la mesure des étapes — seule la cible change d’unité', () => {
    const withHr = imposeEasy({ steps: easySteps, distanceKm: 6.4 }).steps ?? [];
    const withPace = imposeEasy({ steps: easySteps, distanceKm: 6.4 }, null).steps ?? [];

    const measures = (blocks: PlanSessionSteps) =>
      blocks.map((block) => ({
        repeat: block.repeat,
        steps: block.steps.map((s) => ({ distanceM: s.distanceM, durationS: s.durationS })),
      }));

    expect(measures(withHr)).toEqual(measures(withPace));
  });

  it('garde l’allure de séance : c’est elle qui chiffre durées et budget temps', () => {
    const withHr = imposeEasy({ steps: easySteps, distanceKm: 6.4 });
    const withPace = imposeEasy({ steps: easySteps, distanceKm: 6.4 }, null);

    // Le milieu du créneau E, dans les deux régimes — l'UI l'affiche en
    // indication à côté de la cible cardiaque.
    expect(withHr.targetPaceSecPerKm).toBe(353);
    expect(withHr.targetPaceSecPerKm).toBe(withPace.targetPaceSecPerKm);
  });

  /**
   * Le garde-fou central : la FC ne convertit pas en kilomètres, et une durée
   * calculée sur une étape sans allure retombe sur le milieu du même créneau
   * d'endurance que ses bornes encadraient.
   */
  it('laisse distance et durée strictement identiques au régime en allure', () => {
    for (const overrides of [
      { steps: easySteps, distanceKm: 6.4 },
      { steps: walkRunSteps, distanceKm: 5.4 },
      { distanceKm: 7 },
      { distanceKm: 12.5, kind: 'Sortie longue' },
      { distanceKm: 9, durationMin: 63 },
    ]) {
      const withHr = imposeEasy(overrides);
      const withPace = imposeEasy(overrides, null);

      expect(withHr.distanceKm, JSON.stringify(overrides)).toBe(withPace.distanceKm);
      expect(withHr.durationMin, JSON.stringify(overrides)).toBe(withPace.durationMin);
    }
  });

  it('donne un déroulé au footing qui n’en avait pas — sans quoi rien ne porte la cible', () => {
    // La variation `plain` du squelette écrit la majorité des footings sans
    // `steps`, et `PlanSessionOutput` n'a pas de cible cardiaque au niveau
    // séance : sans cette étape, la prescription manquerait le cas le plus
    // fréquent.
    const imposed = imposeEasy({ distanceKm: 7 });

    expect(imposed.steps).toEqual([
      { repeat: 1, steps: [step('run', { distanceM: 7_000, hrZone: 2 })] },
    ]);
  });

  it('n’en fabrique aucun sans FC max : le repli est le comportement d’avant', () => {
    expect(imposeEasy({ distanceKm: 7 }, null).steps).toBeUndefined();
  });

  it('laisse la qualité en allure, de bout en bout', () => {
    const [imposed] = applyImposedPaces(
      [{ sessions: [session(4, { kind: 'Seuil', steps: qualitySteps() })] }],
      PACES,
      null,
      MAX_HR,
    );
    const steps = imposed.sessions[0].steps ?? [];

    // L'effort : les bornes du créneau seuil, pas une zone cardiaque.
    expect(steps[1].steps[0]).toMatchObject({
      paceMinSecPerKm: 280,
      paceMaxSecPerKm: 292,
      hrZone: null,
    });
    expect(imposed.sessions[0].targetPaceSecPerKm).toBe(286);
  });

  it('laisse en allure le bloc spécifique d’une sortie longue', () => {
    // Une intention écrite dans la note déplace le créneau de l'étape : ce
    // bloc-là est de la qualité posée dans une séance facile, et la FC dirait
    // n'importe quoi sur quelques minutes d'effort.
    const specific: PlanSessionSteps = [
      { repeat: 1, steps: [step('run', { distanceM: 4_000, note: 'Mise en route' })] },
      { repeat: 1, steps: [step('run', { distanceM: 3_000, note: 'Bloc à allure objectif' })] },
    ];
    const steps =
      imposeEasy({ kind: 'Sortie longue', steps: specific, distanceKm: 7 }).steps ?? [];

    expect(steps[0].steps[0]).toMatchObject({ hrZone: 2, paceMinSecPerKm: null });
    // Zone M, en allure.
    expect(steps[1].steps[0]).toMatchObject({
      hrZone: null,
      paceMinSecPerKm: 295,
      paceMaxSecPerKm: 320,
    });
  });

  it('laisse une séance de récupération sans aucune cible', () => {
    // La doctrine du module ne change pas : « plus lent que E.max, ou rien ».
    // Lui poser la plage d'endurance — en bpm comme en allure — en ferait un
    // footing.
    const imposed = imposeEasy({ kind: 'Récupération', distanceKm: 5 });

    expect(imposed.steps).toBeUndefined();
    expect(imposed.targetPaceSecPerKm).toBeUndefined();
  });

  it('respecte une zone que le modèle a lui-même écrite, et n’annonce alors pas d’allure', () => {
    // Le comportement d'avant, préservé : quand les zones viennent du modèle,
    // personne n'a demandé de cible d'allure de séance.
    const modelZones: PlanSessionSteps = [
      { repeat: 1, steps: [step('run', { distanceM: 6_000, hrZone: 3 })] },
    ];
    const imposed = imposeEasy({ steps: modelZones, distanceKm: 6 }, null);

    expect(imposed.steps?.[0].steps[0].hrZone).toBe(3);
    expect(imposed.targetPaceSecPerKm).toBeUndefined();
  });

  it('ne prescrit rien en FC sur une FC max implausible', () => {
    expect(imposeEasy({ distanceKm: 7 }, 60).steps).toBeUndefined();
  });

  /**
   * Le **sous-créneau** que le squelette écrit sur certains blocs (« le haut de
   * la plage » d'une fin de sortie longue, les trois tranches d'un progressif,
   * cf. `plan-skeleton/variations`).
   *
   * Il traverse le post-traitement quand la séance se prescrit en fréquence
   * cardiaque, et il est **effacé** dès qu'elle se prescrit en allure : une
   * étape ne porte jamais deux cibles, et le contrat d'étapes refuserait le
   * déroulé.
   */
  describe('le sous-créneau d’endurance', () => {
    /** Une sortie longue à fin appuyée, telle que le squelette l'écrit. */
    const finishSteps: PlanSessionSteps = [
      { repeat: 1, steps: [step('run', { distanceM: 16_000, note: 'Sortie longue en endurance' })] },
      {
        repeat: 1,
        steps: [
          step('run', {
            distanceM: 4_000,
            note: 'Fin de parcours plus appuyée',
            hrPercentMin: 74,
            hrPercentMax: 79,
          }),
        ],
      },
    ];

    it('survit à la pose de la zone, sur le bloc qui le porte et lui seul', () => {
      const steps =
        imposeEasy({ kind: 'Sortie longue', steps: finishSteps, distanceKm: 20 }).steps ?? [];

      expect(steps[0].steps[0]).toMatchObject({
        hrZone: 2,
        hrPercentMin: null,
        hrPercentMax: null,
      });
      expect(steps[1].steps[0]).toMatchObject({
        hrZone: 2,
        hrPercentMin: 74,
        hrPercentMax: 79,
        paceMinSecPerKm: null,
      });
    });

    it('est effacé quand la séance se prescrit finalement en allure', () => {
      const steps =
        imposeEasy({ kind: 'Sortie longue', steps: finishSteps, distanceKm: 20 }, null).steps ?? [];

      for (const block of steps) {
        for (const candidate of block.steps) {
          expect(candidate.hrPercentMin).toBeNull();
          expect(candidate.hrPercentMax).toBeNull();
          expect(candidate.paceMinSecPerKm).toBe(PACES.easy.minSecPerKm);
        }
      }
      // Et le déroulé reste écrivable : allure et sous-créneau sont exclusifs.
      expect(planSessionStepsSchema.safeParse(steps).success).toBe(true);
    });

    /**
     * Ce que la tâche exige de prouver : **la cible change d'amplitude, pas la
     * mesure**. Le même déroulé, bande retirée, rend la même distance, la même
     * durée et la même allure de séance — donc le même budget temps.
     */
    it('ne change ni distance, ni durée, ni budget temps', () => {
      const stripped: PlanSessionSteps = finishSteps.map((block) => ({
        repeat: block.repeat,
        steps: block.steps.map((candidate) => ({
          ...candidate,
          hrPercentMin: null,
          hrPercentMax: null,
        })),
      }));

      for (const maxHrBpm of [MAX_HR, null]) {
        const banded = imposeEasy({ kind: 'Sortie longue', steps: finishSteps, distanceKm: 20 }, maxHrBpm);
        const plain = imposeEasy({ kind: 'Sortie longue', steps: stripped, distanceKm: 20 }, maxHrBpm);

        expect(banded.distanceKm, `FC max ${maxHrBpm}`).toBe(plain.distanceKm);
        expect(banded.durationMin, `FC max ${maxHrBpm}`).toBe(plain.durationMin);
        expect(banded.targetPaceSecPerKm, `FC max ${maxHrBpm}`).toBe(plain.targetPaceSecPerKm);
      }
    });
  });
});

/**
 * Le régime **sans table** : le modèle garde ses allures, l'appli complète la
 * seule comptabilité.
 *
 * Le trou que cela bouche : la dérivation de `distanceKm` ne tournait qu'avec la
 * table, alors que le défaut qu'elle corrige — le modèle n'écrit jamais
 * `distanceKm` — ne dépend pas d'elle. Un plan sans chrono de référence restait
 * condamné par « Volumes hebdomadaires invérifiables ».
 */
describe('applyDerivedMeasures — le régime sans table', () => {
  /** L'allure récente de l'athlète, 6:40/km : ronde, pour que les conversions se lisent. */
  const REFERENCE = 400;

  /** Le déroulé d'une séance dont les mesures sortent de l'unique semaine reçue. */
  function derived(
    tested: PlanWeekOutput['sessions'][number],
    reference: number | null = REFERENCE,
  ): PlanWeekOutput['sessions'][number] {
    return applyDerivedMeasures([{ sessions: [tested] }], reference)[0].sessions[0];
  }

  it('somme un déroulé en distance et le chronomètre à l’allure de conversion', () => {
    // 6 km à 6:40/km = 2 400 s, soit 40 min.
    expect(
      derived(
        session(2, { steps: [{ repeat: 1, steps: [step('run', { distanceM: 6000 })] }] }),
      ),
    ).toMatchObject({ distanceKm: 6, durationMin: 40 });
  });

  it('convertit un déroulé en durée, étape par étape', () => {
    // 900 + 4 × (480 + 120) + 600 = 3 900 s de déroulé, soit 65 min. Les efforts
    // portent l'allure du modèle (305 s/km au milieu de 300–310), tout le reste
    // passe à l'allure récente : 2,25 + 6,3 + 1,2 + 1,5 = 11,2 km.
    expect(derived(session(4, { kind: 'Seuil', steps: qualitySteps() }))).toMatchObject({
      distanceKm: 11.2,
      durationMin: 65,
    });
  });

  it('additionne les deux quand le déroulé mélange distances et durées', () => {
    // 2 km d'échauffement (800 s à l'allure récente) + 2 × 600 s (1,5 km chacun).
    expect(
      derived(
        session(4, {
          steps: [
            { repeat: 1, steps: [step('warmup', { distanceM: 2000 })] },
            { repeat: 2, steps: [step('run', { durationS: 600 })] },
          ],
        }),
      ),
    ).toMatchObject({ distanceKm: 5, durationMin: 33 });
  });

  it('convertit une étape à l’allure que le modèle lui a posée', () => {
    // 600 s à 5:00/km font 2 km ; les mêmes 600 s sans allure d'étape retombent
    // sur l'allure récente et n'en font que 1,5.
    const paced = step('run', { durationS: 600, paceMinSecPerKm: 300, paceMaxSecPerKm: 300 });
    expect(derived(session(2, { steps: [{ repeat: 1, steps: [paced] }] })).distanceKm).toBe(2);
    expect(
      derived(session(2, { steps: [{ repeat: 1, steps: [step('run', { durationS: 600 })] }] }))
        .distanceKm,
    ).toBe(1.5);
  });

  it('prend la cible de la séance avant l’allure récente', () => {
    expect(
      derived(
        session(2, {
          targetPaceSecPerKm: 500,
          steps: [{ repeat: 1, steps: [step('run', { durationS: 600 })] }],
        }),
      ).distanceKm,
    ).toBe(1.2);
  });

  it('estime au repli de 8:00/km quand rien d’autre n’est connu — sans jamais le prescrire', () => {
    // Une athlète sans chrono et sans historique : 600 s valent 1,25 km à
    // 8:00/km. Le repli sert à estimer un volume, pas à prescrire une allure —
    // il ne s'écrit donc ni sur la séance ni sur l'étape.
    const steps = [{ repeat: 1, steps: [step('run', { durationS: 600 })] }];
    const withoutReference = derived(session(2, { steps }), null);

    expect(withoutReference.distanceKm).toBe(1.3);
    expect(withoutReference.targetPaceSecPerKm).toBeUndefined();
    expect(withoutReference.steps).toEqual(steps);
  });

  it('n’écrit aucune allure : les prescriptions du modèle ressortent intactes', () => {
    const steps = qualitySteps();
    const before = structuredClone(steps);
    const imposed = derived(session(4, { kind: 'Seuil', targetPaceSecPerKm: 290, steps }));

    // Ni cible de séance réécrite, ni allure posée sur l'échauffement ou la
    // récupération : sans table, l'appli n'a rien à prescrire que le modèle ne
    // sache mieux — c'est le corridor de plausibilité qui le juge.
    expect(imposed.targetPaceSecPerKm).toBe(290);
    expect(imposed.steps).toEqual(before);
  });

  it('dérive la durée d’une séance sans déroulé qui ne déclare que sa distance', () => {
    // 10 km à 6:40/km = 4 000 s, soit 67 min.
    expect(derived(session(7, { kind: 'Sortie longue', distanceKm: 10 }))).toMatchObject({
      distanceKm: 10,
      durationMin: 67,
    });
  });

  it('dérive la distance d’un footing chiffré en minutes, sans toucher à sa durée', () => {
    // 45 min à 6:40/km = 6,75 km. La durée reste celle du modèle : la
    // reconvertir depuis la distance qu'on vient d'en tirer n'apprendrait rien.
    expect(derived(session(2, { durationMin: 45 }))).toMatchObject({
      distanceKm: 6.8,
      durationMin: 45,
    });
  });

  it('ne corrige pas une séance sans déroulé que le modèle a mesurée des deux côtés', () => {
    // Rien ne la contredit — aucune allure n'est prescrite ici. La réécrire
    // depuis l'allure moyenne récente ferait juger le plan du coach sur une
    // estimation de l'appli, et un budget temps refusé sur cette estimation
    // rouvrirait la classe de blocage qu'on ferme.
    const declared = session(7, { kind: 'Sortie longue', distanceKm: 14, durationMin: 60 });
    expect(derived(declared)).toEqual(declared);
  });

  it('refait la durée qu’un déroulé dément', () => {
    // « 10 km · 45 min » pour un déroulé qui totalise 3 900 s : les 45 min ne
    // sont pas un calcul du modèle, ce sont ses propres étapes qui le disent.
    expect(
      derived(
        session(4, { kind: 'Seuil', distanceKm: 10, durationMin: 45, steps: qualitySteps() }),
      ).durationMin,
    ).toBe(65);
  });

  it('laisse invérifiable ce qui n’est dérivable de rien', () => {
    const bare = session(4);
    expect(derived(bare)).toEqual(bare);

    const week: PlanWeekOutput = {
      sessions: [
        session(2, { distanceKm: 6 }),
        bare,
        session(7, { kind: 'Sortie longue', distanceKm: 10 }),
      ],
    };

    expect(
      validatePlanBusinessRules(applyDerivedMeasures([week], REFERENCE), {
        scope: 'creation',
        weeks: 1,
        sessionsPerWeek: 3,
        longRunDay: 7,
      }),
    ).toEqual([
      'Volumes hebdomadaires invérifiables : chaque séance déclare sa distance `distanceKm`, ' +
        'footings et récupérations compris — il en manque semaine 1.',
    ]);
  });

  it('rend vérifiable une semaine dont les séances n’ont que leur déroulé', () => {
    // Le blocage éradiqué : sans table, le modèle n'écrivait aucun `distanceKm`
    // et la semaine était condamnée quoi qu'elle contienne.
    const week: PlanWeekOutput = {
      sessions: [
        session(2, { steps: [{ repeat: 1, steps: [step('run', { distanceM: 6000 })] }] }),
        session(4, { kind: 'Seuil', title: '4 × 8 min', steps: qualitySteps() }),
        session(7, {
          kind: 'Sortie longue',
          steps: [{ repeat: 1, steps: [step('run', { distanceM: 16_000 })] }],
        }),
      ],
    };
    const [processed] = applyDerivedMeasures([week], REFERENCE);

    expect(processed.sessions.map((tested) => tested.distanceKm)).toEqual([6, 11.2, 16]);
    expect(
      validatePlanBusinessRules([processed], {
        scope: 'creation',
        weeks: 1,
        sessionsPerWeek: 3,
        longRunDay: 7,
      }, { referencePaceSecPerKm: REFERENCE }),
    ).toEqual([]);
  });

  it('est pure : les semaines reçues ne bougent pas', () => {
    const weeks: PlanWeekOutput[] = [
      { sessions: [session(4, { kind: 'Seuil', steps: qualitySteps() })] },
    ];
    const before = structuredClone(weeks);

    applyDerivedMeasures(weeks, REFERENCE);

    expect(weeks).toEqual(before);
  });
});

/**
 * Le choix du régime, en un seul endroit : c'est ce qui rend impossible d'en
 * brancher un et d'oublier l'autre — le trou exact qui condamnait les plans sans
 * chrono de référence.
 */
describe('planWeeksPostProcessing', () => {
  const weeks: PlanWeekOutput[] = [
    {
      sessions: [
        session(4, {
          kind: 'Seuil',
          targetPaceSecPerKm: 700,
          steps: [{ repeat: 1, steps: [step('run', { durationS: 600 })] }],
        }),
      ],
    },
  ];

  it('impose la table quand elle existe : allures réécrites, mesures dérivées', () => {
    const [processed] = planWeeksPostProcessing({ paces: PACES, referencePaceSecPerKm: 400 }, null)(
      weeks,
    );
    const [tested] = processed.sessions;

    // 286 s/km au milieu du créneau T, et l'étape sur ses bornes.
    expect(tested.targetPaceSecPerKm).toBe(286);
    expect(tested.steps?.[0].steps[0]).toMatchObject({
      paceMinSecPerKm: PACES.threshold.minSecPerKm,
      paceMaxSecPerKm: PACES.threshold.maxSecPerKm,
    });
    expect(tested.distanceKm).toBe(2.1);
  });

  it('complète les seules mesures quand la table manque', () => {
    const [processed] = planWeeksPostProcessing({ referencePaceSecPerKm: 400 }, null)(weeks);
    const [tested] = processed.sessions;

    // L'allure de la séance est celle du modèle, et c'est elle qui convertit :
    // 600 s à 11:40/km ne font que 0,9 km.
    expect(tested.targetPaceSecPerKm).toBe(700);
    expect(tested.steps?.[0].steps[0]).toMatchObject({
      paceMinSecPerKm: null,
      paceMaxSecPerKm: null,
    });
    expect(tested.distanceKm).toBe(0.9);
  });

  it('fait descendre la FC max du contexte jusqu’à l’imposition', () => {
    // Le seul chemin par lequel la FC max atteint la prescription : le contexte
    // de validation, que les deux écritures d'un plan (création et fenêtre
    // restante) construisent depuis le même instantané d'entraînement.
    const easy: PlanWeekOutput[] = [
      { sessions: [session(2, { kind: 'Endurance fondamentale', distanceKm: 7 })] },
    ];

    const [withHr] = planWeeksPostProcessing({ paces: PACES, maxHrBpm: 184 }, null)(easy);
    expect(withHr.sessions[0].steps?.[0].steps[0].hrZone).toBe(2);

    const [without] = planWeeksPostProcessing({ paces: PACES }, null)(easy);
    expect(without.sessions[0].steps).toBeUndefined();
  });

  it('ne prescrit aucune FC sans table d’allures : ce régime n’écrit aucune cible', () => {
    // Sans table, l'appli ne prescrit rien — ni allure ni zone. La FC max ne
    // rouvre pas cette porte : le modèle reste maître de ses consignes.
    const easy: PlanWeekOutput[] = [
      { sessions: [session(2, { kind: 'Endurance fondamentale', distanceKm: 7 })] },
    ];
    const [processed] = planWeeksPostProcessing(
      { referencePaceSecPerKm: 400, maxHrBpm: 184 },
      null,
    )(easy);

    expect(processed.sessions[0].steps).toBeUndefined();
  });
});

/*
 * Volumes hebdomadaires cibles.
 */

/** La cible d'une semaine pleine, tous paramètres au plus simple. */
function targetsOf(overrides: Partial<WeeklyVolumeTargetsParams> = {}): WeeklyVolumeTarget[] {
  return weeklyVolumeTargets({
    weeks: 8,
    firstWeekFromDay: 1,
    recentWeeklyKm: 30,
    weeklyTimeMinutes: null,
    // 6:00/km : les kilomètres et les minutes se lisent l'un dans l'autre.
    easyPaceSecPerKm: 360,
    race: null,
    level: 'intermediate',
    ...overrides,
  });
}

/** Les seuls kilomètres, pour lire une progression d'un coup d'œil. */
function targetKm(targets: readonly WeeklyVolumeTarget[]): number[] {
  return targets.map((target) => target.targetKm);
}

/**
 * Une semaine qui **réalise exactement sa cible** : le volume et le temps visés,
 * répartis sur les jours encore ouverts, sortie longue comprise.
 *
 * C'est le plan qu'un modèle parfaitement obéissant écrirait — celui sur lequel
 * les règles métier doivent n'avoir rien à redire. Les parts : la moitié pour
 * une semaine de deux séances, 38 % pour la sortie longue au-delà (sous le
 * plafond de 40 %), le reste réparti également.
 */
function weekForTarget(
  target: Pick<WeeklyVolumeTarget, 'targetKm' | 'targetMinutes'>,
  sessionsPerWeek: number,
  longRunDay: number,
  fromDay: number,
): PlanWeekOutput {
  const days = [longRunDay, ...[1, 2, 3, 4, 5, 6, 7].filter((day) => day !== longRunDay)]
    .filter((day) => day >= fromDay)
    .slice(0, sessionsPerWeek)
    .sort((left, right) => left - right);

  const hasLongRun = days.includes(longRunDay);
  const shares = days.map((day) => {
    if (!hasLongRun || days.length === 1) return 1 / days.length;
    if (days.length === 2) return 0.5;
    return day === longRunDay ? 0.38 : 0.62 / (days.length - 1);
  });

  // La dernière séance absorbe les restes : la semaine doit totaliser sa cible
  // **exactement**, sans quoi un cheveu de flottant ferait constater une hausse
  // que la cible ne porte pas.
  let restKm = target.targetKm;
  let restMin = target.targetMinutes;

  return {
    sessions: days.map((day, index) => {
      const last = index === days.length - 1;
      const distanceKm = last ? restKm : target.targetKm * shares[index];
      const durationMin = last ? restMin : target.targetMinutes * shares[index];
      restKm -= distanceKm;
      restMin -= durationMin;

      return {
        day,
        kind: day === longRunDay ? 'Sortie longue' : 'Endurance fondamentale',
        title: 'Footing',
        distanceKm,
        durationMin,
      };
    }),
  };
}

describe('weeklyVolumeTargets', () => {
  it('ancre le départ sur le volume réellement couru', () => {
    // 30 km récents → au plus 36 km (1,2 ×), et c'est de là que part la montée —
    // au dixième sous le plafond, qui ne se touche jamais (cf. `floorKm`).
    expect(targetsOf().at(0)?.targetKm).toBe(35.9);
    // Les tout petits volumes montent de 3 km, pas de 20 % : 5 + 3 = 8.
    expect(targetsOf({ recentWeeklyKm: 5 }).at(0)?.targetKm).toBe(7.9);
  });

  it('part d’un volume prudent, par niveau, quand l’historique ne dit rien', () => {
    expect(targetsOf({ recentWeeklyKm: null, level: 'beginner' }).at(0)?.targetKm).toBe(11.9);
    expect(targetsOf({ recentWeeklyKm: null, level: 'intermediate' }).at(0)?.targetKm).toBe(23.9);
    expect(targetsOf({ recentWeeklyKm: null, level: 'advanced' }).at(0)?.targetKm).toBe(31.9);
    // Quatre semaines à zéro ne disent pas « démarre à zéro » : l'appelant passe
    // `null`, mais un zéro qui passerait au travers ne fait pas un plan nul.
    expect(targetsOf({ recentWeeklyKm: 0, level: 'beginner' }).at(0)?.targetKm).toBe(11.9);
  });

  it('monte par palier, avec une semaine allégée toutes les quatre semaines', () => {
    // 8 % par semaine, puis 85 % de la précédente en semaine 4 et 8.
    expect(targetKm(targetsOf())).toEqual([35.9, 38.7, 41.7, 35.4, 38.2, 41.2, 44.4, 37.7]);
  });

  it('progresse plus doucement pour un débutant, plus vite pour un confirmé', () => {
    expect(targetsOf({ level: 'beginner' })[1].targetKm).toBe(38.4);
    expect(targetsOf({ level: 'intermediate' })[1].targetKm).toBe(38.7);
    expect(targetsOf({ level: 'advanced' })[1].targetKm).toBe(39.1);
  });

  /*
   * La cadence des semaines allégées d'une **fenêtre restante** n'est plus
   * éprouvée ici, et c'est le signe que la séparation a eu lieu.
   *
   * `weeklyVolumeTargets` portait deux paramètres optionnels
   * (`firstFullWeekCapKm`, `firstFullWeekCadenceRank`) par lesquels une
   * continuation lui faisait faire autre chose qu'un démarrage. Ils ont été
   * retirés : reprendre un plan en cours à sa semaine N a désormais son
   * arithmétique propre (`remainingVolumeTargets`, dans `plan-service.ts`), et
   * c'est là que la cadence, l'ancrage et les trajectoires se mesurent.
   *
   * Ce qui reste partagé — et c'est délibéré, deux cadences finiraient par
   * diverger — est {@link isCutbackCadenceRank}, éprouvée des deux côtés.
   */

  it('ne s’offre pas de semaine allégée quand le plan est trop court pour ça', () => {
    // Quatre semaines de développement : la règle ne l'exige pas, et en gaspiller
    // une reviendrait à supprimer le quart du bloc.
    expect(targetKm(targetsOf({ weeks: 4 }))).toEqual([35.9, 38.7, 41.7, 45]);
  });

  it('tient le budget temps semaine après semaine, montée comprise', () => {
    // 4 h par semaine à 6:00/km, c'est 40 km ; les cibles s'arrêtent donc là, et
    // partent assez bas pour avoir de quoi monter.
    const targets = targetsOf({ weeklyTimeMinutes: 240, weeks: 12 });

    expect(targets.every((target) => target.targetMinutes <= 240 * 0.95)).toBe(true);
    expect(Math.max(...targetKm(targets))).toBeLessThanOrEqual(38);
    expect(Math.max(...targetKm(targets))).toBeGreaterThan(35);
    // Le budget contraint la montée, il ne l'interdit pas : le pic dépasse bien
    // le départ de plus de 10 %.
    expect(Math.max(...targetKm(targets))).toBeGreaterThan(targets[0].targetKm * 1.1);
  });

  it('convertit les kilomètres en temps à l’allure d’endurance', () => {
    // 35,9 km à 6:00/km font 3 h 35, soit 215 min.
    expect(targetsOf()[0].targetMinutes).toBe(215);
    // Sans allure connue, le repli prudent (8:00/km) compte plus de minutes.
    expect(targetsOf({ easyPaceSecPerKm: null })[0].targetMinutes).toBe(287);
  });

  it('proratise la première semaine entamée sur les jours qui y restent', () => {
    // Départ un jeudi : quatre jours sur sept, budget compris.
    const targets = targetsOf({ firstWeekFromDay: 4, weeklyTimeMinutes: 300 });

    expect(targets[0].kind).toBe('partial');
    expect(targets[0].targetKm).toBeCloseTo(targets[1].targetKm * (4 / 7), 0);
    expect(targets[0].targetMinutes).toBeLessThanOrEqual(300 * 0.95 * (4 / 7));
  });

  it('affûte avant une course : trois semaines qui descendent, la course au plus bas', () => {
    const targets = targetsOf({ weeks: 12, race: { isMarathon: true } });
    const kilometers = targetKm(targets);
    const taper = kilometers.slice(-3);

    expect(targets.map((target) => target.kind).slice(-3)).toEqual(['taper', 'taper', 'race']);
    expect(taper[0]).toBeLessThan(kilometers[kilometers.length - 4]);
    expect(taper[1]).toBeLessThan(taper[0]);
    expect(taper[2]).toBeLessThan(taper[1]);
    // La semaine de course reste très en dessous du pic.
    expect(taper[2]).toBeLessThanOrEqual(Math.max(...kilometers.slice(0, -3)) * 0.6);
  });

  it('n’affûte pas un objectif libre : il n’y a pas d’échéance à préparer', () => {
    expect(targetsOf({ weeks: 12 }).every((target) => target.kind !== 'race')).toBe(true);
  });

  /*
   * La régression du chantier : une fenêtre **restante** dont la première
   * semaine — entamée, donc à l'index 0 — est déjà une semaine d'affûtage ou la
   * semaine de la course.
   *
   * La boucle d'affûtage partait de `Math.max(taperFrom, firstFull)` et sautait
   * donc l'index 0 dès que la semaine était entamée ; la valeur écrite ensuite
   * pour cet index-là était le **départ** proratisé, sans facteur d'affûtage.
   * Sur une création, l'index 0 est la première semaine du plan et le raccourci
   * ne se voyait pas. Sur la fenêtre restante d'un plan en cours — révision
   * déclenchée le lundi qui suit la sortie longue, course le dimanche suivant —
   * la semaine de la course recevait un volume de développement.
   *
   * Mesuré avant correction, meilleure semaine réelle 60 km : **61,6 km** écrits
   * pour la semaine de course, quatre « Récupération » de 10,8 km et l'épreuve —
   * un affûtage au-dessus de tout ce que l'athlète avait couru, et
   * `validatePlanBusinessRules` n'y voyait rien.
   */
  const RESTART = { recentWeeklyKm: 60, race: { isMarathon: true }, firstWeekFromDay: 2 } as const;

  it('affûte la semaine entamée qui porte la course, au lieu de la faire développer', () => {
    // Une seule semaine restante, entamée au mardi : c'est la semaine de course.
    // 71,9 km de base × 0,55 (facteur de la dernière semaine) = 39,5, proratisés
    // sur six jours = 33,8. Avant : 61,6.
    const [raceWeek] = targetsOf({ ...RESTART, weeks: 1 });

    expect(raceWeek.targetKm).toBe(33.8);
    // Et le premier invariant qu'un affûtage doit tenir : rester très en dessous
    // de ce que l'athlète court en développement.
    expect(raceWeek.targetKm).toBeLessThan(RESTART.recentWeeklyKm * 0.65);
  });

  it('affûte la semaine entamée qui précède la course', () => {
    // Deux semaines restantes : la première (entamée) est un affûtage à 0,75,
    // la seconde la course à 0,55 — et la course, elle, était déjà juste.
    expect(targetKm(targetsOf({ ...RESTART, weeks: 2 }))).toEqual([46.1, 39.5]);
  });

  it('ne touche pas à une semaine entamée qui n’est pas un affûtage', () => {
    // Le cas de la création, celui qui ne doit pas bouger : dix semaines
    // restantes, l'index 0 est une semaine de développement, il se proratise
    // depuis le départ comme avant.
    const targets = targetsOf({ ...RESTART, weeks: 10 });

    expect(targets[0].kind).toBe('partial');
    expect(targets[0].targetKm).toBe(61.6);
    expect(targets[1].targetKm).toBe(71.9);
  });

  it('rend une entrée par semaine, et rien du tout sans semaine', () => {
    expect(targetsOf({ weeks: 52 })).toHaveLength(52);
    expect(weeklyVolumeTargets({ ...({} as WeeklyVolumeTargetsParams), weeks: 0 })).toEqual([]);
  });
});

/**
 * Le **témoin différentiel de la création** : une empreinte de 28 560
 * configurations, relevée sur le code d'avant la correction de l'affûtage et
 * inchangée après elle.
 *
 * ## Pourquoi une empreinte plutôt que des valeurs
 *
 * Parce que ce que ce test doit prouver n'est pas *quelles* cibles la création
 * écrit — les tests ci-dessus s'en chargent, chiffre par chiffre — mais qu'elle
 * n'en a **pas bougé d'un dixième** sur tout le domaine, y compris là où
 * personne ne pense à regarder. Trente mille tableaux ne se recopient pas dans
 * un fichier de test ; leur empreinte, si.
 *
 * ## Ce que le balayage exclut, et pourquoi
 *
 * Les fenêtres dont **toutes** les semaines sont un affûtage
 * (`weeks <= taperWeekCount`, soit une ou deux semaines menant à une course).
 * Celles-là ont bel et bien changé, et c'est la correction : leur index 0 est
 * lui-même une semaine d'affûtage ou la semaine de la course, et il recevait un
 * volume de développement. Mesuré sur le balayage complet : 1 440 lignes
 * modifiées sur 30 240, toutes dans ce coin-là (24 combinaisons
 * `semaines × objectif × jour de départ`, toutes à `weeks ∈ {1, 2}`, avec course
 * et départ en milieu de semaine), et le sens du changement est celui qu'on
 * voulait — 61,6 → 33,8 km sur une semaine de course d'une athlète à 60 km.
 * Les trois tests nommés ci-dessus les couvrent un par un.
 *
 * Le reste — les 28 560 autres, dont **toute** la grille de production
 * (`volumeCases`, 4 860 combinaisons à 4, 6, 8, 16 et 52 semaines) — est
 * identique au bit près.
 *
 * ## Si ce test casse
 *
 * C'est que la création a bougé. Ce n'est pas nécessairement une faute, mais ce
 * n'est jamais un effet de bord acceptable : il faut le vouloir, le mesurer, et
 * remplacer l'empreinte en connaissance de cause.
 */
describe('weeklyVolumeTargets — non-régression de la création', () => {
  /** L'empreinte gelée. Ne se met à jour qu'avec une intention écrite. */
  const CREATION_DIGEST = 'f2221039b817047403a14a61dd680134d0e69e443f985668da0bbe7780d3f600';

  it('rend exactement les mêmes cibles qu’avant sur tout le domaine', () => {
    const races = [null, { isMarathon: false }, { isMarathon: true }] as const;
    const levels = ['beginner', 'intermediate', 'advanced'] as const;
    const rows: string[] = [];

    for (let weeks = 1; weeks <= 24; weeks += 1) {
      for (const race of races) {
        // Les fenêtres entièrement en affûtage sont exclues : cf. l'en-tête.
        if (weeks <= taperWeekCount(weeks, race)) continue;
        for (let firstWeekFromDay = 1; firstWeekFromDay <= 7; firstWeekFromDay += 1) {
          for (const weeklyTimeMinutes of [null, 120, 300, 600]) {
            for (const recentWeeklyKm of [null, 4, 8, 42.1, 90]) {
              for (const level of levels) {
                const params: WeeklyVolumeTargetsParams = {
                  weeks,
                  firstWeekFromDay,
                  recentWeeklyKm,
                  weeklyTimeMinutes,
                  easyPaceSecPerKm: 330,
                  race,
                  level,
                };
                const key = `${weeks}|${race === null ? 'x' : race.isMarathon ? 'm' : 'r'}|${firstWeekFromDay}|${weeklyTimeMinutes}|${recentWeeklyKm}|${level}`;
                rows.push(`${key}=${JSON.stringify(weeklyVolumeTargets(params))}`);
              }
            }
          }
        }
      }
    }

    expect(rows).toHaveLength(28_560);
    expect(createHash('sha256').update(rows.join('\n')).digest('hex')).toBe(CREATION_DIGEST);
  });
});

describe('weeklySessionBudgets', () => {
  /** Le total d'une décomposition, arrondi comme les cibles : au dixième. */
  function total(budgets: readonly SessionBudget[]): number {
    return Math.round(budgets.reduce((sum, budget) => sum + budget.km, 0) * 10) / 10;
  }

  it('répartit la cible entre sortie longue, qualité et footings', () => {
    // 27,2 km sur 6 séances dont 2 de qualité : c'est la division que le modèle
    // posait de travers, et elle n'a qu'une réponse.
    expect(weeklySessionBudgets(27.2, 6, 2)).toEqual([
      { role: 'long', km: 8 },
      { role: 'quality', km: 4.5 },
      { role: 'quality', km: 4.5 },
      { role: 'easy', km: 3.4 },
      { role: 'easy', km: 3.4 },
      { role: 'easy', km: 3.4 },
    ]);
  });

  /**
   * **La sortie longue est la plus longue séance de la semaine, sans exception.**
   *
   * Ce n'est pas une préférence d'écriture : `validatePlanBusinessRules` refuse
   * une semaine dont la plus longue séance tombe un autre jour, et une semaine
   * décomposée par cette fonction vient de l'**appli**, pas du modèle. Le refus
   * sort donc en `InvalidGeneratedPlanError` — « incohérence interne » —, là où un
   * `InvalidPlanError` actionnable serait le seul verdict lisible pour l'athlète.
   *
   * Les parts garantissent l'ordre en réels ; ce sont les arrondis qui le
   * cassaient, et seulement dans un trou d'un dixième de kilomètre. Mesuré avant
   * correction : à 4,1 km sur 5 séances dont 2 de qualité, **1,0 km de sortie
   * longue contre 1,1 km pour le plus gros footing** — quand 4,0 et 4,2 km
   * passaient. Le balayage ci-dessous couvre les six autres trous du même genre
   * (3,1 · 4,1 · 4,2 · 4,3 km à 4 séances, et les cibles sous 1,2 km que le
   * plancher de distance du contrat rendait impossibles).
   */
  it('ne budgète jamais un footing plus long que la sortie longue', () => {
    // Le trou mesuré, nommément.
    const budgets = weeklySessionBudgets(4.1, 5, 2);
    expect(budgets[0].km).toBeGreaterThanOrEqual(
      Math.max(...budgets.slice(1).map((budget) => budget.km)),
    );

    // Puis tout le domaine : chaque dixième de 0,1 à 20 km, de 2 à 7 séances, de
    // 0 à 2 séances de qualité.
    const failures: string[] = [];
    for (let tenths = 1; tenths <= 200; tenths += 1) {
      const targetKm = Math.round(tenths) / 10;
      for (let sessions = 2; sessions <= 7; sessions += 1) {
        for (let quality = 0; quality <= 2; quality += 1) {
          const decomposition = weeklySessionBudgets(targetKm, sessions, quality);
          const longest = Math.max(...decomposition.slice(1).map((budget) => budget.km));
          if (decomposition[0].km < longest) {
            failures.push(
              `${targetKm} km · ${sessions} séances · ${quality} qualité → sortie longue ` +
                `${decomposition[0].km} km contre ${longest} km`,
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('fait tomber la somme exactement sur la cible', () => {
    for (const targetKm of [8.3, 14, 27.2, 35.9, 44.4, 70.1]) {
      for (const sessions of [2, 3, 4, 5, 6, 7]) {
        for (const quality of [0, 1, 2]) {
          expect(total(weeklySessionBudgets(targetKm, sessions, quality))).toBe(targetKm);
        }
      }
    }
  });

  it('garde la sortie longue en tête de semaine et dans la part que la règle lui laisse', () => {
    for (const targetKm of [8.3, 14, 27.2, 35.9, 44.4, 70.1]) {
      for (const sessions of [2, 3, 4, 5, 6, 7]) {
        for (const quality of [0, 1, 2]) {
          const budgets = weeklySessionBudgets(targetKm, sessions, quality);
          const [long, ...others] = budgets;

          expect(budgets).toHaveLength(sessions);
          expect(long.role).toBe('long');
          // La règle métier lit exactement ces deux choses : la sortie longue est
          // la plus longue séance, et sa part reste dans la fourchette.
          expect(Math.max(...others.map((budget) => budget.km))).toBeLessThanOrEqual(long.km);
          expect(long.km / targetKm).toBeGreaterThanOrEqual(0.2);
          // 40 %, ou `1,6 / nombre de séances` quand la semaine est trop courte
          // pour que 40 % suffise (cf. `longRunMaxShare`).
          expect(long.km / targetKm).toBeLessThanOrEqual(Math.max(0.4, 1.6 / sessions));
        }
      }
    }
  });

  it('pose la sortie longue autour de 30 % dès que la semaine a la place', () => {
    // La fourchette annoncée (28-32 %) vaut à partir de 5 séances : en dessous,
    // le partage égal du reste ferait un footing plus long que la sortie longue,
    // et c'est elle qui monte — ce que la règle prévoit déjà.
    for (const sessions of [5, 6, 7]) {
      const share = weeklySessionBudgets(35.9, sessions, 2)[0].km / 35.9;
      expect(share).toBeGreaterThanOrEqual(0.28);
      expect(share).toBeLessThanOrEqual(0.32);
    }
    expect(weeklySessionBudgets(35.9, 3, 1)[0].km / 35.9).toBeGreaterThan(0.4);
  });

  it('ramène les séances de qualité à ce que la semaine peut porter', () => {
    // Trois séances : une semaine garde un footing à côté de sa sortie longue.
    const budgets = weeklySessionBudgets(27.2, 3, 2);
    expect(budgets.filter((budget) => budget.role === 'quality')).toHaveLength(1);
    expect(budgets.filter((budget) => budget.role === 'easy')).toHaveLength(1);
    // Deux séances : la sortie longue et un footing, pas de qualité du tout.
    expect(weeklySessionBudgets(27.2, 2, 2).map((budget) => budget.role)).toEqual(['long', 'easy']);
  });

  it('rend la cible entière à une semaine d’une seule séance, et rien sans semaine', () => {
    expect(weeklySessionBudgets(12.4, 1, 2)).toEqual([{ role: 'long', km: 12.4 }]);
    expect(weeklySessionBudgets(12.4, 0, 1)).toEqual([]);
    expect(weeklySessionBudgets(0, 6, 1)).toEqual([]);
  });

  it('suit la part de sortie longue que l’appelant impose', () => {
    expect(weeklySessionBudgets(40, 6, 1, 0.25)[0].km).toBe(10);
    expect(weeklySessionBudgets(40, 6, 1, 0.35)[0].km).toBe(14);
    // Mais jamais au-delà de ce que la règle accepte : 50 % sur 6 séances est
    // refusé par `longRunMaxShare`, la décomposition s'arrête à 40 %.
    expect(weeklySessionBudgets(40, 6, 1, 0.5)[0].km).toBe(16);
  });
});

/** Une configuration de plan de la grille exhaustive, avec ses cibles chiffrées. */
type VolumeCase = {
  /** De quoi lire un échec sans dérouler la grille à la main. */
  label: string;
  params: WeeklyVolumeTargetsParams;
  sessionsPerWeek: number;
  longRunDay: number;
  targets: WeeklyVolumeTarget[];
};

/**
 * Toute la grille des configurations balayées — 4 860 combinaisons : durée du
 * plan, nature de l'objectif, jour de départ, budget temps, historique, niveau,
 * nombre de séances et jour de sortie longue.
 */
function volumeCases(): VolumeCase[] {
  const cases: VolumeCase[] = [];

  for (const weeks of [4, 6, 8, 16, 52]) {
    for (const race of [null, { isMarathon: false }, { isMarathon: true }]) {
      for (const firstWeekFromDay of [1, 4, 7]) {
        for (const weeklyTimeMinutes of [null, 300, 120]) {
          for (const recentWeeklyKm of [null, 42.1, 8]) {
            for (const level of ['beginner', 'intermediate', 'advanced'] as const) {
              for (const sessionsPerWeek of [3, 6]) {
                for (const longRunDay of [1, 7]) {
                  const params: WeeklyVolumeTargetsParams = {
                    weeks,
                    firstWeekFromDay,
                    recentWeeklyKm,
                    weeklyTimeMinutes,
                    easyPaceSecPerKm: 330,
                    race,
                    level,
                  };

                  cases.push({
                    label:
                      `${weeks} sem · ${race === null ? 'libre' : race.isMarathon ? 'marathon' : 'course'} · ` +
                      `départ j${firstWeekFromDay} · budget ${weeklyTimeMinutes} · récent ${recentWeeklyKm} · ` +
                      `${level} · ${sessionsPerWeek} séances · SL j${longRunDay}`,
                    params,
                    sessionsPerWeek,
                    longRunDay,
                    targets: weeklyVolumeTargets(params),
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return cases;
}

/**
 * Ce que la validation reproche à un plan qui écrit `written` semaine par
 * semaine, jugé contre les cibles réelles de la configuration.
 *
 * Les deux ne se confondent pas : `written` est ce que le modèle écrit (les
 * cibles, ou les chiffres tels que le prompt les imprime), `testCase.targets`
 * reste la référence que l'appli vérifiera.
 */
function violationsForCase(
  testCase: VolumeCase,
  written: readonly Pick<WeeklyVolumeTarget, 'targetKm' | 'targetMinutes'>[],
): string[] {
  const { params, sessionsPerWeek, longRunDay } = testCase;
  const plan = written.map((target, index) =>
    weekForTarget(target, sessionsPerWeek, longRunDay, index === 0 ? params.firstWeekFromDay : 1),
  );

  return validatePlanBusinessRules(
    plan,
    {
      scope: 'creation',
      weeks: params.weeks,
      sessionsPerWeek,
      longRunDay,
      firstWeekFromDay: params.firstWeekFromDay,
      race: params.race,
      weeklyTargets: testCase.targets,
    },
    { weeklyTimeMinutes: params.weeklyTimeMinutes, recentWeeklyKm: params.recentWeeklyKm },
  );
}

/**
 * Le test qui porte tout le chantier : un plan qui **applique les cibles** ne
 * viole aucune règle de volume, quelle que soit la configuration.
 *
 * C'est la condition de non-régression de l'architecture « le modèle structure,
 * l'appli chiffre » : si une seule combinaison produisait des cibles fautives,
 * le modèle recevrait des consignes que la validation refuserait — et la boucle
 * de reprise serait perdue d'avance, trois tentatives à chaque fois.
 */
describe('weeklyVolumeTargets × validatePlanBusinessRules', () => {
  it('produit des cibles qu’aucune règle de volume ne refuse', () => {
    const failures = volumeCases()
      .map((testCase) => ({ testCase, violations: violationsForCase(testCase, testCase.targets) }))
      .filter(({ violations }) => violations.length > 0)
      .map(({ testCase, violations }) => `${testCase.label} → ${violations.join(' | ')}`);

    expect(failures).toEqual([]);
  });
});

/*
 * Le balayage « fenêtre restante » a déménagé.
 *
 * Il éprouvait `weeklyVolumeTargets` muni de ses deux paramètres de
 * continuation, retirés depuis. Son équivalent — les cibles d'une fenêtre
 * restante qu'aucune règle ne refuse, sur tout le domaine des rangs de cadence,
 * des objectifs, des jours de reprise, des niveaux et des budgets — vit
 * désormais dans `plan-service.test.ts`, contre `remainingVolumeTargets`, qui
 * les calcule.
 */

/**
 * Le pendant du balayage précédent, un cran plus bas : un plan qui suit la
 * **décomposition par séance** ne viole aucune règle non plus.
 *
 * C'est ce que la décomposition promet au modèle. Si une seule configuration
 * produisait une semaine fautive — une sortie longue hors de sa fourchette, un
 * total hors de la bande de ±10 % —, le prompt lui donnerait des chiffres que la
 * validation refuse, et la reprise serait perdue d'avance.
 */
describe('weeklySessionBudgets × validatePlanBusinessRules', () => {
  /** Ce que le service décompose par niveau (`QUALITY_SESSIONS_BY_LEVEL`). */
  const QUALITY_BY_LEVEL = { beginner: 1, intermediate: 2, advanced: 2 } as const;

  /** Une semaine écrite **en recopiant** la décomposition de sa cible. */
  function weekFromBudgets(
    target: Pick<WeeklyVolumeTarget, 'targetKm' | 'targetMinutes'>,
    sessionsPerWeek: number,
    longRunDay: number,
    quality: number,
  ): PlanWeekOutput {
    const budgets = weeklySessionBudgets(target.targetKm, sessionsPerWeek, quality);
    const days = [longRunDay, ...[1, 2, 3, 4, 5, 6, 7].filter((day) => day !== longRunDay)];

    return {
      sessions: budgets.map((budget, index) => ({
        day: days[index],
        kind: budget.role === 'long' ? 'Sortie longue' : budget.role === 'quality' ? 'Seuil' : 'Endurance fondamentale',
        title: 'Séance',
        distanceKm: budget.km,
        ...(budget.role === 'quality' ? { steps: qualitySteps() } : {}),
      })),
    };
  }

  it('produit des semaines qu’aucune règle de volume ne refuse', () => {
    const failures = volumeCases()
      .map((testCase) => {
        const { params, sessionsPerWeek, longRunDay } = testCase;
        const quality = QUALITY_BY_LEVEL[params.level];
        const plan = testCase.targets.map((target, index) =>
          // La première semaine entamée n'est pas décomposée : on ne sait pas
          // combien de séances elle portera (cf. `sessionBudgetWeeks`).
          index === 0 && params.firstWeekFromDay > 1
            ? weekForTarget(target, sessionsPerWeek, longRunDay, params.firstWeekFromDay)
            : weekFromBudgets(target, sessionsPerWeek, longRunDay, quality),
        );

        return {
          testCase,
          violations: validatePlanBusinessRules(
            plan,
            {
              scope: 'creation',
              weeks: params.weeks,
              sessionsPerWeek,
              longRunDay,
              firstWeekFromDay: params.firstWeekFromDay,
              race: params.race,
              weeklyTargets: testCase.targets,
            },
            { weeklyTimeMinutes: params.weeklyTimeMinutes, recentWeeklyKm: params.recentWeeklyKm },
          ),
        };
      })
      .filter(({ violations }) => violations.length > 0)
      .map(({ testCase, violations }) => `${testCase.label} → ${violations.join(' | ')}`);

    expect(failures).toEqual([]);
  });
});

describe('validatePlanBusinessRules — cibles de volume', () => {
  const EXPECTED_WITH_TARGETS: PlanExpectations = {
    scope: 'creation',
    weeks: 1,
    sessionsPerWeek: 3,
    longRunDay: 7,
    weeklyTargets: [{ targetKm: 40, targetMinutes: 240, kind: 'build' }],
  };

  /** Une semaine de `total` kilomètres, sortie longue conforme. */
  function weekOf(total: number): PlanWeekOutput {
    return week([2, 4, 7], [total * 0.31, total * 0.31, total * 0.38]);
  }

  it('accepte une semaine à ±10 % de sa cible', () => {
    expect(validatePlanBusinessRules([weekOf(40)], EXPECTED_WITH_TARGETS)).toEqual([]);
    expect(validatePlanBusinessRules([weekOf(36)], EXPECTED_WITH_TARGETS)).toEqual([]);
    expect(validatePlanBusinessRules([weekOf(44)], EXPECTED_WITH_TARGETS)).toEqual([]);
  });

  it('refuse au-delà, en disant la bande arrondie du côté satisfiable', () => {
    expect(validatePlanBusinessRules([weekOf(30)], EXPECTED_WITH_TARGETS)).toEqual([
      'Semaine 1 : 30,0 km pour une cible de 40,0 km — chaque semaine reste à 10,0 % près ' +
        'de sa cible, soit entre 36,0 km et 44,0 km.',
    ]);
  });

  it('ne dit rien quand aucune cible n’a été chiffrée', () => {
    expect(
      validatePlanBusinessRules([weekOf(12)], { ...EXPECTED_WITH_TARGETS, weeklyTargets: null }),
    ).toEqual([]);
  });
});
