import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ActivityNotFoundError,
  getActivityFeedback,
  saveActivityFeedback,
} from './activity-feedback';
import type { ActivityFeedback } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * L'athlète appartient à un compte : le DAL le résout depuis la session
 * (`getCurrentAthleteId`). Les tests de ce fichier travaillent donc sous une
 * session ouverte, sauf ceux qui éprouvent le cas « pas encore d'athlète » —
 * ils appellent `withoutSession()`, et le DAL ne rend alors aucun athlète.
 */
const { sessionState } = vi.hoisted(() => {
  type Session = { userId: string; name: string; email: string } | null;
  const sessionState: { current: Session } = {
    current: { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' },
  };
  return { sessionState };
});

vi.mock('./session', () => ({ getSession: () => Promise.resolve(sessionState.current) }));

/** Personne n'est connecté : aucune lecture du DAL ne rend d'athlète. */
function withoutSession(): void {
  sessionState.current = null;
}

beforeEach(() => {
  sessionState.current = { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' };
});

/**
 * Aucune base de données : les lectures servent les lignes déclarées par table,
 * l'insertion est enregistrée avec sa clause `ON CONFLICT` — c'est elle qui
 * porte l'écrasement du feedback précédent.
 */
/** La clause `ON CONFLICT` telle que le DAL la passe. */
type ConflictConfig = {
  target: unknown;
  set: { content: SQL; model: SQL; updatedAt: Date };
};

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    inserts: [] as Array<{ table: string; values: unknown }>,
    conflicts: [] as ConflictConfig[],
    selects: [] as Array<{ table: string; where: SQL }>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type SelectChain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => SelectChain;
    orderBy: () => SelectChain;
    limit: () => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      where: (clause) => {
        dbState.selects.push({ table: name, where: clause });
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  type InsertChain = PromiseLike<unknown> & {
    onConflictDoUpdate: (config: ConflictConfig) => InsertChain;
  };

  return {
    db: {
      select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
      insert: (table: Table) => ({
        values: (values: unknown) => {
          dbState.inserts.push({ table: getTableName(table), values });
          const chain: InsertChain = {
            onConflictDoUpdate: (config) => {
              dbState.conflicts.push(config);
              return chain;
            },
            then: (onFulfilled, onRejected) =>
              Promise.resolve(undefined).then(onFulfilled, onRejected),
          };
          return chain;
        },
      }),
    },
  };
});

const dialect = new PgDialect();

/** Clause `WHERE` rendue en SQL + paramètres liés, pour l'affirmer telle qu'elle partira. */
function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée pour cette requête.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

const FEEDBACK_ROW: ActivityFeedback = {
  id: 5,
  activityId: 42,
  content: '## Belle séance\n\nLa dérive cardiaque reste sous 3 %.',
  model: 'claude-opus-5',
  createdAt: new Date('2026-08-09T10:00:00.000Z'),
  updatedAt: new Date('2026-08-09T10:00:00.000Z'),
};

beforeEach(() => {
  dbState.rows = { athlete: [{ id: 1 }], activities: [{ id: 42 }] };
  dbState.inserts = [];
  dbState.conflicts = [];
  dbState.selects = [];
});

describe('getActivityFeedback', () => {
  it("n'expose que le contenu, le modèle et la date, en ISO", async () => {
    dbState.rows.activity_feedbacks = [FEEDBACK_ROW];

    const dto = await getActivityFeedback(42);

    expect(Object.keys(dto ?? {}).sort()).toEqual(['content', 'createdAt', 'model']);
    expect(dto).toEqual({
      content: '## Belle séance\n\nLa dérive cardiaque reste sous 3 %.',
      model: 'claude-opus-5',
      createdAt: '2026-08-09T10:00:00.000Z',
    });
  });

  it('retourne null quand l’activité n’a pas de feedback', async () => {
    dbState.rows.activity_feedbacks = [];

    await expect(getActivityFeedback(42)).resolves.toBeNull();
  });

  it('vérifie l’appartenance de l’activité à l’athlète avant de lire', async () => {
    dbState.rows.activity_feedbacks = [FEEDBACK_ROW];

    await getActivityFeedback(42);

    const where = renderWhere(dbState.selects.find((query) => query.table === 'activities')?.where);
    expect(where.params).toEqual([42, 1]);
  });

  it('retourne null pour une activité qui n’est pas celle de l’athlète', async () => {
    // L'activité existe peut-être, mais pas sous cet athlète : la requête
    // filtrée ne rend rien, et le feedback n'est même pas lu.
    dbState.rows.activities = [];
    dbState.rows.activity_feedbacks = [FEEDBACK_ROW];

    await expect(getActivityFeedback(42)).resolves.toBeNull();
    expect(dbState.selects.some((query) => query.table === 'activity_feedbacks')).toBe(false);
  });

  it('retourne null tant que l’onboarding n’a pas eu lieu', async () => {
    withoutSession();
    dbState.rows.athlete = [];
    dbState.rows.activity_feedbacks = [FEEDBACK_ROW];

    await expect(getActivityFeedback(42)).resolves.toBeNull();
  });
});

describe('saveActivityFeedback', () => {
  it('insère le feedback rattaché à l’activité', async () => {
    await saveActivityFeedback(42, '## Analyse', 'claude-opus-5');

    expect(dbState.inserts).toEqual([
      {
        table: 'activity_feedbacks',
        values: { activityId: 42, content: '## Analyse', model: 'claude-opus-5' },
      },
    ]);
  });

  it('écrase le feedback précédent au lieu d’en empiler un second', async () => {
    await saveActivityFeedback(42, '## Analyse revue', null);

    expect(dbState.conflicts).toHaveLength(1);
    const conflict = dbState.conflicts[0];
    if (!conflict) throw new Error('Aucune clause `ON CONFLICT` enregistrée.');

    // `excluded.*` : la ligne en conflit reprend les valeurs de l'insertion
    // refusée — content et model, jamais createdAt (il date le premier feedback).
    expect(dialect.sqlToQuery(conflict.set.content).sql).toBe('excluded.content');
    expect(dialect.sqlToQuery(conflict.set.model).sql).toBe('excluded.model');
    expect(conflict.set.updatedAt).toBeInstanceOf(Date);
    expect(conflict.set).not.toHaveProperty('createdAt');
  });

  it('refuse d’écrire sur une activité qui n’est pas celle de l’athlète', async () => {
    dbState.rows.activities = [];

    await expect(saveActivityFeedback(42, '## Analyse', null)).rejects.toBeInstanceOf(
      ActivityNotFoundError,
    );
    expect(dbState.inserts).toEqual([]);
  });

  it('refuse d’écrire tant qu’aucun athlète n’est enregistré', async () => {
    withoutSession();
    dbState.rows.athlete = [];

    await expect(saveActivityFeedback(42, '## Analyse', null)).rejects.toBeInstanceOf(
      ActivityNotFoundError,
    );
    expect(dbState.inserts).toEqual([]);
  });
});
