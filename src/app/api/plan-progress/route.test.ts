import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Le registre de progression est `server-only`.
vi.mock('server-only', () => ({}));

/**
 * La session est la première garde de la route : elle est simulée ici, la vraie
 * lecture (better-auth, base) étant éprouvée dans `src/data/session.test.ts`.
 */
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@/data/session', () => ({ getSession }));

/**
 * `connection()` lève hors contexte de requête Next : neutralisé ici, le reste
 * de `next/server` (dont `NextRequest`) restant le vrai code. Ce que le handler
 * en attend — sortir du prérendu au build — se vérifie au build, pas ici.
 */
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: async () => {},
}));

const { GET } = await import('./route');
const { clearPlanProgress, setPlanProgress } = await import('@/lib/ai/progress');

const ENDPOINT = 'http://localhost/api/plan-progress';
const ID = 'd3b07384-d9a0-4c1e-8f2b-5a6c7d8e9f01';

function request(query: string): NextRequest {
  return new NextRequest(`${ENDPOINT}${query}`);
}

beforeEach(() => {
  getSession.mockResolvedValue({ userId: 'user-1', name: 'Gwen', email: 'gwen@trainarr.test' });
});

afterEach(() => {
  clearPlanProgress(ID);
});

describe('GET /api/plan-progress — session', () => {
  it('exige une session, y compris sur un identifiant valide et connu', async () => {
    // Cette route ne rendait qu'un pourcentage et n'exigeait rien ; elle est
    // désormais fermée comme le reste de l'API.
    setPlanProgress(ID, { percent: 37, attempt: 2, maxAttempts: 3 });
    getSession.mockResolvedValue(null);

    const response = await GET(request(`?id=${ID}`));

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuse avant même de regarder l’identifiant', async () => {
    // Un 400 et un 401 diraient deux choses différentes à qui n'a rien à faire
    // là : le refus vient en premier, et il est le même pour tous.
    getSession.mockResolvedValue(null);

    for (const query of ['', '?id=42', `?id=${ID}`]) {
      expect((await GET(request(query))).status).toBe(401);
    }
  });
});

describe('GET /api/plan-progress', () => {
  it("refuse un identifiant qui n'est pas un UUID", async () => {
    for (const query of ['', '?id=', '?id=42', '?id=../../etc/passwd']) {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
    }
  });

  it('rend null sur une génération inconnue', async () => {
    const response = await GET(request(`?id=${ID}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it('rend la progression en cours, et rien de plus', async () => {
    setPlanProgress(ID, { percent: 37, attempt: 2, maxAttempts: 3 });

    const response = await GET(request(`?id=${ID}`));

    // `startedAt` reste au serveur : le client n'en fait rien, et une réponse
    // publique n'expose que ce qu'elle doit.
    await expect(response.json()).resolves.toEqual({
      percent: 37,
      attempt: 2,
      maxAttempts: 3,
    });
  });

  it("interdit la mise en cache d'une progression", async () => {
    setPlanProgress(ID, { percent: 5, attempt: 1, maxAttempts: 3 });

    const response = await GET(request(`?id=${ID}`));

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
