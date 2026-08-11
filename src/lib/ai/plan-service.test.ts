import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { TrainingSnapshotDto } from '@/data/coach-context';
import { PlanNotFoundError, type PlanDto, type PlanSessionDto } from '@/data/plans';
import type { PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

import { REFERENCE_DISTANCES, trainingPacesFromRace } from '@/lib/metrics/vdot';

import { AiInvalidOutputError, AiResponseError, AiUnavailableError, type AiOutputIssue } from './errors';
import {
  MAX_PLAN_WEEKS,
  MIN_RACE_PLAN_WEEKS,
  buildPlanMessages,
  buildPlanUpdateMessages,
  buildSchemaIssuesMessage,
  buildViolationsMessage,
  estimatePlanChars,
  generatePlan,
  planProgressPercent,
  planWindow,
  remainingPlanWindow,
  updatePlanFromInstruction,
  type PlanRequest,
} from './plan-service';
// Le registre n'est pas mocké : ce qu'on éprouve, c'est ce que la route lira.
import { getPlanProgress, type PlanProgress } from './progress';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { chatCompletionJson } = vi.hoisted(() => ({ chatCompletionJson: vi.fn() }));
const { requireAi } = vi.hoisted(() => ({ requireAi: vi.fn() }));
const { dal } = vi.hoisted(() => ({
  dal: {
    getTrainingSnapshot: vi.fn(),
    createDraftPlanWithSessions: vi.fn(),
    getActivePlanWithSessions: vi.fn(),
    applyPlanUpdate: vi.fn(),
    reconcilePlanSessions: vi.fn(),
  },
}));

const { syncPlanToIntervalsSafely } = vi.hoisted(() => ({
  syncPlanToIntervalsSafely: vi.fn(),
}));

/**
 * `after` exige un contexte de requête Next : hors serveur, le vrai lève. Le
 * doublon exécute la tâche immédiatement — ce que les tests éprouvent, c'est le
 * branchement et le fait qu'il passe par `after`, pas le moment de l'exécution.
 */
const { scheduleAfter } = vi.hoisted(() => ({ scheduleAfter: vi.fn() }));

vi.mock('./client', () => ({ chatCompletionJson }));
vi.mock('next/server', () => ({ after: scheduleAfter }));
vi.mock('@/lib/intervals/push-plan', () => ({ syncPlanToIntervalsSafely }));
vi.mock('./availability', () => ({ requireAi }));
vi.mock('@/data/coach-context', () => ({ getTrainingSnapshot: dal.getTrainingSnapshot }));
vi.mock('@/data/plan-reconciliation', () => ({
  reconcilePlanSessions: dal.reconcilePlanSessions,
}));
vi.mock('@/data/plans', async () => {
  // Les erreurs et les bornes sont du vrai code métier : seules les fonctions
  // qui touchent la base sont remplacées.
  const actual = await vi.importActual<typeof import('@/data/plans')>('@/data/plans');
  return {
    ...actual,
    createDraftPlanWithSessions: dal.createDraftPlanWithSessions,
    getActivePlanWithSessions: dal.getActivePlanWithSessions,
    applyPlanUpdate: dal.applyPlanUpdate,
  };
});

const SNAPSHOT: TrainingSnapshotDto = {
  today: '2026-08-11',
  profile: { ageYears: 36, sex: 'female', maxHrBpm: 188, restingHrBpm: 48, weightKg: 62 },
  fitness: { ctl: 52.4, atl: 61.2, tsb: -8.8 },
  vo2max: 48.6,
  weeks: [{ startsOn: '2026-08-03', distanceKm: 42.1, movingTimeS: 13_500, sessions: 4 }],
  recentAvgPaceSecPerKm: 324,
};

const PLAN: PlanDto = {
  id: 3,
  status: 'active',
  goalType: 'race',
  level: 'intermediate',
  goalText: '10 km sous 50 min',
  raceDate: '2026-09-13',
  startsOn: '2026-08-03',
  weeks: 6,
  sessionsPerWeek: 3,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: null,
  referenceTimeS: null,
  summary: 'Bloc de 6 semaines.',
  reviewedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
};

/** Ce qu'une génération écrit : une proposition, pas un plan en cours. */
const DRAFT: PlanDto = { ...PLAN, id: 9, status: 'draft' };

function planSession(overrides: Partial<PlanSessionDto> & { scheduledOn: string }): PlanSessionDto {
  return {
    id: 1,
    kind: 'Endurance',
    title: 'Footing',
    warmup: null,
    recovery: null,
    cooldown: null,
    targetPaceSecPerKm: null,
    volumeM: null,
    durationS: null,
    steps: null,
    completedActivityId: null,
    ...overrides,
  };
}

/** Une étape complète : le contrat porte ses sept clés, `null` pour absent. */
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

/** Le déroulé d'une séance au seuil, tel qu'il est déjà en base. */
const THRESHOLD_STEPS = [
  { repeat: 1, steps: [step('warmup', { durationS: 900, hrZone: 2 })] },
  {
    repeat: 4,
    steps: [
      step('run', { durationS: 480, paceMinSecPerKm: 300, paceMaxSecPerKm: 310 }),
      step('recover', { durationS: 120 }),
    ],
  },
  { repeat: 1, steps: [step('cooldown', { durationS: 600 })] },
];

/** Un chrono de référence : 10 km en 48:30 → VDOT 41,5 (cf. `lib/metrics/vdot`). */
const REFERENCE_RACE = { distance: '10k', timeS: 2_910 } as const;

const REQUEST: PlanRequest = {
  goalType: 'free',
  level: 'intermediate',
  goalText: 'reprendre le volume',
  weeks: 2,
  sessionsPerWeek: 3,
  longRunDay: 7,
};

/**
 * Une semaine conforme : 3 séances, la plus longue le dimanche, et la séance de
 * qualité livrée avec son déroulé — sans lui, elle violerait les règles métier.
 */
const CONFORMING_WEEK = {
  sessions: [
    { day: 2, kind: 'Endurance', title: 'Footing', distanceKm: 8 },
    { day: 4, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10, steps: THRESHOLD_STEPS },
    { day: 7, kind: 'Sortie longue', title: 'Endurance', distanceKm: 16 },
  ],
};

/**
 * Une **première semaine entamée** conforme : rien avant le jeudi, et la sortie
 * longue toujours le dimanche.
 */
const PARTIAL_FIRST_WEEK = {
  sessions: [
    { day: 4, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10, steps: THRESHOLD_STEPS },
    { day: 7, kind: 'Sortie longue', title: 'Endurance', distanceKm: 16 },
  ],
};

/**
 * La même semaine, dont le footing du mardi porte une allure délirante :
 * 10:00/km pour une athlète qui court en 5:24/km (SNAPSHOT).
 */
const ABERRANT_PACE_WEEK = {
  sessions: [
    { day: 2, kind: 'Endurance', title: 'Footing', distanceKm: 8, targetPaceSecPerKm: 600 },
    { day: 4, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10, steps: THRESHOLD_STEPS },
    { day: 7, kind: 'Sortie longue', title: 'Endurance', distanceKm: 16 },
  ],
};

/** Une semaine qui viole les règles : deux séances, aucune le dimanche. */
const BROKEN_WEEK = {
  sessions: [
    { day: 2, kind: 'Endurance', title: 'Footing', distanceKm: 8 },
    { day: 4, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10 },
  ],
};

/**
 * Les rejets du modèle sont journalisés : la console est muselée pour tous les
 * tests, et inspectée par ceux qui éprouvent la trace elle-même.
 */
let consoleError: MockInstance<typeof console.error>;

/** Le diagnostic du suivi de progression, lui, part en `console.info`. */
let consoleInfo: MockInstance<typeof console.info>;

/** Tout ce qui est parti dans un espion de console, en un seul texte. */
function textOf(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

/** Tout ce qui est parti dans `console.error`, en un seul texte. */
function loggedText(): string {
  return textOf(consoleError);
}

beforeEach(() => {
  vi.useFakeTimers();
  // Un mardi : un plan sans date de départ commence donc ce jour-là, sur la
  // semaine du lundi 10 août 2026.
  vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  requireAi.mockResolvedValue(undefined);
  dal.getTrainingSnapshot.mockResolvedValue(SNAPSHOT);
  dal.createDraftPlanWithSessions.mockResolvedValue(DRAFT);
  dal.getActivePlanWithSessions.mockResolvedValue({ plan: PLAN, sessions: [] });
  dal.applyPlanUpdate.mockResolvedValue(undefined);
  dal.reconcilePlanSessions.mockResolvedValue(0);
  syncPlanToIntervalsSafely.mockResolvedValue(undefined);
  scheduleAfter.mockImplementation((task: () => unknown) => {
    void task();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Un départ un lundi : la fenêtre d'avant la première semaine partielle. */
const MONDAY = { startsOn: '2026-08-17' } as const;

describe('planWindow', () => {
  it("déduit la durée de la date de course, jour de course compris", () => {
    // Du lundi 17 août au dimanche 13 septembre : 4 semaines pleines.
    expect(
      planWindow({ ...REQUEST, ...MONDAY, goalType: 'race', raceDate: '2026-09-13' }, '2026-08-11'),
    ).toEqual({ startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 });
    // Course un lundi : la semaine qui la porte compte quand même.
    expect(
      planWindow({ ...REQUEST, ...MONDAY, goalType: 'race', raceDate: '2026-09-14' }, '2026-08-11'),
    ).toEqual({ startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 5, firstWeekFromDay: 1 });
  });

  it('refuse une course trop proche pour être périodisée', () => {
    // Du lundi 17 au dimanche 30 : deux semaines, et le message dit les jours
    // réellement disponibles plutôt qu'un compte de cases du calendrier.
    expect(() =>
      planWindow({ ...REQUEST, ...MONDAY, goalType: 'race', raceDate: '2026-08-30' }, '2026-08-11'),
    ).toThrow(new RegExp(`13 jours avant la course.*${MIN_RACE_PLAN_WEEKS} semaines au minimum`));
  });

  it('refuse une course trop lointaine pour tenir dans un plan', () => {
    // Le plan démarre le lundi 17 août 2026 : sa 52e semaine finit le 15 août
    // 2027. Un jour de plus et la fenêtre déborde — la tronquer produirait un
    // plan qui s'arrête avant la course qu'il prépare.
    expect(
      planWindow({ ...REQUEST, ...MONDAY, goalType: 'race', raceDate: '2027-08-15' }, '2026-08-11')
        .weeks,
    ).toBe(MAX_PLAN_WEEKS);

    expect(() =>
      planWindow({ ...REQUEST, ...MONDAY, goalType: 'race', raceDate: '2027-08-16' }, '2026-08-11'),
    ).toThrow(new RegExp(`Course trop lointaine.*${MAX_PLAN_WEEKS} au plus`));
  });

  it('refuse un objectif course sans date exploitable', () => {
    expect(() => planWindow({ ...REQUEST, ...MONDAY, goalType: 'race' }, '2026-08-11')).toThrow(
      /date de la course/,
    );
    expect(() =>
      planWindow({ ...REQUEST, ...MONDAY, goalType: 'race', raceDate: '2026-02-31' }, '2026-08-11'),
    ).toThrow(/date de la course/);
  });

  it('exige une durée pour un objectif libre', () => {
    expect(() => planWindow({ ...REQUEST, weeks: undefined }, '2026-08-11')).toThrow(
      /durée en semaines/,
    );
  });

  describe('date de démarrage choisie', () => {
    it('démarre le lundi demandé, objectif libre', () => {
      expect(planWindow({ ...REQUEST, startsOn: '2026-08-31' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-31',
        anchor: '2026-08-31',
        weeks: 2,
        firstWeekFromDay: 1,
      });
    });

    it('recompte les semaines d’une course depuis ce lundi-là', () => {
      const race = { ...REQUEST, goalType: 'race', raceDate: '2026-09-27' } as const;

      // Départ le lundi 17 août : 6 semaines jusqu'à la course.
      expect(planWindow({ ...race, ...MONDAY }, '2026-08-11').weeks).toBe(6);
      // Départ repoussé de deux semaines : le plan raccourcit d'autant.
      expect(planWindow({ ...race, startsOn: '2026-08-31' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-31',
        anchor: '2026-08-31',
        weeks: 4,
        firstWeekFromDay: 1,
      });
    });

    it('refuse une course devenue trop proche du démarrage choisi', () => {
      expect(() =>
        planWindow(
          { ...REQUEST, goalType: 'race', raceDate: '2026-09-13', startsOn: '2026-08-31' },
          '2026-08-11',
        ),
      ).toThrow(/trop court/);
    });

    it('démarre aujourd’hui quand rien n’est demandé', () => {
      // Un mardi : le plan commence le jour même, sa première semaine est donc
      // entamée et la grille reste ancrée sur le lundi 10.
      expect(planWindow(REQUEST, '2026-08-11')).toEqual({
        startsOn: '2026-08-11',
        anchor: '2026-08-10',
        weeks: 2,
        firstWeekFromDay: 2,
      });
      expect(planWindow({ ...REQUEST, startsOn: undefined }, '2026-08-11').startsOn).toBe(
        '2026-08-11',
      );
    });

    it('refuse un démarrage passé', () => {
      expect(() => planWindow({ ...REQUEST, startsOn: '2026-08-10' }, '2026-08-11')).toThrow(
        /ne peut pas démarrer dans le passé/,
      );
    });

    it('refuse une date inexploitable', () => {
      expect(() => planWindow({ ...REQUEST, startsOn: '2026-02-31' }, '2026-08-11')).toThrow(
        /AAAA-MM-JJ/,
      );
    });
  });

  describe('départ en milieu de semaine', () => {
    it('ancre la grille sur le lundi de la semaine du départ', () => {
      // Jeudi 13 août : la première semaine est celle du lundi 10, mais le plan
      // ne commence que le 13.
      expect(planWindow({ ...REQUEST, weeks: 8, startsOn: '2026-08-13' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-13',
        anchor: '2026-08-10',
        weeks: 8,
        firstWeekFromDay: 4,
      });
    });

    it('ajoute la semaine entamée aux semaines demandées quand elle est trop courte', () => {
      // Samedi : deux jours restants, ils ne valent pas une semaine
      // d'entraînement — les 8 semaines demandées restent entières.
      expect(planWindow({ ...REQUEST, weeks: 8, startsOn: '2026-08-15' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-15',
        anchor: '2026-08-10',
        weeks: 9,
        firstWeekFromDay: 6,
      });
      // Dimanche : un seul jour, même arbitrage.
      expect(planWindow({ ...REQUEST, weeks: 8, startsOn: '2026-08-16' }, '2026-08-11').weeks).toBe(9);
      // Jeudi : quatre jours, sortie longue du week-end comprise — la semaine
      // entamée compte parmi les huit.
      expect(planWindow({ ...REQUEST, weeks: 8, startsOn: '2026-08-13' }, '2026-08-11').weeks).toBe(8);
    });

    it('exclut une semaine entamée trop courte du minimum d’un plan course', () => {
      const race = { ...REQUEST, goalType: 'race' } as const;

      // Dimanche 16 août, course le lundi 24 : trois semaines ISO depuis l'ancre,
      // mais huit jours de préparation — la semaine entamée d'un jour ne prépare
      // pas une course, et le message le dit.
      expect(() => planWindow({ ...race, raceDate: '2026-08-24', startsOn: '2026-08-16' }, '2026-08-11')).toThrow(
        /ne laisse que 8 jours avant la course/,
      );
      // Une semaine de plus et la préparation tient : quatre semaines ISO, dont
      // trois qui comptent.
      expect(
        planWindow({ ...race, raceDate: '2026-08-31', startsOn: '2026-08-16' }, '2026-08-11').weeks,
      ).toBe(MIN_RACE_PLAN_WEEKS + 1);
      // Jeudi 13 août, même course : quatre jours dans la semaine entamée, elle
      // compte — le seuil ne bouge pas pour un départ du lundi au jeudi.
      expect(
        planWindow({ ...race, raceDate: '2026-08-24', startsOn: '2026-08-13' }, '2026-08-11').weeks,
      ).toBe(MIN_RACE_PLAN_WEEKS);
    });

    it('compte les semaines d’une course depuis l’ancre, semaine entamée comprise', () => {
      const race = { ...REQUEST, goalType: 'race', raceDate: '2026-09-13' } as const;

      // Jeudi 13 août → dimanche 13 septembre : 5 semaines ISO depuis le lundi 10.
      expect(planWindow({ ...race, startsOn: '2026-08-13' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-13',
        anchor: '2026-08-10',
        weeks: 5,
        firstWeekFromDay: 4,
      });
      // Départ le dimanche : même ancre, donc même compte — la semaine entamée
      // d'un seul jour reste la première du plan.
      expect(planWindow({ ...race, startsOn: '2026-08-16' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-16',
        anchor: '2026-08-10',
        weeks: 5,
        firstWeekFromDay: 7,
      });
    });
  });
});

describe('remainingPlanWindow', () => {
  it('découpe à partir de la semaine en cours, entamée', () => {
    // Plan démarré le lundi 3 août, reprise le mercredi 12 : semaine 2 du plan.
    expect(remainingPlanWindow({ startsOn: '2026-08-03', weeks: 6 }, '2026-08-12')).toEqual({
      firstWeekStart: '2026-08-10',
      weeks: 5,
      firstWeekFromDay: 3,
    });
  });

  it("rend le plan entier quand il n'a pas encore commencé", () => {
    expect(remainingPlanWindow({ startsOn: '2026-08-17', weeks: 6 }, '2026-08-12')).toEqual({
      firstWeekStart: '2026-08-17',
      weeks: 6,
      firstWeekFromDay: 1,
    });
  });

  it('découpe un plan démarré en milieu de semaine sur sa grille ISO', () => {
    // Plan démarré le jeudi 13 août : sa première semaine est celle du lundi 10.
    // Reprise le lundi 17 : c'est déjà la deuxième semaine du plan.
    expect(remainingPlanWindow({ startsOn: '2026-08-13', weeks: 5 }, '2026-08-17')).toEqual({
      firstWeekStart: '2026-08-17',
      weeks: 4,
      firstWeekFromDay: 1,
    });
    // Reprise le samedi 15 : toujours la première semaine, entamée depuis samedi.
    expect(remainingPlanWindow({ startsOn: '2026-08-13', weeks: 5 }, '2026-08-15')).toEqual({
      firstWeekStart: '2026-08-10',
      weeks: 5,
      firstWeekFromDay: 6,
    });
  });

  it('rend la semaine entamée du départ quand le plan ne commence pas encore', () => {
    // Reprise avant le départ : rien n'est à replanifier avant le jeudi 13.
    expect(remainingPlanWindow({ startsOn: '2026-08-13', weeks: 5 }, '2026-08-12')).toEqual({
      firstWeekStart: '2026-08-10',
      weeks: 5,
      firstWeekFromDay: 4,
    });
  });

  it('refuse de régénérer un plan arrivé à son terme', () => {
    expect(() => remainingPlanWindow({ startsOn: '2026-08-03', weeks: 1 }, '2026-08-12')).toThrow(
      /arrivé à son terme/,
    );
  });
});

describe('buildPlanMessages', () => {
  const messages = buildPlanMessages(
    { ...REQUEST, goalType: 'race', goalText: '10 km sous 50 min', raceDate: '2026-09-13', weeklyTimeMinutes: 300 },
    { startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 },
    SNAPSHOT,
  );

  it('pose le rôle et les principes dans le message système', () => {
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('coach de course à pied');
    expect(messages[0].content).toContain('10 %');
  });

  it('encode la méthodologie : polarisation, typologie, progression, affûtage', () => {
    const system = messages[0].content;

    // Distribution polarisée et espacement des séances dures.
    expect(system).toContain('80 %');
    expect(system).toContain('Jamais deux jours de suite');
    // Typologie des séances, telle que le `kind` doit la nommer.
    expect(system).toContain('« Seuil »');
    expect(system).toContain('« VMA »');
    expect(system).toContain('« Sortie longue »');
    // Progression et affûtage.
    expect(system).toContain('20 à 40 %');
    expect(system).toContain('Affûtage');
  });

  /**
   * Le modèle doit réussir du premier coup : la validation est le filet, pas la
   * consigne. Ces chiffres sont donc exactement ceux que `plan-schema.ts`
   * vérifie — s'ils divergent, le coach se fait refuser un plan qu'il croyait
   * conforme, et une génération de plusieurs minutes est perdue.
   */
  it('donne les seuils de volume exacts que la validation vérifie', () => {
    const system = messages[0].content;

    expect(system).toContain('PROGRESSION DU VOLUME');
    expect(system).toContain("n'augmente jamais de plus de 12 %");
    expect(system).toContain('TOUTE séance déclare sa distance');
    expect(system).toContain('sur toute fenêtre de 4 semaines, au moins une redescend à 85 %');
    expect(system).toContain("dépasse d'au moins 10 % la première semaine pleine");
    expect(system).toContain(
      'les 2 dernières semaines (3 pour un marathon, sur un plan de 8 semaines et plus) baissent STRICTEMENT',
    );
    expect(system).toContain('ne dépasse pas 65 % du volume de la semaine la plus chargée');
    // La semaine entamée du départ : sa baisse n'en est pas une, et le modèle
    // n'a pas à la compenser.
    expect(system).toContain('amputée des jours passés');
  });

  /**
   * Le budget temps : une limite dure, et dite comme telle.
   *
   * Constaté en production : 2 h par semaine déclarées, ~3 h 30 planifiées. La
   * contrainte figurait bien dans la demande (« 2 h 00 d'entraînement par
   * semaine au plus »), mais rien ne disait au modèle qu'elle serait vérifiée —
   * ni ce qui devait céder quand elle ne tenait pas.
   */
  it('annonce le temps hebdomadaire comme une limite dure vérifiée', () => {
    const system = messages[0].content;

    expect(system).toContain('limite DURE, vérifiée semaine par semaine');
    expect(system).toContain("la somme des `durationMin` d'une semaine");
    expect(system).toContain("c'est le volume qui baisse");
    // Et la contrainte elle-même figure dans la demande, chiffrée.
    expect(messages[1].content).toContain("5 h 00 d'entraînement par semaine au plus");
  });

  /**
   * Le volume de départ : le modèle doit viser juste du premier coup.
   *
   * Constaté en production : 25 km la première semaine, chez une athlète dont
   * les quatre dernières font 9 à 13,6 km. La violation est le filet ; cette
   * ligne-là est la consigne, et elle porte exactement le chiffre que la
   * validation vérifiera.
   */
  it('plafonne la première semaine pleine sur le volume réel récent', () => {
    // Meilleure semaine du snapshot : 42,1 km → max(42,1 × 1,2 ; 42,1 + 3).
    expect(messages[1].content).toContain(
      'Volume de départ : la première semaine pleine ne dépasse pas 50,5 km (ton volume réel récent).',
    );
  });

  it('ne plafonne rien quand l’historique est vide ou nul', () => {
    const window = { startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 };

    expect(buildPlanMessages(REQUEST, window, { ...SNAPSHOT, weeks: [] })[1].content).not.toContain(
      'Volume de départ',
    );
    expect(
      buildPlanMessages(REQUEST, window, {
        ...SNAPSHOT,
        weeks: [{ startsOn: '2026-08-03', distanceKm: 0, movingTimeS: 0, sessions: 0 }],
      })[1].content,
    ).not.toContain('Volume de départ');
  });

  /**
   * Le retour d'utilisation qui a imposé cette ligne : les sorties longues
   * générées sortaient 100 % en endurance, quand les plans concurrents
   * proposaient des passages à l'allure objectif dès la mi-préparation. « La
   * spécificité croît vers l'objectif » ne suffit pas — un petit modèle applique
   * une prescription chiffrée, pas une intention.
   */
  it('prescrit un bloc à allure objectif dans les sorties longues d’une préparation course', () => {
    const system = messages[0].content;

    expect(system).toContain(
      "- À partir de la moitié du plan, la sortie longue contient un bloc à allure objectif (étape `run` avec note « allure objectif », 10 à 25 % de la distance de la sortie), qui s'allonge de semaine en semaine. L'affûtage le raccourcit sans le supprimer.",
    );
    // La note est le pivot : c'est elle que `applyImposedPaces` reconnaît pour
    // poser la plage M sur cette étape-là, au sein d'une séance rangée en E.
    expect(system).toContain('« allure objectif »');
  });

  it('ne prescrit pas de bloc à allure objectif sur un objectif libre', () => {
    // Sans échéance, il n'y a pas d'allure objectif à travailler : la prescrire
    // ferait fabriquer une course au modèle.
    const system = buildPlanMessages(
      REQUEST,
      { startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 },
      SNAPSHOT,
    )[0].content;

    expect(system).not.toContain('À partir de la moitié du plan');
    // Le reste de la section PROGRESSION, lui, ne bouge pas.
    expect(system).toContain("La spécificité croît vers l'objectif");
  });

  it('impose la structure des séances de qualité et le format des étapes', () => {
    const system = messages[0].content;

    expect(system).toContain('`steps`');
    expect(system).toContain('échauffement progressif de 10 à 20 min');
    expect(system).toContain("retour au calme de 5 à 10 min");
    expect(system).toContain("role: 'recover'");
    // Une mesure, une cible : les invariants du contrat, dits au modèle.
    expect(system).toContain('jamais les deux');
    expect(system).toContain('Un bloc ne contient pas de bloc');
  });

  it('montre une étape de récupération plutôt que de la décrire une fois de plus', () => {
    // La faute qui revient à chaque reprise en production : l'étape de
    // récupération d'un bloc répété, écrite avec distance ET durée, alors que
    // l'interdiction est déjà énoncée. Un petit modèle recopie un exemple.
    const system = messages[0].content;

    expect(system).toContain('{ "role": "recover", "durationS": 120 }');
    expect(system).toContain('une mesure, jamais les deux');
  });

  it('ancre les allures sur une référence dite pour ce qu’elle est : une allure d’endurance', () => {
    const system = messages[0].content;

    expect(system).toContain('Allure moyenne des dernières sorties');
    expect(system).toContain("Ce n'est pas une allure de tempo");
    expect(system).toContain('endurance fondamentale et sortie longue : référence + 0 à 15 s/km');
    expect(system).toContain('seuil : référence − 30 à 45 s/km');
    expect(system).toContain('VMA : référence − 60 à 80 s/km');
    expect(system).toContain('répétitions courtes : référence − 80 à 100 s/km');
    expect(system).toContain('récupération trottée : référence + 60 à 120 s/km');
  });

  it('ne présente jamais le repos comme une séance', () => {
    const system = messages[0].content;

    // Une séance est une sortie : « ou repos » poussait le modèle à écrire un
    // jour de repos comme une séance, donc à lui inventer une distance.
    expect(system).toContain('« Récupération » : footing court très souple.');
    expect(system).not.toContain('ou repos');
  });

  it('confronte un objectif chiffré aux données, sans s’y soumettre', () => {
    const system = messages[0].content;

    expect(system).toContain('« 10 km sous 50 min » vaut 5:00/km');
    expect(system).toContain('le plan reste ancré sur les données');
  });

  it('dérive les allures des seules données du snapshot, et sait se taire', () => {
    const system = messages[0].content;

    expect(system).toContain('maxima prudents');
    // Donnée manquante : on cible par zone cardiaque, et on le dit.
    expect(system).toContain("Si l'allure de référence est inconnue");
    expect(system).toContain('`hrZone`');
    expect(system).toContain("Tu n'inventes jamais une valeur");
  });

  it('interdit explicitement les miles : un modèle anglophone y glisse tout seul', () => {
    // Une allure « 10:00 » pensée en min/mile devient un 10:00/km délirant une
    // fois relue en métrique — le cas constaté en production.
    expect(messages[0].content).toContain(
      "Tu travailles EXCLUSIVEMENT en système métrique : distances en mètres et en kilomètres, allures en secondes par kilomètre. Jamais de miles, jamais de min/mile — 10:00/mile n'est pas une allure de ce plan.",
    );
  });

  it('exige la mesure de séance en plus du déroulé, pour que les volumes se comparent', () => {
    expect(messages[0].content).toContain(
      'Toute séance qui porte un `steps` déclare AUSSI sa distance totale estimée au niveau de la séance',
    );
  });

  it('porte objectif, fenêtre et contraintes en toutes lettres', () => {
    const user = messages[1].content;

    expect(user).toContain('« 10 km sous 50 min »');
    expect(user).toContain('dimanche 13 septembre 2026');
    expect(user).toContain('4 semaines, du lundi 17 août 2026 au dimanche 13 septembre 2026');
    expect(user).toContain('3 séances par semaine');
    expect(user).toContain('sortie longue le dimanche');
    expect(user).toContain("5 h 00 d'entraînement par semaine au plus");
  });

  it('annonce une première semaine entamée, son premier jour et son plafond', () => {
    // Départ le jeudi 13 août : la grille reste ancrée au lundi 10, et les
    // trois premiers jours du plan n'existent pas.
    const user = buildPlanMessages(
      REQUEST,
      { startsOn: '2026-08-13', anchor: '2026-08-10', weeks: 2, firstWeekFromDay: 4 },
      SNAPSHOT,
    )[1].content;

    expect(user).toContain('2 semaines, du jeudi 13 août 2026 au dimanche 23 août 2026');
    expect(user).toContain('weeks[0] est la semaine du lundi 10 août 2026.');
    expect(user).toContain(
      "weeks[0] est déjà entamée : elle ne porte de séances qu'à partir du jeudi (day ≥ 4), et en compte 3 au plus.",
    );
    expect(user).toContain('Sa sortie longue reste le dimanche.');
    expect(user).toContain('Les semaines suivantes comptent exactement 3 séances.');
    // Sans budget déclaré, il n'y a pas de plafond à annoncer.
    expect(user).not.toContain('au prorata');
  });

  it('annonce le budget de la semaine entamée, ramené au prorata des jours restants', () => {
    // Départ le jeudi : quatre jours restants, soit 4/7 des 2 h déclarées. Sans
    // cette ligne, le modèle produisait une semaine entamée à la mesure du
    // budget plein, refusée ensuite par un plafond qu'il ne pouvait pas deviner.
    const user = buildPlanMessages(
      { ...REQUEST, weeklyTimeMinutes: 120 },
      { startsOn: '2026-08-13', anchor: '2026-08-10', weeks: 2, firstWeekFromDay: 4 },
      SNAPSHOT,
    )[1].content;

    expect(user).toContain(
      'Le budget de la semaine entamée est ramené à 1 h 08 au prorata des jours restants.',
    );
  });

  it('n’annonce aucun plafond quand la semaine entamée est trop courte pour en porter un', () => {
    // Départ le samedi : deux jours restants, la règle de budget ne s'applique
    // pas à cette semaine-là — annoncer 34 min réclamerait l'impossible.
    const user = buildPlanMessages(
      { ...REQUEST, weeklyTimeMinutes: 120 },
      { startsOn: '2026-08-15', anchor: '2026-08-10', weeks: 2, firstWeekFromDay: 6 },
      SNAPSHOT,
    )[1].content;

    expect(user).not.toContain('au prorata');
  });

  it('dispense la semaine entamée de sa sortie longue quand ce jour est passé', () => {
    const user = buildPlanMessages(
      { ...REQUEST, longRunDay: 2 },
      { startsOn: '2026-08-13', anchor: '2026-08-10', weeks: 2, firstWeekFromDay: 4 },
      SNAPSHOT,
    )[1].content;

    expect(user).toContain("Elle n'a pas de sortie longue : le mardi de cette semaine-là est passé.");
  });

  it('ne dit rien d’une semaine entamée quand le plan démarre un lundi', () => {
    expect(messages[1].content).toContain('Chaque semaine compte exactement 3 séances.');
    expect(messages[1].content).not.toContain('déjà entamée');
  });

  it("dit le niveau à la demande et n'envoie que la section correspondante", () => {
    const system = messages[0].content;

    expect(messages[1].content).toContain('Niveau déclaré : intermédiaire.');
    expect(system).toContain("NIVEAU DE L'ATHLÈTE : INTERMÉDIAIRE");
    expect(system).toContain('1 à 2 séances de qualité par semaine');
    // Les deux autres niveaux ne sont pas envoyés : le budget de contexte est
    // compté, et deux méthodologies contradictoires ne s'appliquent pas.
    expect(system).not.toContain("NIVEAU DE L'ATHLÈTE : DÉBUTANT");
    expect(system).not.toContain("NIVEAU DE L'ATHLÈTE : CONFIRMÉ");
  });

  it('bride la qualité et la progression de volume pour un débutant', () => {
    const system = buildPlanMessages(
      { ...REQUEST, level: 'beginner' },
      { startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 },
      SNAPSHOT,
    );

    expect(system[1].content).toContain('Niveau déclaré : débutant.');
    expect(system[0].content).toContain('AU PLUS UNE séance de qualité par semaine');
    expect(system[0].content).toContain("de 5 à 8 % d'une semaine à l'autre");
    expect(system[0].content).toContain('marche/course');
    expect(system[0].content).not.toContain('2 à 3 × 8 à 12 min');
  });

  it('ouvre les blocs longs et la troisième séance de qualité au confirmé', () => {
    const system = buildPlanMessages(
      { ...REQUEST, level: 'advanced' },
      { startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 },
      SNAPSHOT,
    );

    expect(system[1].content).toContain('Niveau déclaré : confirmé.');
    expect(system[0].content).toContain('2 à 3 × 8 à 12 min');
    expect(system[0].content).toContain('3 ponctuellement');
    expect(system[0].content).not.toContain('AU PLUS UNE séance de qualité par semaine');
    // La méthodologie générale, elle, ne bouge pas d'un niveau à l'autre.
    expect(system[0].content).toContain('coach de course à pied');
  });

  it('porte le snapshot chiffré et rien qui ressemble à une série de points', () => {
    const user = messages[1].content;

    expect(user).toContain('CTL 52');
    expect(user).toContain('VO2max estimée : 48,6');
    expect(user).toContain('5:24/km');
    expect(user).not.toContain('null');
    // Un prompt de génération reste court : le budget est pour la sortie.
    expect(user.length).toBeLessThan(1_500);
  });
});

/**
 * Le chrono change la nature du prompt : les allures ne sont plus dérivées d'une
 * moyenne d'entraînement, elles sont **calculées** — et, la prescription ayant
 * échoué trois déploiements de suite, plus demandées du tout au modèle. C'est
 * l'appli qui les pose (cf. `applyImposedPaces`), le prompt ne fait plus que
 * l'annoncer.
 */
describe('buildPlanMessages — allures imposées', () => {
  const paces = trainingPacesFromRace(REFERENCE_DISTANCES[REFERENCE_RACE.distance], REFERENCE_RACE.timeS);
  const withRace = buildPlanMessages(
    { ...REQUEST, referenceRace: REFERENCE_RACE },
    { startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 },
    SNAPSHOT,
    paces,
  );

  it('donne la table calculée, chrono et VDOT à l’appui', () => {
    const system = withRace[0].content;

    expect(system).toContain("ALLURES — calculées et posées par l'application, tu n'en écris AUCUNE");
    expect(system).toContain('Chrono de référence : 10 km en 48:30 → VDOT 41,5.');
    expect(system).toContain('- E (endurance fondamentale, sortie longue) : 5:56–6:32/km');
    expect(system).toContain('- M (allure marathon, allure objectif) : 5:08–5:37/km');
    expect(system).toContain('- T (seuil) : 4:57–5:11/km');
    expect(system).toContain('- I (VMA) : 4:28–4:39/km');
    expect(system).toContain('- R (répétitions courtes) : 4:08–4:17/km');
  });

  /**
   * Le constat de production qui a imposé le renversement : même avec la table
   * en unique section d'allures, le modèle local prescrivait 12:00/km en EF,
   * 11:00 au seuil et 10:10 en VMA, à chaque tentative de chaque génération. Une
   * consigne numérique ne s'applique pas à cette taille de modèle ; ce qu'on lui
   * demande maintenant, c'est de n'écrire aucune allure.
   */
  it('interdit toute allure au modèle au lieu de lui en prescrire', () => {
    const system = withRace[0].content;

    expect(system).toContain(
      "N'écris PAS d'allures : ni `targetPaceSecPerKm` au niveau de la séance, ni `paceMinSecPerKm`/`paceMaxSecPerKm` dans les étapes.",
    );
    expect(system).toContain('Concentre-toi sur la structure');
    // Plus aucune injonction à ranger une allure dans un créneau : l'appli le
    // fait, et le prompt ne fait que dire lequel ira où.
    expect(system).not.toContain('Tes allures sont CALCULÉES, tu ne les choisis pas');
    expect(system).toContain('endurance fondamentale et sortie longue en [E]');
    expect(system).toContain('seuil en [T]');
    expect(system).toContain('VMA en [I]');
    expect(system).toContain('répétitions courtes en [R]');
    expect(system).toContain('récupérations sans cible');
  });

  it('interdit aussi l’allure écrite en toutes lettres dans le texte libre', () => {
    // Le champ n'est pas le seul chemin vers l'écran : « à 12:00/km » glissé dans
    // un titre ou une note s'affiche à côté de l'allure que l'appli a posée.
    expect(withRace[0].content).toContain(
      "Tu n'écris pas non plus d'allure en toutes lettres dans les titres, les consignes, les notes ou le résumé — l'affichage les porte déjà.",
    );
  });

  it('dit que le `kind` porte désormais l’allure, et rappelle son vocabulaire', () => {
    // C'est le seul champ dont dépend l'allure posée : un `kind` fantaisiste
    // n'est plus une coquetterie de rédaction, il change la séance courue.
    const system = withRace[0].content;

    expect(system).toContain("C'est le `kind` de la séance qui décide de son allure");
    expect(system).toContain('« Endurance fondamentale »');
    expect(system).toContain('« Répétitions »');
    expect(system).toContain("un libellé hors vocabulaire fera poser une allure d'endurance");
  });

  /**
   * L'ancre parasite, telle qu'elle a été diagnostiquée : le modèle calait ses
   * allures sur l'allure d'entraînement moyenne de l'athlète (lente) plutôt que
   * sur la table. Elle sort donc du contexte de ce régime — plus aucune allure
   * ne vient du modèle, elle n'y a plus aucun rôle.
   */
  it('retire du contexte l’allure moyenne des dernières sorties', () => {
    expect(withRace[1].content).not.toContain('Allure moyenne des dernières sorties');
    // Le reste du snapshot, lui, ne bouge pas : c'est lui qui cale les volumes.
    expect(withRace[1].content).toContain('CTL 52');
    expect(withRace[1].content).toContain('42,1 km');
  });

  /**
   * Le défaut constaté en production : les deux sections d'allures partaient
   * ensemble, avec une mention de préséance, et le modèle local suivait la
   * mauvaise — EF à 12:00/km quand la table calculée disait 5:56–6:32/km. Une
   * priorité entre consignes contradictoires ne se résout pas à cette taille de
   * modèle : il n'en voit plus qu'une.
   */
  it('supprime entièrement la section de dérivation : une seule source d’allures', () => {
    const system = withRace[0].content;

    expect(system).not.toContain('ALLURES CIBLES');
    expect(system).not.toContain('Référence = ');
    expect(system).not.toContain('récupération trottée : référence + 60 à 120 s/km');
    expect(system).not.toContain('seuil : référence − 30 à 45 s/km');
    // Plus de section à départager, donc plus de préséance à annoncer.
    expect(system).not.toContain('prime sur « ALLURES CIBLES »');
    // La consigne de repli par zones cardiaques ne concerne que le chemin sans
    // table : ici, toutes les allures sont calculées.
    expect(system).not.toContain("Si l'allure de référence est inconnue");
    // La table, elle, est bien là.
    expect(system).toContain('- T (seuil) : 4:57–5:11/km');
  });

  it('garde la table, mais pour ce qu’elle dit du niveau de l’athlète', () => {
    const system = withRace[0].content;

    // Elle ne prescrit plus rien ; elle situe l'athlète, et c'est ce qui doit
    // caler les distances et les durées des séances.
    expect(system).toContain("Cette table est là pour situer le niveau de l'athlète, pas pour être recopiée.");
    expect(system).toContain('allure course ou allure objectif en [M]');
  });

  it('garde hors des allures les consignes qui valent dans les deux régimes', () => {
    // Elles vivaient dans la section de dérivation mais portent sur le volume et
    // le format : les perdre avec elle changerait le plan produit.
    expect(withRace[0].content).toContain("Tu n'inventes jamais une valeur");
    expect(withRace[0].content).toContain('PROGRESSION DU VOLUME');
  });

  it('ne dit rien de tel sans chrono : les règles de dérivation restent le repli', () => {
    const messages = buildPlanMessages(
      REQUEST,
      { startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 },
      SNAPSHOT,
    );
    const system = messages[0].content;

    expect(system).not.toContain("posées par l'application");
    // Sans table, le modèle dérive encore ses allures — l'allure moyenne reste
    // donc dans le contexte, c'est la seule référence qu'il ait.
    expect(messages[1].content).toContain('Allure moyenne des dernières sorties : 5:24/km.');
    expect(system).toContain('ALLURES CIBLES — dérivées des seules données fournies');
    expect(system).toContain('seuil : référence − 30 à 45 s/km');
    expect(system).toContain('récupération trottée : référence + 60 à 120 s/km');
    expect(system).toContain("Si l'allure de référence est inconnue");
  });
});

describe('buildPlanUpdateMessages', () => {
  const window = { firstWeekStart: '2026-08-10', weeks: 2, firstWeekFromDay: 3 };
  const messages = buildPlanUpdateMessages(
    PLAN,
    [
      planSession({
        scheduledOn: '2026-08-13',
        kind: 'Seuil',
        title: '3 × 8 min',
        volumeM: 10_400,
        steps: THRESHOLD_STEPS,
      }),
      planSession({ scheduledOn: '2026-08-16', kind: 'Sortie longue', title: '16 km', durationS: 5_400 }),
      planSession({ scheduledOn: '2026-08-20', kind: 'Endurance', title: 'Footing', targetPaceSecPerKm: 330 }),
    ],
    window,
    '  je pars en déplacement la semaine prochaine  ',
  );

  it('annonce au modèle qu’il ne régénère que la suite', () => {
    expect(messages[0].content).toContain('semaines restantes');
    expect(messages[0].content).toContain('`settings`');
  });

  it('porte la même méthodologie que la génération, déroulés compris', () => {
    const system = messages[0].content;

    expect(system).toContain('coach de course à pied');
    expect(system).toContain('endurance fondamentale et sortie longue : référence + 0 à 15 s/km');
    expect(system).toContain('`steps` compris');
  });

  it('réaffiche le déroulé des séances à venir, pour qu’il se réécrive en connaissance de cause', () => {
    const user = messages[1].content;

    expect(user).toContain(
      '  déroulé : échauffement 900 s @ Z2 + 4 × (480 s @ 5:00–5:10/km + récup 120 s) + retour au calme 600 s',
    );
    // Une séance sans déroulé n'en invente pas un.
    expect(user).toContain('- dimanche : Sortie longue — 16 km (1 h 30)\n');
  });

  it('groupe les séances à venir par semaine et signale la semaine entamée', () => {
    const user = messages[1].content;

    expect(user).toContain('Semaine 1 (du lundi 10 août 2026, déjà entamée : à replanifier à partir du mercredi)');
    expect(user).toContain('- jeudi : Seuil — 3 × 8 min (10,4 km)');
    expect(user).toContain('- dimanche : Sortie longue — 16 km (1 h 30)');
    expect(user).toContain('Semaine 2 (du lundi 17 août 2026)');
    expect(user).toContain('- jeudi : Endurance — Footing (5:30/km)');
  });

  it('reprend l’instruction détourée', () => {
    expect(messages[1].content).toContain('« je pars en déplacement la semaine prochaine »');
  });

  it('réaffiche le niveau du plan et garde sa méthodologie à l’ajustement', () => {
    const advanced = buildPlanUpdateMessages({ ...PLAN, level: 'advanced' }, [], window, 'plus de seuil');

    expect(advanced[1].content).toContain('Niveau déclaré : confirmé.');
    expect(advanced[0].content).toContain("NIVEAU DE L'ATHLÈTE : CONFIRMÉ");
    expect(advanced[0].content).not.toContain("NIVEAU DE L'ATHLÈTE : INTERMÉDIAIRE");
  });

  it('ne dit rien du niveau d’un plan qui n’en porte pas', () => {
    // Plan antérieur au champ : on ne lui en suppose pas un, l'ajustement reste
    // sur la seule méthodologie générale.
    const legacy = buildPlanUpdateMessages({ ...PLAN, level: null }, [], window, 'plus de seuil');

    expect(legacy[1].content).not.toContain('Niveau déclaré');
    expect(legacy[0].content).not.toContain("NIVEAU DE L'ATHLÈTE");
    expect(legacy[0].content).toContain('coach de course à pied');
  });
});

describe('buildViolationsMessage', () => {
  it('liste les violations et redemande le plan complet', () => {
    const message = buildViolationsMessage(['Semaine 1 : trop de séances.']);

    expect(message).toContain('- Semaine 1 : trop de séances.');
    expect(message).toContain('Régénère le plan complet');
  });
});

/** Une anomalie Zod, telle que `chatCompletionJson` la porte sur son erreur. */
function issue(path: (string | number)[], message: string): AiOutputIssue {
  return { code: 'custom', path, message, input: undefined };
}

/** L'échec type : une étape sur les deux cent cinquante viole un invariant. */
const OFF_SCHEMA = new AiInvalidOutputError(
  'Sortie du coach IA hors schéma « training_plan ».',
  [
    issue(
      ['weeks', 0, 'sessions', 1, 'steps', 1, 'steps', 0],
      'une étape se mesure soit en distance, soit en durée — exactement une des deux.',
    ),
  ],
);

describe('buildSchemaIssuesMessage', () => {
  it('donne le chemin du champ fautif et son motif', () => {
    const message = buildSchemaIssuesMessage(OFF_SCHEMA.issues);

    expect(message).toContain('- weeks.0.sessions.1.steps.1.steps.0 : une étape se mesure');
    expect(message).toContain('Régénère le plan complet');
  });

  it('borne la liste : un modèle égaré produirait des centaines d’anomalies', () => {
    const message = buildSchemaIssuesMessage(
      Array.from({ length: 14 }, (_, index) => issue(['weeks', index], 'hors bornes.')),
    );

    expect(message.split('\n').filter((line) => line.startsWith('- weeks.'))).toHaveLength(10);
    expect(message).toContain('et 4 autres anomalies');
  });

  it("le dit autrement quand la réponse n'était même pas du JSON", () => {
    expect(buildSchemaIssuesMessage([])).toContain("n'était pas du JSON exploitable");
  });
});

describe('generatePlan', () => {
  it('écrit le plan quand la première génération est conforme', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    const plan = await generatePlan(REQUEST);

    // Une proposition, pas un plan en cours : c'est l'athlète qui l'active.
    expect(plan).toBe(DRAFT);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(chatCompletionJson.mock.calls[0][0].schemaName).toBe('training_plan');

    const input = dal.createDraftPlanWithSessions.mock.calls[0][0];
    expect(input.level).toBe('intermediate');
    // Sans date demandée, le plan démarre aujourd'hui (mardi 11 août) et sa
    // grille de jours ISO s'ancre sur le lundi 10.
    expect(input.startsOn).toBe('2026-08-11');
    expect(input.weeks).toBe(2);
    expect(input.raceDate).toBeNull();
    expect(input.summary).toBe('Deux semaines de reprise.');
    expect(input.sessions).toHaveLength(6);
    expect(input.sessions[0]).toMatchObject({ scheduledOn: '2026-08-11', volumeM: 8_000 });
    expect(input.sessions[5].scheduledOn).toBe('2026-08-23');
  });

  it('démarre le jour demandé et date les séances depuis le lundi de sa semaine', async () => {
    // Départ le jeudi 13 août : la première semaine ne porte que le jeudi et le
    // dimanche, la seconde est pleine.
    chatCompletionJson.mockResolvedValue({
      summary: 'Reprise en cours de semaine.',
      weeks: [PARTIAL_FIRST_WEEK, CONFORMING_WEEK],
    });

    await generatePlan({ ...REQUEST, startsOn: '2026-08-13' });

    const input = dal.createDraftPlanWithSessions.mock.calls[0][0];
    // Le plan stocke le jour réel du départ, pas l'ancre.
    expect(input.startsOn).toBe('2026-08-13');
    expect(input.weeks).toBe(2);
    expect(
      input.sessions.map((session: { scheduledOn: string }) => session.scheduledOn),
    ).toEqual(['2026-08-13', '2026-08-16', '2026-08-18', '2026-08-20', '2026-08-23']);
  });

  it('refuse une séance placée avant le départ sur une première semaine entamée', async () => {
    // Le modèle remplit la semaine entamée comme une semaine pleine : le mardi
    // et le jeudi sont derrière nous, ils lui sont renvoyés en violation.
    chatCompletionJson.mockResolvedValue({
      summary: 'x',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await expect(generatePlan({ ...REQUEST, startsOn: '2026-08-15' })).rejects.toThrow(
      AiInvalidOutputError,
    );

    expect(chatCompletionJson.mock.calls[1][0].messages[2].content).toContain(
      'aucune séance avant samedi',
    );
    expect(dal.createDraftPlanWithSessions).not.toHaveBeenCalled();
  });

  it("n'engage rien : ni rapprochement, ni publication au calendrier", async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan(REQUEST);

    // Une proposition ne pilote rien tant qu'elle n'est pas adoptée : rapprocher
    // ses séances des activités ou les publier sur la montre reviendrait à
    // l'imposer. Les deux effets partent de l'adoption (`_lib/actions.ts`).
    expect(dal.reconcilePlanSessions).not.toHaveBeenCalled();
    expect(syncPlanToIntervalsSafely).not.toHaveBeenCalled();
    expect(scheduleAfter).not.toHaveBeenCalled();
  });

  it('reprend une fois en renvoyant les violations, puis écrit le plan corrigé', async () => {
    chatCompletionJson
      .mockResolvedValueOnce({ summary: 'x', weeks: [BROKEN_WEEK, CONFORMING_WEEK] })
      .mockResolvedValueOnce({ summary: 'Corrigé.', weeks: [CONFORMING_WEEK, CONFORMING_WEEK] });

    await generatePlan(REQUEST);

    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    const retryMessages = chatCompletionJson.mock.calls[1][0].messages;
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[2].role).toBe('user');
    expect(retryMessages[2].content).toContain('aucune séance le dimanche');
    // La sortie fautive n'est pas renvoyée : elle coûterait le double de contexte.
    expect(retryMessages.some((message: { content: string }) => message.content.includes('"sessions"'))).toBe(false);
    expect(dal.createDraftPlanWithSessions).toHaveBeenCalledTimes(1);
  });

  it("renvoie au modèle une allure hors de portée de l'athlète, corridor à l'appui", async () => {
    chatCompletionJson
      .mockResolvedValueOnce({ summary: 'x', weeks: [ABERRANT_PACE_WEEK, CONFORMING_WEEK] })
      .mockResolvedValueOnce({ summary: 'Corrigé.', weeks: [CONFORMING_WEEK, CONFORMING_WEEK] });

    await expect(generatePlan(REQUEST)).resolves.toBe(DRAFT);

    // Le corridor est dérivé de l'allure récente du snapshot (5:24/km).
    expect(chatCompletionJson.mock.calls[1][0].messages[2].content).toContain(
      "allure 10:00/km hors de la fourchette plausible [3:34/km – 7:34/km] dérivée de l'allure récente de l'athlète (5:24/km).",
    );
  });

  it("ne juge aucune allure quand l'athlète n'a pas d'allure de référence", async () => {
    dal.getTrainingSnapshot.mockResolvedValue({ ...SNAPSHOT, recentAvgPaceSecPerKm: null });
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [ABERRANT_PACE_WEEK, CONFORMING_WEEK] });

    await expect(generatePlan(REQUEST)).resolves.toBe(DRAFT);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
  });

  it('reprend une sortie hors schéma en pointant le champ fautif, puis écrit le plan', async () => {
    chatCompletionJson
      .mockRejectedValueOnce(OFF_SCHEMA)
      .mockResolvedValueOnce({ summary: 'Corrigé.', weeks: [CONFORMING_WEEK, CONFORMING_WEEK] });

    await expect(generatePlan(REQUEST)).resolves.toBe(DRAFT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    const retryMessages = chatCompletionJson.mock.calls[1][0].messages;
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[2].role).toBe('user');
    // Le chemin désigne l'étape à reprendre : sans lui, le modèle regénère à
    // l'aveugle une sortie de plusieurs centaines d'étapes.
    expect(retryMessages[2].content).toContain('weeks.0.sessions.1.steps.1.steps.0');
    expect(dal.createDraftPlanWithSessions).toHaveBeenCalledTimes(1);
  });

  it('reprend jusqu’à deux fois avant de renoncer', async () => {
    chatCompletionJson
      .mockResolvedValueOnce({ summary: 'x', weeks: [BROKEN_WEEK, CONFORMING_WEEK] })
      .mockRejectedValueOnce(OFF_SCHEMA)
      .mockResolvedValueOnce({ summary: 'Corrigé.', weeks: [CONFORMING_WEEK, CONFORMING_WEEK] });

    await expect(generatePlan(REQUEST)).resolves.toBe(DRAFT);
    expect(chatCompletionJson).toHaveBeenCalledTimes(3);
  });

  it('renonce quand la sortie reste hors schéma après reprises', async () => {
    chatCompletionJson.mockRejectedValue(OFF_SCHEMA);

    await expect(generatePlan(REQUEST)).rejects.toBe(OFF_SCHEMA);
    expect(chatCompletionJson).toHaveBeenCalledTimes(3);
    expect(dal.createDraftPlanWithSessions).not.toHaveBeenCalled();
  });

  it("ne redemande rien quand c'est l'API qui est en défaut", async () => {
    // Une réponse HTTP cassée ne s'arrangera pas en reposant la question : elle
    // remonte au premier coup.
    chatCompletionJson.mockRejectedValue(new AiResponseError('502 Bad Gateway', 502));

    await expect(generatePlan(REQUEST)).rejects.toThrow(AiResponseError);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
  });

  it("renonce après trois échecs, en disant ce qui n'a pas été respecté", async () => {
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [BROKEN_WEEK, BROKEN_WEEK] });

    await expect(generatePlan(REQUEST)).rejects.toThrow(AiInvalidOutputError);
    expect(chatCompletionJson).toHaveBeenCalledTimes(3);
    expect(dal.createDraftPlanWithSessions).not.toHaveBeenCalled();
  });

  it('propage une indisponibilité du coach sans rien lire ni écrire', async () => {
    requireAi.mockRejectedValue(new AiUnavailableError('unreachable'));

    await expect(generatePlan(REQUEST)).rejects.toThrow(AiUnavailableError);
    expect(dal.getTrainingSnapshot).not.toHaveBeenCalled();
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  it('refuse une fenêtre invalide avant tout appel au modèle', async () => {
    await expect(generatePlan({ ...REQUEST, weeks: undefined })).rejects.toThrow(
      /durée en semaines/,
    );
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });
});

describe('generatePlan — chrono de référence', () => {
  it('écrit le chrono avec le plan, et impose sa table au modèle', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan({ ...REQUEST, referenceRace: REFERENCE_RACE });

    expect(chatCompletionJson.mock.calls[0][0].messages[0].content).toContain(
      'Chrono de référence : 10 km en 48:30 → VDOT 41,5.',
    );
    // Le chrono part en base avec le plan : c'est lui qui rejugera les allures
    // au prochain ajustement, et que l'écran du plan affiche.
    const input = dal.createDraftPlanWithSessions.mock.calls[0][0];
    expect(input.referenceDistance).toBe('10k');
    expect(input.referenceTimeS).toBe(2_910);
  });

  it('laisse les deux colonnes nulles quand aucun chrono n’est donné', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan(REQUEST);

    const input = dal.createDraftPlanWithSessions.mock.calls[0][0];
    expect(input.referenceDistance).toBeNull();
    expect(input.referenceTimeS).toBeNull();
  });

  it('refuse un chrono implausible avant d’appeler le modèle', async () => {
    // 5 km en 12 min : plus rapide que le record du monde. La table d'allures
    // calculée dessus serait aberrante — mieux vaut le dire tout de suite.
    await expect(
      generatePlan({ ...REQUEST, referenceRace: { distance: '5k', timeS: 720 } }),
    ).rejects.toThrow(/ne ressemble pas à une course/);

    expect(chatCompletionJson).not.toHaveBeenCalled();
    expect(dal.createDraftPlanWithSessions).not.toHaveBeenCalled();
  });

  /**
   * Le cas qui a fait basculer l'architecture : le modèle sort une allure
   * absurde, et la table existe. Avant, il fallait le lui renvoyer et
   * regénérer — trois fois de suite pour rien. Maintenant l'allure est écrasée,
   * la génération passe du premier coup, et le corridor n'a plus rien à dire.
   */
  it('écrase les allures du modèle au lieu de lui redemander un plan', async () => {
    const fastWeek = {
      sessions: [
        { day: 2, kind: 'Endurance', title: 'Footing', distanceKm: 8 },
        { day: 4, kind: 'VMA', title: '5 × 3 min', distanceKm: 10, targetPaceSecPerKm: 210, steps: THRESHOLD_STEPS },
        { day: 7, kind: 'Sortie longue', title: 'Endurance', distanceKm: 16 },
      ],
    };
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [fastWeek, CONFORMING_WEEK] });

    await expect(generatePlan({ ...REQUEST, referenceRace: REFERENCE_RACE })).resolves.toBe(DRAFT);

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);

    const [{ sessions }] = dal.createDraftPlanWithSessions.mock.calls[0];
    // VMA → milieu de [I] (4:28–4:39/km), et non les 3:30/km écrits ; footing et
    // sortie longue au milieu de [E] (5:56–6:32/km).
    expect(sessions[1]).toMatchObject({ kind: 'VMA', targetPaceSecPerKm: 274 });
    expect(sessions[0]).toMatchObject({ kind: 'Endurance', targetPaceSecPerKm: 374 });
    expect(sessions[2]).toMatchObject({ kind: 'Sortie longue', targetPaceSecPerKm: 374 });
  });

  it('écrit les allures des étapes selon leur rôle, la séance donnant le créneau', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'x',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan({ ...REQUEST, referenceRace: REFERENCE_RACE });

    const [{ sessions }] = dal.createDraftPlanWithSessions.mock.calls[0];
    const [warmup, block, cooldown] = sessions[1].steps;

    // L'échauffement du déroulé porte une `hrZone` : elle est conservée, et
    // aucune allure ne vient s'y ajouter (une étape ne porte jamais les deux).
    expect(warmup.steps[0]).toMatchObject({
      hrZone: 2,
      paceMinSecPerKm: null,
      paceMaxSecPerKm: null,
    });
    // L'effort d'une séance au seuil : les bornes de [T].
    expect(block.steps[0]).toMatchObject({ paceMinSecPerKm: 297, paceMaxSecPerKm: 311 });
    // Sa récupération : aucune cible.
    expect(block.steps[1]).toMatchObject({ paceMinSecPerKm: null, paceMaxSecPerKm: null });
    // Le retour au calme se court en endurance, pas au seuil.
    expect(cooldown.steps[0]).toMatchObject({ paceMinSecPerKm: 356, paceMaxSecPerKm: 392 });
  });

  it('laisse le modèle poser ses allures quand il n’y a pas de table', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'x',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan(REQUEST);

    const [{ sessions }] = dal.createDraftPlanWithSessions.mock.calls[0];
    // Sans chrono, rien n'est écrasé : le corridor dérivé de l'allure récente
    // reste le seul filet.
    expect(sessions[0].targetPaceSecPerKm).toBeNull();
    expect(sessions[1].steps[1].steps[0]).toMatchObject({
      paceMinSecPerKm: 300,
      paceMaxSecPerKm: 310,
    });
  });
});

describe('updatePlanFromInstruction — chrono de référence', () => {
  it('reprend le chrono du plan : un ajustement ne réinvente pas les allures', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: {
        ...PLAN,
        startsOn: '2026-08-10',
        weeks: 2,
        referenceDistance: '10k',
        referenceTimeS: 2_910,
      },
      sessions: [],
    });
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [
        { sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] },
        CONFORMING_WEEK,
      ],
    });

    await updatePlanFromInstruction('rien de spécial');

    expect(chatCompletionJson.mock.calls[0][0].messages[0].content).toContain(
      "ALLURES — calculées et posées par l'application, tu n'en écris AUCUNE",
    );
    expect(chatCompletionJson.mock.calls[0][0].messages[0].content).toContain(
      '- T (seuil) : 4:57–5:11/km',
    );

    // Et l'ajustement passe par le même post-traitement : la sortie longue
    // écrite sans allure ressort au milieu de [E].
    const [, { sessions }] = dal.applyPlanUpdate.mock.calls[0];
    expect(sessions[0]).toMatchObject({ kind: 'Sortie longue', targetPaceSecPerKm: 374 });
  });

  it('s’en passe sur un plan qui n’en porte pas', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: { ...PLAN, startsOn: '2026-08-10', weeks: 2 },
      sessions: [],
    });
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [
        { sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] },
        CONFORMING_WEEK,
      ],
    });

    await updatePlanFromInstruction('rien de spécial');

    expect(chatCompletionJson.mock.calls[0][0].messages[0].content).not.toContain(
      "posées par l'application",
    );
    // Rien n'est écrasé non plus : sans table, il n'y a rien à imposer.
    const [, { sessions }] = dal.applyPlanUpdate.mock.calls[0];
    expect(sessions[0].targetPaceSecPerKm).toBeNull();
  });
});

/**
 * Une génération qui échoue ne laisse à l'utilisatrice qu'un message générique :
 * ces logs sont le seul moyen de savoir, en production, sur quoi le modèle local
 * a buté. Les taire serait un bug.
 */
describe('journal des rejets', () => {
  it('dit le rang de la tentative, la nature du rejet et les violations', async () => {
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [BROKEN_WEEK, BROKEN_WEEK] });

    await expect(generatePlan(REQUEST)).rejects.toThrow(AiInvalidOutputError);

    const logged = loggedText();
    expect(logged).toContain('[plan] tentative 1/3 (training_plan) rejetée — violations métier');
    expect(logged).toContain('[plan] tentative 2/3 (training_plan) rejetée — violations métier');
    expect(logged).toContain('[plan] tentative 3/3 (training_plan) rejetée — violations métier');
    // Le détail exact renvoyé au modèle, pas un « erreur de validation ».
    expect(logged).toContain('aucune séance le dimanche');
    expect(logged).toContain('[plan] génération abandonnée après 3 tentatives');
  });

  it('dit les champs en défaut quand la sortie est hors schéma', async () => {
    chatCompletionJson.mockRejectedValue(OFF_SCHEMA);

    await expect(generatePlan(REQUEST)).rejects.toBe(OFF_SCHEMA);

    const logged = loggedText();
    expect(logged).toContain('[plan] tentative 1/3 (training_plan) rejetée — sortie hors schéma');
    expect(logged).toContain('weeks.0.sessions.1.steps.1.steps.0');
    expect(logged).toContain('[plan] génération abandonnée après 3 tentatives');
    // Le schéma a bien été violé sur le fond : rien ne laisse penser à une coupure.
    expect(logged).not.toContain('tronquée');
  });

  it('soupçonne une sortie tronquée quand la réponse n’était même pas du JSON', async () => {
    // Aucune anomalie Zod : `chatCompletionJson` n'a pas pu parser le contenu.
    chatCompletionJson.mockRejectedValue(
      new AiInvalidOutputError("Le coach IA n'a pas produit du JSON pour « training_plan ».", []),
    );

    await expect(generatePlan(REQUEST)).rejects.toThrow(AiInvalidOutputError);

    expect(loggedText()).toContain(
      'sortie hors schéma — sortie probablement tronquée (contexte plein ?)',
    );
  });

  it('journalise aussi les rejets d’un ajustement, sous son propre schéma', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: { ...PLAN, startsOn: '2026-08-10', weeks: 2 },
      sessions: [],
    });
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [BROKEN_WEEK, BROKEN_WEEK] });

    await expect(updatePlanFromInstruction('change tout')).rejects.toThrow(AiInvalidOutputError);

    expect(loggedText()).toContain('tentative 1/3 (training_plan_update) rejetée');
  });
});

describe('updatePlanFromInstruction', () => {
  /** Plan démarré le lundi 10 août : reprise demain (mercredi 12), 1 semaine entamée + 1. */
  const ACTIVE = {
    plan: { ...PLAN, startsOn: '2026-08-10', weeks: 2 },
    sessions: [
      planSession({ scheduledOn: '2026-08-10', id: 1, completedActivityId: 42 }),
      planSession({ scheduledOn: '2026-08-16', id: 2 }),
      planSession({ scheduledOn: '2026-08-20', id: 3 }),
    ],
  };

  it('régénère les semaines restantes et met à jour les réglages', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({
      summary: 'Semaine allégée.',
      settings: { sessionsPerWeek: 3 },
      weeks: [{ sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] }, CONFORMING_WEEK],
    });

    const plan = await updatePlanFromInstruction('allège la semaine');

    expect(plan).toBe(ACTIVE.plan);
    expect(chatCompletionJson.mock.calls[0][0].schemaName).toBe('training_plan_update');

    // Séances et réglages partent en un seul appel : le DAL les écrit dans la
    // même transaction.
    expect(dal.applyPlanUpdate).toHaveBeenCalledTimes(1);
    const [planId, update] = dal.applyPlanUpdate.mock.calls[0];
    expect(planId).toBe(3);
    expect(update.fromDate).toBe('2026-08-12');
    expect(update.sessions.map((session: { scheduledOn: string }) => session.scheduledOn)).toEqual([
      '2026-08-16',
      '2026-08-18',
      '2026-08-20',
      '2026-08-23',
    ]);

    // `sessionsPerWeek` est inchangé : seul le résumé part au DAL.
    expect(update.settings).toEqual({ summary: 'Semaine allégée.' });
  });

  it('rapproche les séances régénérées des activités déjà courues', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [{ sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] }, CONFORMING_WEEK],
    });

    await updatePlanFromInstruction('rien de spécial');

    expect(dal.reconcilePlanSessions).toHaveBeenCalledWith(ACTIVE.plan.id);
  });

  it('republie le plan ajusté au calendrier intervals.icu', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [{ sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] }, CONFORMING_WEEK],
    });

    await updatePlanFromInstruction('rien de spécial');

    expect(syncPlanToIntervalsSafely).toHaveBeenCalledWith(`plan ${ACTIVE.plan.id}`);
    // Différée elle aussi : un ajustement rend la main dès que la base est écrite.
    expect(scheduleAfter).toHaveBeenCalledTimes(1);
  });

  it("ajuste quand même le plan si le rapprochement échoue", async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [{ sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] }, CONFORMING_WEEK],
    });
    dal.reconcilePlanSessions.mockRejectedValue(new Error('deadlock detected'));

    await expect(updatePlanFromInstruction('rien de spécial')).resolves.toBe(ACTIVE.plan);
    expect(loggedText()).toContain('rapprochement des séances');
  });

  it('ne soumet au modèle que les séances à venir non réalisées', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [{ sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] }, CONFORMING_WEEK],
    });

    await updatePlanFromInstruction('rien de spécial');

    const user = chatCompletionJson.mock.calls[0][0].messages[1].content;
    expect(user).toContain('Semaine 1 (du lundi 10 août 2026, déjà entamée');
    expect(user).toContain('- dimanche : Endurance — Footing');
    expect(user).not.toContain('lundi : Endurance');
  });

  it('juge la sortie sur les réglages patchés par le modèle', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux séances désormais.',
      settings: { sessionsPerWeek: 2 },
      weeks: [
        { sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] },
        {
          sessions: [
            { day: 4, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10, steps: THRESHOLD_STEPS },
            { day: 7, kind: 'Sortie longue', title: '16 km', distanceKm: 16 },
          ],
        },
      ],
    });

    await updatePlanFromInstruction('plutôt 2 séances par semaine');

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(dal.applyPlanUpdate.mock.calls[0][1].settings).toEqual({
      summary: 'Deux séances désormais.',
      sessionsPerWeek: 2,
    });
  });

  it('reprend aussi sur une sortie hors schéma, comme à la génération', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockRejectedValueOnce(OFF_SCHEMA).mockResolvedValueOnce({
      summary: 'ok',
      weeks: [{ sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] }, CONFORMING_WEEK],
    });

    await expect(updatePlanFromInstruction('rien de spécial')).resolves.toBe(ACTIVE.plan);

    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    expect(chatCompletionJson.mock.calls[1][0].messages[2].content).toContain(
      'weeks.0.sessions.1.steps.1.steps.0',
    );
  });

  it("juge les allures réécrites sur l'allure récente de l'athlète", async () => {
    // Le prompt de modification ne porte pas le snapshot : le service le charge
    // pour ce seul contrôle, sans quoi un ajustement pourrait réintroduire les
    // allures aberrantes que la génération refuse.
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [
        { sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14, targetPaceSecPerKm: 600 }] },
        CONFORMING_WEEK,
      ],
    });

    await expect(updatePlanFromInstruction('rien de spécial')).rejects.toThrow(AiInvalidOutputError);

    expect(dal.getTrainingSnapshot).toHaveBeenCalled();
    expect(loggedText()).toContain(
      "allure 10:00/km hors de la fourchette plausible [3:34/km – 7:34/km] dérivée de l'allure récente de l'athlète (5:24/km).",
    );
    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
  });

  it('renonce après trois échecs sans rien écrire', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [BROKEN_WEEK, BROKEN_WEEK] });

    await expect(updatePlanFromInstruction('change tout')).rejects.toThrow(AiInvalidOutputError);
    expect(chatCompletionJson).toHaveBeenCalledTimes(3);
    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.reconcilePlanSessions).not.toHaveBeenCalled();
  });

  it("échoue proprement quand aucun plan n'est actif", async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(null);

    await expect(updatePlanFromInstruction('allège')).rejects.toThrow(PlanNotFoundError);
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  it('propage une indisponibilité du coach', async () => {
    requireAi.mockRejectedValue(new AiUnavailableError('unconfigured'));

    await expect(updatePlanFromInstruction('allège')).rejects.toThrow(AiUnavailableError);
    expect(dal.getActivePlanWithSessions).not.toHaveBeenCalled();
  });
});

/**
 * Le budget temps, jugé sur ce que la **sortie** déclare.
 *
 * La faille que ces tests ferment : « je peux courir 4 h par semaine
 * maintenant » fait patcher `settings.weeklyTimeMinutes` par le modèle, mais la
 * validation lisait le budget **stocké** — les semaines élargies étaient donc
 * déclarées en violation à chaque tentative, et l'ajustement condamné aux trois
 * échecs sans qu'aucune correction ne soit possible.
 */
describe('budget temps hebdomadaire', () => {
  /** Un plan de 2 h par semaine, démarré le lundi 10 : reprise demain (mercredi 12). */
  const ACTIVE_2H = {
    plan: { ...PLAN, startsOn: '2026-08-10', weeks: 2, weeklyTimeMinutes: 120 },
    sessions: [planSession({ scheduledOn: '2026-08-16', id: 2 })],
  };

  /**
   * La semaine entamée : une seule sortie, **dans** son budget au prorata.
   *
   * Le chiffre tient les deux fenêtres où cette fixture sert, et c'est
   * délibéré — sans quoi les tests ci-dessous constateraient une violation de la
   * semaine 2 pendant que la semaine 1 en produirait une autre, sans que rien ne
   * le dise (d'où les `not.toContain` qui les accompagnent) :
   *
   * - ajustement, reprise le mercredi 12 → 5 jours restants, 2 h ramenées à
   *   1 h 25 (1 h 34 tolérance comprise) ;
   * - génération, départ le jeudi 13 → 4 jours restants, 2 h ramenées à 1 h 08
   *   (1 h 15 tolérance comprise).
   */
  const PARTIAL_WEEK = {
    sessions: [
      { day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14, durationMin: 60 },
    ],
  };

  /** Une semaine pleine conforme, durées déclarées : 3 h 00 au total. */
  function timedWeek(durationsMin: [number, number, number]) {
    return {
      sessions: [
        { day: 2, kind: 'Endurance', title: 'Footing', distanceKm: 8, durationMin: durationsMin[0] },
        {
          day: 4,
          kind: 'Seuil',
          title: '3 × 8 min',
          distanceKm: 10,
          durationMin: durationsMin[1],
          steps: THRESHOLD_STEPS,
        },
        {
          day: 7,
          kind: 'Sortie longue',
          title: 'Endurance',
          distanceKm: 16,
          durationMin: durationsMin[2],
        },
      ],
    };
  }

  /** 3 h 00 sur la semaine pleine : au-dessus des 2 h du plan, sous 4 h. */
  const THREE_HOURS_WEEK = timedWeek([45, 55, 80]);

  it("juge l'ajustement sur le budget que la sortie déclare, pas sur celui du plan", async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE_2H);
    chatCompletionJson.mockResolvedValue({
      summary: 'Quatre heures par semaine désormais.',
      settings: { weeklyTimeMinutes: 240 },
      weeks: [PARTIAL_WEEK, THREE_HOURS_WEEK],
    });

    await updatePlanFromInstruction('je peux courir 4 h par semaine maintenant');

    // Une seule tentative : 3 h tiennent dans les 4 h que l'instruction déclare.
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(dal.applyPlanUpdate.mock.calls[0][1].settings).toEqual({
      summary: 'Quatre heures par semaine désormais.',
      weeklyTimeMinutes: 240,
    });
  });

  it('retombe sur le budget du plan quand la sortie ne porte pas de réglages', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE_2H);
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [PARTIAL_WEEK, THREE_HOURS_WEEK],
    });

    await expect(updatePlanFromInstruction('rien de spécial')).rejects.toThrow(
      AiInvalidOutputError,
    );

    expect(loggedText()).toContain(
      "Semaine 2 : 3 h 00 d'entraînement pour un budget déclaré de 2 h 00 — " +
        'réduis distances ou séances (2 h 12 au plus, tolérance comprise).',
    );
    // La semaine entamée, elle, tient dans son prorata : une violation de plus
    // passerait inaperçue d'un `toContain`, et ferait juger cette fixture sur un
    // manquement qu'elle n'est pas censée porter.
    expect(loggedText()).not.toContain('déjà entamée');
    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
  });

  it('ne contrôle plus rien quand la sortie efface le budget', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE_2H);
    chatCompletionJson.mockResolvedValue({
      summary: "Plus de contrainte d'horaire.",
      settings: { weeklyTimeMinutes: null },
      weeks: [PARTIAL_WEEK, timedWeek([120, 120, 160])],
    });

    await updatePlanFromInstruction("je n'ai plus de contrainte de temps");

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    // Le budget effacé part en base : la sortie est jugée sur la contrainte
    // qu'elle fait enregistrer, jamais sur une autre.
    expect(dal.applyPlanUpdate.mock.calls[0][1].settings).toEqual({
      summary: "Plus de contrainte d'horaire.",
      weeklyTimeMinutes: null,
    });
  });

  it('juge la génération sur le budget de la requête', async () => {
    // Une création ne porte pas de réglages : rien dans sa sortie ne peut
    // déplacer le budget que le formulaire a déclaré.
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [PARTIAL_WEEK, THREE_HOURS_WEEK] });

    // Départ le jeudi 13 : première semaine entamée, puis une semaine pleine.
    await expect(
      generatePlan({ ...REQUEST, weeklyTimeMinutes: 120, startsOn: '2026-08-13' }),
    ).rejects.toThrow(AiInvalidOutputError);

    expect(loggedText()).toContain(
      "Semaine 2 : 3 h 00 d'entraînement pour un budget déclaré de 2 h 00",
    );
    expect(loggedText()).not.toContain('déjà entamée');
    expect(dal.createDraftPlanWithSessions).not.toHaveBeenCalled();
  });

  it('exempte du budget une semaine entamée de moins de quatre jours', async () => {
    // Le défaut constaté : un ajustement lancé le samedi reprend le dimanche, et
    // les 2 h se prorataient en 17 min — alors que la règle de sortie longue
    // exige une sortie longue ce dimanche-là. Aucune semaine n'était
    // satisfaisable, et les trois tentatives étaient perdues d'avance.
    vi.setSystemTime(new Date('2026-08-15T09:00:00.000Z'));
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE_2H);
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [
        {
          sessions: [
            { day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14, durationMin: 85 },
          ],
        },
        timedWeek([25, 25, 42]),
      ],
    });

    await updatePlanFromInstruction('rien de spécial');

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(dal.applyPlanUpdate).toHaveBeenCalled();
  });
});

describe("estimatePlanChars — calibrage de l'estimation", () => {
  /*
   * La fixture qui étalonne `CHARS_PER_SESSION`.
   *
   * Ces séances ne servent aucune règle métier : elles ne sont là que pour être
   * **pesées**. Elles suivent `COACH_RULES` au pied de la lettre — `steps`
   * obligatoire sur une séance de qualité (échauffement, blocs répétés portant
   * leur récupération, retour au calme), allures aux deux bornes, distance et
   * durée déclarées au niveau de la séance — parce que c'est cette sortie-là que
   * le modèle écrit, et donc celle dont le pourcentage mesure l'avancement.
   */

  /** Séance de qualité au seuil : 3 blocs, dont un répété 3 fois. */
  const THRESHOLD = {
    day: 2,
    kind: 'Seuil',
    title: '3 × 10 min au seuil',
    targetPaceSecPerKm: 255,
    distanceKm: 13,
    durationMin: 68,
    steps: [
      { steps: [{ role: 'warmup', durationS: 900, paceMinSecPerKm: 330, paceMaxSecPerKm: 345 }] },
      {
        repeat: 3,
        steps: [
          { role: 'run', durationS: 600, paceMinSecPerKm: 250, paceMaxSecPerKm: 260 },
          { role: 'recover', durationS: 120, paceMinSecPerKm: 390, paceMaxSecPerKm: 420 },
        ],
      },
      { steps: [{ role: 'cooldown', durationS: 600, paceMinSecPerKm: 345, paceMaxSecPerKm: 360 }] },
    ],
  };

  /** Séance de VMA : même forme, 5 répétitions plus courtes. */
  const INTERVALS = {
    day: 4,
    kind: 'VMA',
    title: '5 × 3 min à VMA',
    targetPaceSecPerKm: 240,
    distanceKm: 12,
    durationMin: 60,
    steps: [
      { steps: [{ role: 'warmup', durationS: 1200, paceMinSecPerKm: 330, paceMaxSecPerKm: 345 }] },
      {
        repeat: 5,
        steps: [
          { role: 'run', durationS: 180, paceMinSecPerKm: 225, paceMaxSecPerKm: 235 },
          { role: 'recover', durationS: 180, paceMinSecPerKm: 400, paceMaxSecPerKm: 430 },
        ],
      },
      { steps: [{ role: 'cooldown', durationS: 600, paceMinSecPerKm: 345, paceMaxSecPerKm: 360 }] },
    ],
  };

  const EASY = {
    day: 3,
    kind: 'Endurance fondamentale',
    title: 'Footing 10 km',
    targetPaceSecPerKm: 335,
    distanceKm: 10,
    durationMin: 56,
  };

  const SECOND_EASY = {
    day: 5,
    kind: 'Endurance fondamentale',
    title: 'Footing 8 km',
    targetPaceSecPerKm: 335,
    distanceKm: 8,
    durationMin: 45,
  };

  const LONG_RUN = {
    day: 7,
    kind: 'Sortie longue',
    title: '18 km en endurance',
    targetPaceSecPerKm: 340,
    distanceKm: 18,
    durationMin: 102,
  };

  /** Un résumé de 4 phrases, au milieu des 3 à 5 que la méthodologie demande. */
  const SUMMARY =
    'Bloc de 12 semaines vers le semi-marathon : quatre séances par semaine, une ' +
    'séance de seuil et une séance de VMA en alternance, la sortie longue le ' +
    'dimanche. Le volume monte progressivement de 38 à 58 km, avec une semaine ' +
    'allégée toutes les trois semaines. Les allures sont calées sur ton allure ' +
    'moyenne récente, pas sur un modèle générique. Point de vigilance : ta charge ' +
    'récente est basse, la première semaine reste volontairement conservatrice.';

  /** Ce que le modèle écrit vraiment : le plan sérialisé en JSON compact. */
  function serializedPlanChars(sessions: unknown[], weeks: number): number {
    return JSON.stringify({
      summary: SUMMARY,
      weeks: Array.from({ length: weeks }, () => ({ sessions })),
    }).length;
  }

  // Au plus 2 séances de qualité par semaine, quel que soit le nombre de
  // séances : c'est ce plafond méthodologique qui fait varier le poids moyen
  // d'une séance d'une configuration à l'autre.
  const WEEKS = [
    { label: '3 séances, 1 qualité', sessions: [THRESHOLD, EASY, LONG_RUN] },
    { label: '4 séances, 2 qualité', sessions: [THRESHOLD, INTERVALS, EASY, LONG_RUN] },
    { label: '5 séances, 2 qualité', sessions: [THRESHOLD, INTERVALS, EASY, SECOND_EASY, LONG_RUN] },
  ];

  it.each(WEEKS)('tient à un quart près de la sortie réelle — $label', ({ sessions }) => {
    // La borne qui compte vraiment. En dessous, la barre saturerait à 99 % bien
    // avant la fin ; au-dessus, elle terminerait loin du compte. ±25 % est le
    // pire écart que le calibrage laisse passer, et il reste invisible à l'œil
    // sur une barre.
    const real = serializedPlanChars(sessions, 12);
    const estimated = estimatePlanChars(12, sessions.length);

    expect(estimated / real).toBeGreaterThan(0.75);
    expect(estimated / real).toBeLessThan(1.25);
  });

  it('croît avec les semaines et avec les séances', () => {
    expect(estimatePlanChars(8, 4)).toBeGreaterThan(estimatePlanChars(4, 4));
    expect(estimatePlanChars(8, 5)).toBeGreaterThan(estimatePlanChars(8, 4));
  });

  it("compte chaque séance dans l'ordre de grandeur d'une séance écrite", () => {
    // La marge d'une séance de plus reste bornée par les deux extrêmes mesurés :
    // un footing sans déroulé, et une séance de qualité avec le sien.
    const marginal = estimatePlanChars(1, 4) - estimatePlanChars(1, 3);

    expect(marginal).toBeGreaterThanOrEqual(JSON.stringify(EASY).length);
    expect(marginal).toBeLessThanOrEqual(JSON.stringify(THRESHOLD).length);
  });

  it('reste positif sur le plus petit plan possible', () => {
    expect(estimatePlanChars(1, 1)).toBeGreaterThan(0);
  });
});

describe('planProgressPercent', () => {
  it('rend la part reçue de la sortie attendue', () => {
    expect(planProgressPercent(0, 1_000)).toBe(0);
    expect(planProgressPercent(425, 1_000)).toBe(43);
  });

  it("ne dépasse jamais 99 % — la génération n'est finie qu'une fois validée", () => {
    expect(planProgressPercent(1_000, 1_000)).toBe(99);
    expect(planProgressPercent(9_000, 1_000)).toBe(99);
  });
});

describe('progression de la génération', () => {
  const PROGRESS_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

  /** Ce que `chatCompletionJson` reçoit, réduit à ce que ces tests consomment. */
  type JsonCall = { onProgress?: (receivedChars: number) => void };

  /**
   * Le plan attendu par `REQUEST` : deux semaines de trois séances. Son
   * estimation sert d'échelle aux pourcentages ci-dessous.
   */
  const ESTIMATED = estimatePlanChars(2, 3);

  it('alimente le registre au fil du flux, puis efface son entrée', async () => {
    const seen: (PlanProgress | null)[] = [];
    chatCompletionJson.mockImplementation(async (options: JsonCall) => {
      seen.push(getPlanProgress(PROGRESS_ID));
      options.onProgress?.(Math.round(ESTIMATED / 4));
      seen.push(getPlanProgress(PROGRESS_ID));
      options.onProgress?.(Math.round(ESTIMATED / 2));
      seen.push(getPlanProgress(PROGRESS_ID));
      return { summary: 'Deux semaines de reprise.', weeks: [CONFORMING_WEEK, CONFORMING_WEEK] };
    });

    await generatePlan(REQUEST, PROGRESS_ID);

    // Une entrée existe dès avant le premier chunk : la barre apparaît sans
    // attendre que le modèle ait écrit quoi que ce soit.
    expect(seen.map((progress) => progress?.percent)).toEqual([0, 25, 50]);
    expect(seen[2]).toMatchObject({ attempt: 1, maxAttempts: 3 });
    // Effacée en `finally` : plus rien à lire une fois le plan écrit.
    expect(getPlanProgress(PROGRESS_ID)).toBeNull();
  });

  it('remet le pourcentage à zéro et compte la tentative à chaque reprise', async () => {
    const attempts: (PlanProgress | null)[] = [];
    chatCompletionJson
      .mockImplementationOnce(async (options: JsonCall) => {
        attempts.push(getPlanProgress(PROGRESS_ID));
        options.onProgress?.(ESTIMATED);
        return { summary: 'x', weeks: [BROKEN_WEEK, CONFORMING_WEEK] };
      })
      .mockImplementationOnce(async (options: JsonCall) => {
        // La reprise réécrit le plan complet : laisser la barre à 99 % pendant
        // toute la seconde génération serait un mensonge.
        attempts.push(getPlanProgress(PROGRESS_ID));
        options.onProgress?.(Math.round(ESTIMATED / 10));
        attempts.push(getPlanProgress(PROGRESS_ID));
        return { summary: 'Corrigé.', weeks: [CONFORMING_WEEK, CONFORMING_WEEK] };
      });

    await generatePlan(REQUEST, PROGRESS_ID);

    expect(attempts[0]).toMatchObject({ percent: 0, attempt: 1, maxAttempts: 3 });
    expect(attempts[1]).toMatchObject({ percent: 0, attempt: 2, maxAttempts: 3 });
    expect(attempts[2]).toMatchObject({ percent: 10, attempt: 2 });
  });

  it("efface l'entrée même quand la génération échoue", async () => {
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [BROKEN_WEEK, BROKEN_WEEK] });

    await expect(generatePlan(REQUEST, PROGRESS_ID)).rejects.toThrow(AiInvalidOutputError);

    expect(getPlanProgress(PROGRESS_ID)).toBeNull();
  });

  it('suit aussi un ajustement de plan', async () => {
    // Le plan actif du bloc « updatePlanFromInstruction » : deux semaines, dont
    // la première est déjà entamée (reprise à partir de demain).
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: { ...PLAN, startsOn: '2026-08-10', weeks: 2 },
      sessions: [],
    });
    let during: PlanProgress | null = null;
    chatCompletionJson.mockImplementation(async (options: JsonCall) => {
      options.onProgress?.(1_000);
      during = getPlanProgress(PROGRESS_ID);
      return {
        summary: 'Ajusté.',
        weeks: [
          { sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] },
          CONFORMING_WEEK,
        ],
      };
    });

    await updatePlanFromInstruction('allège la semaine prochaine', PROGRESS_ID);

    expect(during).toMatchObject({ attempt: 1, maxAttempts: 3 });
    expect(getPlanProgress(PROGRESS_ID)).toBeNull();
  });

  /**
   * Le maillon le plus fragile de la chaîne « modale → action → service →
   * registre → route » est le premier : l'identifiant est tiré par le
   * navigateur et joint au `FormData`, et l'action l'écarte sans bruit s'il
   * n'est pas un UUID. Une attente muette ne disait pas lequel avait lâché.
   */
  it('journalise que la génération est suivie, avec le début de l’identifiant', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan(REQUEST, PROGRESS_ID);

    expect(textOf(consoleInfo)).toContain('[plan] progression suivie (id a1b2c3d4)');
    // L'identifiant complet ne part pas au journal : huit caractères suffisent
    // à rapprocher la ligne des requêtes `/api/plan-progress`.
    expect(textOf(consoleInfo)).not.toContain(PROGRESS_ID);
  });

  it('journalise aussi une génération non suivie : le silence était le problème', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan(REQUEST);

    expect(textOf(consoleInfo)).toContain('[plan] génération sans suivi de progression');
  });

  it('journalise de la même façon un ajustement', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: { ...PLAN, startsOn: '2026-08-10', weeks: 2 },
      sessions: [],
    });
    chatCompletionJson.mockResolvedValue({
      summary: 'Ajusté.',
      weeks: [
        { sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] },
        CONFORMING_WEEK,
      ],
    });

    await updatePlanFromInstruction('allège la semaine prochaine', PROGRESS_ID);

    expect(textOf(consoleInfo)).toContain('[plan] progression suivie (id a1b2c3d4)');
  });

  it('ne streame pas et ne suit rien sans identifiant', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan(REQUEST);

    // Sans callback, `client.ts` reste en mode non-streamé : rien ne change pour
    // les appelants qui n'affichent pas de progression.
    expect(chatCompletionJson.mock.calls[0][0].onProgress).toBeUndefined();
  });
});
