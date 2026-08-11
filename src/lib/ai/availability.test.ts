import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only` lève hors contexte serveur React : neutralisé pour les tests.
vi.mock('server-only', () => ({}));

import { resetEnvCache } from '@/config/env';

import {
  AI_AVAILABILITY_TTL_MS,
  getAiAvailability,
  requireAi,
  resetAiAvailabilityCache,
} from './availability';
import { AiUnavailableError } from './errors';

const BASE_URL = 'http://ia.test:8080';
const API_KEY = 'cle-ia-de-test-a-ne-jamais-journaliser';

type Call = { url: string; init: RequestInit | undefined };

/** Remplace `fetch` par un espion — aucun test n'ouvre de connexion. */
function stubFetch(response: Response | (() => Response | Promise<never>)): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : response;
  });
  return { calls };
}

function authorizationOf(call: Call): string | null {
  return new Headers(call.init?.headers).get('authorization');
}

/** Une erreur de délai de garde, telle que `fetch` la rejette sur signal expiré. */
function timeoutError(): Error {
  const error = new Error("L'opération a expiré.");
  error.name = 'TimeoutError';
  return error;
}

beforeEach(() => {
  resetEnvCache();
  resetAiAvailabilityCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetEnvCache();
  resetAiAvailabilityCache();
});

describe('getAiAvailability — configuration absente', () => {
  it('rend « unconfigured » sans toucher au réseau', async () => {
    const { calls } = stubFetch(new Response('{}', { status: 200 }));

    await expect(getAiAvailability()).resolves.toEqual({
      available: false,
      reason: 'unconfigured',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('getAiAvailability — ping llama.cpp', () => {
  beforeEach(() => {
    vi.stubEnv('AI_PROVIDER', 'llamacpp');
    vi.stubEnv('AI_BASE_URL', BASE_URL);
    resetEnvCache();
  });

  it('interroge /health et rend disponible sur 200', async () => {
    const { calls } = stubFetch(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));

    await expect(getAiAvailability()).resolves.toEqual({ available: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://ia.test:8080/health');
    expect(calls[0].init?.method).toBe('GET');
    // Délai de garde posé sur le ping : un statut ne retient pas un rendu.
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retire un /v1 final de AI_BASE_URL (erreur de recopie la plus probable)', async () => {
    vi.stubEnv('AI_BASE_URL', `${BASE_URL}/v1/`);
    resetEnvCache();
    const { calls } = stubFetch(new Response(null, { status: 200 }));

    await getAiAvailability();

    expect(calls[0].url).toBe('http://ia.test:8080/health');
  });

  it('rend indisponible sur 503 — modèle en cours de chargement', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'loading model' }), { status: 503 }));

    await expect(getAiAvailability()).resolves.toEqual({
      available: false,
      reason: 'unreachable',
    });
  });

  it('rend indisponible sur panne réseau, sans lever', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));

    await expect(getAiAvailability()).resolves.toEqual({
      available: false,
      reason: 'unreachable',
    });
  });

  it('rend indisponible quand le délai de garde coupe', async () => {
    stubFetch(() => Promise.reject(timeoutError()));

    await expect(getAiAvailability()).resolves.toEqual({
      available: false,
      reason: 'unreachable',
    });
  });

  it("n'envoie pas d'en-tête d'authentification sur /health", async () => {
    vi.stubEnv('AI_API_KEY', API_KEY);
    resetEnvCache();
    const { calls } = stubFetch(new Response(null, { status: 200 }));

    await getAiAvailability();

    expect(authorizationOf(calls[0])).toBeNull();
  });
});

describe('getAiAvailability — ping compatible OpenAI', () => {
  beforeEach(() => {
    vi.stubEnv('AI_PROVIDER', 'openai');
    vi.stubEnv('AI_BASE_URL', BASE_URL);
    resetEnvCache();
  });

  it('interroge /v1/models avec la clé en Bearer', async () => {
    vi.stubEnv('AI_API_KEY', API_KEY);
    resetEnvCache();
    const { calls } = stubFetch(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await expect(getAiAvailability()).resolves.toEqual({ available: true });
    expect(calls[0].url).toBe('http://ia.test:8080/v1/models');
    expect(authorizationOf(calls[0])).toBe(`Bearer ${API_KEY}`);
  });

  it("omet l'en-tête quand aucune clé n'est configurée", async () => {
    const { calls } = stubFetch(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await getAiAvailability();

    expect(authorizationOf(calls[0])).toBeNull();
  });

  it('rend indisponible sur 401 — clé refusée', async () => {
    stubFetch(new Response('nope', { status: 401 }));

    await expect(getAiAvailability()).resolves.toEqual({
      available: false,
      reason: 'unreachable',
    });
  });
});

describe('getAiAvailability — mémorisation', () => {
  beforeEach(() => {
    vi.stubEnv('AI_PROVIDER', 'llamacpp');
    vi.stubEnv('AI_BASE_URL', BASE_URL);
    resetEnvCache();
  });

  it('ne pinge qu\'une fois pour deux consultations rapprochées', async () => {
    const { calls } = stubFetch(new Response(null, { status: 200 }));

    await getAiAvailability();
    await expect(getAiAvailability()).resolves.toEqual({ available: true });

    expect(calls).toHaveLength(1);
  });

  it('repinge une fois le statut périmé', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T08:00:00Z'));
    const { calls } = stubFetch(new Response(null, { status: 200 }));

    await getAiAvailability();
    vi.advanceTimersByTime(AI_AVAILABILITY_TTL_MS - 1);
    await getAiAvailability();
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(2);
    await getAiAvailability();
    expect(calls).toHaveLength(2);
  });

  it('mémorise aussi une indisponibilité — une API éteinte ne se sonde pas en boucle', async () => {
    const { calls } = stubFetch(() => Promise.reject(new TypeError('fetch failed')));

    await getAiAvailability();
    await getAiAvailability();

    expect(calls).toHaveLength(1);
  });

  it('oublie le statut à la demande', async () => {
    const { calls } = stubFetch(new Response(null, { status: 200 }));

    await getAiAvailability();
    resetAiAvailabilityCache();
    await getAiAvailability();

    expect(calls).toHaveLength(2);
  });
});

describe('requireAi', () => {
  it('laisse passer quand le coach répond', async () => {
    vi.stubEnv('AI_BASE_URL', BASE_URL);
    resetEnvCache();
    stubFetch(new Response(null, { status: 200 }));

    await expect(requireAi()).resolves.toBeUndefined();
  });

  it('lève AiUnavailableError avec le motif « unconfigured »', async () => {
    const error = await requireAi().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).reason).toBe('unconfigured');
  });

  it('lève AiUnavailableError avec le motif « unreachable »', async () => {
    vi.stubEnv('AI_BASE_URL', BASE_URL);
    resetEnvCache();
    stubFetch(new Response(null, { status: 503 }));

    const error = await requireAi().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).reason).toBe('unreachable');
  });
});
