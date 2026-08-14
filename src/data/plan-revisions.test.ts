import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import type { PlanRevision } from './db/schema';
import {
  PlanRevisionNotFoundError,
  StalePlanRevisionError,
  acceptPlanRevision,
  depositPlanRevision,
  getPendingPlanRevision,
  getPendingPlanRevisionDetail,
  planRevisionPayloadSchema,
  rejectPlanRevision,
  toPlanRevisionSessions,
  type PlanRevisionDeposit,
  type PlanRevisionPayload,
} from './plan-revisions';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { athlete } = vi.hoisted(() => ({
  athlete: { getCurrentAthleteId: vi.fn() },
}));

vi.mock('./athlete', async () => {
  // `isCivilDate` est du vrai code : c'est lui qui valide le payload.
  const actual = await vi.importActual<typeof import('./athlete')>('./athlete');
  return { ...actual, getCurrentAthleteId: athlete.getCurrentAthleteId };
});

const { plansDal } = vi.hoisted(() => ({ plansDal: { applyPlanUpdate: vi.fn() } }));

vi.mock('./plans', async () => {
  const actual = await vi.importActual<typeof import('./plans')>('./plans');
  return { ...actual, applyPlanUpdate: plansDal.applyPlanUpdate };
});

/**
 * Aucune base : les lectures servent les lignes déclarées par table, les
 * écritures sont enregistrées avec leur clause `WHERE` — c'est elle qui porte
 * l'anti-IDOR, donc c'est elle que les tests inspectent (cf. `plans.test.ts`,
 * même doublure).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    returning: {} as Record<string, unknown[]>,
    insertErrors: {} as Record<string, unknown>,
    inserts: [] as Array<{ table: string; values: unknown }>,
    updates: [] as Array<{ table: string; values: unknown; where: SQL }>,
    deletes: [] as Array<{ table: string; where: SQL }>,
    selects: [] as Array<{ table: string; where: SQL }>,
    joins: [] as Array<{ table: string; on: SQL }>,
    transactions: 0,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type SelectChain = PromiseLike<unknown[]> & {
    innerJoin: (table: Table, on: SQL) => SelectChain;
    where: (clause: SQL) => SelectChain;
    orderBy: () => SelectChain;
    limit: () => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      innerJoin: (table, on) => {
        dbState.joins.push({ table: getTableName(table), on });
        return chain;
      },
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

  type WriteChain = PromiseLike<unknown> & { returning: () => Promise<unknown[]> };

  const writeChain = (name: string): WriteChain => ({
    returning: () => Promise.resolve(dbState.returning[name] ?? []),
    then: (onFulfilled, onRejected) => Promise.resolve(undefined).then(onFulfilled, onRejected),
  });

  const rejectingChain = (error: unknown): WriteChain => ({
    returning: () => Promise.reject(error),
    then: (onFulfilled, onRejected) => Promise.reject(error).then(onFulfilled, onRejected),
  });

  const client = {
    select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
    insert: (table: Table) => ({
      values: (values: unknown) => {
        const name = getTableName(table);
        dbState.inserts.push({ table: name, values });
        const failure = dbState.insertErrors[name];
        return failure === undefined ? writeChain(name) : rejectingChain(failure);
      },
    }),
    update: (table: Table) => ({
      set: (values: unknown) => ({
        where: (clause: SQL) => {
          const name = getTableName(table);
          dbState.updates.push({ table: name, values, where: clause });
          return writeChain(name);
        },
      }),
    }),
    delete: (table: Table) => ({
      where: (clause: SQL) => {
        const name = getTableName(table);
        dbState.deletes.push({ table: name, where: clause });
        return writeChain(name);
      },
    }),
  };

  return {
    db: {
      ...client,
      transaction: (run: (tx: typeof client) => Promise<unknown>) => {
        dbState.transactions += 1;
        return run(client);
      },
    },
  };
});

const dialect = new PgDialect();

function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

/** Une violation d'unicité telle que drizzle 0.45 l'enveloppe. */
function uniqueViolation(constraint: string): Error {
  const driverError = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: '23505', constraint_name: constraint },
  );
  return new Error("Failed query: insert into 'plan_revisions'", { cause: driverError });
}

const ATHLETE_ID = 7;
const PLAN_UPDATED_AT = new Date('2026-08-11T09:00:00.000Z');

const STEPS: PlanSessionSteps = [
  {
    repeat: 3,
    steps: [
      {
        role: 'run',
        distanceM: 800,
        durationS: null,
        paceMinSecPerKm: 225,
        paceMaxSecPerKm: 230,
        hrZone: null,
        note: null,
      },
    ],
  },
];

function payload(overrides: Partial<PlanRevisionPayload> = {}): PlanRevisionPayload {
  return {
    fromDate: '2026-08-12',
    sessions: [
      {
        scheduledOn: '2026-08-12',
        kind: 'Endurance fondamentale',
        title: 'Footing',
        warmup: null,
        recovery: null,
        cooldown: null,
        targetPaceSecPerKm: 374,
        volumeM: 10_000,
        durationS: 3_600,
        steps: null,
      },
      {
        scheduledOn: '2026-08-14',
        kind: 'VMA courte · piste',
        title: '3 × 800 m',
        warmup: '20 min souple',
        recovery: '90 s en trot',
        cooldown: '10 min souple',
        targetPaceSecPerKm: 225,
        volumeM: 8_000,
        durationS: 2_700,
        steps: STEPS,
      },
    ],
    settings: { summary: 'Bloc allégé.' },
    ...overrides,
  };
}

/** Le dépôt d'une revue, la source de loin la plus fréquente. */
function deposit(
  overrides: Partial<Extract<PlanRevisionDeposit, { source: 'review' }>> = {},
): PlanRevisionDeposit {
  return {
    source: 'review',
    planId: 3,
    reason: 'Deux séances manquées : la charge redescend.',
    direction: 'decrease',
    weeks: 3,
    before: { volumeKm: 42, intensityKm: 9 },
    after: { volumeKm: 36, intensityKm: 7 },
    payload: payload(),
    reviewedSessionCount: 4,
    ...overrides,
  };
}

function revisionRow(overrides: Partial<PlanRevision> = {}): PlanRevision {
  return {
    id: 11,
    athleteId: ATHLETE_ID,
    planId: 3,
    source: 'review',
    reason: 'Deux séances manquées : la charge redescend.',
    direction: 'decrease',
    weeks: 3,
    beforeVolumeKm: 42,
    beforeIntensityKm: 9,
    afterVolumeKm: 36,
    afterIntensityKm: 7,
    payload: payload(),
    planUpdatedAt: PLAN_UPDATED_AT,
    createdAt: new Date('2026-08-11T09:05:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows = {};
  dbState.returning = {};
  dbState.insertErrors = {};
  dbState.inserts = [];
  dbState.updates = [];
  dbState.deletes = [];
  dbState.selects = [];
  dbState.joins = [];
  dbState.transactions = 0;
  athlete.getCurrentAthleteId.mockResolvedValue(ATHLETE_ID);
  plansDal.applyPlanUpdate.mockResolvedValue(undefined);
});

describe('planRevisionPayloadSchema', () => {
  it('accepte ce que les services produisent', () => {
    expect(planRevisionPayloadSchema.safeParse(payload()).success).toBe(true);
  });

  it('refuse une date de reprise qui n’est pas une date civile', () => {
    expect(planRevisionPayloadSchema.safeParse(payload({ fromDate: '12/08/2026' })).success).toBe(
      false,
    );
  });

  it('refuse un déroulé que le schéma des séances rejetterait', () => {
    const broken = payload();
    // Une étape se mesure soit en distance, soit en durée — jamais les deux.
    const invalid = {
      ...broken,
      sessions: [
        {
          ...broken.sessions[1],
          steps: [{ repeat: 1, steps: [{ ...STEPS[0].steps[0], durationS: 120 }] }],
        },
      ],
    };

    expect(planRevisionPayloadSchema.safeParse(invalid).success).toBe(false);
  });

  it('écarte les clés inconnues plutôt que de les stocker', () => {
    const parsed = planRevisionPayloadSchema.parse({
      ...payload(),
      settings: { summary: 'Bloc.', inventé: 12 },
    });

    expect(parsed.settings).toEqual({ summary: 'Bloc.' });
  });
});

describe('toPlanRevisionSessions', () => {
  it('remplace les clés absentes par des `null` explicites', () => {
    expect(
      toPlanRevisionSessions([{ scheduledOn: '2026-08-12', kind: 'Endurance', title: 'Footing' }]),
    ).toEqual([
      {
        scheduledOn: '2026-08-12',
        kind: 'Endurance',
        title: 'Footing',
        warmup: null,
        recovery: null,
        cooldown: null,
        targetPaceSecPerKm: null,
        volumeM: null,
        durationS: null,
        steps: null,
      },
    ]);
  });
});

describe('depositPlanRevision', () => {
  beforeEach(() => {
    dbState.rows = { plans: [{ updatedAt: PLAN_UPDATED_AT }] };
  });

  it('écrit la proposition et son témoin de péremption en une transaction', async () => {
    expect(await depositPlanRevision(deposit(), ATHLETE_ID)).toBe('deposited');

    expect(dbState.transactions).toBe(1);
    const insert = dbState.inserts.find((entry) => entry.table === 'plan_revisions');
    expect(insert?.values).toMatchObject({
      athleteId: ATHLETE_ID,
      planId: 3,
      source: 'review',
      direction: 'decrease',
      weeks: 3,
      beforeVolumeKm: 42,
      beforeIntensityKm: 9,
      afterVolumeKm: 36,
      afterIntensityKm: 7,
      // L'état du plan **au moment du calcul** : c'est lui que l'acceptation
      // relira pour savoir si la proposition tient toujours.
      planUpdatedAt: PLAN_UPDATED_AT,
    });
  });

  it('avance le marqueur d’une revue sans toucher à `updated_at`', async () => {
    await depositPlanRevision(deposit(), ATHLETE_ID);

    const marker = dbState.updates.find((entry) => entry.table === 'plans');
    expect(marker?.values).toMatchObject({ reviewedSessionCount: 4 });
    // `updated_at` date le **contenu** du plan, et sert de témoin de péremption :
    // le faire bouger périmerait la proposition à l'instant où on l'écrit.
    expect(marker?.values).not.toHaveProperty('updatedAt');
    expect(renderWhere(marker?.where).params).toEqual([3, ATHLETE_ID, 'active']);
  });

  it('avance le marqueur d’un test : la date du test et sa note, jamais le chrono', async () => {
    await depositPlanRevision(
      {
        source: 'fitness-test',
        planId: 3,
        reason: 'Test du 11 août : 25:40 sur 5 km.',
        direction: 'decrease',
        weeks: 3,
        before: { volumeKm: 42, intensityKm: 9 },
        after: { volumeKm: 36, intensityKm: 7 },
        payload: payload({
          settings: { referenceDistance: '5k', referenceTimeS: 1_540 },
        }),
        referenceUpdatedOn: '2026-08-11',
        lastTestNote: 'Test du 11 août : 25:40 sur 5 km.',
      },
      ATHLETE_ID,
    );

    const marker = dbState.updates.find((entry) => entry.table === 'plans');
    expect(marker?.values).toEqual({
      referenceUpdatedOn: '2026-08-11',
      lastTestNote: 'Test du 11 août : 25:40 sur 5 km.',
    });
    // Le chrono attend l'acceptation : il vit dans le payload, pas sur le plan.
    expect(marker?.values).not.toHaveProperty('referenceTimeS');
  });

  it('efface la proposition précédente avant d’écrire la nouvelle', async () => {
    await depositPlanRevision(deposit(), ATHLETE_ID);

    const purge = dbState.deletes.find((entry) => entry.table === 'plan_revisions');
    expect(renderWhere(purge?.where).params).toEqual([ATHLETE_ID]);
  });

  it('n’écrit rien quand le plan n’est plus le plan actif de l’athlète', async () => {
    dbState.rows = { plans: [] };

    expect(await depositPlanRevision(deposit(), ATHLETE_ID)).toBe('no-active-plan');
    expect(dbState.inserts).toHaveLength(0);
    expect(dbState.updates).toHaveLength(0);
  });

  it('traduit la collision d’unicité en abandon, pas en panne', async () => {
    dbState.insertErrors = {
      plan_revisions: uniqueViolation('plan_revisions_pending_per_athlete'),
    };

    expect(await depositPlanRevision(deposit(), ATHLETE_ID)).toBe('conflict');
  });

  it('refuse un payload hors schéma avant d’effacer quoi que ce soit', async () => {
    await expect(
      depositPlanRevision(deposit({ payload: payload({ fromDate: 'demain' }) }), ATHLETE_ID),
    ).rejects.toThrow();

    expect(dbState.transactions).toBe(0);
    expect(dbState.deletes).toHaveLength(0);
  });
});

describe('getPendingPlanRevision', () => {
  it('ne rend rien quand il n’y a pas de proposition', async () => {
    expect(await getPendingPlanRevision(ATHLETE_ID)).toBeNull();
  });

  it('rend un DTO minimal, sans le payload', async () => {
    dbState.rows = { plan_revisions: [revisionRow()] };

    const revision = await getPendingPlanRevision(ATHLETE_ID);

    expect(revision).toEqual({
      id: 11,
      planId: 3,
      source: 'review',
      direction: 'decrease',
      reason: 'Deux séances manquées : la charge redescend.',
      weeks: 3,
      before: { volumeKm: 42, intensityKm: 9 },
      after: { volumeKm: 36, intensityKm: 7 },
      createdAt: '2026-08-11T09:05:00.000Z',
    });
    expect(revision).not.toHaveProperty('payload');
  });

  it('exige que le plan visé soit toujours le plan actif', async () => {
    dbState.rows = { plan_revisions: [revisionRow()] };

    await getPendingPlanRevision(ATHLETE_ID);

    // Adopter une proposition de plan archive le plan en cours : la
    // réévaluation qui le visait ne décrit alors plus rien.
    // Le rapprochement des deux colonnes `athlete_id` n'a pas de paramètre : le
    // seul lié est l'état exigé du plan.
    expect(renderWhere(dbState.joins[0]?.on).params).toEqual(['active']);
    expect(renderWhere(dbState.joins[0]?.on).sql).toContain('"athlete_id"');
    expect(renderWhere(dbState.selects[0]?.where).params).toEqual([ATHLETE_ID]);
  });
});

describe('getPendingPlanRevisionDetail', () => {
  it('rend les séances proposées avec des identifiants négatifs', async () => {
    dbState.rows = { plan_revisions: [revisionRow()] };

    const detail = await getPendingPlanRevisionDetail(ATHLETE_ID);

    expect(detail?.fromDate).toBe('2026-08-12');
    expect(detail?.sessions.map((session) => session.id)).toEqual([-1, -2]);
    // Ces séances n'existent pas en base : rien ne les a réalisées.
    expect(detail?.sessions.every((session) => session.completedActivityId === null)).toBe(true);
    expect(detail?.sessions[1]).toMatchObject({
      scheduledOn: '2026-08-14',
      kind: 'VMA courte · piste',
      volumeM: 8_000,
      steps: STEPS,
    });
  });

  it('n’affiche rien quand le payload stocké ne se relit plus', async () => {
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbState.rows = {
      plan_revisions: [revisionRow({ payload: { fromDate: 'hier' } as PlanRevisionPayload })],
    };

    expect(await getPendingPlanRevisionDetail(ATHLETE_ID)).toBeNull();
    expect(errored).toHaveBeenCalled();
    errored.mockRestore();
  });
});

describe('acceptPlanRevision', () => {
  beforeEach(() => {
    dbState.rows = { plan_revisions: [revisionRow()], plans: [{ updatedAt: PLAN_UPDATED_AT }] };
    dbState.returning = { plan_revisions: [{ id: 11 }] };
  });

  it('applique **le payload stocké**, jamais un recalcul', async () => {
    expect(await acceptPlanRevision(11)).toEqual({ planId: 3 });

    expect(plansDal.applyPlanUpdate).toHaveBeenCalledWith(3, payload(), ATHLETE_ID);
  });

  it('jette la proposition une fois appliquée', async () => {
    await acceptPlanRevision(11);

    const purge = dbState.deletes.find((entry) => entry.table === 'plan_revisions');
    expect(renderWhere(purge?.where).params).toEqual([11, ATHLETE_ID]);
  });

  it('refuse une proposition périmée plutôt que d’écraser le plan', async () => {
    // Un ajustement manuel entre le calcul et le clic : le plan n'est plus celui
    // sur lequel la proposition a été calculée.
    dbState.rows.plans = [{ updatedAt: new Date('2026-08-11T18:00:00.000Z') }];

    await expect(acceptPlanRevision(11)).rejects.toThrow(StalePlanRevisionError);
    expect(plansDal.applyPlanUpdate).not.toHaveBeenCalled();
    // Et elle est jetée : la rejouer donnerait le même refus.
    expect(dbState.deletes.some((entry) => entry.table === 'plan_revisions')).toBe(true);
  });

  it('refuse aussi quand le plan visé n’est plus actif', async () => {
    dbState.rows.plans = [];

    await expect(acceptPlanRevision(11)).rejects.toThrow(StalePlanRevisionError);
    expect(plansDal.applyPlanUpdate).not.toHaveBeenCalled();
  });

  it('refuse un identifiant qui n’est pas celui de la proposition en attente', async () => {
    await expect(acceptPlanRevision(12)).rejects.toThrow(PlanRevisionNotFoundError);
    expect(plansDal.applyPlanUpdate).not.toHaveBeenCalled();
  });

  it('refuse sans athlète, avant même de lire quoi que ce soit', async () => {
    athlete.getCurrentAthleteId.mockResolvedValue(null);

    await expect(acceptPlanRevision(11)).rejects.toThrow(PlanRevisionNotFoundError);
    expect(dbState.selects).toHaveLength(0);
  });
});

describe('rejectPlanRevision', () => {
  it('supprime la proposition sous l’athlète de la session', async () => {
    dbState.returning = { plan_revisions: [{ id: 11 }] };

    await rejectPlanRevision(11);

    expect(renderWhere(dbState.deletes[0]?.where).params).toEqual([11, ATHLETE_ID]);
  });

  it('signale une proposition déjà partie — à l’appelant de décider', async () => {
    dbState.returning = { plan_revisions: [] };

    await expect(rejectPlanRevision(11)).rejects.toThrow(PlanRevisionNotFoundError);
  });

  it('ne recule aucun marqueur : c’est ce qui rend le refus définitif', async () => {
    dbState.returning = { plan_revisions: [{ id: 11 }] };

    await rejectPlanRevision(11);

    expect(dbState.updates).toHaveLength(0);
  });
});
