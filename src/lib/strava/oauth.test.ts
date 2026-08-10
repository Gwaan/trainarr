import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `@/config/env` commence par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

import { resetEnvCache } from '@/config/env';

import { StravaAuthError } from './errors';
import {
  buildAuthorizeUrl,
  exchangeCode,
  hasRequiredScope,
  refreshTokens,
  REQUIRED_STRAVA_SCOPE,
  STRAVA_SCOPE,
} from './oauth';

/** Périmètre tel que Strava le renvoie dans le query param du callback. */
const GRANTED_SCOPE = 'read,activity:read_all,profile:read_all';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/** Corps d'une réponse `/oauth/token` réelle, réduit à ce qui nous intéresse. */
const TOKEN_PAYLOAD = {
  token_type: 'Bearer',
  expires_at: 1_786_000_000,
  expires_in: 21_600,
  refresh_token: 'refresh-abc',
  access_token: 'access-xyz',
  athlete: { id: 987_654, username: 'gwen', firstname: 'Gwen' },
};

/** Corps de la requête émise, décodé. */
function sentBody(call = 0): Record<string, string> {
  const init = fetchMock.mock.calls[call]?.[1];
  const body = init?.body;
  if (!(body instanceof URLSearchParams)) {
    throw new Error('Le corps de la requête doit être un URLSearchParams.');
  }
  return Object.fromEntries(body.entries());
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('STRAVA_CLIENT_ID', '12345');
  vi.stubEnv('STRAVA_CLIENT_SECRET', 'client-secret-de-test');
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe('buildAuthorizeUrl', () => {
  it("construit l'URL d'autorisation attendue par Strava", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: '12345',
        redirectUri: 'https://watchenv.gwenzr.dev/api/strava/callback',
        state: 'anti-csrf-token',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      client_id: '12345',
      redirect_uri: 'https://watchenv.gwenzr.dev/api/strava/callback',
      response_type: 'code',
      approval_prompt: 'auto',
      scope: 'activity:read_all,profile:read_all',
      state: 'anti-csrf-token',
    });
  });

  it('demande la lecture complète des activités et du profil', () => {
    expect(STRAVA_SCOPE).toBe('activity:read_all,profile:read_all');
  });
});

describe('hasRequiredScope', () => {
  it('accepte un périmètre contenant activity:read_all', () => {
    expect(hasRequiredScope(GRANTED_SCOPE)).toBe(true);
    expect(hasRequiredScope('activity:read_all')).toBe(true);
    expect(hasRequiredScope('read, activity:read_all , profile:read_all')).toBe(true);
  });

  it('refuse le périmètre dégradé quand « activités privées » est décoché', () => {
    // Strava accorde `activity:read` : une partie des sorties resterait invisible.
    expect(hasRequiredScope('read,activity:read,profile:read_all')).toBe(false);
  });

  it('refuse un périmètre inconnu plutôt que de le supposer suffisant', () => {
    expect(hasRequiredScope(null)).toBe(false);
    expect(hasRequiredScope('')).toBe(false);
  });

  it('compare les éléments de la liste, pas la sous-chaîne', () => {
    expect(hasRequiredScope('activity:read_all_public')).toBe(false);
    expect(REQUIRED_STRAVA_SCOPE).toBe('activity:read_all');
  });
});

describe('exchangeCode', () => {
  it('échange le code contre un jeu de jetons normalisé', async () => {
    fetchMock.mockResolvedValue(jsonResponse(TOKEN_PAYLOAD));

    const tokens = await exchangeCode('code-du-callback', GRANTED_SCOPE);

    expect(tokens).toEqual({
      accessToken: 'access-xyz',
      refreshToken: 'refresh-abc',
      expiresAt: new Date(1_786_000_000 * 1000),
      athleteStravaId: 987_654,
      scope: GRANTED_SCOPE,
    });
  });

  it('expose le périmètre du callback : Strava ne le renvoie pas avec les jetons', async () => {
    fetchMock.mockResolvedValue(jsonResponse(TOKEN_PAYLOAD));

    // Cas réel : l'athlète a décoché « activités privées ».
    const tokens = await exchangeCode('code-du-callback', 'read,activity:read');

    expect(tokens.scope).toBe('read,activity:read');
    expect(hasRequiredScope(tokens.scope)).toBe(false);
  });

  it('laisse le périmètre inconnu quand le callback ne le porte pas', async () => {
    fetchMock.mockResolvedValue(jsonResponse(TOKEN_PAYLOAD));

    await expect(exchangeCode('code-du-callback', null)).resolves.toMatchObject({ scope: null });
  });

  it('poste les identifiants dans le corps, jamais dans l’URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(TOKEN_PAYLOAD));

    await exchangeCode('code-du-callback', GRANTED_SCOPE);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://www.strava.com/oauth/token');
    expect(String(url)).not.toContain('client-secret-de-test');
    expect(init?.method).toBe('POST');
    expect(sentBody()).toEqual({
      client_id: '12345',
      client_secret: 'client-secret-de-test',
      code: 'code-du-callback',
      grant_type: 'authorization_code',
    });
  });

  it('échoue explicitement quand Strava refuse le code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'Bad Request', errors: [{ code: 'invalid' }] }, { status: 400 }),
    );

    const error = await exchangeCode('code-perime', GRANTED_SCOPE).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StravaAuthError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as Error).message).toContain('Bad Request');
  });

  it('échoue quand la réponse ne contient pas les champs attendus', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'access-xyz' }));

    await expect(exchangeCode('code', GRANTED_SCOPE)).rejects.toBeInstanceOf(StravaAuthError);
  });

  it('ne recopie jamais un jeton dans le message d’erreur', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'access-xyz', expires_at: 1 }));

    const error = await exchangeCode('code', GRANTED_SCOPE).catch((cause: unknown) => cause);

    expect((error as Error).message).not.toContain('access-xyz');
  });

  it('échoue quand la réponse n’est pas du JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>oups</html>', { status: 200 }));

    await expect(exchangeCode('code', GRANTED_SCOPE)).rejects.toBeInstanceOf(StravaAuthError);
  });
});

describe('refreshTokens', () => {
  it('demande un nouveau jeu de jetons avec le refresh token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        token_type: 'Bearer',
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_at: 1_786_100_000,
      }),
    );

    const tokens = await refreshTokens('refresh-abc');

    expect(sentBody()).toEqual({
      client_id: '12345',
      client_secret: 'client-secret-de-test',
      refresh_token: 'refresh-abc',
      grant_type: 'refresh_token',
    });
    // Le refresh ne renvoie ni l'athlète ni le périmètre : ne rien inventer.
    expect(tokens).toEqual({
      scope: null,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: new Date(1_786_100_000 * 1000),
      athleteStravaId: null,
    });
  });

  it('signale un refresh token révoqué', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Bad Request' }, { status: 401 }));

    const error = await refreshTokens('refresh-revoque').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StravaAuthError);
    expect(error).toMatchObject({ status: 401 });
  });
});

describe('identifiants applicatifs manquants', () => {
  it('échoue avant tout appel réseau', async () => {
    vi.stubEnv('STRAVA_CLIENT_SECRET', '');
    resetEnvCache();

    const error = await exchangeCode('code', GRANTED_SCOPE).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StravaAuthError);
    expect((error as Error).message).toContain('STRAVA_CLIENT_SECRET');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
