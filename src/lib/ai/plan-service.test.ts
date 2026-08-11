import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrainingSnapshotDto } from '@/data/coach-context';
import type { PlanDto, PlanSessionDto } from '@/data/plans';

import { AiInvalidOutputError, AiUnavailableError } from './errors';
import {
  MAX_PLAN_WEEKS,
  MIN_RACE_PLAN_WEEKS,
  buildPlanMessages,
  buildPlanUpdateMessages,
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

vi.mock('./client', () => ({ chatCompletionJson }));
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
    completedActivityId: null,
    ...overrides,
  };
}

const REQUEST: PlanRequest = {
  goalType: 'free',
  goalText: 'reprendre le volume',
  weeks: 2,
  sessionsPerWeek: 3,
  longRunDay: 7,
};

/** Une semaine conforme : 3 séances, la plus longue le dimanche. */
const CONFORMING_WEEK = {
  sessions: [
    { day: 2, kind: 'Endurance', title: 'Footing', distanceKm: 8 },
    { day: 4, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10 },
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

beforeEach(() => {
  vi.useFakeTimers();
  // Un mardi : le prochain lundi est le 17 août 2026.
  vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));
  vi.clearAllMocks();
  requireAi.mockResolvedValue(undefined);
  dal.getTrainingSnapshot.mockResolvedValue(SNAPSHOT);
  dal.createPlanWithSessions.mockResolvedValue(PLAN);
  dal.getActivePlanWithSessions.mockResolvedValue({ plan: PLAN, sessions: [] });
  dal.applyPlanUpdate.mockResolvedValue(undefined);
  dal.reconcilePlanSessions.mockResolvedValue(0);
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
      planSession({ scheduledOn: '2026-08-13', kind: 'Seuil', title: '3 × 8 min', volumeM: 10_400 }),
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

  it('rend quand même le plan quand le rapprochement échoue', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    chatCompletionJson.mockResolvedValue({
      summary: 'Deux semaines de reprise.',
      weeks: [CONFORMING_WEEK, CONFORMING_WEEK],
    });
    dal.reconcilePlanSessions.mockRejectedValue(new Error('deadlock detected'));

    // Le plan est écrit et valide : un rapprochement raté ne l'annule pas, il se
    // journalise.
    await expect(generatePlan(REQUEST)).resolves.toBe(PLAN);
    expect(logged).toHaveBeenCalled();
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

  it("renonce après un second échec, en disant ce qui n'a pas été respecté", async () => {
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [BROKEN_WEEK, BROKEN_WEEK] });

    await expect(generatePlan(REQUEST)).rejects.toThrow(AiInvalidOutputError);
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
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

  it("ajuste quand même le plan si le rapprochement échoue", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({
      summary: 'ok',
      weeks: [{ sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] }, CONFORMING_WEEK],
    });
    dal.reconcilePlanSessions.mockRejectedValue(new Error('deadlock detected'));

    await expect(updatePlanFromInstruction('rien de spécial')).resolves.toBe(ACTIVE.plan);
    expect(logged).toHaveBeenCalled();
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
            { day: 4, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10 },
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

  it('renonce après un second échec sans rien écrire', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue({ summary: 'x', weeks: [BROKEN_WEEK, BROKEN_WEEK] });

    await expect(updatePlanFromInstruction('change tout')).rejects.toThrow(AiInvalidOutputError);
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
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
