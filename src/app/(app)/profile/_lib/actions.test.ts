import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AthleteOwnerRequiredError, InvalidAthleteProfileError } from '@/data/athlete';

import { saveProfileAction, type ProfileFormState } from './actions';
import { CLEAR_API_KEY_VALUE } from './intervals-state';

vi.mock('server-only', () => ({}));

/**
 * L'action est mince : seule sa validation lui appartient. Le DAL, la reprise
 * des imports et l'invalidation du cache sont donc simulés — ce qu'on éprouve
 * ici, ce sont les bornes rendues à l'utilisateur et l'enchaînement
 * création → reprise.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    hasAthlete: vi.fn(),
    getCurrentAthleteId: vi.fn(),
    createAthlete: vi.fn(),
    updateAthleteProfile: vi.fn(),
    saveIntervalsSettings: vi.fn(),
    recoverPendingImports: vi.fn(),
    revalidatePath: vi.fn(),
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock('@/lib/fit/recover', () => ({ recoverPendingImports: mocks.recoverPendingImports }));

vi.mock('@/data/athlete', async (importOriginal) => ({
  // Les bornes, les erreurs typées et les helpers de date restent les vrais :
  // la validation de l'action doit rester alignée sur celle du DAL.
  ...(await importOriginal<typeof import('@/data/athlete')>()),
  hasAthlete: mocks.hasAthlete,
  getCurrentAthleteId: mocks.getCurrentAthleteId,
  createAthlete: mocks.createAthlete,
  updateAthleteProfile: mocks.updateAthleteProfile,
  saveIntervalsSettings: mocks.saveIntervalsSettings,
}));

const IDLE: ProfileFormState = { status: 'idle' };

const VALID_FIELDS: Record<string, string> = {
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: '191',
  restingHrBpm: '48',
  weightKg: '68.4',
  birthDate: '1990-04-17',
};

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries({ ...VALID_FIELDS, ...overrides })) {
    data.set(name, value);
  }
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasAthlete.mockResolvedValue(false);
  mocks.getCurrentAthleteId.mockResolvedValue(7);
  mocks.createAthlete.mockResolvedValue(undefined);
  mocks.updateAthleteProfile.mockResolvedValue(undefined);
  mocks.saveIntervalsSettings.mockResolvedValue(undefined);
  mocks.recoverPendingImports.mockResolvedValue({ requeued: 0, backfillReopened: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveProfileAction — validation', () => {
  it('convertit le formulaire en profil typé', async () => {
    await saveProfileAction(IDLE, form({ displayName: '  Gwen  ' }));

    expect(mocks.createAthlete).toHaveBeenCalledWith({
      displayName: 'Gwen',
      sex: 'female',
      maxHrBpm: 191,
      restingHrBpm: 48,
      weightKg: 68.4,
      birthDate: '1990-04-17',
    });
  });

  it('accepte la virgule décimale française pour le poids', async () => {
    await saveProfileAction(IDLE, form({ weightKg: '62,5' }));

    expect(mocks.createAthlete).toHaveBeenCalledWith(
      expect.objectContaining({ weightKg: 62.5 }),
    );
  });

  it('traite les champs facultatifs laissés vides comme non renseignés', async () => {
    await saveProfileAction(
      IDLE,
      form({ sex: '', maxHrBpm: '', restingHrBpm: '', weightKg: '', birthDate: '' }),
    );

    expect(mocks.createAthlete).toHaveBeenCalledWith({
      displayName: 'Gwen',
      sex: null,
      maxHrBpm: null,
      restingHrBpm: null,
      weightKg: null,
      birthDate: null,
    });
  });

  it.each([
    ['nom vide', { displayName: '  ' }, 'displayName'],
    ['nom trop long', { displayName: 'a'.repeat(101) }, 'displayName'],
    ['sexe inattendu', { sex: 'autre' }, 'sex'],
    ['FC max sous la borne', { maxHrBpm: '99' }, 'maxHrBpm'],
    ['FC max au-dessus de la borne', { maxHrBpm: '231' }, 'maxHrBpm'],
    ['FC max non numérique', { maxHrBpm: 'beaucoup' }, 'maxHrBpm'],
    ['FC max décimale', { maxHrBpm: '190,5' }, 'maxHrBpm'],
    ['FC de repos sous la borne', { restingHrBpm: '24' }, 'restingHrBpm'],
    ['FC de repos au-dessus de la borne', { restingHrBpm: '101' }, 'restingHrBpm'],
    ['poids sous la borne', { weightKg: '29.9' }, 'weightKg'],
    ['poids au-dessus de la borne', { weightKg: '200.1' }, 'weightKg'],
    ['date de naissance mal formée', { birthDate: '17/04/1990' }, 'birthDate'],
    ['date de naissance inexistante', { birthDate: '1990-02-31' }, 'birthDate'],
    ['date de naissance antérieure à 1900', { birthDate: '1899-12-31' }, 'birthDate'],
    ['date de naissance future', { birthDate: '2999-01-01' }, 'birthDate'],
  ])('refuse %s sans rien écrire', async (_label, overrides, field) => {
    const state = await saveProfileAction(IDLE, form(overrides));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.[field as keyof NonNullable<ProfileFormState['fieldErrors']>]).toEqual(
      expect.any(String),
    );
    expect(mocks.createAthlete).not.toHaveBeenCalled();
    expect(mocks.updateAthleteProfile).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('donne un message explicite pour la FC max', async () => {
    const state = await saveProfileAction(IDLE, form({ maxHrBpm: '250' }));

    expect(state.fieldErrors?.maxHrBpm).toContain('FC max entre 100 et 230');
  });

  it('refuse une FC de repos supérieure ou égale à la FC max', async () => {
    // Les deux valeurs sont dans leurs bornes respectives : seule leur relation
    // est fautive (100 est à la fois la FC max minimale et la FC de repos maximale).
    const state = await saveProfileAction(IDLE, form({ maxHrBpm: '100', restingHrBpm: '100' }));

    expect(state.fieldErrors?.restingHrBpm).toContain('inférieure à la FC max');
  });

  it('accepte les bornes incluses', async () => {
    const state = await saveProfileAction(
      IDLE,
      form({ maxHrBpm: '230', restingHrBpm: '25', weightKg: '30' }),
    );

    expect(state.status).toBe('success');
  });

  it('rapporte plusieurs champs fautifs en une fois', async () => {
    const state = await saveProfileAction(IDLE, form({ displayName: '', weightKg: '3' }));

    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(['displayName', 'weightKg']);
  });
});

describe('saveProfileAction — onboarding', () => {
  it('crée le profil puis relance les imports en attente', async () => {
    mocks.recoverPendingImports.mockResolvedValue({ requeued: 31, backfillReopened: true });

    const state = await saveProfileAction(IDLE, form());

    expect(mocks.createAthlete).toHaveBeenCalledTimes(1);
    // La reprise vise le dossier de l'athlète qui vient de naître : elle ne
    // ramasse jamais ce qui traîne à la racine de la boîte de dépôt.
    expect(mocks.recoverPendingImports).toHaveBeenCalledWith(7);
    expect(state).toEqual({
      status: 'success',
      message: 'Profil créé — 31 imports relancés, historique en cours de rapatriement.',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('accorde le message au singulier', async () => {
    mocks.recoverPendingImports.mockResolvedValue({ requeued: 1, backfillReopened: false });

    const state = await saveProfileAction(IDLE, form());

    expect(state.message).toBe('Profil créé — 1 import relancé.');
  });

  it('ne reprend rien quand l’athlète créé reste introuvable', async () => {
    // Cas de bord : la création a réussi mais la relecture ne rend rien (base
    // coupée entre les deux). Reprendre « pour personne » n'a aucun sens.
    mocks.getCurrentAthleteId.mockResolvedValue(null);

    const state = await saveProfileAction(IDLE, form());

    expect(mocks.recoverPendingImports).not.toHaveBeenCalled();
    expect(state).toEqual({ status: 'success', message: 'Profil créé.' });
  });

  it("reste un succès quand la reprise n'a rien pu faire", async () => {
    mocks.recoverPendingImports.mockResolvedValue({ requeued: 0, backfillReopened: false });

    await expect(saveProfileAction(IDLE, form())).resolves.toEqual({
      status: 'success',
      message: 'Profil créé.',
    });
  });
});

describe('saveProfileAction — édition', () => {
  it('met à jour le profil existant sans relancer les imports', async () => {
    mocks.hasAthlete.mockResolvedValue(true);

    const state = await saveProfileAction(IDLE, form());

    expect(mocks.updateAthleteProfile).toHaveBeenCalledTimes(1);
    expect(mocks.createAthlete).not.toHaveBeenCalled();
    expect(mocks.recoverPendingImports).not.toHaveBeenCalled();
    expect(state).toEqual({ status: 'success', message: 'Profil mis à jour.' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
});

describe('saveProfileAction — identifiants intervals.icu', () => {
  const KEY = 'k'.repeat(40);

  it('enregistre les identifiants saisis à la création', async () => {
    const state = await saveProfileAction(
      IDLE,
      form({ intervalsAthleteId: '  i671024 ', apiKey: `  ${KEY} ` }),
    );

    expect(mocks.saveIntervalsSettings).toHaveBeenCalledWith({
      intervalsAthleteId: 'i671024',
      apiKey: KEY,
    });
    expect(state.status).toBe('success');
    // La clé ne revient jamais vers le client, même en écho d'un succès.
    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it('accepte une création sans identifiants — ils restent facultatifs', async () => {
    const state = await saveProfileAction(IDLE, form());

    expect(mocks.saveIntervalsSettings).toHaveBeenCalledWith({ intervalsAthleteId: '' });
    expect(state.status).toBe('success');
  });

  it("n'y touche pas en édition, où ces champs ont leur propre formulaire", async () => {
    mocks.hasAthlete.mockResolvedValue(true);

    await saveProfileAction(IDLE, form({ intervalsAthleteId: 'i9', apiKey: KEY }));

    expect(mocks.saveIntervalsSettings).not.toHaveBeenCalled();
  });

  it('refuse un champ intervals.icu hors bornes sans créer le profil', async () => {
    const state = await saveProfileAction(IDLE, form({ apiKey: 'k'.repeat(257) }));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.apiKey).toEqual(expect.any(String));
    expect(mocks.createAthlete).not.toHaveBeenCalled();
    expect(mocks.saveIntervalsSettings).not.toHaveBeenCalled();
  });

  it('rapporte ensemble les champs physiologiques et intervals.icu fautifs', async () => {
    const state = await saveProfileAction(
      IDLE,
      form({ displayName: '', apiKey: KEY, clearApiKey: CLEAR_API_KEY_VALUE }),
    );

    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(['apiKey', 'displayName']);
  });

  it("dit que le profil est créé quand seuls les identifiants n'ont pas pu l'être", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.saveIntervalsSettings.mockRejectedValue(new Error('secret absent'));

    const state = await saveProfileAction(IDLE, form({ apiKey: KEY }));

    expect(state.status).toBe('error');
    expect(state.message).toContain('Profil créé');
    // Le profil existe : la page doit repasser en mode édition, où la section
    // dédiée permet de reprendre la clé.
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
    // La reprise des imports a bien eu lieu : elle ne se rejouerait jamais, la
    // création n'ayant lieu qu'une fois.
    expect(mocks.recoverPendingImports).toHaveBeenCalledWith(7);
    expect(JSON.stringify(state)).not.toContain(KEY);
    expect(logged).toHaveBeenCalled();
  });
});

describe('saveProfileAction — erreurs du DAL', () => {
  it("dit qu'une session est nécessaire plutôt qu'un échec générique", async () => {
    mocks.createAthlete.mockRejectedValue(new AthleteOwnerRequiredError());

    const state = await saveProfileAction(IDLE, form());

    expect(state.status).toBe('error');
    expect(state.message).toContain('reconnecte-toi');
  });

  it('reporte une erreur de bornes du DAL sur son champ', async () => {
    mocks.createAthlete.mockRejectedValue(
      new InvalidAthleteProfileError('weightKg', 'Poids hors bornes.'),
    );

    const state = await saveProfileAction(IDLE, form());

    expect(state).toEqual({
      status: 'error',
      fieldErrors: { weightKg: 'Poids hors bornes.' },
      message: 'Corrige les champs signalés.',
    });
  });

  it('ne laisse fuir aucune trace d’exécution vers le client', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.createAthlete.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    const state = await saveProfileAction(IDLE, form());

    expect(state.status).toBe('error');
    expect(JSON.stringify(state)).not.toContain('ECONNREFUSED');
    expect(logged).toHaveBeenCalled();
  });
});
