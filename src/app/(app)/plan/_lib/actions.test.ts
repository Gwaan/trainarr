import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanAction, type PlanFormState } from './actions';
import { earliestPlanStart, latestPlanStart, latestRaceDate } from './plan-window';

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
  startsOn: '',
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

/** Date de course la plus lointaine acceptée quand le départ reste au défaut. */
const LATEST_RACE = latestRaceDate(earliestPlanStart(TODAY));

describe('createPlanAction — date de course', () => {
  it('accepte la course la plus lointaine que le plan puisse couvrir', async () => {
    const state = await createPlanAction(IDLE, form({ raceDate: LATEST_RACE }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ goalType: 'race', raceDate: LATEST_RACE }),
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

describe('createPlanAction — date de démarrage', () => {
  it('laisse le service appliquer son défaut quand le champ est vide', async () => {
    const state = await createPlanAction(IDLE, form());

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ startsOn: undefined }),
    );
  });

  it('transmet le lundi choisi', async () => {
    const startsOn = latestPlanStart(TODAY);
    // La course est repoussée d'autant : les deux dates doivent rester cohérentes.
    const state = await createPlanAction(IDLE, form({ startsOn, raceDate: '2026-11-15' }));

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(expect.objectContaining({ startsOn }));
  });

  it('refuse un démarrage passé, sur le champ, sans appeler le coach', async () => {
    const state = await createPlanAction(IDLE, form({ startsOn: '2026-08-10' }));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.startsOn).toContain('au plus tôt le prochain lundi');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it('refuse un démarrage au-delà de huit semaines', async () => {
    const state = await createPlanAction(IDLE, form({ startsOn: '2026-10-12' }));

    expect(state.fieldErrors?.startsOn).toContain('Démarrage trop lointain');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it("refuse un jour qui n'est pas un lundi", async () => {
    const state = await createPlanAction(IDLE, form({ startsOn: '2026-08-19' }));

    expect(state.fieldErrors?.startsOn).toContain('démarre un lundi');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it('refuse une course devenue trop proche du démarrage choisi, sur ce champ-là', async () => {
    // Course le 13 septembre, départ le 31 août : plus que deux semaines.
    const state = await createPlanAction(
      IDLE,
      form({ startsOn: '2026-08-31', raceDate: '2026-09-13' }),
    );

    expect(state.status).toBe('error');
    // Le refus porte sur la date que l'athlète peut déplacer, pas sur sa course.
    expect(state.fieldErrors?.startsOn).toContain('au moins 3 semaines');
    expect(state.fieldErrors?.raceDate).toBeUndefined();
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it("signale l'incohérence sur la course tant qu'aucun démarrage n'est choisi", async () => {
    const state = await createPlanAction(IDLE, form({ raceDate: '2026-08-30' }));

    expect(state.fieldErrors?.raceDate).toContain('au moins 3 semaines');
    expect(mocks.generatePlan).not.toHaveBeenCalled();
  });

  it('accepte un objectif libre démarrant plus tard', async () => {
    const state = await createPlanAction(
      IDLE,
      form({ goalType: 'free', weeks: '8', raceDate: '', startsOn: '2026-09-07' }),
    );

    expect(state.status).toBe('success');
    expect(mocks.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ goalType: 'free', weeks: 8, startsOn: '2026-09-07' }),
    );
  });
});
