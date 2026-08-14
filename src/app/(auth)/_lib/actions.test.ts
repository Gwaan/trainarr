import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_PASSWORD_MIN_LENGTH } from '@/lib/auth/limits';
import { APIError } from 'better-auth/api';

import { createFirstAccountAction, signInAction } from './actions';
import type { AuthFormState } from './form-state';
import { getAuth } from '@/lib/auth';
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

const { SIGN_UP_CLOSED_CODE, SIGN_UP_CLOSED_MESSAGE } = await import(
  '@/lib/auth/sign-up-guard'
);

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
      formData({ name: 'Gwen', email: 'gwen@example.test', password: 'court' }),
    );

    expect(state.fieldErrors?.password).toContain(String(AUTH_PASSWORD_MIN_LENGTH));
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('refuse une adresse e-mail invalide', async () => {
    const state = await createFirstAccountAction(
      IDLE,
      formData({ name: 'Gwen', email: 'pas-un-email', password: VALID_PASSWORD }),
    );

    expect(state.fieldErrors?.email).toBeDefined();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it("crée le compte puis renvoie à l'accueil, déjà connectée", async () => {
    getAuthMock.mockReturnValue(authStub({}));

    await expect(
      createFirstAccountAction(
        IDLE,
        formData({ name: 'Gwen', email: 'gwen@example.test', password: VALID_PASSWORD }),
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
      formData({ name: 'Gwen', email: 'gwen@example.test', password: VALID_PASSWORD }),
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
      formData({ name: 'Gwen', email: 'gwen@example.test', password: VALID_PASSWORD }),
    );

    expect(state).toEqual({ status: 'error', message: "Le compte n'a pas pu être créé. Réessaie." });
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
