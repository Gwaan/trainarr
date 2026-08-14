import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityNotFoundError, hasActivityStreams, saveActivityStreams } from './activities';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Cloisonnement des séries temporelles.
 *
 * `activity_streams` n'a pas d'`athlete_id` : son propriétaire est celui de son
 * activité, et ces deux fonctions sont les seules à l'écrire ou à l'interroger.
 * Elles tournent dans l'ingestion — le watcher et le poller, hors requête —
 * donc l'athlète leur est **passé** : il n'y a pas de session à interroger, et
 * il ne peut pas y en avoir.
 */

/** Requête enregistrée : sa table, sa clause `WHERE` et sa condition de jointure. */
type RecordedQuery = { table: string; where: SQL | null; join: SQL | null };

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    queries: [] as RecordedQuery[],
    inserts: [] as Array<{ table: string; values: unknown }>,
    deletes: [] as string[],
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => Chain;
    innerJoin: (table: Table, clause: SQL) => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const query: RecordedQuery = { table: getTableName(table), where: null, join: null };
    dbState.queries.push(query);

    const chain: Chain = {
      where: (clause) => {
        query.where = clause;
        return chain;
      },
      innerJoin: (_joined, clause) => {
        query.join = clause;
        return chain;
      },
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.rows[query.table] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  type InsertChain = PromiseLike<unknown> & { onConflictDoUpdate: () => InsertChain };

  const writer = {
    insert: (table: Table) => ({
      values: (values: unknown) => {
        dbState.inserts.push({ table: getTableName(table), values });
        const chain: InsertChain = {
          onConflictDoUpdate: () => chain,
          then: (onFulfilled, onRejected) =>
            Promise.resolve(undefined).then(onFulfilled, onRejected),
        };
        return chain;
      },
    }),
    delete: (table: Table) => {
      dbState.deletes.push(getTableName(table));
      return { where: () => Promise.resolve() };
    },
  };

  return {
    db: {
      select: () => ({ from: chainFor }),
      transaction: (run: (tx: typeof writer) => Promise<void>) => run(writer),
    },
  };
});

const dialect = new PgDialect();

function render(clause: SQL | null | undefined): { sql: string; params: unknown[] } {
  if (clause == null) throw new Error('Aucune clause enregistrée pour cette requête.');
  const rendered = dialect.sqlToQuery(clause);
  return { sql: rendered.sql, params: rendered.params };
}

beforeEach(() => {
  dbState.rows = {};
  dbState.queries = [];
  dbState.inserts = [];
  dbState.deletes = [];
});

describe('hasActivityStreams', () => {
  it('rend `true` quand l’activité de cet athlète porte une série', async () => {
    dbState.rows.activity_streams = [{ id: 3 }];

    await expect(hasActivityStreams(42, 1)).resolves.toBe(true);
  });

  it('vérifie l’appartenance par la jointure, au lieu de la supposer', async () => {
    dbState.rows.activity_streams = [{ id: 3 }];

    await hasActivityStreams(42, 1);

    const query = dbState.queries[0];
    expect(query?.table).toBe('activity_streams');
    // La jointure porte l'athlète : les séries d'un autre compte ne peuvent pas
    // entrer dans le résultat, quel que soit l'identifiant demandé.
    expect(render(query?.join).params).toEqual([1]);
    expect(render(query?.where).params).toEqual([42]);
  });

  it('rend `false` pour l’activité d’un autre athlète, comme pour une inexistante', async () => {
    // La jointure filtrante ne rend rien : les deux cas sont indistinguables.
    dbState.rows.activity_streams = [];

    await expect(hasActivityStreams(42, 2)).resolves.toBe(false);
  });
});

describe('saveActivityStreams', () => {
  it('écrit les séries de l’activité de l’athlète', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityStreams(42, 1, { time: [0, 1], heartrate: [130, 140] });

    expect(dbState.inserts).toEqual([
      {
        table: 'activity_streams',
        values: [
          { activityId: 42, type: 'time', data: [0, 1] },
          { activityId: 42, type: 'heartrate', data: [130, 140] },
        ],
      },
    ]);
  });

  it('confronte l’activité à l’athlète avant toute écriture', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityStreams(42, 1, { time: [0, 1] });

    expect(render(dbState.queries[0]?.where).params).toEqual([42, 1]);
  });

  it('refuse d’écrire sur l’activité d’un autre athlète', async () => {
    // L'activité 42 existe, mais sous un autre compte : la lecture filtrée ne
    // rend rien, et l'écriture est refusée par la même erreur qu'un
    // identifiant inexistant.
    dbState.rows.activities = [];

    await expect(saveActivityStreams(42, 2, { time: [0, 1] })).rejects.toBeInstanceOf(
      ActivityNotFoundError,
    );
    expect(dbState.inserts).toEqual([]);
    expect(dbState.deletes).toEqual([]);
  });

  it('ne purge rien non plus quand l’activité n’est pas la sienne', async () => {
    // Le cas piégeux : un jeu de streams **vide** ne fait aucune insertion, mais
    // la fonction est un remplacement — sans le contrôle, elle supprimerait
    // toutes les séries de l'activité d'autrui.
    dbState.rows.activities = [];

    await expect(saveActivityStreams(42, 2, {})).rejects.toBeInstanceOf(ActivityNotFoundError);
    expect(dbState.deletes).toEqual([]);
  });
});
