import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { TrainingSnapshotDto } from '@/data/coach-context';
import type { PlanReviewDto, PlanReviewSessionDto } from '@/data/plan-review';
import { InvalidPlanError, type PlanDto, type PlanSessionDto } from '@/data/plans';
import type { PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

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
  recentAvgPaceSecPerKm: 324,
};

/** Plan démarré le lundi 10 août, 2 semaines : reprise demain (mercredi 12). */
const PLAN: PlanDto = {
  id: 3,
  status: 'active',
  goalType: 'race',
  level: 'intermediate',
  goalText: '10 km sous 50 min',
  raceDate: '2026-09-13',
  startsOn: '2026-08-10',
  weeks: 2,
  sessionsPerWeek: 3,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: null,
  referenceTimeS: null,
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

/** Une semaine conforme aux règles métier : 3 séances, la plus longue le dimanche. */
const CONFORMING_WEEK = {
  sessions: [
    { day: 2, kind: 'Endurance', title: 'Footing', distanceKm: 8 },
    { day: 4, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10, steps: THRESHOLD_STEPS },
    { day: 7, kind: 'Sortie longue', title: 'Endurance', distanceKm: 16 },
  ],
};

/** Ce qu'un ajustement rend sur cette fenêtre : semaine entamée, puis semaine pleine. */
const ADJUST_WEEKS = [
  { sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] },
  CONFORMING_WEEK,
];

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

describe('maybeReviewActivePlan — déclenchement', () => {
  it('ne fait rien sous le seuil de séances réalisées', async () => {
    dal.getPlanReview.mockResolvedValue({ ...REVIEW, completedSessionCount: 3 });

    await maybeReviewActivePlan();

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

    await maybeReviewActivePlan();

    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  it('révise dès le seuil atteint', async () => {
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });

    await maybeReviewActivePlan();

    expect(REVIEW.completedSessionCount).toBe(REVIEW_EVERY_SESSIONS);
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(chatCompletionJson.mock.calls[0][0].schemaName).toBe('training_plan_review');
    expect(logs()).toContain('[plan/review] déclenchée sur le plan 3');
  });

  it('ne fait rien, et ne lit rien, quand le coach n’est pas configuré', async () => {
    getAiAvailability.mockResolvedValue({ available: false, reason: 'unconfigured' });

    await maybeReviewActivePlan();

    expect(dal.getActivePlanWithSessions).not.toHaveBeenCalled();
    expect(chatCompletionJson).not.toHaveBeenCalled();
    expect(logs()).toBe('');
  });

  it('ne fait rien sans plan actif', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(null);

    await maybeReviewActivePlan();

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

    const first = maybeReviewActivePlan();
    // La première révision doit avoir atteint le modèle : c'est là qu'elle
    // s'installe pour des minutes, et donc là que le verrou compte.
    await vi.waitFor(() => expect(chatCompletionJson).toHaveBeenCalledTimes(1));

    await maybeReviewActivePlan();

    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(logs()).toContain('déjà en cours');

    finish({ decision: 'keep', reason: 'Le plan tient.' });
    await first;

    // Le verrou est rendu : la révision suivante repart normalement.
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Toujours bon.' });
    await maybeReviewActivePlan();
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
  });
});

describe('maybeReviewActivePlan — bilan envoyé au modèle', () => {
  beforeEach(() => {
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });
  });

  it('met le prévu en regard du couru, et nomme les séances manquées', async () => {
    await maybeReviewActivePlan();

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

    await maybeReviewActivePlan();

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
    await maybeReviewActivePlan();

    const user = chatCompletionJson.mock.calls[0][0].messages[1].content;
    // Les séances restantes, celle déjà réalisée exclue.
    expect(user).toContain('Séances restantes (2 semaines) :');
    expect(user).toContain('Charge : CTL 52 · ATL 61 · TSB -9.');
    expect(user).toContain('Allure moyenne des dernières sorties : 5:24/km.');
  });

  it('impose « ne rien changer » comme réponse par défaut', async () => {
    await maybeReviewActivePlan();

    const system = chatCompletionJson.mock.calls[0][0].messages[0].content;
    // La méthodologie du coach est reprise telle quelle : une révision se juge
    // avec les règles qui ont écrit le plan.
    expect(system).toContain('RÉPARTITION DE LA CHARGE');
    expect(system).toContain("NIVEAU DE L'ATHLÈTE : INTERMÉDIAIRE");
    expect(system).toContain('tu ne changes RIEN');
    expect(system).toContain("C'est la réponse par défaut.");
  });
});

describe('maybeReviewActivePlan — décision', () => {
  it('n’écrit rien au plan quand le coach le conserve, mais avance le marqueur', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'keep',
      reason: 'Les quatre séances sont dans les cibles, la charge reste soutenable.',
    });

    await maybeReviewActivePlan();

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4);
    expect(logs()).toContain(
      '[plan/review] plan 3 conservé — Les quatre séances sont dans les cibles, la charge reste soutenable.',
    );
  });

  it('réécrit la suite du plan quand le coach ajuste, et reporte la raison au résumé', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Deux séances manquées et un TSB très négatif : la semaine suivante est allégée.',
      weeks: ADJUST_WEEKS,
    });

    await maybeReviewActivePlan();

    expect(dal.applyPlanUpdate).toHaveBeenCalledTimes(1);
    const [planId, update] = dal.applyPlanUpdate.mock.calls[0];
    expect(planId).toBe(3);
    // Reprise demain, comme un ajustement par instruction.
    expect(update.fromDate).toBe('2026-08-12');
    expect(update.sessions.map((session: { scheduledOn: string }) => session.scheduledOn)).toEqual([
      '2026-08-16',
      '2026-08-18',
      '2026-08-20',
      '2026-08-23',
    ]);
    expect(update.settings).toEqual({
      summary:
        'Bloc de 2 semaines.\n\nRévision du mardi 11 août 2026 : Deux séances manquées et un TSB très négatif : la semaine suivante est allégée.',
    });

    // Les deux effets de bord d'un plan que l'athlète suit.
    expect(dal.reconcilePlanSessions).toHaveBeenCalledWith(3);
    expect(syncPlanToIntervalsSafely).toHaveBeenCalled();

    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4);
    expect(logs()).toContain('[plan/review] plan 3 ajusté — Deux séances manquées');
  });

  it('avance le marqueur et synchronise même sans contexte de requête (watcher FIT)', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Charge trop élevée.',
      weeks: ADJUST_WEEKS,
    });

    // Le déclencheur nominal est le watcher : `after` y lève. Une révision qui
    // s'en servirait perdrait le marqueur — et réécrirait le plan à chaque
    // fichier importé, en boucle.
    await expect(maybeReviewActivePlan()).resolves.toBeUndefined();

    expect(scheduleAfter).not.toHaveBeenCalled();
    expect(dal.applyPlanUpdate).toHaveBeenCalledTimes(1);
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4);
    expect(syncPlanToIntervalsSafely).toHaveBeenCalledWith('révision du plan');
  });

  it('avance quand même le marqueur quand un effet de bord échoue', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Charge trop élevée.',
      weeks: ADJUST_WEEKS,
    });
    dal.reconcilePlanSessions.mockRejectedValue(new Error('base indisponible'));
    syncPlanToIntervalsSafely.mockRejectedValue(new Error('intervals.icu injoignable'));

    await expect(maybeReviewActivePlan()).resolves.toBeUndefined();

    // Le plan est écrit : la révision a eu lieu, elle ne doit pas être rejouée.
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4);
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
      weeks: [
        { sessions: [{ day: 7, kind: 'Sortie longue', title: '14 km', distanceKm: 14 }] },
        {
          sessions: [
            { day: 2, kind: 'Endurance', title: 'Footing', distanceKm: 8 },
            { day: 3, kind: 'Endurance', title: 'Footing', distanceKm: 6 },
            { day: 5, kind: 'Seuil', title: '3 × 8 min', distanceKm: 10, steps: THRESHOLD_STEPS },
            { day: 7, kind: 'Sortie longue', title: 'Endurance', distanceKm: 16 },
          ],
        },
      ],
    });

    await maybeReviewActivePlan();

    const [, update] = dal.applyPlanUpdate.mock.calls[0];
    expect(update.settings.sessionsPerWeek).toBe(4);
  });

  it('laisse le marqueur intact et journalise quand la révision échoue', async () => {
    chatCompletionJson.mockRejectedValue(new Error('coach injoignable'));

    // Fire-and-forget : l'appelant ne doit jamais voir passer l'erreur.
    await expect(maybeReviewActivePlan()).resolves.toBeUndefined();

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining('[plan/review] révision impossible'),
    );
    expect(errored).toHaveBeenCalledWith(expect.stringContaining('coach injoignable'));
  });

  it('n’avance pas le marqueur quand l’écriture du plan ajusté échoue', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Charge trop élevée.',
      weeks: ADJUST_WEEKS,
    });
    dal.applyPlanUpdate.mockRejectedValue(new Error('base indisponible'));

    await maybeReviewActivePlan();

    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(errored).toHaveBeenCalledWith(expect.stringContaining('base indisponible'));
  });
});

describe('maybeReviewActivePlan — plan modifié pendant la révision', () => {
  beforeEach(() => {
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Charge trop élevée.',
      weeks: ADJUST_WEEKS,
    });
  });

  it('abandonne sans écrire quand le plan a bougé pendant la génération', async () => {
    // Un ajustement demandé depuis la page du plan pendant les minutes de
    // génération : c'est lui qui fait foi, pas ce que le modèle vient d'écrire.
    dal.getPlanUpdatedAt.mockResolvedValue('2026-08-11T09:30:00.000Z');

    await maybeReviewActivePlan();

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    // Marqueur intact : le prochain palier retentera sur l'état à jour.
    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(logs()).toContain('[plan/review] plan 3 modifié pendant la révision — abandon');
  });

  it('abandonne aussi quand le plan n’est plus actif', async () => {
    dal.getPlanUpdatedAt.mockResolvedValue(null);

    await maybeReviewActivePlan();

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
  });
});

describe('maybeReviewActivePlan — échecs', () => {
  it('avance le marqueur quand la sortie du modèle reste inexploitable', async () => {
    chatCompletionJson.mockRejectedValue(new AiInvalidOutputError('JSON illisible'));

    await expect(maybeReviewActivePlan()).resolves.toBeUndefined();

    // Trois tentatives, puis abandon : redemander la même chose au même modèle
    // donnerait la même sortie, et le seuil resterait franchi pour toujours.
    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4);
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining(
        '[plan/review] révision abandonnée (sortie du modèle inexploitable) — prochaine tentative au palier suivant (4 séances)',
      ),
    );
  });

  it('avance le marqueur quand le plan produit sort de sa fenêtre', async () => {
    chatCompletionJson.mockResolvedValue({
      decision: 'adjust',
      reason: 'Charge trop élevée.',
      weeks: ADJUST_WEEKS,
    });
    dal.applyPlanUpdate.mockRejectedValue(
      new InvalidPlanError('sessions', 'Séance hors de la fenêtre du plan.'),
    );

    await maybeReviewActivePlan();

    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4);
  });

  it('impose un délai de garde après un échec transitoire', async () => {
    chatCompletionJson.mockRejectedValue(new AiUnavailableError('unreachable'));

    await maybeReviewActivePlan();

    expect(dal.markPlanReviewed).not.toHaveBeenCalled();
    expect(errored).toHaveBeenCalledWith(
      expect.stringContaining('nouvelle tentative dans 30 min au plus tôt'),
    );

    // Les fichiers suivants du même backfill ne relancent rien.
    chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });
    await maybeReviewActivePlan();
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    expect(logs()).toContain('[plan/review] déclenchement ignoré : échec récent');

    // Le délai passé, la révision reste due et repart.
    vi.setSystemTime(new Date(Date.now() + REVIEW_COOLDOWN_MS + 1));
    await maybeReviewActivePlan();
    expect(chatCompletionJson).toHaveBeenCalledTimes(2);
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4);
  });
});

describe('maybeReviewActivePlan — plan arrivé à son terme', () => {
  it('avance le marqueur sans rien demander au modèle', async () => {
    // Plan de 2 semaines démarré le 10 août : au 20 septembre, il est fini.
    vi.setSystemTime(new Date('2026-09-20T09:00:00.000Z'));

    await maybeReviewActivePlan();

    expect(chatCompletionJson).not.toHaveBeenCalled();
    expect(dal.markPlanReviewed).toHaveBeenCalledWith(3, 4);
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
