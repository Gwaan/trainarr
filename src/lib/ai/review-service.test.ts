import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { TrainingSnapshotDto } from '@/data/coach-context';
import type { PlanReviewDto, PlanReviewSessionDto } from '@/data/plan-review';
import { InvalidPlanError, type PlanDto, type PlanSessionDto } from '@/data/plans';

import { AiInvalidOutputError, AiUnavailableError } from './errors';
import {
  REVIEW_COOLDOWN_MS,
  REVIEW_EVERY_SESSIONS,
  maybeReviewActivePlan,
  resetReviewState,
  withReviewNote,
} from './review-service';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { chatCompletionJson } = vi.hoisted(() => ({ chatCompletionJson: vi.fn() }));
const { getAiAvailability } = vi.hoisted(() => ({ getAiAvailability: vi.fn() }));
const { dal } = vi.hoisted(() => ({
  dal: {
    getTrainingSnapshot: vi.fn(),
    getActivePlanWithSessions: vi.fn(),
    applyPlanUpdate: vi.fn(),
    getPlanReview: vi.fn(),
    getPlanUpdatedAt: vi.fn(),
    markPlanReviewed: vi.fn(),
    reconcilePlanSessions: vi.fn(),
  },
}));

const { syncPlanToIntervalsSafely } = vi.hoisted(() => ({ syncPlanToIntervalsSafely: vi.fn() }));

/**
 * `after` exige un contexte de requête Next : hors de l'un (le watcher FIT), il
 * lève `E468`. Le doublon reproduit ce refus par défaut — une révision qui
 * dépendrait de `after` échouerait donc ici, comme en production.
 */
const { scheduleAfter } = vi.hoisted(() => ({ scheduleAfter: vi.fn() }));

/** Le refus de `after` hors requête, tel que Next le lève. */
function outsideRequestScope(): Error {
  return new Error('`after` was called outside a request scope. (E468)');
}

vi.mock('./client', () => ({ chatCompletionJson }));
vi.mock('./availability', () => ({ getAiAvailability }));
vi.mock('next/server', () => ({ after: scheduleAfter }));
vi.mock('@/lib/intervals/push-plan', () => ({ syncPlanToIntervalsSafely }));
vi.mock('@/data/coach-context', () => ({ getTrainingSnapshot: dal.getTrainingSnapshot }));
vi.mock('@/data/plan-reconciliation', () => ({ reconcilePlanSessions: dal.reconcilePlanSessions }));
vi.mock('@/data/plan-review', () => ({
  getPlanReview: dal.getPlanReview,
  getPlanUpdatedAt: dal.getPlanUpdatedAt,
  markPlanReviewed: dal.markPlanReviewed,
}));
vi.mock('@/data/plans', async () => {
  // Les erreurs et les bornes sont du vrai code métier : seules les fonctions
  // qui touchent la base sont remplacées.
  const actual = await vi.importActual<typeof import('@/data/plans')>('@/data/plans');
  return {
    ...actual,
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
  longestSessionKm30d: 14.2,
  recentAvgPaceSecPerKm: 324,
};

/**
 * Plan démarré le lundi 10 août, 2 semaines : reprise demain (mercredi 12), et
 * la course le dernier jour du plan.
 *
 * La date de course n'est plus décorative depuis que la fenêtre restante est
 * reconstruite par l'appli : c'est elle qui pose la séance du jour J et qui
 * ferme la semaine de course.
 */
const PLAN: PlanDto = {
  id: 3,
  status: 'active',
  goalType: 'race',
  intent: 'race',
  returnInjuryHistory: false,
  level: 'intermediate',
  goalText: '10 km sous 50 min',
  raceDate: '2026-08-23',
  startsOn: '2026-08-10',
  weeks: 2,
  sessionsPerWeek: 3,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: null,
  referenceTimeS: null,
  referenceUpdatedOn: null,
  lastTestNote: null,
  summary: 'Bloc de 2 semaines.',
  reviewedAt: null,
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

const ACTIVE = {
  plan: PLAN,
  sessions: [
    planSession({ scheduledOn: '2026-08-10', id: 1, completedActivityId: 42 }),
    planSession({ scheduledOn: '2026-08-16', id: 2 }),
    planSession({ scheduledOn: '2026-08-20', id: 3 }),
  ],
};

function reviewSession(
  overrides: Partial<PlanReviewSessionDto> & { scheduledOn: string },
): PlanReviewSessionDto {
  return {
    kind: 'Endurance fondamentale',
    title: 'Footing',
    targetPaceSecPerKm: 330,
    volumeM: 10_000,
    durationS: 3_300,
    completed: null,
    ...overrides,
  };
}

/** L'`updatedAt` du plan au moment du bilan — le témoin du contrôle de fraîcheur. */
const PLAN_UPDATED_AT = '2026-08-10T08:00:00.000Z';

/** Un bilan qui atteint le seuil : 4 séances réalisées non encore relues. */
const REVIEW: PlanReviewDto = {
  completedSessionCount: 4,
  reviewedSessionCount: 0,
  older: null,
  updatedAt: PLAN_UPDATED_AT,
  sessions: [
    reviewSession({
      scheduledOn: '2026-08-04',
      completed: { distanceM: 10_120, movingTimeS: 3_360, avgPaceSecPerKm: 332, avgHrBpm: 141 },
    }),
    reviewSession({ scheduledOn: '2026-08-06', kind: 'Seuil', title: '3 × 8 min' }),
  ],
};

/**
 * Ce que le coach rend quand il ajuste : un verdict, et rien d'autre.
 *
 * Plus une seule semaine — c'est l'appli qui reconstruit la fenêtre restante
 * (`rewriteRemainingPlan`). Le contrat de sortie l'impose, et ces fixtures le
 * montrent : il n'y a plus rien à écrire ici qui ressemble à un plan.
 */
const ADJUST = { decision: 'adjust', reason: 'Charge trop élevée.' } as const;

/** Et quand il conserve le plan. */
const KEEP = { decision: 'keep', reason: 'Le plan tient.' } as const;

/** Les séances écrites en base par la dernière révision. */
function updatedSessions(): {
  scheduledOn: string;
  kind: string;
  volumeM: number | null;
  durationS: number | null;
  targetPaceSecPerKm: number | null;
}[] {
  return dal.applyPlanUpdate.mock.calls[0][1].sessions;
}

let logged: MockInstance<typeof console.log>;
let errored: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.clearAllMocks();
  // Verrou et cooldown vivent dans le module : sans remise à zéro, un scénario
  // d'échec ferait sortir tous les suivants sans rien faire.
  resetReviewState();
  vi.useFakeTimers();
  // Mardi 11 août 2026, 11 h à Paris.
  vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));

  logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  errored = vi.spyOn(console, 'error').mockImplementation(() => {});

  getAiAvailability.mockResolvedValue({ available: true });
  dal.getTrainingSnapshot.mockResolvedValue(SNAPSHOT);
  dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
  dal.getPlanReview.mockResolvedValue(REVIEW);
  dal.getPlanUpdatedAt.mockResolvedValue(PLAN_UPDATED_AT);
  dal.applyPlanUpdate.mockResolvedValue(undefined);
  dal.markPlanReviewed.mockResolvedValue(undefined);
  dal.reconcilePlanSessions.mockResolvedValue(0);
  scheduleAfter.mockImplementation(() => {
    throw outsideRequestScope();
  });
});

afterEach(() => {
  vi.useRealTimers();
  logged.mockRestore();
  errored.mockRestore();
});

/** Le texte de tous les appels à `console.log`, concaténé. */
function logs(): string {
  return logged.mock.calls.map((call) => String(call[0])).join('\n');
}

/**
 * L'athlète du fichier importé. Il est **donné** au service comme à l'ingestion :
 * le watcher FIT tourne hors requête, il n'y a pas de session à interroger.
 */
const ATHLETE_ID = 7;

describe('maybeReviewActivePlan — déclenchement', () => {
  it('ne fait rien sous le seuil de séances réalisées', async () => {
    dal.getPlanReview.mockResolvedValue({ ...REVIEW, completedSessionCount: 3 });

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(chatCompletionJson).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    // Un seuil non atteint est l'état normal : il ne bavarde pas.
    expect(logs()).toBe('');
  });

  it('compte les séances **depuis la dernière révision**, pas depuis le début', async () => {
    // 6 réalisées dont 3 déjà relues : il n'en reste que 3 à juger.
    dal.getPlanReview.mockResolvedValue({
      ...REVIEW,
      completedSessionCount: 6,
      reviewedSessionCount: 3,
    });

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  it('révise dès le seuil atteint', async () => {
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(REVIEW.completedSessionCount).toBe(REVIEW_EVERY_SESSIONS);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(chatCompletionJson.mock.calls[0][0].schemaName).toBe('training_plan_review');
    expect(logs()).toContain('[plan/review] déclenchée sur le plan 3');
  });

  it('passe l’athlète reçu à chaque lecture du DAL, sans jamais le déduire', async () => {
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });

    await maybeReviewActivePlan(ATHLETE_ID);

    // Ces trois-là lisaient « l'athlète courant » : hors requête, elles
    // rendaient `null` et la révision s'arrêtait avant même de commencer.
    expect(dal.getActivePlanWithSessions).toHaveBeenCalledWith(ATHLETE_ID);
    expect(dal.getPlanReview).toHaveBeenCalledWith(3, ATHLETE_ID);
    expect(dal.getTrainingSnapshot).toHaveBeenCalledWith(ATHLETE_ID);
  });

  it('ne fait rien, et ne lit rien, quand le coach n’est pas configuré', async () => {
    getAiAvailability.mockResolvedValue({ available: false, reason: 'unconfigured' });

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.getActivePlanWithSessions).not.toHaveBeenCalled();
    expect(chatCompletionJson).not.toHaveBeenCalled();
    expect(logs()).toBe('');
  });

  it('ne fait rien sans plan actif', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(null);

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.getPlanReview).not.toHaveBeenCalled();
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  it('ignore un déclenchement pendant qu’une révision tourne', async () => {
    // La génération dure : c'est précisément la fenêtre pendant laquelle les
    // imports suivants ne doivent pas en lancer une seconde.
    let finish: (value: unknown) => void = () => {};
    chatCompletionJson.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const first = maybeReviewActivePlan(ATHLETE_ID);
    // La première révision doit avoir atteint le modèle : c'est là qu'elle
    // s'installe pour des minutes, et donc là que le verrou compte.
    await vi.waitFor(() => expect(chatCompletionJson).toHaveBeenCalledTimes(1));

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(logs()).toContain('déjà en cours');

    finish({ decision: 'keep', reason: 'Le plan tient.' });
    await first;

    // Le verrou est rendu : la révision suivante repart normalement.
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Toujours bon.' });
    await maybeReviewActivePlan(ATHLETE_ID);
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
  });
});

describe('maybeReviewActivePlan — bilan envoyé au modèle', () => {
  beforeEach(() => {
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });
  });

  it('met le prévu en regard du couru, et nomme les séances manquées', async () => {
    await maybeReviewActivePlan(ATHLETE_ID);

    const user = chatCompletionJson.mock.calls[0][0].messages[1].content;
    expect(user).toContain(
      '- mardi 4 août 2026 · Endurance fondamentale — Footing (prévu : 10,0 km · 55 min · 5:30/km) → couru : 10,1 km · 56 min · 5:32/km · FC 141 bpm',
    );
    expect(user).toContain(
      '- jeudi 6 août 2026 · Seuil — 3 × 8 min (prévu : 10,0 km · 55 min · 5:30/km) → MANQUÉE',
    );
  });

  it('résume en une ligne les séances trop anciennes pour être détaillées', async () => {
    dal.getPlanReview.mockResolvedValue({
      ...REVIEW,
      older: { count: 23, completed: 18, missed: 5 },
    });

    await maybeReviewActivePlan(ATHLETE_ID);

    const user = chatCompletionJson.mock.calls[0][0].messages[1].content;
    expect(user).toContain(
      '- et 23 séances plus anciennes (18 réalisées, 5 manquées), non détaillées.',
    );
    // L'agrégat précède le détail : le bilan se lit dans l'ordre chronologique.
    expect(user.indexOf('23 séances plus anciennes')).toBeLessThan(
      user.indexOf('mardi 4 août 2026'),
    );
  });

  it('joint la suite du plan et l’état de forme', async () => {
    await maybeReviewActivePlan(ATHLETE_ID);

    const user = chatCompletionJson.mock.calls[0][0].messages[1].content;
    // Les séances restantes, celle déjà réalisée exclue.
    expect(user).toContain('Séances restantes (2 semaines) :');
    expect(user).toContain('Charge : CTL 52 · ATL 61 · TSB -9.');
    expect(user).toContain('Allure moyenne des dernières sorties : 5:24/km.');
  });

  it('impose « ne rien changer » comme réponse par défaut', async () => {
    await maybeReviewActivePlan(ATHLETE_ID);

    const system = chatCompletionJson.mock.calls[0][0].messages[0].content;
    expect(system).toContain("C'est la réponse par défaut");
    // Ce que le prompt ne porte plus : la méthodologie d'entraînement. Elle ne
    // servait qu'à faire écrire des semaines au modèle, et il n'en écrit plus —
    // ces règles-là vivent en code, vérifiées à l'exécution.
    expect(system).not.toContain('RÉPARTITION DE LA CHARGE');
    expect(system).toContain("Tu n'écris donc aucune séance, aucun volume, aucune allure.");
  });
});

describe('maybeReviewActivePlan — décision', () => {
  it('n’écrit rien au plan quand le coach le conserve, mais avance le marqueur', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'keep',
      reason: 'Les quatre séances sont dans les cibles, la charge reste soutenable.',
    });

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
    expect(logs()).toContain(
      '[plan/review] plan 3 conservé — Les quatre séances sont dans les cibles, la charge reste soutenable.',
    );
  });

  it('recalcule la suite du plan quand le coach ajuste, et reporte la raison au résumé', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Deux séances manquées et un TSB très négatif : la semaine suivante est allégée.',
    });

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.applyPlanUpdate).toHaveBeenCalledTimes(1);
    const [planId, update] = dal.applyPlanUpdate.mock.calls[0];
    expect(planId).toBe(3);
    // Reprise demain, comme un ajustement par instruction.
    expect(update.fromDate).toBe('2026-08-12');
    // Aucune journée déjà écoulée n'est réécrite, et la dernière séance est la
    // course elle-même.
    const days = updatedSessions().map((session) => session.scheduledOn);
    expect(days.every((day) => day >= '2026-08-12')).toBe(true);
    expect(updatedSessions()[updatedSessions().length - 1]).toMatchObject({
      scheduledOn: '2026-08-23',
      kind: 'Course',
    });
    expect(update.settings).toEqual({
      summary:
        'Bloc de 2 semaines.\n\nRévision du mardi 11 août 2026 : Deux séances manquées et un TSB très négatif : la semaine suivante est allégée.',
    });

    // Les deux effets de bord d'un plan que l'athlète suit.
    expect(dal.reconcilePlanSessions).toHaveBeenCalledWith(3, ATHLETE_ID);
    expect(syncPlanToIntervalsSafely).toHaveBeenCalled();

    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
    expect(logs()).toContain('[plan/review] plan 3 ajusté — Deux séances manquées');
  });

  it('avance le marqueur et synchronise même sans contexte de requête (watcher FIT)', async () => {
    chatCompletionJson.mockResolvedValue(ADJUST);

    // Le déclencheur nominal est le watcher : `after` y lève. Une révision qui
    // s'en servirait perdrait le marqueur — et réécrirait le plan à chaque
    // fichier importé, en boucle.
    await expect(maybeReviewActivePlan(ATHLETE_ID)).resolves.toBeUndefined();

    expect(scheduleAfter).not.toHaveBeenCalled();
    expect(dal.applyPlanUpdate).toHaveBeenCalledTimes(1);
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
    expect(syncPlanToIntervalsSafely).toHaveBeenCalledWith('révision du plan', ATHLETE_ID);
  });

  it('avance quand même le marqueur quand un effet de bord échoue', async () => {
    chatCompletionJson.mockResolvedValue(ADJUST);
    dal.reconcilePlanSessions.mockRejectedValue(new Error('base indisponible'));
    syncPlanToIntervalsSafely.mockRejectedValue(new Error('intervals.icu injoignable'));

    await expect(maybeReviewActivePlan(ATHLETE_ID)).resolves.toBeUndefined();

    // Le plan est écrit : la révision a eu lieu, elle ne doit pas être rejouée.
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining('rapprochement des séances du plan 3 impossible'),
      expect.anything(),
    );
  });

  it('reporte les réglages durables que la révision change', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Trois séances tenues sur quatre : on passe à 4 séances par semaine.',
      settings: { sessionsPerWeek: 4 },
    });

    await maybeReviewActivePlan(ATHLETE_ID);

    const [, update] = dal.applyPlanUpdate.mock.calls[0];
    expect(update.settings.sessionsPerWeek).toBe(4);
    // Et le calendrier recalculé les porte : la semaine pleine en compte quatre.
    const week = updatedSessions().filter((session) => session.scheduledOn >= '2026-08-17');
    expect(week).toHaveLength(4);
  });

  it('laisse le marqueur intact et journalise quand la révision échoue', async () => {
    chatCompletionJson.mockRejectedValue(new Error('coach injoignable'));

    // Fire-and-forget : l'appelant ne doit jamais voir passer l'erreur.
    await expect(maybeReviewActivePlan(ATHLETE_ID)).resolves.toBeUndefined();

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining('[plan/review] révision impossible'),
    );
    expect(errored).toHaveBeenCalledWith(expect.stringContaining('coach injoignable'));
  });

  it('n’avance pas le marqueur quand l’écriture du plan ajusté échoue', async () => {
    chatCompletionJson.mockResolvedValue(ADJUST);
    dal.applyPlanUpdate.mockRejectedValue(new Error('base indisponible'));

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(errored).toHaveBeenCalledWith(expect.stringContaining('base indisponible'));
  });
});

/**
 * Le budget temps d'une révision est une **entrée du calcul**, comme partout
 * ailleurs depuis la bascule : les cibles de la fenêtre sont chiffrées sous lui,
 * et le squelette les répartit sans les défaire.
 */
describe('maybeReviewActivePlan — budget temps hebdomadaire', () => {
  /** Le même plan, mais 2 h par semaine. */
  const AT_2H = { plan: { ...PLAN, weeklyTimeMinutes: 120 }, sessions: ACTIVE.sessions };

  beforeEach(() => {
    dal.getActivePlanWithSessions.mockResolvedValue(AT_2H);
  });

  it('tient le budget du plan dans les semaines qu’elle recalcule', async () => {
    chatCompletionJson.mockResolvedValue(ADJUST);

    await maybeReviewActivePlan(ATHLETE_ID);

    const byWeek = new Map<string, number>();
    for (const session of updatedSessions()) {
      const week = session.scheduledOn < '2026-08-17' ? 'S1' : 'S2';
      byWeek.set(week, (byWeek.get(week) ?? 0) + (session.durationS ?? 0));
    }
    for (const [week, seconds] of byWeek) {
      // 2 h déclarées, tolérance de 20 % comprise (cf. `VOLUME_RULES`).
      expect(seconds, week).toBeLessThanOrEqual(120 * 60 * 1.2);
    }
  });

  it('ignore un budget effacé par le modèle : personne ne le lui a demandé', async () => {
    // Lever la contrainte de temps est une décision de l'athlète, prise sur le
    // chemin de l'instruction. Une révision se déclenche toute seule : un
    // provider hors grammaire écrivant `null` effacerait sinon une contrainte de
    // vie sans que personne ne l'ait demandé.
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Charge à revoir.',
      settings: { weeklyTimeMinutes: null, sessionsPerWeek: 2 },
    });

    await maybeReviewActivePlan(ATHLETE_ID);

    const { settings } = dal.applyPlanUpdate.mock.calls[0][1];
    // Le budget seul est écarté : réduire le nombre de séances est exactement ce
    // qu'une révision a le droit de conclure.
    expect(settings.sessionsPerWeek).toBe(2);
    expect(settings).not.toHaveProperty('weeklyTimeMinutes');
  });
});

/**
 * La révision emprunte le même chemin qu'un ajustement, post-traitement des
 * allures compris : sur un plan qui porte un chrono, aucune allure ne vient du
 * modèle — c'est l'appli qui les pose (cf. `applyImposedPaces`).
 */
describe('maybeReviewActivePlan — allures imposées', () => {
  /** Le même plan, avec le chrono de référence : 10 km en 48:30 → VDOT 41,5. */
  const WITH_RACE = {
    plan: { ...PLAN, referenceDistance: '10k' as const, referenceTimeS: 2_910 },
    sessions: ACTIVE.sessions,
  };

  beforeEach(() => {
    dal.getActivePlanWithSessions.mockResolvedValue(WITH_RACE);
  });

  it('retire du contexte l’ancre parasite quand une table existe', async () => {
    chatCompletionJson.mockResolvedValue(KEEP);

    await maybeReviewActivePlan(ATHLETE_ID);

    // L'allure moyenne des dernières sorties égarait le modèle : elle sort du
    // contexte dès qu'une table existe.
    const [{ messages }] = chatCompletionJson.mock.calls[0];
    expect(messages[1].content).not.toContain('Allure moyenne des dernières sorties');
  });

  it('pose les allures de la table sur les semaines recalculées', async () => {
    chatCompletionJson.mockResolvedValue(ADJUST);

    await maybeReviewActivePlan(ATHLETE_ID);

    const sessions = updatedSessions();
    // Endurance au milieu de [E] (5:56–6:32/km) …
    expect(sessions[0].targetPaceSecPerKm).toBe(374);
    // … et le jour J à l'allure de l'objectif, jamais en endurance.
    const raceDay = sessions[sessions.length - 1];
    expect(raceDay.kind).toBe('Course');
    expect(raceDay.targetPaceSecPerKm).toBeLessThan(374);
  });

  it('ne touche à rien quand la révision conserve le plan', async () => {
    chatCompletionJson.mockResolvedValue(KEEP);

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
  });

  it('dérive les mesures sans rien prescrire quand le plan ne porte pas de chrono', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    chatCompletionJson.mockResolvedValue(ADJUST);

    await maybeReviewActivePlan(ATHLETE_ID);

    // Les volumes sont écrits par l'appli dans les deux régimes ; sans table, la
    // seule chose qui manque est la prescription d'allure.
    expect(updatedSessions().every((session) => session.volumeM !== null)).toBe(true);
    expect(
      updatedSessions().every((session) => session.targetPaceSecPerKm === null),
    ).toBe(true);
  });
});

describe('maybeReviewActivePlan — plan modifié pendant la révision', () => {
  beforeEach(() => {
    chatCompletionJson.mockResolvedValue(ADJUST);
  });

  it('abandonne sans écrire quand le plan a bougé pendant la génération', async () => {
    // Un ajustement demandé depuis la page du plan pendant les minutes de
    // génération : c'est lui qui fait foi, pas ce que le modèle vient d'écrire.
    dal.getPlanUpdatedAt.mockResolvedValue('2026-08-11T09:30:00.000Z');

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    // Marqueur intact : la révision reste due, sur l'état à jour.
    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(logs()).toContain('[plan/review] plan 3 modifié pendant la révision — abandon');
  });

  it('ne rejoue pas la génération entière à l’import suivant', async () => {
    // Le marqueur n'avance pas, donc le seuil reste franchi : sans cooldown, le
    // prochain fichier importé redemanderait la même révision et rejouerait les
    // mêmes appels au modèle — 45 mesurés sur un plan de 16 semaines à 5 séances,
    // pour un travail qu'on vient de jeter.
    dal.getPlanUpdatedAt.mockResolvedValue('2026-08-11T09:30:00.000Z');

    await maybeReviewActivePlan(ATHLETE_ID);
    const callsAfterAbandon = chatCompletionJson.mock.calls.length;

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(chatCompletionJson.mock.calls.length).toBe(callsAfterAbandon);
    expect(logs()).toContain('[plan/review] déclenchement ignoré : échec récent');
  });

  it('abandonne aussi quand le plan n’est plus actif', async () => {
    dal.getPlanUpdatedAt.mockResolvedValue(null);

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
  });
});

describe('maybeReviewActivePlan — échecs', () => {
  it('avance le marqueur quand la sortie du modèle reste inexploitable', async () => {
    chatCompletionJson.mockRejectedValue(new AiInvalidOutputError('JSON illisible'));

    await expect(maybeReviewActivePlan(ATHLETE_ID)).resolves.toBeUndefined();

    // Trois tentatives, puis abandon : redemander la même chose au même modèle
    // donnerait la même sortie, et le seuil resterait franchi pour toujours.
    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining(
        '[plan/review] révision abandonnée (sortie du modèle inexploitable) — prochaine tentative au palier suivant (4 séances)',
      ),
    );
  });

  it('avance le marqueur quand le plan produit sort de sa fenêtre', async () => {
    chatCompletionJson.mockResolvedValue(ADJUST);
    dal.applyPlanUpdate.mockRejectedValue(
      new InvalidPlanError('sessions', 'Séance hors de la fenêtre du plan.'),
    );

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
  });

  it('impose un délai de garde après un échec transitoire', async () => {
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unreachable'));

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining('nouvelle tentative dans 30 min au plus tôt'),
    );

    // Les fichiers suivants du même backfill ne relancent rien.
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });
    await maybeReviewActivePlan(ATHLETE_ID);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(logs()).toContain('[plan/review] déclenchement ignoré : échec récent');

    // Le délai passé, la révision reste due et repart.
    vi.setSystemTime(new Date(Date.now() + REVIEW_COOLDOWN_MS + 1));
    await maybeReviewActivePlan(ATHLETE_ID);
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
  });

  /**
   * Verrou et délai de garde vivent sur `globalThis`, et pas dans le module :
   * en build standalone, le watcher FIT et un route handler n'embarquent pas
   * forcément la même instance de ce fichier — deux instances, ce seraient deux
   * verrous, donc deux révisions concurrentes sur le même plan. Recharger le
   * module ici joue ce dédoublement.
   */
  it('partage verrou et délai de garde entre deux instances du module', async () => {
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unreachable'));
    await maybeReviewActivePlan(ATHLETE_ID);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const reloaded = await import('./review-service');

    // La seconde instance voit le cooldown posé par la première.
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });
    await reloaded.maybeReviewActivePlan(ATHLETE_ID);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);

    // Et le lever depuis l'une le lève pour l'autre.
    reloaded.resetReviewState();
    await maybeReviewActivePlan(ATHLETE_ID);
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
  });
});

describe('maybeReviewActivePlan — plan arrivé à son terme', () => {
  it('avance le marqueur sans rien demander au modèle', async () => {
    // Plan de 2 semaines démarré le 10 août : au 20 septembre, il est fini.
    vi.setSystemTime(new Date('2026-09-20T09:00:00.000Z'));

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(chatCompletionJson).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
    expect(logs()).toContain('[plan/review] plan 3 arrivé à son terme, rien à réviser');
    expect(errored).not.toHaveBeenCalled();
  });
});

describe('withReviewNote', () => {
  it('ajoute la raison en dernier paragraphe du résumé', () => {
    expect(withReviewNote('Bloc de 8 semaines.', '2026-08-11', 'Charge trop élevée.')).toBe(
      'Bloc de 8 semaines.\n\nRévision du mardi 11 août 2026 : Charge trop élevée.',
    );
  });

  it('remplace la note de la révision précédente au lieu de l’empiler', () => {
    const summary =
      'Bloc de 8 semaines.\n\nRévision du mardi 4 août 2026 : première correction.';

    expect(withReviewNote(summary, '2026-08-11', 'seconde correction.')).toBe(
      'Bloc de 8 semaines.\n\nRévision du mardi 11 août 2026 : seconde correction.',
    );
  });

  it('ramène une raison multi-paragraphe à une seule ligne', () => {
    // Sans normalisation, le second paragraphe ne porterait pas le préfixe : la
    // révision suivante ne le reconnaîtrait pas, et il s'empilerait.
    const summary = withReviewNote(
      'Bloc de 8 semaines.',
      '2026-08-11',
      'Charge trop élevée.\n\n  La semaine suivante est allégée.\n',
    );

    expect(summary).toBe(
      'Bloc de 8 semaines.\n\nRévision du mardi 11 août 2026 : Charge trop élevée. La semaine suivante est allégée.',
    );
    expect(withReviewNote(summary, '2026-08-18', 'Le plan tient.')).toBe(
      'Bloc de 8 semaines.\n\nRévision du mardi 18 août 2026 : Le plan tient.',
    );
  });

  it('se passe d’un résumé absent', () => {
    expect(withReviewNote(null, '2026-08-11', 'Charge trop élevée.')).toBe(
      'Révision du mardi 11 août 2026 : Charge trop élevée.',
    );
  });
});

/*
 * Une révision sur une **longue** fenêtre restante.
 *
 * Le plan de deux semaines ci-dessus tient en une phase d'affûtage : il ne porte
 * aucun créneau de qualité, donc la révision n'y appelle le modèle qu'une fois.
 * Ce plan-ci en porte, et c'est ce qui permet d'éprouver la reconstruction
 * complète — périodisation conservée, créneaux remplis, repli quand le coach
 * lâche.
 */

/**
 * Seize semaines commencées le lundi 1er juin, course le dimanche 20 septembre.
 * Au mardi 11 août, il en reste six — et l'athlète est dans son bloc spécifique.
 */
const LONG_PLAN: PlanDto = {
  ...PLAN,
  startsOn: '2026-06-01',
  weeks: 16,
  raceDate: '2026-09-20',
};

/** Le coach de cette fenêtre : un verdict, puis un déroulé par créneau. */
function coachAdjustsLongPlan(): void {
  chatCompletionJson.mockImplementation(async (call: { schemaName: string }) => {
    if (call.schemaName === 'training_plan_review') return ADJUST;
    if (call.schemaName === 'quality_session') {
      return {
        title: 'Séance écrite par le coach',
        steps: [
          {
            repeat: 1,
            steps: [
              {
                role: 'run',
                distanceM: 6_000,
              },
            ],
          },
        ],
      };
    }
    throw new Error(`schéma inattendu sur le chemin de révision : ${call.schemaName}`);
  });
}

describe('maybeReviewActivePlan — fenêtre longue', () => {
  beforeEach(() => {
    dal.getActivePlanWithSessions.mockResolvedValue({ plan: LONG_PLAN, sessions: ACTIVE.sessions });
  });

  it('conserve la position dans la périodisation : pas de retour en phase de base', async () => {
    coachAdjustsLongPlan();

    await maybeReviewActivePlan(ATHLETE_ID);

    // Quatre créneaux de qualité sur les six semaines restantes : trois de
    // spécificité, un d'affûtage. Une périodisation recalculée sur la seule
    // fenêtre restante aurait rendu des semaines de base.
    const kinds = updatedSessions().map((session) => session.kind);
    // Spécificité 10 km : du seuil ; affûtage : de la VMA ; puis la course.
    expect(kinds).toContain('Seuil');
    expect(kinds).toContain('VMA');
    expect(kinds).toContain('Course');
    // Les répétitions courtes sont la qualité de la phase de **base** : leur
    // absence est la preuve que le plan n'y est pas retourné.
    expect(kinds).not.toContain('Répétitions');
  });

  it('ne réécrit aucune journée déjà écoulée', async () => {
    coachAdjustsLongPlan();

    await maybeReviewActivePlan(ATHLETE_ID);

    expect(updatedSessions().every((session) => session.scheduledOn >= '2026-08-12')).toBe(true);
  });

  it('écrit un plan entièrement déterministe quand le coach lâche après son verdict', async () => {
    chatCompletionJson.mockImplementation(async (call: { schemaName: string }) => {
      if (call.schemaName === 'training_plan_review') return ADJUST;
      throw new AiUnavailableError('unreachable');
    });

    await expect(maybeReviewActivePlan(ATHLETE_ID)).resolves.toBeUndefined();

    // Le plan est écrit malgré tout, complet et mesuré : un créneau qui échoue
    // se replie sur un déroulé déterministe.
    expect(dal.applyPlanUpdate).toHaveBeenCalledTimes(1);
    expect(updatedSessions().every((session) => session.volumeM !== null)).toBe(true);
    expect(updatedSessions().map((session) => session.kind)).not.toContain('Répétitions');
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
  });

  it('n’écrit rien et retentera quand le verdict lui-même n’arrive pas', async () => {
    // Un verdict n'a pas de repli déterministe, et c'est délibéré : se replier
    // sur « keep » avalerait une révision due, sur « adjust » ferait recalculer
    // un plan que personne n'a jugé.
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unreachable'));

    await expect(maybeReviewActivePlan(ATHLETE_ID)).resolves.toBeUndefined();

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining('nouvelle tentative dans 30 min au plus tôt'),
    );
  });

  it('abandonne sans faire échouer l’import quand la fenêtre est infaisable', async () => {
    // Six séances par semaine sur un volume réel de 1 km : le squelette refuse
    // d'écrire des séances de moins de 500 m. Échec **permanent** — le marqueur
    // avance, sans quoi chaque fichier importé rejouerait le même refus.
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: { ...LONG_PLAN, sessionsPerWeek: 6, weeklyTimeMinutes: null },
      sessions: ACTIVE.sessions,
    });
    dal.getTrainingSnapshot.mockResolvedValue({
      ...SNAPSHOT,
      weeks: [{ startsOn: '2026-08-03', distanceKm: 1, movingTimeS: 400, sessions: 1 }],
    });
    chatCompletionJson.mockResolvedValue(ADJUST);

    await expect(maybeReviewActivePlan(ATHLETE_ID)).resolves.toBeUndefined();

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4, ATHLETE_ID);
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining('[plan/review] révision abandonnée'),
    );
  });
});
