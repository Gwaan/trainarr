import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getFitnessTestCandidate,
  pickTestActivity,
  recordFitnessTest,
} from './fitness-test';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données — même doublure que `plan-reconciliation.test.ts` : une
 * file de jeux de résultats par table, consommée dans l'ordre des requêtes (le
 * dernier reste servi ensuite). `activities` est lue **deux fois** ici : la
 * jointure qui identifie le test, puis les sorties de la journée.
 *
 * Les clauses `WHERE` sont enregistrées telles qu'elles partiront : c'est là que
 * vivent l'anti-IDOR et le filtre « plan actif », donc c'est elles que les tests
 * inspectent.
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

  const nextResult = (queues: Record<string, unknown[][]>, name: string): unknown[] => {
    const queue = queues[name];
    if (!queue || queue.length === 0) return [];
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? [];
  };

  type SelectChain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => SelectChain;
    innerJoin: () => SelectChain;
    orderBy: () => SelectChain;
    limit: () => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      where: (clause) => {
        dbState.selects.push({ table: name, where: clause });
        return chain;
      },
      innerJoin: () => chain,
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

const { athlete } = vi.hoisted(() => ({
  athlete: { getAthleteProfileById: vi.fn() },
}));

// Le module ne résout plus l'athlète : il le reçoit. Seule la lecture du profil
// **par identifiant** subsiste, et c'est elle qu'on remplace.
vi.mock('./athlete', () => ({
  getAthleteProfileById: athlete.getAthleteProfileById,
}));

const dialect = new PgDialect();

/** Clause `WHERE` rendue en SQL + paramètres liés, pour l'affirmer telle qu'elle partira. */
function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée pour cette requête.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

/**
 * Les séries d'une sortie qui couvre 6 km à `paceSecPerKm`, un point par
 * kilomètre — assez pour que `computeBestSegments` y isole un 5 km.
 */
function streams(activityId: number, paceSecPerKm: number) {
  const points = 7;
  return [
    {
      activityId,
      type: 'distance',
      data: Array.from({ length: points }, (_unused, index) => index * 1_000),
    },
    {
      activityId,
      type: 'time',
      data: Array.from({ length: points }, (_unused, index) => index * paceSecPerKm),
    },
  ];
}

/** La ligne de la jointure activité ↔ séance ↔ plan, telle que la requête la rend. */
function joined(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    maxHrBpm: 181,
    sessionKind: 'Test 5 km',
    scheduledOn: '2026-09-16',
    planId: 3,
    planStartsOn: '2026-08-10',
    referenceDistance: '5k',
    referenceTimeS: 1_620,
    referenceUpdatedOn: null,
    ...overrides,
  };
}

/** Une sortie du jour du test, telle que la seconde requête la rend. */
function dayActivity(overrides: Partial<Record<string, unknown>> & { id: number }) {
  return {
    startedAt: new Date('2026-09-16T16:00:00.000Z'),
    sportType: 'Run',
    maxHrBpm: 180,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows = {};
  dbState.returning = {};
  dbState.updates = [];
  dbState.selects = [];
  athlete.getAthleteProfileById.mockResolvedValue({ maxHrBpm: 184 });
});

describe('pickTestActivity', () => {
  it('retient la sortie dont le meilleur 5 km est le plus rapide', () => {
    // Le footing du matin est importé le premier et consomme la séance ; c'est
    // pourtant le test du soir qui porte le chrono.
    const picked = pickTestActivity([
      { id: 10, maxHrBpm: 150, bestFiveKTimeS: 1_800 },
      { id: 11, maxHrBpm: 181, bestFiveKTimeS: 1_580 },
    ]);

    expect(picked?.id).toBe(11);
  });

  it('fait passer après une sortie sans 5 km mesurable', () => {
    expect(
      pickTestActivity([
        { id: 10, maxHrBpm: 150, bestFiveKTimeS: null },
        { id: 11, maxHrBpm: 181, bestFiveKTimeS: 1_800 },
      ])?.id,
    ).toBe(11);
    // Et quand aucune n'en a un, il reste la première : le verdict dira
    // « inexploitable », mais il sera écrit.
    expect(
      pickTestActivity([
        { id: 11, maxHrBpm: 150, bestFiveKTimeS: null },
        { id: 10, maxHrBpm: 181, bestFiveKTimeS: null },
      ])?.id,
    ).toBe(10);
  });

  it('tranche l’égalité par le plus petit identifiant, et reste déterministe', () => {
    const candidates = [
      { id: 11, maxHrBpm: 181, bestFiveKTimeS: 1_580 },
      { id: 10, maxHrBpm: 179, bestFiveKTimeS: 1_580 },
    ];
    expect(pickTestActivity(candidates)?.id).toBe(10);
    expect(pickTestActivity(candidates)?.id).toBe(10);
  });

  it('ne rend rien sur une journée vide', () => {
    expect(pickTestActivity([])).toBeNull();
  });
});

describe('getFitnessTestCandidate', () => {
  it('ne rend rien quand la séance rapprochée n’est pas un test', async () => {
    dbState.rows = { activities: [[joined({ sessionKind: 'Seuil' })]] };

    expect(await getFitnessTestCandidate(42, 1)).toBeNull();
  });

  it('ne rend rien quand aucune séance d’un plan actif n’est rapprochée', async () => {
    dbState.rows = { activities: [[]] };

    expect(await getFitnessTestCandidate(42, 1)).toBeNull();
    // Le filtre « plan actif » part bien avec la lecture : un plan archivé ne se
    // recalibre pas.
    expect(renderWhere(dbState.selects[0]?.where).params).toContain('active');
  });

  it('borne la lecture à l’athlète reçu : un id d’activité ne suffit pas', async () => {
    dbState.rows = { activities: [[]] };

    expect(await getFitnessTestCandidate(42, 9)).toBeNull();
    // L'athlète est dans le `WHERE`, pas déduit d'une session : le service de
    // fond n'en a pas, et l'activité d'un autre compte ne doit rien recalibrer.
    expect(renderWhere(dbState.selects[0]?.where).params).toContain(9);
  });

  it('ne rend rien quand le plan n’a pas de chrono de référence', async () => {
    dbState.rows = {
      activities: [[joined({ referenceDistance: null, referenceTimeS: null })]],
    };

    expect(await getFitnessTestCandidate(42, 1)).toBeNull();
  });

  it('retient le meilleur 5 km de la journée, pas celui de l’activité rapprochée', async () => {
    // Le footing du matin (id 42) a pris le créneau ; le test du soir (id 43)
    // est la sortie rapide de la journée.
    dbState.rows = {
      activities: [[joined()], [dayActivity({ id: 43, maxHrBpm: 179 })]],
      activity_streams: [[...streams(42, 360), ...streams(43, 310)]],
    };

    const candidate = await getFitnessTestCandidate(42, 1);

    expect(candidate).not.toBeNull();
    expect(candidate?.activityId).toBe(43);
    expect(candidate?.bestFiveKTimeS).toBe(5 * 310);
    // La FC max suit l'activité retenue, pas celle qui a déclenché l'import.
    expect(candidate?.activityMaxHrBpm).toBe(179);
  });

  it('ignore les sorties d’un autre jour et celles qui ne sont pas de la course', async () => {
    dbState.rows = {
      activities: [
        [joined()],
        [
          // Plus rapide, mais courue la veille : hors du jour du test.
          dayActivity({ id: 43, startedAt: new Date('2026-09-15T16:00:00.000Z') }),
          // Plus rapide, mais à vélo.
          dayActivity({ id: 44, sportType: 'Ride' }),
        ],
      ],
      activity_streams: [
        [...streams(42, 360), ...streams(43, 200), ...streams(44, 150)],
      ],
    };

    const candidate = await getFitnessTestCandidate(42, 1);

    expect(candidate?.activityId).toBe(42);
    expect(candidate?.bestFiveKTimeS).toBe(5 * 360);
  });

  it('rend le plan, sa référence et la date planifiée du test', async () => {
    dbState.rows = {
      activities: [[joined({ referenceUpdatedOn: '2026-08-19' })], []],
      activity_streams: [streams(42, 320)],
    };

    const candidate = await getFitnessTestCandidate(42, 1);

    expect(candidate).toEqual({
      planId: 3,
      activityId: 42,
      planStartsOn: '2026-08-10',
      referenceDistanceM: 5_000,
      referenceTimeS: 1_620,
      referenceUpdatedOn: '2026-08-19',
      // La date du test est celle à laquelle la séance était planifiée : c'est
      // au jour civil que le rapprochement lie.
      testedOn: '2026-09-16',
      activityMaxHrBpm: 181,
      profileMaxHrBpm: 184,
      bestFiveKTimeS: 5 * 320,
    });
  });

  it('rend un candidat sans chrono quand la journée n’a aucun 5 km mesurable', async () => {
    dbState.rows = { activities: [[joined()], []], activity_streams: [[]] };

    const candidate = await getFitnessTestCandidate(42, 1);

    // Pas de refus silencieux : le service écrira « inexploitable » plutôt que
    // de ne rien dire.
    expect(candidate?.bestFiveKTimeS).toBeNull();
    expect(candidate?.activityId).toBe(42);
  });

  it('ne conclut rien de la FC quand le profil n’en porte pas', async () => {
    athlete.getAthleteProfileById.mockResolvedValue(null);
    dbState.rows = { activities: [[joined()], []], activity_streams: [streams(42, 320)] };

    expect((await getFitnessTestCandidate(42, 1))?.profileMaxHrBpm).toBeNull();
  });
});

describe('recordFitnessTest', () => {
  it('écrit la note seule quand le chrono ne bouge pas', async () => {
    dbState.returning = { plans: [[{ id: 3 }]] };

    expect(await recordFitnessTest(3, { note: 'Test du 16 septembre : rien ne change.' }, 1)).toBe(
      true,
    );

    const update = dbState.updates[0];
    expect(update?.table).toBe('plans');
    const values = update?.values as Record<string, unknown>;
    expect(values.lastTestNote).toBe('Test du 16 septembre : rien ne change.');
    // Ni la référence ni sa date : un test qui ne fait rien bouger ne redémarre
    // pas la cadence.
    expect(values).not.toHaveProperty('referenceTimeS');
    expect(values).not.toHaveProperty('referenceUpdatedOn');
  });

  it('écrit le chrono et sa date quand le test l’améliore', async () => {
    dbState.returning = { plans: [[{ id: 3 }]] };

    await recordFitnessTest(
      3,
      { note: 'Nouveau record.', reference: { timeS: 1_580.4, updatedOn: '2026-09-16' } },
      1,
    );

    const values = dbState.updates[0]?.values as Record<string, unknown>;
    expect(values.referenceDistance).toBe('5k');
    expect(values.referenceTimeS).toBe(1_580);
    expect(values.referenceUpdatedOn).toBe('2026-09-16');
  });

  it('porte l’appartenance et l’état actif dans le `WHERE`, pas dans une lecture préalable', async () => {
    dbState.returning = { plans: [[{ id: 3 }]] };

    await recordFitnessTest(3, { note: 'Note.' }, 1);

    const { params } = renderWhere(dbState.updates[0]?.where);
    expect(params).toEqual([3, 1, 'active']);
  });

  it('écrit sous l’athlète reçu, jamais sous celui d’une session', async () => {
    dbState.returning = { plans: [[{ id: 3 }]] };

    await recordFitnessTest(3, { note: 'Note.' }, 9);

    expect(renderWhere(dbState.updates[0]?.where).params).toEqual([3, 9, 'active']);
  });

  it('rend `false` quand le plan n’est plus le plan actif de l’athlète', async () => {
    dbState.returning = { plans: [[]] };

    expect(await recordFitnessTest(3, { note: 'Note.' }, 1)).toBe(false);
  });
});
