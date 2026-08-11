import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REVIEW_MAX_DETAILED_SESSIONS,
  boundReviewSessions,
  getPlanReview,
  getPlanUpdatedAt,
  markPlanReviewed,
  sessionsSinceReview,
  type PlanReviewSessionDto,
} from './plan-review';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données — même doublure que `plan-reconciliation.test.ts` : une
 * file de jeux de résultats par table, et les clauses `WHERE` enregistrées
 * telles qu'elles partiront (c'est là que vit l'anti-IDOR).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[][]>,
    updates: [] as Array<{ table: string; values: unknown; where: SQL }>,
    selects: [] as Array<{ table: string; where: SQL }>,
    joins: [] as Array<{ table: string; on: SQL | undefined }>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  const nextResult = (queues: Record<string, unknown[][]>, name: string): unknown[] => {
    const queue = queues[name];
    if (!queue || queue.length === 0) return [];
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? [];
  };

  type SelectChain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => SelectChain;
    leftJoin: (table: Table, on: SQL | undefined) => SelectChain;
    orderBy: () => SelectChain;
    limit: () => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      where: (clause) => {
        dbState.selects.push({ table: name, where: clause });
        return chain;
      },
      leftJoin: (table, on) => {
        dbState.joins.push({ table: getTableName(table), on });
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(nextResult(dbState.rows, name)).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return {
    db: {
      select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
      update: (table: Table) => ({
        set: (values: unknown) => ({
          where: (clause: SQL) => {
            dbState.updates.push({ table: getTableName(table), values, where: clause });
            return Promise.resolve([]);
          },
        }),
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

/** Aujourd'hui : mardi 11 août 2026, 11 h à Paris. */
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));

afterAll(() => {
  vi.useRealTimers();
});

/** Une ligne de la jointure séance ↔ activité, telle que la requête la rend. */
function joined(overrides: Partial<Record<string, unknown>> & { scheduledOn: string }) {
  return {
    kind: 'Endurance fondamentale',
    title: 'Footing',
    targetPaceSecPerKm: 330,
    volumeM: 10_000,
    durationS: 3_300,
    distanceM: null,
    movingTimeS: null,
    avgPaceSecPerKm: null,
    avgHrBpm: null,
    ...overrides,
  };
}

/** Une séance du bilan, côté DTO. */
function reviewSession(
  overrides: Partial<PlanReviewSessionDto> & { scheduledOn: string },
): PlanReviewSessionDto {
  return {
    kind: 'Endurance fondamentale',
    title: 'Footing',
    targetPaceSecPerKm: 330,
    volumeM: 10_000,
    durationS: 3_300,
    completed: null,
    ...overrides,
  };
}

/** Dernière modification du plan, telle que la colonne la rend. */
const UPDATED_AT = new Date('2026-08-10T08:00:00.000Z');

beforeEach(() => {
  dbState.rows = { athlete: [[{ id: 1 }]] };
  dbState.updates = [];
  dbState.selects = [];
  dbState.joins = [];
});

describe('sessionsSinceReview', () => {
  const first = reviewSession({
    scheduledOn: '2026-08-01',
    completed: { distanceM: 10_000, movingTimeS: 3_300, avgPaceSecPerKm: 330, avgHrBpm: 142 },
  });
  const missed = reviewSession({ scheduledOn: '2026-08-03' });
  const second = reviewSession({
    scheduledOn: '2026-08-05',
    completed: { distanceM: 8_000, movingTimeS: 2_600, avgPaceSecPerKm: 325, avgHrBpm: 148 },
  });

  it('rend tout quand aucune révision n’a eu lieu', () => {
    expect(sessionsSinceReview([first, missed, second], 0)).toEqual([first, missed, second]);
  });

  it('reprend après la dernière séance réalisée déjà relue', () => {
    // La séance manquée du 3 précède la seconde réalisée : elle était déjà sous
    // les yeux du coach, elle ne revient pas.
    expect(sessionsSinceReview([first, missed, second], 1)).toEqual([missed, second]);
    expect(sessionsSinceReview([first, missed, second], 2)).toEqual([]);
  });

  it('ne rend rien quand le marqueur dépasse ce qui reste (séances supprimées)', () => {
    expect(sessionsSinceReview([first, second], 5)).toEqual([]);
  });
});

describe('boundReviewSessions', () => {
  /** `count` séances alternant réalisées et manquées, dans l'ordre chronologique. */
  function series(count: number): PlanReviewSessionDto[] {
    return Array.from({ length: count }, (_unused, index) =>
      reviewSession({
        scheduledOn: `2026-06-${String(index + 1).padStart(2, '0')}`,
        completed:
          index % 2 === 0
            ? { distanceM: 10_000, movingTimeS: 3_300, avgPaceSecPerKm: 330, avgHrBpm: 142 }
            : null,
      }),
    );
  }

  it('ne touche à rien tant que la fenêtre suffit', () => {
    const sessions = series(REVIEW_MAX_DETAILED_SESSIONS);

    expect(boundReviewSessions(sessions)).toEqual({ sessions, older: null });
  });

  it('ne détaille que les plus récentes et compte le reste', () => {
    // 20 séances : 10 réalisées (indices pairs), 10 manquées.
    const sessions = series(20);

    const bounded = boundReviewSessions(sessions, 12);

    expect(bounded.sessions).toEqual(sessions.slice(8));
    // Les 8 écartées sont les plus anciennes : 4 réalisées, 4 manquées.
    expect(bounded.older).toEqual({ count: 8, completed: 4, missed: 4 });
  });
});

describe('getPlanReview', () => {
  it('rend le prévu et le couru des séances depuis la dernière révision', async () => {
    dbState.rows.plans = [[{ reviewedSessionCount: 1, updatedAt: UPDATED_AT }]];
    dbState.rows.planned_sessions = [
      [
        // Déjà relue : elle ne figure pas au bilan, mais elle compte.
        joined({
          scheduledOn: '2026-08-01',
          distanceM: 10_120,
          movingTimeS: 3_360,
          avgPaceSecPerKm: 332,
          avgHrBpm: 141,
        }),
        joined({ scheduledOn: '2026-08-04', kind: 'Seuil', title: '3 × 8 min' }),
        joined({
          scheduledOn: '2026-08-06',
          distanceM: 8_050,
          movingTimeS: 2_500,
          avgPaceSecPerKm: 310,
          avgHrBpm: 156,
        }),
      ],
    ];

    await expect(getPlanReview(3)).resolves.toEqual({
      completedSessionCount: 2,
      reviewedSessionCount: 1,
      older: null,
      updatedAt: UPDATED_AT.toISOString(),
      sessions: [
        reviewSession({ scheduledOn: '2026-08-04', kind: 'Seuil', title: '3 × 8 min' }),
        reviewSession({
          scheduledOn: '2026-08-06',
          completed: {
            distanceM: 8_050,
            movingTimeS: 2_500,
            avgPaceSecPerKm: 310,
            avgHrBpm: 156,
          },
        }),
      ],
    });
  });

  it('ne lit que les séances de l’athlète courant, jusqu’à aujourd’hui', async () => {
    dbState.rows.plans = [[{ reviewedSessionCount: 0, updatedAt: UPDATED_AT }]];
    dbState.rows.planned_sessions = [[]];

    await getPlanReview(3);

    const planWhere = renderWhere(
      dbState.selects.find((select) => select.table === 'plans')?.where,
    );
    expect(planWhere.sql).toContain('"athlete_id" =');
    expect(planWhere.sql).toContain('"status" =');
    expect(planWhere.params).toContain(1);
    expect(planWhere.params).toContain('active');

    const sessionsWhere = renderWhere(
      dbState.selects.find((select) => select.table === 'planned_sessions')?.where,
    );
    expect(sessionsWhere.sql).toContain('"athlete_id" =');
    // Rien du futur : une séance à venir n'est ni réalisée ni manquée.
    expect(sessionsWhere.params).toContain('2026-08-11');

    // La jointure est externe et porte elle aussi l'athlète : une séance
    // manquée doit survivre à la jointure, et aucune activité d'un autre ne
    // peut s'y rattacher.
    const join = dbState.joins.find((entry) => entry.table === 'activities');
    expect(join).toBeDefined();
    expect(renderWhere(join?.on).sql).toContain('"activities"."athlete_id" =');
  });

  it('ne rend rien quand le plan n’est pas le plan actif de l’athlète', async () => {
    dbState.rows.plans = [[]];

    await expect(getPlanReview(999)).resolves.toBeNull();
    // Aucune lecture des séances : la question ne se pose plus.
    expect(dbState.selects.some((select) => select.table === 'planned_sessions')).toBe(false);
  });

  it('ne rend rien tant qu’aucun athlète n’est enregistré', async () => {
    dbState.rows.athlete = [[]];

    await expect(getPlanReview(3)).resolves.toBeNull();
    expect(dbState.selects.some((select) => select.table === 'plans')).toBe(false);
  });
});

describe('getPlanUpdatedAt', () => {
  it('rend la dernière modification du plan actif de l’athlète', async () => {
    dbState.rows.plans = [[{ updatedAt: UPDATED_AT }]];

    await expect(getPlanUpdatedAt(3)).resolves.toBe(UPDATED_AT.toISOString());

    const where = renderWhere(dbState.selects.find((select) => select.table === 'plans')?.where);
    expect(where.params).toContain(3);
    expect(where.params).toContain(1);
    expect(where.params).toContain('active');
  });

  it('ne rend rien quand le plan n’est plus le plan actif', async () => {
    dbState.rows.plans = [[]];

    await expect(getPlanUpdatedAt(3)).resolves.toBeNull();
  });

  it('ne rend rien tant qu’aucun athlète n’est enregistré', async () => {
    dbState.rows.athlete = [[]];

    await expect(getPlanUpdatedAt(3)).resolves.toBeNull();
    expect(dbState.selects.some((select) => select.table === 'plans')).toBe(false);
  });
});

describe('markPlanReviewed', () => {
  it('avance le marqueur et date la révision, sur le seul plan actif de l’athlète', async () => {
    await markPlanReviewed(3, 6);

    const update = dbState.updates[0];
    expect(update.table).toBe('plans');
    expect(update.values).toEqual({ reviewedSessionCount: 6, reviewedAt: expect.any(Date) });

    const where = renderWhere(update.where);
    expect(where.params).toContain(3);
    expect(where.params).toContain(1);
    expect(where.params).toContain('active');
  });

  it('n’écrit rien tant qu’aucun athlète n’est enregistré', async () => {
    dbState.rows.athlete = [[]];

    await markPlanReviewed(3, 6);

    expect(dbState.updates).toHaveLength(0);
  });
});
