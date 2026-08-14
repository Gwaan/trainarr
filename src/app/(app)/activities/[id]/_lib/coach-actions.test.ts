import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_REQUIRED_MESSAGE } from '@/lib/auth/messages';

import { requestFeedbackAction, type CoachFeedbackState } from './coach-actions';
import { COACH_ACTIVITY_NOT_FOUND } from './coach-messages';

vi.mock('server-only', () => ({}));

/**
 * L'action est mince : le contexte, l'appel au modèle et l'écriture vivent dans
 * `lib/ai/feedback-service.ts`. Ce qu'on éprouve ici, c'est la seule chose qui
 * lui appartienne — le fait qu'elle se garde **elle-même**. Une Server Action
 * exportée est un endpoint public : elle s'appelle en POST direct, sans passer
 * par le bouton de la page.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    generateActivityFeedback: vi.fn(),
    revalidatePath: vi.fn(),
    /** La vraie lecture de session est éprouvée dans `src/data/session.test.ts`. */
    getSession: vi.fn(),
  },
}));

vi.mock('@/data/session', () => ({ getSession: mocks.getSession }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/ai/feedback-service', () => ({
  generateActivityFeedback: mocks.generateActivityFeedback,
}));

const IDLE: CoachFeedbackState = { status: 'idle' };

function form(activityId: string): FormData {
  const data = new FormData();
  data.set('activityId', activityId);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({
    userId: 'user-1',
    name: 'Gwen',
    email: 'gwen@trainarr.test',
  });
  mocks.generateActivityFeedback.mockResolvedValue(undefined);
});

describe('requestFeedbackAction — session', () => {
  it('refuse sans session, sans appeler le coach', async () => {
    mocks.getSession.mockResolvedValue(null);

    const state = await requestFeedbackAction(IDLE, form('42'));

    expect(state).toEqual({ status: 'error', message: SESSION_REQUIRED_MESSAGE });
    expect(mocks.generateActivityFeedback).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('rend le même refus quel que soit l’identifiant envoyé', async () => {
    // Ni « cette séance n'existe pas », ni « elle ne t'appartient pas » : le
    // refus ne dit rien de ce qu'il y a derrière.
    mocks.getSession.mockResolvedValue(null);

    const first = await requestFeedbackAction(IDLE, form('42'));
    const second = await requestFeedbackAction(IDLE, form('987654321'));
    const nonsense = await requestFeedbackAction(IDLE, form('pas-un-id'));

    expect(first).toEqual(second);
    expect(first).toEqual(nonsense);
  });
});

describe('requestFeedbackAction — avec session', () => {
  it('demande l’analyse puis revalide la page de la séance', async () => {
    const state = await requestFeedbackAction(IDLE, form('42'));

    expect(state).toEqual({ status: 'success' });
    expect(mocks.generateActivityFeedback).toHaveBeenCalledWith(42);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/activities/42');
  });

  it('refuse un identifiant qui n’en est pas un, sans appeler le coach', async () => {
    const state = await requestFeedbackAction(IDLE, form('0x2a'));

    expect(state).toEqual({ status: 'error', message: COACH_ACTIVITY_NOT_FOUND });
    expect(mocks.generateActivityFeedback).not.toHaveBeenCalled();
  });
});
