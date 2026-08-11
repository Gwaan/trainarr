import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { TrainingSnapshotDto } from '@/data/coach-context';
import type { PlanDto, PlanSessionDto } from '@/data/plans';
import type { PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

import { AiInvalidOutputError, AiResponseError, AiUnavailableError, type AiOutputIssue } from './errors';
import {
  MAX_PLAN_WEEKS,
  MIN_RACE_PLAN_WEEKS,
  buildPlanMessages,
  buildPlanUpdateMessages,
  buildSchemaIssuesMessage,
  buildViolationsMessage,
  generatePlan,
  nextPlanStart,
  planWindow,
  remainingPlanWindow,
  updatePlanFromInstruction,
  type PlanRequest,
} from './plan-service';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { chatCompletionJson } = vi.hoisted(() => ({ chatCompletionJson: vi.fn() }));
const { requireAi } = vi.hoisted(() => ({ requireAi: vi.fn() }));
const { dal } = vi.hoisted(() => ({
  dal: {
    getTrainingSnapshot: vi.fn(),
    createPlanWithSessions: vi.fn(),
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
    createPlanWithSessions: dal.createPlanWithSessions,
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
  goalText: '10 km sous 50 min',
  raceDate: '2026-09-13',
  startsOn: '2026-08-03',
  weeks: 6,
  sessionsPerWeek: 3,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  summary: 'Bloc de 6 semaines.',
  createdAt: '2026-08-01T10:00:00.000Z',
};

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

const REQUEST: PlanRequest = {
  goalType: 'free',
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

/** Tout ce qui est parti dans `console.error`, en un seul texte. */
function loggedText(): string {
  return consoleError.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

beforeEach(() => {
  vi.useFakeTimers();
  // Un mardi : le prochain lundi est le 17 août 2026.
  vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  requireAi.mockResolvedValue(undefined);
  dal.getTrainingSnapshot.mockResolvedValue(SNAPSHOT);
  dal.createPlanWithSessions.mockResolvedValue(PLAN);
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

describe('nextPlanStart', () => {
  it('démarre le lundi suivant', () => {
    expect(nextPlanStart('2026-08-11')).toBe('2026-08-17');
    expect(nextPlanStart('2026-08-16')).toBe('2026-08-17');
  });

  it('démarre le jour même quand on est déjà lundi', () => {
    expect(nextPlanStart('2026-08-17')).toBe('2026-08-17');
  });
});

describe('planWindow', () => {
  it("déduit la durée de la date de course, jour de course compris", () => {
    // Du lundi 17 août au dimanche 13 septembre : 4 semaines pleines.
    expect(planWindow({ ...REQUEST, goalType: 'race', raceDate: '2026-09-13' }, '2026-08-11')).toEqual(
      { startsOn: '2026-08-17', weeks: 4 },
    );
    // Course un lundi : la semaine qui la porte compte quand même.
    expect(planWindow({ ...REQUEST, goalType: 'race', raceDate: '2026-09-14' }, '2026-08-11')).toEqual(
      { startsOn: '2026-08-17', weeks: 5 },
    );
  });

  it('refuse une course trop proche pour être périodisée', () => {
    expect(() =>
      planWindow({ ...REQUEST, goalType: 'race', raceDate: '2026-08-30' }, '2026-08-11'),
    ).toThrow(new RegExp(`moins de ${MIN_RACE_PLAN_WEEKS} semaines`));
  });

  it('refuse une course trop lointaine pour tenir dans un plan', () => {
    // Le plan démarre le lundi 17 août 2026 : sa 52e semaine finit le 15 août
    // 2027. Un jour de plus et la fenêtre déborde — la tronquer produirait un
    // plan qui s'arrête avant la course qu'il prépare.
    expect(
      planWindow({ ...REQUEST, goalType: 'race', raceDate: '2027-08-15' }, '2026-08-11').weeks,
    ).toBe(MAX_PLAN_WEEKS);

    expect(() =>
      planWindow({ ...REQUEST, goalType: 'race', raceDate: '2027-08-16' }, '2026-08-11'),
    ).toThrow(new RegExp(`Course trop lointaine.*${MAX_PLAN_WEEKS} au plus`));
  });

  it('refuse un objectif course sans date exploitable', () => {
    expect(() => planWindow({ ...REQUEST, goalType: 'race' }, '2026-08-11')).toThrow(
      /date de la course/,
    );
    expect(() =>
      planWindow({ ...REQUEST, goalType: 'race', raceDate: '2026-02-31' }, '2026-08-11'),
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
        weeks: 2,
      });
    });

    it('recompte les semaines d’une course depuis ce lundi-là', () => {
      const race = { ...REQUEST, goalType: 'race', raceDate: '2026-09-27' } as const;

      // Départ par défaut (lundi 17 août) : 6 semaines jusqu'à la course.
      expect(planWindow(race, '2026-08-11').weeks).toBe(6);
      // Départ repoussé de deux semaines : le plan raccourcit d'autant.
      expect(planWindow({ ...race, startsOn: '2026-08-31' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-31',
        weeks: 4,
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

    it('garde le prochain lundi quand rien n’est demandé', () => {
      expect(planWindow(REQUEST, '2026-08-11').startsOn).toBe('2026-08-17');
      expect(planWindow({ ...REQUEST, startsOn: undefined }, '2026-08-11').startsOn).toBe(
        '2026-08-17',
      );
    });

    it('refuse un démarrage passé', () => {
      expect(() => planWindow({ ...REQUEST, startsOn: '2026-08-10' }, '2026-08-11')).toThrow(
        /ne peut pas démarrer dans le passé/,
      );
    });

    it("refuse un jour qui n'est pas un lundi — le jour des séances est un jour ISO", () => {
      expect(() => planWindow({ ...REQUEST, startsOn: '2026-08-19' }, '2026-08-11')).toThrow(
        /démarre un lundi/,
      );
    });

    it('refuse une date inexploitable', () => {
      expect(() => planWindow({ ...REQUEST, startsOn: '2026-02-31' }, '2026-08-11')).toThrow(
        /AAAA-MM-JJ/,
      );
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

  it('refuse de régénérer un plan arrivé à son terme', () => {
    expect(() => remainingPlanWindow({ startsOn: '2026-08-03', weeks: 1 }, '2026-08-12')).toThrow(
      /arrivé à son terme/,
    );
  });
});

describe('buildPlanMessages', () => {
  const messages = buildPlanMessages(
    { ...REQUEST, goalType: 'race', goalText: '10 km sous 50 min', raceDate: '2026-09-13', weeklyTimeMinutes: 300 },
    { startsOn: '2026-08-17', weeks: 4 },
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
    expect(system).toContain('25 à 30 %');
    expect(system).toContain('Affûtage');
    expect(system).toContain('10 à 14 jours');
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

    expect(plan).toBe(PLAN);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(chatCompletionJson.mock.calls[0][0].schemaName).toBe('training_plan');

    const input = dal.createPlanWithSessions.mock.calls[0][0];
    expect(input.startsOn).toBe('2026-08-17');
    expect(input.weeks).toBe(2);
    expect(input.raceDate).toBeNull();
    expect(input.summary).toBe('Deux semaines de reprise.');
    expect(input.sessions).toHaveLength(6);
    expect(input.sessions[0]).toMatchObject({ scheduledOn: '2026-08-18', volumeM: 8_000 });
    expect(input.sessions[5].scheduledOn).toBe('2026-08-30');
  });

  it('rapproche le plan écrit des activités déjà en base', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan(REQUEST);

    expect(dal.reconcilePlanSessions).toHaveBeenCalledWith(PLAN.id);
  });

  it('publie le plan écrit au calendrier intervals.icu, hors du fil de la requête', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });

    await generatePlan(REQUEST);

    expect(syncPlanToIntervalsSafely).toHaveBeenCalledWith(`plan ${PLAN.id}`);
    // Par `after` : une API injoignable ne doit pas ajouter ses délais de garde
    // au temps d'attente de l'utilisatrice.
    expect(scheduleAfter).toHaveBeenCalledTimes(1);
  });

  it("n'attend pas la synchronisation du calendrier pour rendre le plan", async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });
    // La tâche différée n'est pas exécutée : le plan doit sortir quand même.
    scheduleAfter.mockImplementation(() => {});

    await expect(generatePlan(REQUEST)).resolves.toBe(PLAN);
    expect(syncPlanToIntervalsSafely).not.toHaveBeenCalled();
  });

  it('rend quand même le plan quand le rapprochement échoue', async () => {
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });
    dal.reconcilePlanSessions.mockRejectedValue(new Error('deadlock detected'));

    // Le plan est écrit et valide : un rapprochement raté ne l'annule pas, il se
    // journalise.
    await expect(generatePlan(REQUEST)).resolves.toBe(PLAN);
    expect(loggedText()).toContain('rapprochement des séances');
    // Et le calendrier est quand même synchronisé : les deux effets de bord sont
    // indépendants.
    expect(syncPlanToIntervalsSafely).toHaveBeenCalled();
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
    expect(dal.createPlanWithSessions).toHaveBeenCalledTimes(1);
  });

  it('reprend une sortie hors schéma en pointant le champ fautif, puis écrit le plan', async () => {
    chatCompletionJson
      .mockRejectedValueOnce(OFF_SCHEMA)
      .mockResolvedValueOnce({ summary: 'Corrigé.', weeks: [CONFORMING_WEEK, CONFORMING_WEEK] });

    await expect(generatePlan(REQUEST)).resolves.toBe(PLAN);

    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    const retryMessages = chatCompletionJson.mock.calls[1][0].messages;
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[2].role).toBe('user');
    // Le chemin désigne l'étape à reprendre : sans lui, le modèle regénère à
    // l'aveugle une sortie de plusieurs centaines d'étapes.
    expect(retryMessages[2].content).toContain('weeks.0.sessions.1.steps.1.steps.0');
    expect(dal.createPlanWithSessions).toHaveBeenCalledTimes(1);
  });

  it('reprend jusqu’à deux fois avant de renoncer', async () => {
    chatCompletionJson
      .mockResolvedValueOnce({ summary: 'x', weeks: [BROKEN_WEEK, CONFORMING_WEEK] })
      .mockRejectedValueOnce(OFF_SCHEMA)
      .mockResolvedValueOnce({ summary: 'Corrigé.', weeks: [CONFORMING_WEEK, CONFORMING_WEEK] });

    await expect(generatePlan(REQUEST)).resolves.toBe(PLAN);
    expect(chatCompletionJson).toHaveBeenCalledTimes(3);
  });

  it('renonce quand la sortie reste hors schéma après reprises', async () => {
    chatCompletionJson.mockRejectedValue(OFF_SCHEMA);

    await expect(generatePlan(REQUEST)).rejects.toBe(OFF_SCHEMA);
    expect(chatCompletionJson).toHaveBeenCalledTimes(3);
    expect(dal.createPlanWithSessions).not.toHaveBeenCalled();
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
    expect(dal.createPlanWithSessions).not.toHaveBeenCalled();
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

    await expect(updatePlanFromInstruction('allège')).rejects.toThrow(
      /Aucun plan actif ne correspond/,
    );
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  it('propage une indisponibilité du coach', async () => {
    requireAi.mockRejectedValue(new AiUnavailableError('unconfigured'));

    await expect(updatePlanFromInstruction('allège')).rejects.toThrow(AiUnavailableError);
    expect(dal.getActivePlanWithSessions).not.toHaveBeenCalled();
  });
});
