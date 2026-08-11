import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Le registre de progression est `server-only`.
vi.mock('server-only', () => ({}));

const { GET } = await import('./route');
const { clearPlanProgress, setPlanProgress } = await import('@/lib/ai/progress');

const ENDPOINT = 'http://localhost/api/plan-progress';
const ID = 'd3b07384-d9a0-4c1e-8f2b-5a6c7d8e9f01';

function request(query: string): NextRequest {
  return new NextRequest(`${ENDPOINT}${query}`);
}

afterEach(() => {
  clearPlanProgress(ID);
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
