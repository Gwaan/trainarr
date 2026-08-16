import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityNotFoundError, saveActivityBestSegments } from './activities';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Écriture des meilleurs efforts persistés.
 *
 * `activity_best_segments` n'a pas d'`athlete_id` : son propriétaire est celui
 * de son activité. La fonction tourne dans l'ingestion — le watcher et le
 * poller, hors requête — donc l'athlète lui est **passé** : il n'y a pas de
 * session à interroger, et il ne peut pas y en avoir.
 */

type RecordedQuery = { table: string; where: SQL | null };

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    queries: [] as RecordedQuery[],
    inserts: [] as Array<{ table: string; values: unknown }>,
    deletes: [] as string[],
    updates: [] as Array<{ table: string; values: unknown; where: SQL | null }>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const query: RecordedQuery = { table: getTableName(table), where: null };
    dbState.queries.push(query);

    const chain: Chain = {
      where: (clause) => {
        query.where = clause;
        return chain;
      },
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.rows[query.table] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  const writer = {
    insert: (table: Table) => ({
      values: (values: unknown) => {
        dbState.inserts.push({ table: getTableName(table), values });
        return Promise.resolve();
      },
    }),
    delete: (table: Table) => {
      dbState.deletes.push(getTableName(table));
      return { where: () => Promise.resolve() };
    },
    update: (table: Table) => ({
      set: (values: unknown) => {
        const update = { table: getTableName(table), values, where: null as SQL | null };
        dbState.updates.push(update);
        return {
          where: (clause: SQL) => {
            update.where = clause;
            return Promise.resolve();
          },
        };
      },
    }),
  };

  return {
    db: {
      select: () => ({ from: chainFor }),
      transaction: (run: (tx: typeof writer) => Promise<void>) => run(writer),
    },
  };
});

const dialect = new PgDialect();

function render(clause: SQL | null | undefined): { params: unknown[] } {
  if (clause == null) throw new Error('Aucune clause enregistrée pour cette requête.');
  return { params: dialect.sqlToQuery(clause).params };
}

const SEGMENTS = [
  { targetM: 400, timeS: 100, paceSecPerKm: 250 },
  { targetM: 1609.34, timeS: 402.335, paceSecPerKm: 250 },
];

beforeEach(() => {
  dbState.rows = {};
  dbState.queries = [];
  dbState.inserts = [];
  dbState.deletes = [];
  dbState.updates = [];
});

/** La marque de balayage posée par la transaction, `null` si elle ne l'a pas été. */
function scanMark(): { activityId: number; at: unknown } | null {
  const update = dbState.updates.find((row) => row.table === 'activities');
  if (update === undefined) return null;

  const values = update.values;
  if (typeof values !== 'object' || values === null || !('bestSegmentsScannedAt' in values)) {
    throw new Error('La mise à jour de `activities` ne porte pas la marque de balayage.');
  }

  return { activityId: Number(render(update.where).params[0]), at: values.bestSegmentsScannedAt };
}

describe('saveActivityBestSegments', () => {
  it('écrit les segments de l’activité de l’athlète', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityBestSegments(42, 1, SEGMENTS);

    // Purge puis réécriture : la fonction est un remplacement, pas une
    // complétion — une cible qui ne sort plus du calcul ne doit pas survivre en
    // record fantôme.
    expect(dbState.deletes).toEqual(['activity_best_segments']);
    expect(dbState.inserts).toEqual([
      {
        table: 'activity_best_segments',
        values: [
          { activityId: 42, targetM: 400, timeS: 100, paceSecPerKm: 250 },
          { activityId: 42, targetM: 1609.34, timeS: 402.335, paceSecPerKm: 250 },
        ],
      },
    ]);
  });

  it('confronte l’activité à l’athlète avant toute écriture', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityBestSegments(42, 1, SEGMENTS);

    expect(render(dbState.queries[0]?.where).params).toEqual([42, 1]);
  });

  it('efface sans rien insérer quand la séance n’a aucun segment', async () => {
    // Une séance de moins de 400 m n'a aucun meilleur effort : la liste vide est
    // une écriture valide, qui nettoie ce qu'un calcul précédent aurait laissé.
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityBestSegments(42, 1, []);

    expect(dbState.deletes).toEqual(['activity_best_segments']);
    expect(dbState.inserts).toEqual([]);
  });

  it('marque la séance comme balayée, avec ou sans segment', async () => {
    // « Regardée », et pas « pourvue de segments » : c'est cette marque qui fait
    // sortir la séance du prédicat de rattrapage. Sans elle sur le cas vide, une
    // séance dont le calcul ne rend rien resterait comptée « en attente » pour
    // toujours, et l'écran des records annoncerait des records provisoires
    // même après le passage de `pnpm db:backfill:best-segments`.
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityBestSegments(42, 1, []);
    expect(scanMark()).toEqual({ activityId: 42, at: expect.any(Date) });

    dbState.updates = [];
    await saveActivityBestSegments(42, 1, SEGMENTS);
    expect(scanMark()).toEqual({ activityId: 42, at: expect.any(Date) });
  });

  it('refuse d’écrire sur l’activité d’un autre athlète', async () => {
    // L'activité 42 existe, mais sous un autre compte : la lecture filtrée ne
    // rend rien, et l'écriture est refusée par la même erreur qu'un identifiant
    // inexistant.
    dbState.rows.activities = [];

    await expect(saveActivityBestSegments(42, 2, SEGMENTS)).rejects.toBeInstanceOf(
      ActivityNotFoundError,
    );
    expect(dbState.inserts).toEqual([]);
    // Et surtout : rien n'est purgé non plus. Sans ce contrôle, une liste vide
    // effacerait les records d'autrui.
    expect(dbState.deletes).toEqual([]);
    // Ni marquée balayée : la séance d'autrui reste ce qu'elle était.
    expect(dbState.updates).toEqual([]);
  });
});
