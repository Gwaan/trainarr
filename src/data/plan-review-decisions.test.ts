import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listPlanReviewDecisions,
  recordPlanReviewDecision,
  type PlanReviewDecisionInput,
} from './plan-review-decisions';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { athlete } = vi.hoisted(() => ({ athlete: { getCurrentAthleteId: vi.fn() } }));

vi.mock('./athlete', () => ({ getCurrentAthleteId: athlete.getCurrentAthleteId }));

/**
 * Aucune base : la lecture sert les lignes déclarées, l'écriture est enregistrée
 * avec sa clause `WHERE` — c'est elle qui porte le cloisonnement, donc c'est
 * elle que les tests inspectent (même doublure que `plan-revisions.test.ts`).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    inserts: [] as Array<{ table: string; values: unknown }>,
    selects: [] as Array<{ table: string; where: SQL }>,
    limits: [] as number[],
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type SelectChain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => SelectChain;
    orderBy: () => SelectChain;
    limit: (value: number) => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      where: (clause) => {
        dbState.selects.push({ table: name, where: clause });
        return chain;
      },
      orderBy: () => chain,
      limit: (value) => {
        dbState.limits.push(value);
        return chain;
      },
      then: (onFulfilled, onRejected) => Promise.resolve(dbState.rows).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return {
    db: {
      select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
      insert: (table: Table) => ({
        values: (values: unknown) => {
          dbState.inserts.push({ table: getTableName(table), values });
          return Promise.resolve(undefined);
        },
      }),
    },
  };
});

const dialect = new PgDialect();

function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

const ATHLETE_ID = 7;

function decision(overrides: Partial<PlanReviewDecisionInput> = {}): PlanReviewDecisionInput {
  return {
    planId: 3,
    verdict: 'keep',
    reason: 'Les quatre séances sont dans les cibles.',
    planWeek: 5,
    sessionsCompleted: 4,
    sessionsMissed: 1,
    fitness: { ctl: 52.4, atl: 61.2, tsb: -8.8 },
    revisionId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows = [];
  dbState.inserts = [];
  dbState.selects = [];
  dbState.limits = [];
  athlete.getCurrentAthleteId.mockResolvedValue(ATHLETE_ID);
});

describe('recordPlanReviewDecision', () => {
  it('écrit le verdict, sa raison et le résumé des entrées sous l’athlète reçu', async () => {
    await recordPlanReviewDecision(
      decision({ verdict: 'adjust', reason: 'Charge trop élevée.', revisionId: 88 }),
      ATHLETE_ID,
    );

    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]).toMatchObject({ table: 'plan_review_decisions' });
    expect(dbState.inserts[0].values).toEqual({
      // L'appartenance vient de l'appelant, jamais de la ligne journalisée : le
      // service tourne hors requête, il n'y a pas de session à interroger.
      athleteId: ATHLETE_ID,
      planId: 3,
      verdict: 'adjust',
      reason: 'Charge trop élevée.',
      planWeek: 5,
      sessionsCompleted: 4,
      sessionsMissed: 1,
      ctl: 52.4,
      atl: 61.2,
      tsb: -8.8,
      revisionId: 88,
    });
  });

  it('écrit une charge absente en `NULL`, jamais en zéro', async () => {
    await recordPlanReviewDecision(decision({ fitness: null }), ATHLETE_ID);

    // Un zéro serait une donnée inventée : la charge n'était pas calculable.
    expect(dbState.inserts[0].values).toMatchObject({ ctl: null, atl: null, tsb: null });
  });
});

describe('listPlanReviewDecisions', () => {
  const ROW = {
    verdict: 'adjust',
    reason: 'Charge trop élevée.',
    planWeek: 5,
    sessionsCompleted: 4,
    sessionsMissed: 1,
    ctl: 52.4,
    atl: 61.2,
    tsb: -8.8,
    revisionId: 88,
    createdAt: new Date('2026-08-11T09:00:00.000Z'),
  };

  it('cloisonne la lecture sur l’athlète de la session', async () => {
    dbState.rows = [ROW];

    await listPlanReviewDecisions();

    expect(renderWhere(dbState.selects[0]?.where).params).toEqual([ATHLETE_ID]);
  });

  it('rend un DTO minimal : aucune clé de base ne franchit la frontière', async () => {
    dbState.rows = [ROW];

    expect(await listPlanReviewDecisions()).toEqual([
      {
        verdict: 'adjust',
        reason: 'Charge trop élevée.',
        planWeek: 5,
        sessionsCompleted: 4,
        sessionsMissed: 1,
        ctl: 52.4,
        atl: 61.2,
        tsb: -8.8,
        // De la proposition, il ne reste que le fait qu'il y en ait eu une.
        deposited: true,
        decidedAt: '2026-08-11T09:00:00.000Z',
      },
    ]);
  });

  it('dit qu’un verdict n’a rien déposé quand il n’a rien déposé', async () => {
    dbState.rows = [{ ...ROW, verdict: 'keep', revisionId: null }];

    expect((await listPlanReviewDecisions())[0]).toMatchObject({
      verdict: 'keep',
      deposited: false,
    });
  });

  it('borne la lecture, et respecte la borne demandée', async () => {
    dbState.rows = [ROW];

    await listPlanReviewDecisions();
    await listPlanReviewDecisions(5);

    expect(dbState.limits).toEqual([20, 5]);
  });

  it('ne lit rien, et ne rend rien, sans athlète', async () => {
    athlete.getCurrentAthleteId.mockResolvedValue(null);

    expect(await listPlanReviewDecisions()).toEqual([]);
    expect(dbState.selects).toHaveLength(0);
  });
});
