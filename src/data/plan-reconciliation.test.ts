import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  linkActivityToPlannedSession,
  matchActivitiesToSessions,
  pickPlannedSession,
  reconcilePlanSessions,
  type ActivityCandidate,
  type PendingSession,
  type SessionCandidate,
} from './plan-reconciliation';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * **Ce module ne lit plus de session, et ce mock est là pour l'attester.**
 *
 * Le rapprochement est déclenché par l'ingestion d'un fichier FIT, qui tourne
 * hors requête : `headers()` y lève, `getSession()` rend « pas de session », et
 * l'athlète déduit ressortait `null` — les liens n'étaient jamais posés. Il est
 * désormais un paramètre. La session est donc remplacée par un espion qui lève :
 * n'importe quel retour à une déduction ferait échouer ces tests au lieu de
 * repartir en silence.
 */
const { getSessionSpy } = vi.hoisted(() => ({
  getSessionSpy: vi.fn(() => {
    throw new Error('`getSession` ne doit pas être appelée : ce module reçoit son athlète.');
  }),
}));

vi.mock('./session', () => ({ getSession: getSessionSpy }));

afterEach(() => {
  expect(getSessionSpy).not.toHaveBeenCalled();
});

/**
 * Aucune base de données.
 *
 * Chaque table sert une **file** de jeux de résultats, consommée dans l'ordre
 * des requêtes (le dernier reste servi ensuite) : `planned_sessions` est lue
 * deux fois par une réconciliation, avec des lignes différentes.
 *
 * Les écritures sont enregistrées avec leur clause `WHERE` — c'est elle qui
 * porte l'anti-IDOR et la fermeture de course sur `completed_activity_id`, donc
 * c'est elle que les tests inspectent (rendue en SQL, cf. `renderWhere`).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[][]>,
    returning: {} as Record<string, unknown[][]>,
    updates: [] as Array<{ table: string; values: unknown; where: SQL }>,
    selects: [] as Array<{ table: string; where: SQL }>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  /** Prochain jeu de résultats de la table — le dernier de la file resservant. */
  const nextResult = (queues: Record<string, unknown[][]>, name: string): unknown[] => {
    const queue = queues[name];
    if (!queue || queue.length === 0) return [];
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? [];
  };

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
            const name = getTableName(table);
            dbState.updates.push({ table: name, values, where: clause });
            return { returning: () => Promise.resolve(nextResult(dbState.returning, name)) };
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
const NOW = new Date('2026-08-11T09:00:00.000Z');

vi.useFakeTimers();
vi.setSystemTime(NOW);

afterAll(() => {
  vi.useRealTimers();
});

/** Une sortie du 12 août 2026, 8 h 30 à Paris. */
/** L'athlète que l'ingestion passe au rapprochement — jamais déduit d'une session. */
const ATHLETE_ID = 1;

const RUN: ActivityCandidate & { athleteId: number } = {
  id: 42,
  athleteId: ATHLETE_ID,
  sportType: 'Run',
  startedAt: new Date('2026-08-12T06:30:00.000Z'),
};

beforeEach(() => {
  dbState.rows = { athlete: [[{ id: 1 }]] };
  dbState.returning = {};
  dbState.updates = [];
  dbState.selects = [];
});

describe('pickPlannedSession', () => {
  it('ne choisit rien quand aucune séance ne tombe ce jour-là', () => {
    expect(pickPlannedSession([])).toBeNull();
  });

  it('prend la seule candidate, hors plan comprise', () => {
    expect(pickPlannedSession([{ id: 7, planId: null }])).toEqual({ id: 7, planId: null });
  });

  it('préfère la séance du plan actif à une séance hors plan', () => {
    const outOfPlan: SessionCandidate = { id: 2, planId: null };
    const inPlan: SessionCandidate = { id: 9, planId: 3 };

    // Le plan l'emporte même avec l'`id` le plus grand, et quel que soit l'ordre
    // de la liste : c'est le plan que l'athlète suit.
    expect(pickPlannedSession([outOfPlan, inPlan])).toBe(inPlan);
    expect(pickPlannedSession([inPlan, outOfPlan])).toBe(inPlan);
  });

  it('départage deux séances du plan par le plus petit `id`', () => {
    expect(pickPlannedSession([{ id: 9, planId: 3 }, { id: 4, planId: 3 }])).toEqual({
      id: 4,
      planId: 3,
    });
  });

  it('départage deux séances hors plan par le plus petit `id`', () => {
    expect(pickPlannedSession([{ id: 9, planId: null }, { id: 4, planId: null }])).toEqual({
      id: 4,
      planId: null,
    });
  });
});

describe('matchActivitiesToSessions', () => {
  const SESSION: PendingSession = { id: 7, scheduledOn: '2026-08-12' };
  const NONE = new Set<number>();

  it('rapproche la sortie du jour de la séance de ce jour', () => {
    expect(matchActivitiesToSessions([SESSION], [RUN], NONE)).toEqual([
      { sessionId: 7, activityId: 42 },
    ]);
  });

  it('ne rapproche rien quand aucune activité ne tombe ce jour-là', () => {
    expect(matchActivitiesToSessions([SESSION], [], NONE)).toEqual([]);
    expect(
      matchActivitiesToSessions(
        [SESSION],
        [{ ...RUN, startedAt: new Date('2026-08-13T06:30:00.000Z') }],
        NONE,
      ),
    ).toEqual([]);
  });

  it('ignore ce qui n’est pas de la course à pied', () => {
    expect(
      matchActivitiesToSessions([SESSION], [{ ...RUN, sportType: 'Ride' }], NONE),
    ).toEqual([]);
  });

  it('ignore une activité déjà rapprochée d’une autre séance', () => {
    expect(matchActivitiesToSessions([SESSION], [RUN], new Set([42]))).toEqual([]);
  });

  it('raisonne en jour civil de l’athlète, pas en UTC', () => {
    // 12 août 22 h 30 UTC = 13 août 0 h 30 à Paris : la séance du 13 la réclame.
    const lateRun: ActivityCandidate = {
      ...RUN,
      startedAt: new Date('2026-08-12T22:30:00.000Z'),
    };

    expect(matchActivitiesToSessions([SESSION], [lateRun], NONE)).toEqual([]);
    expect(
      matchActivitiesToSessions([{ id: 8, scheduledOn: '2026-08-13' }], [lateRun], NONE),
    ).toEqual([{ sessionId: 8, activityId: 42 }]);
  });

  it('ne sert qu’une séance quand une seule sortie couvre deux séances du jour', () => {
    const matches = matchActivitiesToSessions(
      [{ id: 9, scheduledOn: '2026-08-12' }, SESSION],
      [RUN],
      NONE,
    );

    // La première créée (plus petit `id`) est servie ; l'autre reste en attente.
    expect(matches).toEqual([{ sessionId: 7, activityId: 42 }]);
  });

  it('sert deux séances du même jour dans l’ordre chronologique des sorties', () => {
    const evening: ActivityCandidate = {
      id: 43,
      sportType: 'Run',
      startedAt: new Date('2026-08-12T16:00:00.000Z'),
    };

    expect(
      matchActivitiesToSessions(
        [{ id: 9, scheduledOn: '2026-08-12' }, SESSION],
        [evening, RUN],
        NONE,
      ),
    ).toEqual([
      { sessionId: 7, activityId: 42 },
      { sessionId: 9, activityId: 43 },
    ]);
  });

  it('départage deux sorties parties au même instant par le plus petit `id`', () => {
    const twin: ActivityCandidate = { ...RUN, id: 41 };

    expect(matchActivitiesToSessions([SESSION], [RUN, twin], NONE)).toEqual([
      { sessionId: 7, activityId: 41 },
    ]);
  });

  it('traite les séances par date, du plus ancien au plus récent', () => {
    const older: ActivityCandidate = {
      id: 40,
      sportType: 'Run',
      startedAt: new Date('2026-08-11T06:30:00.000Z'),
    };

    expect(
      matchActivitiesToSessions(
        [SESSION, { id: 3, scheduledOn: '2026-08-11' }],
        [RUN, older],
        NONE,
      ),
    ).toEqual([
      { sessionId: 3, activityId: 40 },
      { sessionId: 7, activityId: 42 },
    ]);
  });

  it('ne rapproche rien sans séance en attente', () => {
    expect(matchActivitiesToSessions([], [RUN], NONE)).toEqual([]);
  });
});

describe('linkActivityToPlannedSession', () => {
  /** Base type : l'activité existe, elle n'est rapprochée de rien, une séance l'attend. */
  function givenPendingSession(candidates: unknown[] = [{ id: 7, planId: 3 }]): void {
    dbState.rows.activities = [[RUN]];
    dbState.rows.plans = [[{ id: 3 }]];
    dbState.rows.planned_sessions = [[], candidates];
    dbState.returning.planned_sessions = [[{ id: 7 }]];
  }

  it('rapproche l’activité de la séance du jour et le signale', async () => {
    givenPendingSession();

    await expect(linkActivityToPlannedSession(42, ATHLETE_ID)).resolves.toBe(true);

    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]?.table).toBe('planned_sessions');
    expect(dbState.updates[0]?.values).toEqual({ completedActivityId: 42 });
  });

  it('n’écrase jamais un lien posé entre-temps (course entre deux imports)', async () => {
    givenPendingSession();

    await linkActivityToPlannedSession(42, ATHLETE_ID);

    const where = renderWhere(dbState.updates[0]?.where);
    expect(where.params).toEqual([7]);
    expect(where.sql).toContain('"completed_activity_id" is null');
  });

  it('cherche la séance du jour civil de l’activité, chez son athlète', async () => {
    givenPendingSession();

    await linkActivityToPlannedSession(42, ATHLETE_ID);

    const query = dbState.selects.filter((select) => select.table === 'planned_sessions')[1];
    const where = renderWhere(query?.where);
    // Athlète, jour civil (8 h 30 à Paris, pas le 11 août UTC), plan actif.
    expect(where.params).toEqual([1, '2026-08-12', 3]);
    expect(where.sql).toContain('"completed_activity_id" is null');
    expect(where.sql).toContain('"plan_id" is null');
  });

  it('ne retient que le plan actif : une proposition en attente n’est jamais rapprochée', async () => {
    givenPendingSession();

    await linkActivityToPlannedSession(42, ATHLETE_ID);

    const where = renderWhere(dbState.selects.find((select) => select.table === 'plans')?.where);
    // Le statut est dans le `WHERE` : les séances d'un brouillon (comme celles
    // d'un plan archivé) restent hors d'atteinte — les marquer « réalisées »
    // ferait raconter à un plan que l'athlète n'a pas choisi une histoire qui
    // n'est pas la sienne.
    expect(where.params).toEqual([1, 'active']);
  });

  it('n’accepte que les séances hors plan quand aucun plan n’est actif', async () => {
    givenPendingSession([{ id: 7, planId: null }]);
    dbState.rows.plans = [[]];

    await expect(linkActivityToPlannedSession(42, ATHLETE_ID)).resolves.toBe(true);

    const query = dbState.selects.filter((select) => select.table === 'planned_sessions')[1];
    const where = renderWhere(query?.where);
    expect(where.params).toEqual([1, '2026-08-12']);
    expect(where.sql).toContain('"plan_id" is null');
  });

  it('ne fait rien pour une activité inconnue', async () => {
    dbState.rows.activities = [[]];

    await expect(linkActivityToPlannedSession(42, ATHLETE_ID)).resolves.toBe(false);
    expect(dbState.updates).toEqual([]);
  });

  it('confronte l’activité à l’athlète reçu, dans la même clause', async () => {
    givenPendingSession();

    await linkActivityToPlannedSession(42, ATHLETE_ID);

    const query = dbState.selects.find((select) => select.table === 'activities');
    expect(renderWhere(query?.where).params).toEqual([42, ATHLETE_ID]);
  });

  it('ne rapproche rien pour l’activité d’un autre athlète', async () => {
    // L'activité 42 existe et une séance l'attend — mais chez quelqu'un d'autre.
    // Prendre l'athlète sur la ligne trouvée aurait posé le lien quand même :
    // ici la lecture filtrée ne rend rien, et la fonction s'arrête là.
    givenPendingSession();
    dbState.rows.activities = [[]];

    await expect(linkActivityToPlannedSession(42, 2)).resolves.toBe(false);
    expect(dbState.updates).toEqual([]);
    expect(dbState.selects.some((select) => select.table === 'planned_sessions')).toBe(false);
  });

  it('ne rapproche pas une activité qui n’est pas de la course à pied', async () => {
    givenPendingSession();
    dbState.rows.activities = [[{ ...RUN, sportType: 'Ride' }]];

    await expect(linkActivityToPlannedSession(42, ATHLETE_ID)).resolves.toBe(false);
    expect(dbState.updates).toEqual([]);
    expect(dbState.selects.some((select) => select.table === 'planned_sessions')).toBe(false);
  });

  it('est idempotente : une activité déjà rapprochée ne l’est pas deux fois', async () => {
    givenPendingSession();
    dbState.rows.planned_sessions = [[{ id: 7 }]];

    await expect(linkActivityToPlannedSession(42, ATHLETE_ID)).resolves.toBe(false);
    expect(dbState.updates).toEqual([]);
  });

  it('ne fait rien quand aucune séance n’attend ce jour-là', async () => {
    givenPendingSession([]);

    await expect(linkActivityToPlannedSession(42, ATHLETE_ID)).resolves.toBe(false);
    expect(dbState.updates).toEqual([]);
  });

  it('rend `false` quand une écriture concurrente a gagné la séance', async () => {
    givenPendingSession();
    dbState.returning.planned_sessions = [[]];

    await expect(linkActivityToPlannedSession(42, ATHLETE_ID)).resolves.toBe(false);
  });
});

describe('reconcilePlanSessions', () => {
  /** Deux séances passées en attente, une sortie qui réalise la première. */
  function givenPlanToReconcile(): void {
    dbState.rows.planned_sessions = [
      [
        { id: 7, scheduledOn: '2026-08-10' },
        { id: 8, scheduledOn: '2026-08-11' },
      ],
      [],
    ];
    dbState.rows.activities = [
      [{ id: 42, sportType: 'Run', startedAt: new Date('2026-08-10T06:30:00.000Z') }],
    ];
    dbState.returning.planned_sessions = [[{ id: 7 }]];
  }

  it('rapproche les séances passées et compte les liens posés', async () => {
    givenPlanToReconcile();

    await expect(reconcilePlanSessions(3, 1)).resolves.toBe(1);

    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]?.values).toEqual({ completedActivityId: 42 });
    expect(renderWhere(dbState.updates[0]?.where).params).toEqual([7]);
  });

  it('ne lit que les séances passées non réalisées, du plan et de l’athlète', async () => {
    givenPlanToReconcile();

    await reconcilePlanSessions(3, 1);

    const where = renderWhere(
      dbState.selects.find((select) => select.table === 'planned_sessions')?.where,
    );
    expect(where.params).toEqual([3, 1, '2026-08-11']);
    expect(where.sql).toContain('"completed_activity_id" is null');
    expect(where.sql).toContain('"scheduled_on" <= $3');
  });

  it('ne réutilise pas une activité déjà rapprochée d’une autre séance', async () => {
    givenPlanToReconcile();
    dbState.rows.planned_sessions[1] = [{ activityId: 42 }];

    await expect(reconcilePlanSessions(3, 1)).resolves.toBe(0);
    expect(dbState.updates).toEqual([]);
  });

  it('ne lit aucune activité quand le plan n’a aucune séance passée en attente', async () => {
    dbState.rows.planned_sessions = [[]];

    await expect(reconcilePlanSessions(3, 1)).resolves.toBe(0);
    expect(dbState.selects.some((select) => select.table === 'activities')).toBe(false);
  });

  it('ne compte pas une séance gagnée entre-temps par un import', async () => {
    givenPlanToReconcile();
    dbState.returning.planned_sessions = [[]];

    await expect(reconcilePlanSessions(3, 1)).resolves.toBe(0);
  });

  it('rapproche sous l’athlète reçu, jamais sous celui d’une session', async () => {
    // Le déclencheur nominal est le suivi de plan derrière une ingestion : il
    // tourne hors requête, il n'y a pas de session à interroger.
    givenPlanToReconcile();

    await reconcilePlanSessions(3, 9);

    const where = renderWhere(
      dbState.selects.find((select) => select.table === 'planned_sessions')?.where,
    );
    expect(where.params).toEqual([3, 9, '2026-08-11']);
  });
});
