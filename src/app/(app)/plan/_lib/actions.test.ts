import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanAction, type PlanFormState } from './actions';
import { latestRaceDate } from './plan-window';

vi.mock('server-only', () => ({}));

/**
 * L'action est mince : seule sa validation lui appartient. Ce qu'on éprouve ici,
 * c'est la borne calendaire rendue à l'utilisatrice — une course hors de portée
 * doit être refusée sur son champ, avant les minutes d'attente d'une génération.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    generatePlan: vi.fn(),
    updatePlanFromInstruction: vi.fn(),
    revalidatePath: vi.fn(),
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock('@/lib/ai/plan-service', async (importOriginal) => ({
  // La fenêtre du plan et ses bornes restent le vrai code : la validation de
  // l'action doit rester alignée sur celle du service.
  ...(await importOriginal<typeof import('@/lib/ai/plan-service')>()),
  generatePlan: mocks.generatePlan,
  updatePlanFromInstruction: mocks.updatePlanFromInstruction,
}));

const IDLE: PlanFormState = { status: 'idle' };

/** Aujourd'hui : mardi 11 août 2026 — le plan démarrerait le lundi 17. */
const TODAY = '2026-08-11';

const VALID_FIELDS: Record<string, string> = {
  goalType: 'race',
  goalText: '10 km sous 50 min',
  raceDate: '2026-09-13',
  weeks: '',
  sessionsPerWeek: '3',
  weeklyTimeHours: '',
  longRunDay: '7',
};

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries({ ...VALID_FIELDS, ...overrides })) {
    data.set(name, value);
  }
  return data;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T09:00:00.000Z`));
  vi.clearAllMocks();
  mocks.generatePlan.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPlanAction — date de course', () => {
  it('accepte la course la plus lointaine que le plan puisse couvrir', async () => {
    const state = await createPlanAction(IDLE, form({ raceDate: latestRaceDate(TODAY) }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ goalType: 'race', raceDate: latestRaceDate(TODAY) }),
    );
  });

  it('refuse le lendemain de cette date, sur le champ, sans appeler le coach', async () => {
    const state = await createPlanAction(IDLE, form({ raceDate: '2027-08-16' }));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.raceDate).toContain('Course trop lointaine');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuse toujours une course passée', async () => {
    const state = await createPlanAction(IDLE, form({ raceDate: '2026-08-10' }));

    expect(state.fieldErrors?.raceDate).toContain('à venir');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });
});
