import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { StravaTokenSet } from '@/lib/strava/oauth';

import * as stravaTokensModule from './strava-tokens';
import { getFreshAccessToken, isStravaConnected, saveStravaTokens } from './strava-tokens';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : la chaîne de requête est factice et sert les lignes
 * déclarées par table. Les écritures sont enregistrées pour assertion.
 *
 * Deux comportements imitent délibérément Postgres, sans quoi les correctifs de
 * concurrence ne seraient pas testables :
 * - `transaction` sérialise les callbacks, comme le fait `pg_advisory_xact_lock` ;
 * - un `update` fusionne les valeurs dans les lignes servies, pour qu'une relecture
 *   dans la transaction voie bien ce qu'un concurrent vient d'écrire.
 */
const { queryState } = vi.hoisted(() => ({
  queryState: {
    rows: {} as Record<string, Array<Record<string, unknown>>>,
    inserts: [] as Array<{ table: string; values: unknown }>,
    updates: [] as Array<{ table: string; values: unknown }>,
    /** Instructions passées à `tx.execute()`, pour vérifier la prise du verrou. */
    executed: [] as unknown[],
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: () => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const chain: Chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(queryState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  const executor = {
    select: () => ({ from: chainFor }),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown>) => {
        const name = getTableName(table);
        queryState.inserts.push({ table: name, values });
        queryState.rows[name] = [...(queryState.rows[name] ?? []), values];
        return Promise.resolve();
      },
    }),
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const name = getTableName(table);
          queryState.updates.push({ table: name, values });
          queryState.rows[name] = (queryState.rows[name] ?? []).map((row) => ({
            ...row,
            ...values,
          }));
          return Promise.resolve();
        },
      }),
    }),
    execute: (query: unknown) => {
      queryState.executed.push(query);
      return Promise.resolve([]);
    },
  };

  // Émule l'exclusion mutuelle du verrou advisory : deux transactions ne
  // s'exécutent jamais en même temps.
  let pending: Promise<unknown> = Promise.resolve();

  return {
    db: {
      ...executor,
      transaction: (callback: (tx: typeof executor) => Promise<unknown>) => {
        const run = pending.then(() => callback(executor));
        pending = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    },
  };
});

const { refreshTokensMock } = vi.hoisted(() => ({
  refreshTokensMock: vi.fn<(refreshToken: string) => Promise<StravaTokenSet>>(),
}));

vi.mock('@/lib/strava/oauth', () => ({ refreshTokens: refreshTokensMock }));

/** Aujourd'hui : lundi 10 août 2026, 11 h à Paris. */
const NOW = new Date('2026-08-10T09:00:00.000Z');

vi.useFakeTimers();
vi.setSystemTime(NOW);

afterAll(() => {
  vi.useRealTimers();
});

const ATHLETE_ROW = { id: 1 };

/** Ligne de jetons telle que la sélectionne le DAL (colonnes explicites). */
function tokenRow(expiresAt: Date) {
  return { accessToken: 'access-en-base', refreshToken: 'refresh-en-base', expiresAt };
}

const REFRESHED: StravaTokenSet = {
  accessToken: 'access-rafraichi',
  refreshToken: 'refresh-rafraichi',
  expiresAt: new Date('2026-08-10T15:00:00.000Z'),
  // Une réponse de refresh ne porte ni l'athlète ni le périmètre accordé.
  athleteStravaId: null,
  scope: null,
};

/** Écritures enregistrées pour une table donnée. */
function updatesOn(table: string): unknown[] {
  return queryState.updates.filter((entry) => entry.table === table).map((entry) => entry.values);
}

beforeEach(() => {
  queryState.rows = {};
  queryState.inserts = [];
  queryState.updates = [];
  queryState.executed = [];
  refreshTokensMock.mockReset();
  refreshTokensMock.mockResolvedValue(REFRESHED);
  vi.setSystemTime(NOW);
});

describe('saveStravaTokens', () => {
  const TOKENS: StravaTokenSet = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: new Date('2026-08-10T15:00:00.000Z'),
    athleteStravaId: 987_654,
    scope: 'read,activity:read_all,profile:read_all',
  };

  it('insère les jetons quand aucun n’est enregistré', async () => {
    queryState.rows.athlete = [ATHLETE_ROW];

    await saveStravaTokens(TOKENS);

    expect(queryState.inserts).toEqual([
      {
        table: 'strava_tokens',
        values: {
          athleteId: 1,
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: TOKENS.expiresAt,
          scope: 'read,activity:read_all,profile:read_all',
          updatedAt: NOW,
        },
      },
    ]);
  });

  it('met à jour la ligne existante plutôt que d’en créer une seconde', async () => {
    queryState.rows.athlete = [ATHLETE_ROW];
    queryState.rows.strava_tokens = [{ id: 7 }];

    await saveStravaTokens(TOKENS);

    expect(queryState.inserts).toEqual([]);
    expect(updatesOn('strava_tokens')).toEqual([
      {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: TOKENS.expiresAt,
        scope: 'read,activity:read_all,profile:read_all',
        updatedAt: NOW,
      },
    ]);
  });

  it('persiste l’identifiant Strava de l’athlète : le filtrage des webhooks en dépend', async () => {
    queryState.rows.athlete = [ATHLETE_ROW];

    await saveStravaTokens(TOKENS);

    expect(updatesOn('athlete')).toEqual([{ stravaAthleteId: 987_654, updatedAt: NOW }]);
  });

  it('n’efface ni l’identifiant Strava ni le périmètre lors d’un refresh', async () => {
    queryState.rows.athlete = [ATHLETE_ROW];
    queryState.rows.strava_tokens = [{ id: 7 }];

    await saveStravaTokens(REFRESHED);

    // Aucune écriture sur `athlete`, et pas de colonne `scope` dans le set.
    expect(updatesOn('athlete')).toEqual([]);
    expect(updatesOn('strava_tokens')[0]).not.toHaveProperty('scope');
  });

  it('refuse d’enregistrer des jetons sans athlète en base', async () => {
    await expect(saveStravaTokens(TOKENS)).rejects.toThrowError(/athlète/i);
    expect(queryState.inserts).toEqual([]);
  });
});

describe('getFreshAccessToken', () => {
  it('retourne null quand Strava n’est pas connecté', async () => {
    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(refreshTokensMock).not.toHaveBeenCalled();
  });

  it('sert le jeton en base tant qu’il reste valide plus de 5 min', async () => {
    queryState.rows.strava_tokens = [tokenRow(new Date('2026-08-10T09:06:00.000Z'))];

    await expect(getFreshAccessToken()).resolves.toBe('access-en-base');
    expect(refreshTokensMock).not.toHaveBeenCalled();
    expect(queryState.updates).toEqual([]);
  });

  it('rafraîchit quand l’expiration est à moins de 5 min', async () => {
    queryState.rows.athlete = [ATHLETE_ROW];
    queryState.rows.strava_tokens = [tokenRow(new Date('2026-08-10T09:04:00.000Z'))];

    await expect(getFreshAccessToken()).resolves.toBe('access-rafraichi');
    expect(refreshTokensMock).toHaveBeenCalledWith('refresh-en-base');
  });

  it('rafraîchit un jeton déjà expiré', async () => {
    queryState.rows.athlete = [ATHLETE_ROW];
    queryState.rows.strava_tokens = [tokenRow(new Date('2026-08-10T08:00:00.000Z'))];

    await expect(getFreshAccessToken()).resolves.toBe('access-rafraichi');
    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
  });

  it('persiste le nouveau jeu, refresh token compris (Strava le fait tourner)', async () => {
    queryState.rows.athlete = [ATHLETE_ROW];
    queryState.rows.strava_tokens = [tokenRow(new Date('2026-08-10T08:00:00.000Z'))];

    await getFreshAccessToken();

    expect(updatesOn('strava_tokens')).toEqual([
      {
        accessToken: 'access-rafraichi',
        refreshToken: 'refresh-rafraichi',
        expiresAt: REFRESHED.expiresAt,
        updatedAt: NOW,
      },
    ]);
  });

  it('laisse remonter l’échec du refresh plutôt que de servir un jeton mort', async () => {
    queryState.rows.athlete = [ATHLETE_ROW];
    queryState.rows.strava_tokens = [tokenRow(new Date('2026-08-10T08:00:00.000Z'))];
    refreshTokensMock.mockRejectedValue(new Error('refresh token révoqué'));

    await expect(getFreshAccessToken()).rejects.toThrowError('refresh token révoqué');
  });
});

describe('getFreshAccessToken — course au refresh', () => {
  beforeEach(() => {
    queryState.rows.athlete = [ATHLETE_ROW];
    queryState.rows.strava_tokens = [tokenRow(new Date('2026-08-10T08:00:00.000Z'))];
  });

  it('prend un verrou advisory dédié avant de relire les jetons', async () => {
    await getFreshAccessToken();

    const statements = queryState.executed.map((query) =>
      new PgDialect().sqlToQuery(query as SQL),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain('pg_advisory_xact_lock');
    // La clé est un paramètre lié, pas une valeur interpolée dans le SQL.
    expect(statements[0]?.params).toHaveLength(1);
  });

  it('ne déclenche qu’un seul appel /oauth/token pour deux appels concurrents', async () => {
    /*
     * Strava fait tourner le refresh token : si les deux appels rafraîchissaient,
     * le second partirait d'un refresh token déjà invalidé et Strava resterait
     * déconnecté. Le verrou sérialise, et le second appel relit les jetons dans
     * sa transaction — il trouve celui du premier et n'en demande pas d'autre.
     */
    const [first, second] = await Promise.all([getFreshAccessToken(), getFreshAccessToken()]);

    expect(refreshTokensMock).toHaveBeenCalledTimes(1);
    expect(refreshTokensMock).toHaveBeenCalledWith('refresh-en-base');
    expect(first).toBe('access-rafraichi');
    expect(second).toBe('access-rafraichi');
    // Une seule écriture : le second n'a rien réécrit par-dessus.
    expect(updatesOn('strava_tokens')).toHaveLength(1);
  });
});

describe('isStravaConnected', () => {
  it('est faux sans jetons', async () => {
    await expect(isStravaConnected()).resolves.toBe(false);
  });

  it('est vrai avec des jetons, même expirés — sans les exposer', async () => {
    queryState.rows.strava_tokens = [tokenRow(new Date('2026-01-01T00:00:00.000Z'))];

    const connected = await isStravaConnected();

    expect(connected).toBe(true);
    expect(JSON.stringify(connected)).not.toContain('access-en-base');
  });
});

describe('étanchéité des jetons', () => {
  it('n’expose aucune fonction qui retournerait la ligne de jetons', () => {
    expect(Object.keys(stravaTokensModule).sort()).toEqual([
      'getFreshAccessToken',
      'isStravaConnected',
      'saveStravaTokens',
    ]);
  });

  it('ne laisse sortir que l’access token, jamais le refresh token', async () => {
    queryState.rows.strava_tokens = [tokenRow(new Date('2026-08-10T15:00:00.000Z'))];

    const result = await getFreshAccessToken();

    expect(result).toBe('access-en-base');
    expect(result).not.toContain('refresh-en-base');
  });
});
