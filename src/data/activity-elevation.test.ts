import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ActivityNotFoundError,
  countPendingElevation,
  recordActivityElevation,
} from './activities';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Écriture du dénivelé persisté d'une activité.
 *
 * Trois propriétés à tenir, et elles sont indépendantes :
 *
 * 1. **complétion, jamais écrasement** — ce que le fichier a dit reste
 *    prioritaire sur le calcul de repli ;
 * 2. **la paire d'un seul tenant** — le repli n'écrit que si D+ *et* D− sont
 *    absents, sans quoi une séance porterait un D+ de la montre et un D− de
 *    notre hystérésis, deux filtres différents dans la même formule de Greif ;
 * 3. **la marque de balayage est posée dans tous les cas**, y compris quand rien
 *    n'est calculable. Sans elle, le rattrapage resélectionnerait éternellement
 *    les séances dont le flux d'altitude est inexploitable.
 *
 * La fonction tourne dans l'ingestion — le watcher, hors requête — donc
 * l'athlète lui est **passé** : il n'y a pas de session à interroger.
 */

type RecordedQuery = { table: string; where: SQL | null };

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    queries: [] as RecordedQuery[],
    updates: [] as Array<{ table: string; values: Record<string, unknown>; where: SQL | null }>,
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

  return {
    db: {
      select: () => ({ from: chainFor }),
      update: (table: Table) => ({
        set: (values: Record<string, unknown>) => {
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
    },
  };
});

const dialect = new PgDialect();

function render(clause: SQL | null | undefined): { sql: string; params: unknown[] } {
  if (clause == null) throw new Error('Aucune clause enregistrée pour cette requête.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

beforeEach(() => {
  dbState.rows = {};
  dbState.queries = [];
  dbState.updates = [];
});

describe('recordActivityElevation', () => {
  it('écrit les deux sens en complétion, et marque la séance balayée', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await recordActivityElevation(42, 1, { gainM: 32, lossM: 30.5 });

    const update = dbState.updates[0];
    expect(update?.table).toBe('activities');
    expect(Object.keys(update?.values ?? {}).sort()).toEqual([
      'elevationGainM',
      'elevationLossM',
      'elevationScannedAt',
    ]);
    expect(update?.values.elevationScannedAt).toBeInstanceOf(Date);

    // Un `case` conditionné à la paire, et non une affectation sèche : le
    // `total_ascent` du fichier, quand il existe, prime sur le calcul depuis le
    // flux — et il l'emporte pour **les deux** colonnes à la fois.
    const gain = render(update?.values.elevationGainM as SQL);
    expect(gain.sql).toContain('case when');
    expect(gain.params).toEqual([32]);
    expect(render(update?.values.elevationLossM as SQL).params).toEqual([30.5]);

    expect(render(update?.where).params).toEqual([42]);
  });

  it('conditionne les deux colonnes à une paire entièrement vide', async () => {
    // D+ et D− entrent ensemble dans la formule de Greif : un `coalesce` par
    // colonne aurait complété le seul sens manquant, et persisté un D+ mesuré
    // par la montre à côté d'un D− mesuré par notre hystérésis de 1 m — deux
    // filtres différents dans la même distance équivalente.
    dbState.rows.activities = [{ id: 42 }];

    await recordActivityElevation(42, 1, { gainM: 32, lossM: 30.5 });

    const update = dbState.updates[0];
    for (const column of ['elevationGainM', 'elevationLossM'] as const) {
      const { sql } = render(update?.values[column] as SQL);
      expect(sql).toContain('"elevation_gain_m" is null');
      expect(sql).toContain('"elevation_loss_m" is null');
    }
  });

  it('ne pose que la marque quand rien n’est calculable', async () => {
    // Le cas qui fait converger le rattrapage : un flux d'altitude absent ou
    // inexploitable. Sans cette marque, la séance resterait « en attente » à
    // chaque passage, pour toujours.
    dbState.rows.activities = [{ id: 42 }];

    await recordActivityElevation(42, 1, null);

    expect(dbState.updates[0]?.values).toEqual({ elevationScannedAt: expect.any(Date) });
  });

  it('confronte l’activité à l’athlète avant toute écriture', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await recordActivityElevation(42, 1, { gainM: 10, lossM: 10 });

    expect(render(dbState.queries[0]?.where).params).toEqual([42, 1]);
  });

  it('refuse d’écrire sur l’activité d’un autre athlète', async () => {
    // L'activité existe, mais sous un autre compte : la lecture filtrée ne rend
    // rien, et l'écriture est refusée par la même erreur qu'un identifiant
    // inexistant — les deux cas ne se distinguent pas.
    dbState.rows.activities = [];

    await expect(recordActivityElevation(42, 2, { gainM: 10, lossM: 10 })).rejects.toBeInstanceOf(
      ActivityNotFoundError,
    );
    expect(dbState.updates).toEqual([]);
  });
});

/**
 * Le compteur qui rend la VO₂max **provisoire** à l'écran. Sans lui, la page
 * « Progression » affiche un nuage où les séances récentes portent la correction
 * d'altitude et l'historique ne la porte pas, sans un mot — et un écart à
 * 30 jours qui compare deux grandeurs différentes.
 */
describe('countPendingElevation', () => {
  it('compte sous le prédicat partagé avec le rattrapage, borné à son athlète', async () => {
    dbState.rows.activities = [{ value: 137 }];

    expect(await countPendingElevation(1)).toBe(137);

    const { sql, params } = render(dbState.queries[0]?.where);
    expect(params).toContain(1);
    // Les trois conditions de `pendingElevationWhere`, dans le SQL réellement
    // envoyé : un flux d'altitude en base, les **deux** sens absents (la paire
    // est atomique), et jamais balayée — c'est cette dernière qui fait que le
    // compteur peut atteindre zéro, y compris pour une séance dont le flux ne
    // rend rien.
    expect(sql).toContain('exists');
    expect(sql).toContain("'altitude'");
    expect(sql).toContain('"elevation_gain_m" is null');
    expect(sql).toContain('"elevation_loss_m" is null');
    expect(sql).toContain('"elevation_scanned_at" is null');
  });

  it('rend zéro plutôt qu’`undefined` quand la requête ne ramène rien', async () => {
    // Un compteur absent doit se lire « rien à rattraper », jamais faire planter
    // l'écran qu'il annote.
    dbState.rows.activities = [];

    expect(await countPendingElevation(1)).toBe(0);
  });
});
