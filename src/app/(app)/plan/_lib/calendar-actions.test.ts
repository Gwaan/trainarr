import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionNotMovableError, type PlanWithSessions } from '@/data/plans';

import { moveSessionAction, type SessionMoveState } from './calendar-actions';

vi.mock('server-only', () => ({}));

/**
 * L'action est mince : seules lui appartiennent la validation de l'entrée, la
 * vérification d'appartenance au plan actif, et l'ordre des effets (écrire, puis
 * republier, puis revalider). Les règles d'entraînement, elles, sont éprouvées
 * dans `lib/plan-calendar/move-rules.test.ts` — ici, on vérifie seulement
 * qu'elles sont bien consultées et que leur verdict est rendu tel quel.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    getActivePlanWithSessions: vi.fn(),
    rescheduleSession: vi.fn(),
    revalidatePath: vi.fn(),
    syncPlanToIntervalsSafely: vi.fn(),
    /** `after` exige un contexte de requête Next : le doublon exécute tout de suite. */
    scheduleAfter: vi.fn(),
    /** L'action sert une requête : c'est elle qui résout l'athlète de la session. */
    getCurrentAthleteId: vi.fn(),
  },
}));

vi.mock('@/data/athlete', async (importOriginal) => ({
  // `todayCivilDate` est pure et reste le vrai code : c'est elle qui décide si
  // la destination est passée.
  ...(await importOriginal<typeof import('@/data/athlete')>()),
  getCurrentAthleteId: mocks.getCurrentAthleteId,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/server', () => ({ after: mocks.scheduleAfter }));
vi.mock('@/lib/intervals/push-plan', () => ({
  syncPlanToIntervalsSafely: mocks.syncPlanToIntervalsSafely,
}));

vi.mock('@/data/plans', async (importOriginal) => ({
  // Les erreurs typées restent le vrai code : c'est sur elles que l'action
  // distingue le cas attendu de la panne.
  ...(await importOriginal<typeof import('@/data/plans')>()),
  getActivePlanWithSessions: mocks.getActivePlanWithSessions,
  rescheduleSession: mocks.rescheduleSession,
}));

const IDLE: SessionMoveState = { status: 'idle' };

/** Aujourd'hui : mercredi 12 août 2026, 11 h à Paris. */
const TODAY = '2026-08-12';

/** Plan actif du lundi 10 août, 4 semaines : dernier jour le dimanche 6 septembre. */
function planWithSessions(overrides: Partial<PlanWithSessions['plan']> = {}): PlanWithSessions {
  return {
    plan: {
      id: 3,
      status: 'active',
      goalType: 'race',
      intent: 'race',
      returnInjuryHistory: false,
      level: 'intermediate',
      goalText: '10 km sous 50 min',
      raceDate: '2026-09-13',
      startsOn: '2026-08-10',
      weeks: 4,
      sessionsPerWeek: 4,
      weeklyTimeMinutes: 300,
      longRunDay: 7,
      referenceDistance: '10k',
      referenceTimeS: 2_910,
      referenceUpdatedOn: null,
      lastTestNote: null,
      summary: null,
      reviewedAt: null,
      createdAt: '2026-08-09T10:00:00.000Z',
      ...overrides,
    },
    sessions: [
      {
        id: 7,
        scheduledOn: '2026-08-14',
        kind: 'Seuil',
        title: '3 × 2 km',
        warmup: null,
        recovery: null,
        cooldown: null,
        targetPaceSecPerKm: 245,
        volumeM: 12_400,
        durationS: 3_900,
        steps: null,
        completedActivityId: null,
      },
      {
        id: 8,
        scheduledOn: '2026-08-16',
        kind: 'Sortie longue',
        title: 'Sortie longue en endurance',
        warmup: null,
        recovery: null,
        cooldown: null,
        targetPaceSecPerKm: null,
        volumeM: 16_000,
        durationS: null,
        steps: null,
        completedActivityId: null,
      },
    ],
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T09:00:00.000Z`));
  vi.clearAllMocks();
  mocks.revalidatePath.mockImplementation(() => {});
  mocks.getCurrentAthleteId.mockResolvedValue(7);
  mocks.getActivePlanWithSessions.mockResolvedValue(planWithSessions());
  mocks.rescheduleSession.mockResolvedValue(undefined);
  mocks.scheduleAfter.mockImplementation((run: () => void) => {
    run();
  });
});

describe('moveSessionAction — validation', () => {
  it.each([
    ['identifiant vide', { sessionId: '', toDate: '2026-08-18' }],
    ['identifiant non numérique', { sessionId: '7a', toDate: '2026-08-18' }],
    ['identifiant en notation exponentielle', { sessionId: '1e3', toDate: '2026-08-18' }],
    ['identifiant nul', { sessionId: '0', toDate: '2026-08-18' }],
    ['date au format français', { sessionId: '7', toDate: '18/08/2026' }],
    ['date absente', { sessionId: '7', toDate: '' }],
  ])('refuse %s sans rien écrire', async (_label, fields) => {
    const state = await moveSessionAction(IDLE, form(fields));

    expect(state.status).toBe('error');
    expect(mocks.rescheduleSession).not.toHaveBeenCalled();
  });
});

describe('moveSessionAction — appartenance au plan actif', () => {
  it("refuse quand aucun plan n'est actif", async () => {
    mocks.getActivePlanWithSessions.mockResolvedValue(null);

    const state = await moveSessionAction(IDLE, form({ sessionId: '7', toDate: '2026-08-18' }));

    expect(state).toEqual({ status: 'error', message: 'Aucun plan actif : recharge la page.' });
    expect(mocks.rescheduleSession).not.toHaveBeenCalled();
  });

  it("refuse une séance qui n'appartient pas au plan actif (anti-IDOR)", async () => {
    const state = await moveSessionAction(IDLE, form({ sessionId: '999', toDate: '2026-08-18' }));

    expect(state.status).toBe('error');
    expect(state.message).toContain("n'est pas dans ton plan en cours");
    expect(mocks.rescheduleSession).not.toHaveBeenCalled();
  });
});

describe('moveSessionAction — verdict des règles', () => {
  it('rend le refus des règles tel quel, sans écrire', async () => {
    // Le plan finit le dimanche 6 septembre : le 10 en sort.
    const state = await moveSessionAction(IDLE, form({ sessionId: '7', toDate: '2026-09-10' }));

    expect(state.status).toBe('error');
    expect(state.message).toContain('Ton plan court du');
    expect(mocks.rescheduleSession).not.toHaveBeenCalled();
  });

  it('écrit, republie et revalide quand le déplacement passe sans réserve', async () => {
    const state = await moveSessionAction(IDLE, form({ sessionId: '7', toDate: '2026-08-19' }));

    expect(state).toEqual({ status: 'success', message: 'Séance déplacée.' });
    expect(mocks.rescheduleSession).toHaveBeenCalledWith(3, 7, '2026-08-19');
    expect(mocks.syncPlanToIntervalsSafely).toHaveBeenCalledWith('déplacement de séance', 7);
    expect(mocks.revalidatePath.mock.calls.map(([path]) => path)).toEqual(['/plan', '/']);
  });

  it('déplace quand même, en remontant les avertissements', async () => {
    // Le seuil du 14 vient se coller à la sortie longue du 16 : jours durs
    // accolés, et le déplacement a quand même lieu.
    const state = await moveSessionAction(IDLE, form({ sessionId: '7', toDate: '2026-08-15' }));

    expect(state.status).toBe('success');
    expect(mocks.rescheduleSession).toHaveBeenCalledWith(3, 7, '2026-08-15');
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings?.[0]).toContain('deux séances dures');
  });
});

describe('moveSessionAction — pannes de l’écriture', () => {
  it('traduit SessionNotMovableError sans republier', async () => {
    mocks.rescheduleSession.mockRejectedValue(new SessionNotMovableError());

    const state = await moveSessionAction(IDLE, form({ sessionId: '7', toDate: '2026-08-19' }));

    expect(state.status).toBe('error');
    expect(state.message).toContain('ne peut plus être déplacée');
    expect(mocks.syncPlanToIntervalsSafely).not.toHaveBeenCalled();
  });

  it("ne laisse pas fuir l'inattendu", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rescheduleSession.mockRejectedValue(new Error('connexion perdue'));

    const state = await moveSessionAction(IDLE, form({ sessionId: '7', toDate: '2026-08-19' }));

    expect(state).toEqual({
      status: 'error',
      message: "La séance n'a pas pu être déplacée. Réessaie.",
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('ne transforme pas un déplacement réussi en échec si la revalidation lève', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error('hors contexte de requête');
    });

    const state = await moveSessionAction(IDLE, form({ sessionId: '7', toDate: '2026-08-19' }));

    expect(state.status).toBe('success');
    logged.mockRestore();
  });
});
