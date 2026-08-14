import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasAnyUser } from './users';

vi.mock('server-only', () => ({}));

// Aucune base : le client est remplacé par une chaîne de requête factice.
const { queryState } = vi.hoisted(() => ({
  queryState: {
    rows: [] as unknown[],
    /** Nombre de lignes réellement demandées au `LIMIT`. */
    limits: [] as number[],
  },
}));

vi.mock('./db/client', () => {
  type QueryChain = {
    from: () => QueryChain;
    limit: (count: number) => Promise<unknown[]>;
  };
  const chain: QueryChain = {
    from: () => chain,
    limit: (count) => {
      queryState.limits.push(count);
      return Promise.resolve(queryState.rows);
    },
  };

  return { db: { select: () => chain } };
});

beforeEach(() => {
  queryState.rows = [];
  queryState.limits = [];
});

describe('hasAnyUser', () => {
  it('répond « non » sur une installation neuve', async () => {
    await expect(hasAnyUser()).resolves.toBe(false);
  });

  it('répond « oui » dès la première ligne', async () => {
    queryState.rows = [{ id: 'u1' }];

    await expect(hasAnyUser()).resolves.toBe(true);
  });

  it('ne lit jamais plus d\'une ligne : la question est « au moins un ? »', async () => {
    await hasAnyUser();

    expect(queryState.limits).toEqual([1]);
  });

  it('laisse remonter une panne de lecture — un « non » inventé ouvrirait la porte', async () => {
    const failure = new Error('base injoignable');
    queryState.rows = [];
    const { db } = await import('./db/client');
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw failure;
    });

    await expect(hasAnyUser()).rejects.toThrow(failure);
  });
});
