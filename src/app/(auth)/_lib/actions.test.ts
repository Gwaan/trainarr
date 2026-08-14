import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_PASSWORD_MIN_LENGTH } from '@/lib/auth/limits';
import { APIError } from 'better-auth/api';

import {
  createFirstAccountAction,
  createInvitedAccountAction,
  signInAction,
} from './actions';
import type { AuthFormState } from './form-state';
import { getAuth } from '@/lib/auth';
import { generateInvitationToken } from '@/lib/auth/invitation-token';
import { INVITATION_UNUSABLE_MESSAGE, InvitationUnusableError, consumeInvitation } from '@/data/invitations';
import { redirect } from 'next/navigation';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));

// `redirect()` lève une exception de contrôle : on la reproduit pour vérifier
// que rien ne s'exécute derrière.
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

/**
 * `@/lib/auth` est remplacé : l'importer vraiment construirait l'instance
 * better-auth, son adaptateur Drizzle et le client Postgres, dont ces actions
 * n'ont pas besoin pour être éprouvées.
 *
 * Les constantes, elles, viennent des vrais modules — leur valeur exacte fait
 * partie de ce qui est vérifié ici (le seuil affiché dans un message d'erreur,
 * le code que l'action reconnaît).
 */
vi.mock('@/lib/auth', async () => {
  const limits = await vi.importActual<typeof import('@/lib/auth/limits')>(
    '@/lib/auth/limits',
  );
  const guard = await vi.importActual<typeof import('@/lib/auth/sign-up-guard')>(
    '@/lib/auth/sign-up-guard',
  );

  return {
    ...limits,
    SIGN_UP_CLOSED_CODE: guard.SIGN_UP_CLOSED_CODE,
    SIGN_UP_CLOSED_MESSAGE: guard.SIGN_UP_CLOSED_MESSAGE,
    authUnavailableMessage: vi.fn(() => null),
    getAuth: vi.fn(),
  };
});

/**
 * Le DAL des invitations est remplacé par un espion, mais **ses règles restent
 * les vraies** : la classe d'erreur et le message viennent du module réel — ce
 * sont eux que l'action doit reconnaître et rendre tels quels.
 */
vi.mock('@/data/invitations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/invitations')>()),
  consumeInvitation: vi.fn(),
}));

const { SIGN_UP_CLOSED_CODE, SIGN_UP_CLOSED_MESSAGE } = await import(
  '@/lib/auth/sign-up-guard'
);

const consumeInvitationMock = vi.mocked(consumeInvitation);

const getAuthMock = vi.mocked(getAuth);
const redirectMock = vi.mocked(redirect);

/** Dérivé de la borne : relever le minimum ne doit pas casser ces tests. */
const VALID_PASSWORD = 'a'.repeat(AUTH_PASSWORD_MIN_LENGTH);

const IDLE: AuthFormState = { status: 'idle' };

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/** Une instance better-auth réduite à ce que les actions en utilisent. */
function authStub(overrides: {
  signInEmail?: () => Promise<unknown>;
  signUpEmail?: () => Promise<unknown>;
}) {
  return {
    api: {
      signInEmail: overrides.signInEmail ?? (() => Promise.resolve({})),
      signUpEmail: overrides.signUpEmail ?? (() => Promise.resolve({})),
    },
  } as unknown as ReturnType<typeof getAuth>;
}

beforeEach(() => {
  getAuthMock.mockReset();
  redirectMock.mockClear();
  consumeInvitationMock.mockReset();
  vi.restoreAllMocks();
});

describe('signInAction', () => {
  it('signale les champs vides sans toucher à better-auth', async () => {
    const state = await signInAction(IDLE, formData({ email: '  ', password: '' }));

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.email).toBeDefined();
    expect(state.fieldErrors?.password).toBeDefined();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('ouvre la session puis renvoie à l\'accueil', async () => {
    getAuthMock.mockReturnValue(authStub({}));

    await expect(
      signInAction(IDLE, formData({ email: 'gwen@example.test', password: VALID_PASSWORD })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenCalledWith('/');
  });

  it("oppose le même refus à un compte inconnu et à un mot de passe faux", async () => {
    // better-auth répond déjà la même erreur dans les deux cas ; ce test fige la
    // conséquence côté écran : rien ne dit à un inconnu quels comptes existent.
    const refuse = () =>
      Promise.reject(
        new APIError('UNAUTHORIZED', {
          message: 'Invalid email or password',
          code: 'INVALID_EMAIL_OR_PASSWORD',
        }),
      );

    getAuthMock.mockReturnValue(authStub({ signInEmail: refuse }));
    const unknownAccount = await signInAction(
      IDLE,
      formData({ email: 'inconnu@example.test', password: VALID_PASSWORD }),
    );

    getAuthMock.mockReturnValue(authStub({ signInEmail: refuse }));
    const wrongPassword = await signInAction(
      IDLE,
      formData({ email: 'gwen@example.test', password: 'mauvais-mot-de-passe' }),
    );

    expect(unknownAccount.message).toBe(wrongPassword.message);
    expect(unknownAccount).toEqual({ status: 'error', message: 'E-mail ou mot de passe incorrect.' });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('rend le même refus générique sur une panne, sans en laisser filer la trace', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getAuthMock.mockReturnValue(
      authStub({
        signInEmail: () => Promise.reject(new Error('connexion à la base refusée')),
      }),
    );

    const state = await signInAction(
      IDLE,
      formData({ email: 'gwen@example.test', password: VALID_PASSWORD }),
    );

    expect(state).toEqual({ status: 'error', message: 'E-mail ou mot de passe incorrect.' });
    expect(JSON.stringify(state)).not.toContain('base');
    expect(consoleError).toHaveBeenCalledOnce();
  });
});

describe('createFirstAccountAction', () => {
  it('refuse un mot de passe trop court avant tout appel', async () => {
    const state = await createFirstAccountAction(
      IDLE,
      formData({
        name: 'Gwen',
        email: 'gwen@example.test',
        password: 'court',
        passwordConfirm: 'court',
      }),
    );

    expect(state.fieldErrors?.password).toContain(String(AUTH_PASSWORD_MIN_LENGTH));
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it("refuse deux saisies différentes, et le dit sur la confirmation", async () => {
    // Le formulaire contrôle déjà cette égalité ; ce test fige le fait que
    // l'action ne s'y fie pas — elle est appelable sans lui.
    const state = await createFirstAccountAction(
      IDLE,
      formData({
        name: 'Gwen',
        email: 'gwen@example.test',
        password: VALID_PASSWORD,
        passwordConfirm: `${VALID_PASSWORD}x`,
      }),
    );

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.passwordConfirm).toBeDefined();
    // L'erreur se pose sur la confirmation, jamais sur le mot de passe : c'est
    // la seconde frappe qu'on corrige.
    expect(state.fieldErrors?.password).toBeUndefined();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('refuse une confirmation absente — le champ manquant ne vaut pas accord', async () => {
    const state = await createFirstAccountAction(
      IDLE,
      formData({
        name: 'Gwen',
        email: 'gwen@example.test',
        password: VALID_PASSWORD,
      }),
    );

    expect(state.fieldErrors?.passwordConfirm).toBeDefined();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('refuse une adresse e-mail invalide', async () => {
    const state = await createFirstAccountAction(
      IDLE,
      formData({
        name: 'Gwen',
        email: 'pas-un-email',
        password: VALID_PASSWORD,
        passwordConfirm: VALID_PASSWORD,
      }),
    );

    expect(state.fieldErrors?.email).toBeDefined();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it("crée le compte puis renvoie à l'accueil, déjà connectée", async () => {
    getAuthMock.mockReturnValue(authStub({}));

    await expect(
      createFirstAccountAction(
        IDLE,
        formData({
          name: 'Gwen',
          email: 'gwen@example.test',
          password: VALID_PASSWORD,
          passwordConfirm: VALID_PASSWORD,
        }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenCalledWith('/');
  });

  it('reprend le refus du crochet quand la porte s\'est refermée entre-temps', async () => {
    getAuthMock.mockReturnValue(
      authStub({
        signUpEmail: () =>
          Promise.reject(
            new APIError('FORBIDDEN', { message: SIGN_UP_CLOSED_MESSAGE, code: SIGN_UP_CLOSED_CODE }),
          ),
      }),
    );

    const state = await createFirstAccountAction(
      IDLE,
      formData({
        name: 'Gwen',
        email: 'gwen@example.test',
        password: VALID_PASSWORD,
        passwordConfirm: VALID_PASSWORD,
      }),
    );

    expect(state).toEqual({ status: 'error', message: SIGN_UP_CLOSED_MESSAGE });
  });

  it('reste générique quand la course sur l\'index unique est perdue', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Le perdant reçoit ce que better-auth fait d'une violation de contrainte.
    getAuthMock.mockReturnValue(
      authStub({
        signUpEmail: () =>
          Promise.reject(
            new APIError('UNPROCESSABLE_ENTITY', {
              message: 'Failed to create user',
              code: 'FAILED_TO_CREATE_USER',
            }),
          ),
      }),
    );

    const state = await createFirstAccountAction(
      IDLE,
      formData({
        name: 'Gwen',
        email: 'gwen@example.test',
        password: VALID_PASSWORD,
        passwordConfirm: VALID_PASSWORD,
      }),
    );

    expect(state).toEqual({ status: 'error', message: "Le compte n'a pas pu être créé. Réessaie." });
    expect(consoleError).toHaveBeenCalledOnce();
  });
});

describe('createInvitedAccountAction', () => {
  const TOKEN = generateInvitationToken();

  /** Le formulaire complet, jeton compris — le champ caché de l'écran d'invitation. */
  function invitedForm(overrides: Record<string, string> = {}): FormData {
    return formData({
      name: 'Alex',
      email: 'alex@example.test',
      password: VALID_PASSWORD,
      passwordConfirm: VALID_PASSWORD,
      token: TOKEN,
      ...overrides,
    });
  }

  /** Une consommation qui aboutit : le DAL exécute le rappel de création. */
  function consumptionSucceeds(): void {
    consumeInvitationMock.mockImplementation(async (_token, createAccount) => {
      await createAccount();
    });
  }

  it('crée le compte à travers la consommation du jeton, puis renvoie à l\'accueil', async () => {
    const signUpEmail = vi.fn(() => Promise.resolve({ user: { id: 'u-new' } }));
    getAuthMock.mockReturnValue(authStub({ signUpEmail }));
    consumptionSucceeds();

    await expect(createInvitedAccountAction(IDLE, invitedForm())).rejects.toThrow(
      'NEXT_REDIRECT',
    );

    // Le jeton part au DAL, et la création n'est qu'un rappel qu'il déclenche :
    // il n'y a pas de chemin où l'un s'exécute sans l'autre.
    expect(consumeInvitationMock).toHaveBeenCalledOnce();
    expect(consumeInvitationMock.mock.calls[0]?.[0]).toBe(TOKEN);
    expect(signUpEmail).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith('/');
  });

  it("n'inscrit personne quand le lien n'ouvre rien", async () => {
    const signUpEmail = vi.fn(() => Promise.resolve({ user: { id: 'u-new' } }));
    getAuthMock.mockReturnValue(authStub({ signUpEmail }));
    consumeInvitationMock.mockRejectedValue(new InvitationUnusableError());

    const state = await createInvitedAccountAction(IDLE, invitedForm());

    // Le rappel n'a jamais été appelé : better-auth n'a rien vu passer.
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(state).toEqual({ status: 'error', message: INVITATION_UNUSABLE_MESSAGE });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('oppose le même refus à un lien inconnu, expiré, révoqué ou déjà servi', async () => {
    getAuthMock.mockReturnValue(authStub({}));

    // Mal formé : refusé avant même d'atteindre la base.
    const malformed = await createInvitedAccountAction(
      IDLE,
      invitedForm({ token: 'pas-un-jeton' }),
    );
    // Refusé par la base, pour l'une quelconque des quatre raisons.
    consumeInvitationMock.mockRejectedValue(new InvitationUnusableError());
    const refused = await createInvitedAccountAction(IDLE, invitedForm());

    expect(malformed).toEqual(refused);
    expect(malformed.message).toBe(INVITATION_UNUSABLE_MESSAGE);
  });

  it('ne touche ni au DAL ni à better-auth quand le jeton est mal formé', async () => {
    getAuthMock.mockReturnValue(authStub({}));

    await createInvitedAccountAction(IDLE, invitedForm({ token: '' }));

    expect(consumeInvitationMock).not.toHaveBeenCalled();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('vérifie les mêmes bornes que la création du premier compte', async () => {
    getAuthMock.mockReturnValue(authStub({}));

    const short = await createInvitedAccountAction(
      IDLE,
      invitedForm({ password: 'court', passwordConfirm: 'court' }),
    );
    const mismatch = await createInvitedAccountAction(
      IDLE,
      invitedForm({ passwordConfirm: `${VALID_PASSWORD}x` }),
    );

    expect(short.fieldErrors?.password).toContain(String(AUTH_PASSWORD_MIN_LENGTH));
    expect(mismatch.fieldErrors?.passwordConfirm).toBeDefined();
    expect(consumeInvitationMock).not.toHaveBeenCalled();
  });

  it("dit qu'une adresse est déjà prise — le lien, lui, n'a pas été dépensé", async () => {
    getAuthMock.mockReturnValue(authStub({}));
    consumeInvitationMock.mockRejectedValue(
      new APIError('UNPROCESSABLE_ENTITY', {
        message: 'User already exists. Use another email.',
        code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
      }),
    );

    const state = await createInvitedAccountAction(IDLE, invitedForm());

    expect(state.fieldErrors?.email).toBeDefined();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('ne laisse jamais filer le jeton, ni au client ni dans les journaux', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getAuthMock.mockReturnValue(authStub({}));
    consumeInvitationMock.mockRejectedValue(new Error('base injoignable'));

    const state = await createInvitedAccountAction(IDLE, invitedForm());

    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TOKEN);
    expect(state).toEqual({ status: 'error', message: "Le compte n'a pas pu être créé. Réessaie." });
  });
});
