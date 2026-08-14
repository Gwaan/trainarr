import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'better-auth/api';
import { redirect } from 'next/navigation';

import { AUTH_PASSWORD_MIN_LENGTH } from '@/lib/auth/limits';
import { getAuth } from '@/lib/auth';

import {
  changeAccountPasswordAction,
  signOutAction,
  updateAccountNameAction,
} from './account-actions';
import { ACCOUNT_FORM_IDLE } from './account-state';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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
 * n'ont pas besoin pour être éprouvées. Les bornes, elles, viennent du vrai
 * module — leur valeur fait partie de ce qui est vérifié ici.
 */
vi.mock('@/lib/auth', async () => {
  const limits = await vi.importActual<typeof import('@/lib/auth/limits')>(
    '@/lib/auth/limits',
  );

  return {
    ...limits,
    authUnavailableMessage: vi.fn(() => null),
    getAuth: vi.fn(),
  };
});

const getAuthMock = vi.mocked(getAuth);
const redirectMock = vi.mocked(redirect);

/** Dérivé de la borne : relever le minimum ne doit pas casser ces tests. */
const VALID_PASSWORD = 'a'.repeat(AUTH_PASSWORD_MIN_LENGTH);
const NEW_PASSWORD = 'b'.repeat(AUTH_PASSWORD_MIN_LENGTH);

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

type ApiCall = (input: unknown) => Promise<unknown>;

/** Une instance better-auth réduite à ce que ces actions en utilisent. */
function authStub(overrides: {
  updateUser?: ApiCall;
  changePassword?: ApiCall;
  signOut?: ApiCall;
}) {
  return {
    api: {
      updateUser: overrides.updateUser ?? (() => Promise.resolve({ status: true })),
      changePassword: overrides.changePassword ?? (() => Promise.resolve({ token: null })),
      signOut: overrides.signOut ?? (() => Promise.resolve({ success: true })),
    },
  } as unknown as ReturnType<typeof getAuth>;
}

const unauthorized = () =>
  Promise.reject(
    new APIError('UNAUTHORIZED', { message: 'Unauthorized', code: 'UNAUTHORIZED' }),
  );

beforeEach(() => {
  getAuthMock.mockReset();
  redirectMock.mockClear();
  vi.restoreAllMocks();
});

describe('updateAccountNameAction', () => {
  it('refuse un nom vide sans toucher à better-auth', async () => {
    const state = await updateAccountNameAction(
      ACCOUNT_FORM_IDLE,
      formData({ name: '   ' }),
    );

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.name).toBeDefined();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it("désigne le compte par les en-têtes, jamais par le formulaire", async () => {
    const updateUser = vi.fn<ApiCall>().mockResolvedValue({ status: true });
    getAuthMock.mockReturnValue(authStub({ updateUser }));

    // `userId` est ignoré : rien dans le corps ne dit *qui* est modifié.
    const state = await updateAccountNameAction(
      ACCOUNT_FORM_IDLE,
      formData({ name: '  Gwen  ', userId: 'quelqu-un-d-autre' }),
    );

    expect(state.status).toBe('success');
    expect(updateUser).toHaveBeenCalledOnce();
    const [input] = updateUser.mock.calls[0] ?? [];
    expect(input).toEqual({ body: { name: 'Gwen' }, headers: expect.any(Headers) });
  });

  it('invite à se reconnecter quand la session a disparu entre-temps', async () => {
    getAuthMock.mockReturnValue(authStub({ updateUser: unauthorized }));

    const state = await updateAccountNameAction(
      ACCOUNT_FORM_IDLE,
      formData({ name: 'Gwen' }),
    );

    expect(state.status).toBe('error');
    expect(state.message).toContain('Reconnecte-toi');
  });

  it('reste générique sur une panne, sans en laisser filer la trace', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getAuthMock.mockReturnValue(
      authStub({
        updateUser: () => Promise.reject(new Error('connexion à la base refusée')),
      }),
    );

    const state = await updateAccountNameAction(
      ACCOUNT_FORM_IDLE,
      formData({ name: 'Gwen' }),
    );

    expect(state.status).toBe('error');
    expect(JSON.stringify(state)).not.toContain('base');
    expect(consoleError).toHaveBeenCalledOnce();
  });
});

describe('changeAccountPasswordAction', () => {
  it('exige le mot de passe actuel avant tout appel', async () => {
    const state = await changeAccountPasswordAction(
      ACCOUNT_FORM_IDLE,
      formData({
        currentPassword: '',
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      }),
    );

    expect(state.fieldErrors?.currentPassword).toBeDefined();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('refuse deux saisies différentes, et le dit sur la confirmation', async () => {
    const state = await changeAccountPasswordAction(
      ACCOUNT_FORM_IDLE,
      formData({
        currentPassword: VALID_PASSWORD,
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: `${NEW_PASSWORD}x`,
      }),
    );

    expect(state.fieldErrors?.newPasswordConfirm).toBeDefined();
    expect(state.fieldErrors?.newPassword).toBeUndefined();
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('refuse un nouveau mot de passe trop court', async () => {
    const state = await changeAccountPasswordAction(
      ACCOUNT_FORM_IDLE,
      formData({
        currentPassword: VALID_PASSWORD,
        newPassword: 'court',
        newPasswordConfirm: 'court',
      }),
    );

    expect(state.fieldErrors?.newPassword).toContain(String(AUTH_PASSWORD_MIN_LENGTH));
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it('révoque les autres sessions et ne renvoie ni jeton ni utilisateur', async () => {
    const changePassword = vi.fn<ApiCall>().mockResolvedValue({
      token: 'jeton-de-session-tout-neuf',
      user: { id: 'user_1', email: 'gwen@example.test', name: 'Gwen' },
    });
    getAuthMock.mockReturnValue(authStub({ changePassword }));

    const state = await changeAccountPasswordAction(
      ACCOUNT_FORM_IDLE,
      formData({
        currentPassword: VALID_PASSWORD,
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      }),
    );

    const [input] = changePassword.mock.calls[0] ?? [];
    expect(input).toEqual({
      body: {
        currentPassword: VALID_PASSWORD,
        newPassword: NEW_PASSWORD,
        // Une session volée ne doit pas survivre à la rotation du mot de passe.
        revokeOtherSessions: true,
      },
      headers: expect.any(Headers),
    });
    expect(state.status).toBe('success');
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('jeton-de-session-tout-neuf');
    expect(serialized).not.toContain('gwen@example.test');
    expect(serialized).not.toContain(NEW_PASSWORD);
  });

  it('signale un mot de passe actuel faux sur son propre champ', async () => {
    getAuthMock.mockReturnValue(
      authStub({
        changePassword: () =>
          Promise.reject(
            new APIError('BAD_REQUEST', {
              message: 'Invalid password',
              code: 'INVALID_PASSWORD',
            }),
          ),
      }),
    );

    const state = await changeAccountPasswordAction(
      ACCOUNT_FORM_IDLE,
      formData({
        currentPassword: 'mauvais-mot-de-passe',
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      }),
    );

    expect(state.status).toBe('error');
    expect(state.fieldErrors?.currentPassword).toBe('Mot de passe actuel incorrect.');
  });

  it('invite à se reconnecter quand la session a disparu entre-temps', async () => {
    getAuthMock.mockReturnValue(authStub({ changePassword: unauthorized }));

    const state = await changeAccountPasswordAction(
      ACCOUNT_FORM_IDLE,
      formData({
        currentPassword: VALID_PASSWORD,
        newPassword: NEW_PASSWORD,
        newPasswordConfirm: NEW_PASSWORD,
      }),
    );

    expect(state.status).toBe('error');
    expect(state.message).toContain('Reconnecte-toi');
  });
});

describe('signOutAction', () => {
  it("ferme la session puis renvoie à l'écran de connexion", async () => {
    const signOut = vi.fn<ApiCall>().mockResolvedValue({ success: true });
    getAuthMock.mockReturnValue(authStub({ signOut }));

    await expect(signOutAction()).rejects.toThrow('NEXT_REDIRECT');
    // Les en-têtes portent le cookie : c'est ce qui désigne la session à fermer
    // et ce qui permet à better-auth de la faire expirer côté navigateur.
    expect(signOut).toHaveBeenCalledWith({ headers: expect.any(Headers) });
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it("dit l'échec au lieu de l'avaler — se croire sortie serait pire", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getAuthMock.mockReturnValue(
      authStub({ signOut: () => Promise.reject(new Error('base injoignable')) }),
    );

    const state = await signOutAction();

    expect(state.status).toBe('error');
    expect(state.message).toContain('toujours connectée');
    expect(JSON.stringify(state)).not.toContain('injoignable');
    expect(consoleError).toHaveBeenCalledOnce();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("ne prétend pas déconnecter quand l'authentification n'est pas configurée", async () => {
    getAuthMock.mockReturnValue(null);

    const state = await signOutAction();

    expect(state.status).toBe('error');
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
