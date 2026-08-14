import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AthleteNotFoundError, InvalidIntervalsSettingsError } from '@/data/athlete';
import { SecretKeyUnavailableError } from '@/lib/crypto/secret-box';

import { saveIntervalsAction } from './intervals-actions';
import { CLEAR_API_KEY_VALUE, INTERVALS_FORM_IDLE } from './intervals-state';

vi.mock('server-only', () => ({}));

/**
 * L'action est mince : seule la traduction formulaire → DAL et le rendu des
 * refus lui appartiennent. Le DAL et l'invalidation du cache sont donc simulés.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    saveIntervalsSettings: vi.fn(),
    revalidatePath: vi.fn(),
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock('@/data/athlete', async (importOriginal) => ({
  // Les bornes et les erreurs typées restent les vraies.
  ...(await importOriginal<typeof import('@/data/athlete')>()),
  saveIntervalsSettings: mocks.saveIntervalsSettings,
}));

const KEY = 'k'.repeat(40);

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveIntervalsSettings.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveIntervalsAction', () => {
  it('enregistre une clé saisie et son identifiant', async () => {
    const state = await saveIntervalsAction(
      INTERVALS_FORM_IDLE,
      form({ intervalsAthleteId: 'i671024', apiKey: KEY }),
    );

    expect(mocks.saveIntervalsSettings).toHaveBeenCalledWith({
      intervalsAthleteId: 'i671024',
      apiKey: KEY,
    });
    expect(state.status).toBe('success');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('conserve la clé enregistrée quand seul l’identifiant change', async () => {
    const state = await saveIntervalsAction(
      INTERVALS_FORM_IDLE,
      form({ intervalsAthleteId: 'i42', apiKey: '' }),
    );

    expect(mocks.saveIntervalsSettings).toHaveBeenCalledWith({ intervalsAthleteId: 'i42' });
    expect(state.message).toBe('Réglages intervals.icu enregistrés.');
  });

  it('efface la clé quand la case est cochée', async () => {
    const state = await saveIntervalsAction(
      INTERVALS_FORM_IDLE,
      form({ intervalsAthleteId: 'i42', apiKey: '', clearApiKey: CLEAR_API_KEY_VALUE }),
    );

    expect(mocks.saveIntervalsSettings).toHaveBeenCalledWith({
      intervalsAthleteId: 'i42',
      apiKey: null,
    });
    expect(state.message).toContain('effacée');
  });

  it('refuse un effacement doublé d’une saisie, sans rien écrire', async () => {
    const state = await saveIntervalsAction(
      INTERVALS_FORM_IDLE,
      form({ apiKey: KEY, clearApiKey: CLEAR_API_KEY_VALUE }),
    );

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.apiKey).toEqual(expect.any(String));
    expect(mocks.saveIntervalsSettings).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ne renvoie jamais la clé saisie au client', async () => {
    const state = await saveIntervalsAction(
      INTERVALS_FORM_IDLE,
      form({ intervalsAthleteId: 'i1', apiKey: KEY }),
    );

    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it('reporte une erreur de bornes du DAL sur son champ', async () => {
    mocks.saveIntervalsSettings.mockRejectedValue(
      new InvalidIntervalsSettingsError('intervalsAthleteId', 'Identifiant trop long.'),
    );

    const state = await saveIntervalsAction(INTERVALS_FORM_IDLE, form({ apiKey: KEY }));

    expect(state).toEqual({
      status: 'error',
      fieldErrors: { intervalsAthleteId: 'Identifiant trop long.' },
      message: 'Corrige les champs signalés.',
    });
  });

  it('renvoie vers la création quand le compte n’a pas encore d’athlète', async () => {
    mocks.saveIntervalsSettings.mockRejectedValue(new AthleteNotFoundError());

    const state = await saveIntervalsAction(INTERVALS_FORM_IDLE, form({ apiKey: KEY }));

    expect(state.status).toBe('error');
    expect(state.message).toContain('Aucun profil enregistré');
  });

  it("dit qu'aucune clé n'a été stockée quand l'installation n'a pas de secret", async () => {
    mocks.saveIntervalsSettings.mockRejectedValue(new SecretKeyUnavailableError('vide'));

    const state = await saveIntervalsAction(INTERVALS_FORM_IDLE, form({ apiKey: KEY }));

    expect(state.status).toBe('error');
    expect(state.message).toContain('BETTER_AUTH_SECRET');
    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it('ne laisse fuir aucune trace d’exécution vers le client', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.saveIntervalsSettings.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432'),
    );

    const state = await saveIntervalsAction(INTERVALS_FORM_IDLE, form({ apiKey: KEY }));

    expect(state.status).toBe('error');
    expect(JSON.stringify(state)).not.toContain('ECONNREFUSED');
    expect(logged).toHaveBeenCalled();
  });
});
