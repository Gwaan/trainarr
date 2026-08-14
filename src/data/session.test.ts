import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSession } from './session';
import { getAuth } from '@/lib/auth';

vi.mock('server-only', () => ({}));

// `headers()` n'existe qu'en contexte de requête ; on rend un jeu vide.
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));

vi.mock('@/lib/auth', () => ({ getAuth: vi.fn() }));

const getAuthMock = vi.mocked(getAuth);

/** L'objet que better-auth rend : bien plus large que ce que le DTO laisse passer. */
const FULL_SESSION = {
  user: {
    id: 'user_1',
    name: 'Gwen',
    email: 'gwen@example.test',
    emailVerified: false,
    image: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  session: {
    id: 'sess_1',
    token: 'jeton-de-session-secret',
    userId: 'user_1',
    expiresAt: new Date('2026-02-01T00:00:00Z'),
    ipAddress: '192.0.2.10',
    userAgent: 'Trainarr/1.0',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
};

/** Une instance better-auth réduite à ce que `getSession` en utilise. */
function authStub(getSessionImpl: () => Promise<unknown>) {
  return { api: { getSession: getSessionImpl } } as unknown as ReturnType<typeof getAuth>;
}

beforeEach(() => {
  getAuthMock.mockReset();
  vi.restoreAllMocks();
});

describe('getSession', () => {
  it("rend « pas de session » quand l'authentification n'est pas configurée", async () => {
    getAuthMock.mockReturnValue(null);

    await expect(getSession()).resolves.toBeNull();
  });

  it('rend « pas de session » quand aucun cookie valide n\'accompagne la requête', async () => {
    getAuthMock.mockReturnValue(authStub(() => Promise.resolve(null)));

    await expect(getSession()).resolves.toBeNull();
  });

  it("rend de quoi identifier et afficher l'utilisateur", async () => {
    getAuthMock.mockReturnValue(authStub(() => Promise.resolve(FULL_SESSION)));

    await expect(getSession()).resolves.toEqual({
      userId: 'user_1',
      name: 'Gwen',
      email: 'gwen@example.test',
    });
  });

  it('ne laisse franchir ni jeton, ni session brute, ni trace de connexion', async () => {
    getAuthMock.mockReturnValue(authStub(() => Promise.resolve(FULL_SESSION)));

    const dto = await getSession();

    expect(Object.keys(dto ?? {}).sort()).toEqual(['email', 'name', 'userId']);
    expect(JSON.stringify(dto)).not.toContain('jeton-de-session-secret');
    expect(JSON.stringify(dto)).not.toContain('192.0.2.10');
  });

  it('traite une panne de lecture comme une absence de session, et la journalise', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getAuthMock.mockReturnValue(
      authStub(() => Promise.reject(new Error('base injoignable'))),
    );

    await expect(getSession()).resolves.toBeNull();
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
