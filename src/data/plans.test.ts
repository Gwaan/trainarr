import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AthleteNotFoundError } from './athlete';
import type { Plan, PlannedSession } from './db/schema';
import {
  InvalidPlanError,
  PlanNotFoundError,
  applyPlanUpdate,
  archiveActivePlan,
  createPlanWithSessions,
  getActivePlanWithSessions,
  getPlannedSessionForActivity,
  planEndExclusive,
  toPlanDto,
  toPlanSessionDto,
  validatePlanInput,
  type CreatePlanInput,
  type NewPlanSessionInput,
  type PlanUpdate,
} from './plans';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : les lectures servent les lignes déclarées par table,
 * les écritures sont enregistrées avec leur clause `WHERE` — c'est elle qui
 * porte l'anti-IDOR et la préservation des séances réalisées, donc c'est elle
 * que les tests inspectent (rendue en SQL, cf. `renderWhere`).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    returning: {} as Record<string, unknown[]>,
    inserts: [] as Array<{ table: string; values: unknown }>,
    updates: [] as Array<{ table: string; values: unknown; where: SQL }>,
    deletes: [] as Array<{ table: string; where: SQL }>,
    selects: [] as Array<{ table: string; where: SQL }>,
    /** Nombre de transactions ouvertes — une écriture composite doit en ouvrir une. */
    transactions: 0,
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

  type WriteChain = PromiseLike<unknown> & { returning: () => Promise<unknown[]> };

  const writeChain = (name: string): WriteChain => ({
    returning: () => Promise.resolve(dbState.returning[name] ?? []),
    then: (onFulfilled, onRejected) => Promise.resolve(undefined).then(onFulfilled, onRejected),
  });

  const client = {
    select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
    insert: (table: Table) => ({
      values: (values: unknown) => {
        const name = getTableName(table);
        dbState.inserts.push({ table: name, values });
        return writeChain(name);
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
        dbState.deletes.push({ table: getTableName(table), where: clause });
        return Promise.resolve();
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

/** Clause `WHERE` rendue en SQL + paramètres liés, pour l'affirmer telle qu'elle partira. */
function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée pour cette requête.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

/**
 * Aujourd'hui : lundi 10 août 2026, 11 h à Paris — premier jour du plan des
 * fixtures. C'est la date que l'archivage compare aux séances qu'il purge.
 */
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-08-10T09:00:00.000Z'));

afterAll(() => {
  vi.useRealTimers();
});

const PLAN_ROW: Plan = {
  id: 3,
  athleteId: 1,
  status: 'active',
  goalType: 'race',
  goalText: '10 km sous 50 min le 15 novembre',
  raceDate: '2026-11-15',
  startsOn: '2026-08-10',
  weeks: 8,
  sessionsPerWeek: 4,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  summary: 'Bloc de 8 semaines, une séance de seuil par semaine.',
  createdAt: new Date('2026-08-09T10:00:00.000Z'),
  updatedAt: new Date('2026-08-09T10:00:00.000Z'),
};

const SESSION_ROW: PlannedSession = {
  id: 7,
  athleteId: 1,
  planId: 3,
  scheduledOn: '2026-08-12',
  kind: 'VMA courte · piste',
  title: '6 × 800 m',
  targetPaceSecPerKm: 225,
  warmup: '20 min @ 5:30/km',
  recovery: '90 s en trot',
  cooldown: '10 min souple',
  volumeM: 12_400,
  durationS: 3_900,
  completedActivityId: null,
  createdAt: new Date('2026-08-09T10:00:00.000Z'),
};

const PLAN_DTO_KEYS = [
  'createdAt',
  'goalText',
  'goalType',
  'id',
  'longRunDay',
  'raceDate',
  'sessionsPerWeek',
  'startsOn',
  'status',
  'summary',
  'weeklyTimeMinutes',
  'weeks',
];

const SESSION_DTO_KEYS = [
  'completedActivityId',
  'cooldown',
  'durationS',
  'id',
  'kind',
  'recovery',
  'scheduledOn',
  'targetPaceSecPerKm',
  'title',
  'volumeM',
  'warmup',
];

const SESSION_INPUT: NewPlanSessionInput = {
  scheduledOn: '2026-08-12',
  kind: 'VMA courte · piste',
  title: '6 × 800 m',
};

/** Plan valide — chaque test n'en modifie que ce qu'il éprouve. */
const VALID_INPUT: CreatePlanInput = {
  goalType: 'race',
  goalText: '10 km sous 50 min le 15 novembre',
  raceDate: '2026-11-15',
  startsOn: '2026-08-10',
  weeks: 8,
  sessionsPerWeek: 4,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  summary: 'Bloc de 8 semaines.',
  sessions: [SESSION_INPUT],
};

beforeEach(() => {
  dbState.rows = { athlete: [{ id: 1 }] };
  dbState.returning = {};
  dbState.inserts = [];
  dbState.updates = [];
  dbState.deletes = [];
  dbState.selects = [];
  dbState.transactions = 0;
});

describe('planEndExclusive', () => {
  it('ouvre la fenêtre sur `weeks × 7` jours pleins', () => {
    expect(planEndExclusive('2026-08-10', 8)).toBe('2026-10-05');
    expect(planEndExclusive('2026-08-10', 1)).toBe('2026-08-17');
  });
});

describe('validatePlanInput', () => {
  it('normalise les facultatifs et détoure le texte de l’objectif', () => {
    const values = validatePlanInput({
      ...VALID_INPUT,
      goalType: 'free',
      goalText: '  améliorer mon endurance  ',
      raceDate: undefined,
      weeklyTimeMinutes: undefined,
      summary: undefined,
    });

    expect(values.goalText).toBe('améliorer mon endurance');
    expect(values.raceDate).toBeNull();
    expect(values.weeklyTimeMinutes).toBeNull();
    expect(values.summary).toBeNull();
  });

  it('exige une date de course pour un objectif daté', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, raceDate: null })).toThrow(InvalidPlanError);
    try {
      validatePlanInput({ ...VALID_INPUT, raceDate: null });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPlanError);
      expect((error as InvalidPlanError).field).toBe('raceDate');
    }
  });

  it('refuse une date de course sur un objectif libre', () => {
    expect(() =>
      validatePlanInput({ ...VALID_INPUT, goalType: 'free', raceDate: '2026-11-15' }),
    ).toThrow(InvalidPlanError);
  });

  it('refuse une date de course inexistante au calendrier', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, raceDate: '2026-02-31' })).toThrow(
      InvalidPlanError,
    );
    expect(() => validatePlanInput({ ...VALID_INPUT, raceDate: '15/11/2026' })).toThrow(
      InvalidPlanError,
    );
  });

  it('refuse une date de début malformée', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, startsOn: '2026-8-10' })).toThrow(
      InvalidPlanError,
    );
  });

  it('exige un objectif non vide', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, goalText: '   ' })).toThrow(InvalidPlanError);
  });

  it('exige au moins une semaine, en nombre entier', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, weeks: 0 })).toThrow(InvalidPlanError);
    expect(() => validatePlanInput({ ...VALID_INPUT, weeks: -3 })).toThrow(InvalidPlanError);
    expect(() => validatePlanInput({ ...VALID_INPUT, weeks: 8.5 })).toThrow(InvalidPlanError);
  });

  it('borne les séances par semaine à 1..7', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, sessionsPerWeek: 0 })).toThrow(
      InvalidPlanError,
    );
    expect(() => validatePlanInput({ ...VALID_INPUT, sessionsPerWeek: 8 })).toThrow(
      InvalidPlanError,
    );
    expect(validatePlanInput({ ...VALID_INPUT, sessionsPerWeek: 7 }).sessionsPerWeek).toBe(7);
  });

  it('borne le jour de sortie longue aux jours ISO 1..7', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, longRunDay: 0 })).toThrow(InvalidPlanError);
    expect(() => validatePlanInput({ ...VALID_INPUT, longRunDay: 8 })).toThrow(InvalidPlanError);
    expect(validatePlanInput({ ...VALID_INPUT, longRunDay: 1 }).longRunDay).toBe(1);
  });

  it('refuse un temps hebdomadaire nul ou supérieur à une semaine réelle', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, weeklyTimeMinutes: 0 })).toThrow(
      InvalidPlanError,
    );
    expect(() => validatePlanInput({ ...VALID_INPUT, weeklyTimeMinutes: 10_081 })).toThrow(
      InvalidPlanError,
    );
  });

  it('refuse un plan sans aucune séance', () => {
    try {
      validatePlanInput({ ...VALID_INPUT, sessions: [] });
      expect.unreachable('un plan vide ne planifie rien');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPlanError);
      expect((error as InvalidPlanError).field).toBe('sessions');
    }
  });

  it('refuse une séance hors de la fenêtre du plan', () => {
    // Fenêtre : [2026-08-10, 2026-10-05[ pour 8 semaines.
    expect(() =>
      validatePlanInput({
        ...VALID_INPUT,
        sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-08-09' }],
      }),
    ).toThrow(InvalidPlanError);
    expect(() =>
      validatePlanInput({
        ...VALID_INPUT,
        sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-10-05' }],
      }),
    ).toThrow(InvalidPlanError);
  });

  it('accepte les deux bornes réellement couvertes', () => {
    const values = validatePlanInput({
      ...VALID_INPUT,
      sessions: [
        { ...SESSION_INPUT, scheduledOn: '2026-08-10' },
        { ...SESSION_INPUT, scheduledOn: '2026-10-04' },
      ],
    });

    expect(values.sessions).toHaveLength(2);
  });

  it('refuse une séance sans type ni intitulé', () => {
    expect(() =>
      validatePlanInput({ ...VALID_INPUT, sessions: [{ ...SESSION_INPUT, title: '  ' }] }),
    ).toThrow(InvalidPlanError);
    expect(() =>
      validatePlanInput({ ...VALID_INPUT, sessions: [{ ...SESSION_INPUT, kind: '' }] }),
    ).toThrow(InvalidPlanError);
  });
});

describe('toPlanDto', () => {
  it("n'expose que les champs du DTO, sans identifiant d'athlète", () => {
    const dto = toPlanDto(PLAN_ROW);

    expect(Object.keys(dto).sort()).toEqual(PLAN_DTO_KEYS);
    expect(dto).not.toHaveProperty('athleteId');
    expect(dto).not.toHaveProperty('updatedAt');
  });

  it('sérialise la date de création en ISO et recopie le reste tel quel', () => {
    const dto = toPlanDto(PLAN_ROW);

    expect(dto.createdAt).toBe('2026-08-09T10:00:00.000Z');
    expect(dto).toMatchObject({
      id: 3,
      status: 'active',
      goalType: 'race',
      raceDate: '2026-11-15',
      startsOn: '2026-08-10',
      weeks: 8,
      sessionsPerWeek: 4,
      weeklyTimeMinutes: 300,
      longRunDay: 7,
    });
  });

  it('préserve les champs absents en `null`', () => {
    const dto = toPlanDto({
      ...PLAN_ROW,
      goalType: 'free',
      raceDate: null,
      weeklyTimeMinutes: null,
      summary: null,
    });

    expect(dto.raceDate).toBeNull();
    expect(dto.weeklyTimeMinutes).toBeNull();
    expect(dto.summary).toBeNull();
  });
});

describe('toPlanSessionDto', () => {
  it("n'expose que les champs du DTO, ni `athleteId` ni `planId`", () => {
    const dto = toPlanSessionDto(SESSION_ROW);

    expect(Object.keys(dto).sort()).toEqual(SESSION_DTO_KEYS);
    expect(dto).not.toHaveProperty('athleteId');
    expect(dto).not.toHaveProperty('planId');
  });
});

describe('getActivePlanWithSessions', () => {
  it('retourne null tant que l’onboarding n’a pas eu lieu', async () => {
    dbState.rows = { athlete: [] };

    await expect(getActivePlanWithSessions()).resolves.toBeNull();
  });

  it('retourne null quand aucun plan actif n’existe', async () => {
    dbState.rows.plans = [];

    await expect(getActivePlanWithSessions()).resolves.toBeNull();
  });

  it('retourne le plan et ses séances en DTOs', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.rows.planned_sessions = [SESSION_ROW];

    const result = await getActivePlanWithSessions();

    expect(Object.keys(result?.plan ?? {}).sort()).toEqual(PLAN_DTO_KEYS);
    expect(result?.sessions).toHaveLength(1);
    expect(Object.keys(result?.sessions[0] ?? {}).sort()).toEqual(SESSION_DTO_KEYS);
  });

  it('ne lit que le plan actif de l’athlète', async () => {
    dbState.rows.plans = [PLAN_ROW];

    await getActivePlanWithSessions();

    const where = renderWhere(dbState.selects.find((query) => query.table === 'plans')?.where);
    expect(where.params).toEqual([1, 'active']);
  });
});

describe('createPlanWithSessions', () => {
  it('refuse d’écrire tant qu’aucun athlète n’est enregistré', async () => {
    dbState.rows = { athlete: [] };

    await expect(createPlanWithSessions(VALID_INPUT)).rejects.toBeInstanceOf(AthleteNotFoundError);
    expect(dbState.inserts).toEqual([]);
  });

  it('valide avant toute écriture', async () => {
    await expect(
      createPlanWithSessions({ ...VALID_INPUT, sessionsPerWeek: 9 }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    expect(dbState.transactions).toBe(0);
    expect(dbState.inserts).toEqual([]);
  });

  it('archive le plan actif puis insère le nouveau, dans une transaction', async () => {
    dbState.returning.plans = [PLAN_ROW];

    const dto = await createPlanWithSessions(VALID_INPUT);

    expect(dbState.transactions).toBe(1);

    const archive = dbState.updates[0];
    expect(archive?.table).toBe('plans');
    expect(archive?.values).toMatchObject({ status: 'archived' });
    expect(renderWhere(archive?.where).params).toEqual([1, 'active']);

    expect(dbState.inserts[0]?.table).toBe('plans');
    expect(dbState.inserts[0]?.values).toMatchObject({
      athleteId: 1,
      status: 'active',
      goalType: 'race',
      raceDate: '2026-11-15',
      weeks: 8,
    });

    expect(Object.keys(dto).sort()).toEqual(PLAN_DTO_KEYS);
  });

  it('rattache chaque séance au plan créé et à l’athlète', async () => {
    dbState.returning.plans = [PLAN_ROW];

    await createPlanWithSessions({
      ...VALID_INPUT,
      sessions: [SESSION_INPUT, { ...SESSION_INPUT, scheduledOn: '2026-08-15', warmup: '15 min' }],
    });

    const insert = dbState.inserts.find((row) => row.table === 'planned_sessions');
    expect(insert?.values).toEqual([
      {
        athleteId: 1,
        planId: 3,
        scheduledOn: '2026-08-12',
        kind: 'VMA courte · piste',
        title: '6 × 800 m',
        warmup: null,
        recovery: null,
        cooldown: null,
        targetPaceSecPerKm: null,
        volumeM: null,
        durationS: null,
      },
      {
        athleteId: 1,
        planId: 3,
        scheduledOn: '2026-08-15',
        kind: 'VMA courte · piste',
        title: '6 × 800 m',
        warmup: '15 min',
        recovery: null,
        cooldown: null,
        targetPaceSecPerKm: null,
        volumeM: null,
        durationS: null,
      },
    ]);
  });

  it('emporte les séances à venir non réalisées du plan qu’il archive', async () => {
    dbState.returning.plans = [PLAN_ROW];

    await createPlanWithSessions(VALID_INPUT);

    expect(dbState.deletes).toHaveLength(1);
    const where = renderWhere(dbState.deletes[0]?.where);
    // À partir d'aujourd'hui seulement : les séances passées restent l'histoire
    // de l'athlète, et une séance déjà rapprochée d'une activité survit.
    expect(where.params).toEqual([3, '2026-08-10']);
    expect(where.sql).toContain('"plan_id" in ($1)');
    expect(where.sql).toContain('"scheduled_on" >= $2');
    expect(where.sql).toContain('"completed_activity_id" is null');
  });

  it('échoue si l’insertion du plan ne rend aucune ligne, sans écrire de séance', async () => {
    dbState.returning.plans = [];

    await expect(createPlanWithSessions(VALID_INPUT)).rejects.toThrow();
    expect(dbState.inserts.some((row) => row.table === 'planned_sessions')).toBe(false);
    // Aucun plan archivé : rien à purger non plus.
    expect(dbState.deletes).toEqual([]);
  });
});

describe('archiveActivePlan', () => {
  it('archive le plan actif et le signale', async () => {
    dbState.returning.plans = [{ id: 3 }];

    await expect(archiveActivePlan()).resolves.toBe(true);
    expect(dbState.updates[0]?.values).toMatchObject({ status: 'archived' });
    expect(renderWhere(dbState.updates[0]?.where).params).toEqual([1, 'active']);
  });

  it('emporte les séances à venir non réalisées du plan archivé, en transaction', async () => {
    dbState.returning.plans = [{ id: 3 }];

    await archiveActivePlan();

    expect(dbState.transactions).toBe(1);
    expect(dbState.deletes).toHaveLength(1);
    const where = renderWhere(dbState.deletes[0]?.where);
    // Le passé du plan reste en base : seules les séances d'aujourd'hui et après,
    // encore non rapprochées d'une activité, disparaissent avec lui.
    expect(where.params).toEqual([3, '2026-08-10']);
    expect(where.sql).toContain('"plan_id" in ($1)');
    expect(where.sql).toContain('"scheduled_on" >= $2');
    expect(where.sql).toContain('"completed_activity_id" is null');
  });

  it('retourne false quand il n’y avait aucun plan actif, sans rien purger', async () => {
    dbState.returning.plans = [];

    await expect(archiveActivePlan()).resolves.toBe(false);
    expect(dbState.deletes).toEqual([]);
  });

  it('retourne false sans athlète, sans rien écrire', async () => {
    dbState.rows = { athlete: [] };

    await expect(archiveActivePlan()).resolves.toBe(false);
    expect(dbState.updates).toEqual([]);
  });
});

describe('applyPlanUpdate', () => {
  /** Ce qu'une instruction du coach produit : la suite du plan et ses réglages. */
  const UPDATE: PlanUpdate = {
    fromDate: '2026-08-15',
    sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-08-20' }],
    settings: { sessionsPerWeek: 3 },
  };

  it('réécrit les séances et les réglages dans une seule transaction', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, UPDATE);

    expect(dbState.transactions).toBe(1);
    expect(dbState.deletes).toHaveLength(1);
    expect(dbState.inserts[0]?.table).toBe('planned_sessions');
    expect(dbState.inserts[0]?.values).toEqual([
      expect.objectContaining({ athleteId: 1, planId: 3, scheduledOn: '2026-08-20' }),
    ]);

    // Une seule écriture sur le plan : elle porte les réglages *et* `updatedAt`.
    expect(dbState.updates).toHaveLength(1);
    const update = dbState.updates[0];
    expect(update?.table).toBe('plans');
    expect(update?.values).toEqual({ sessionsPerWeek: 3, updatedAt: expect.any(Date) });
    expect(renderWhere(update?.where).params).toEqual([3, 1, 'active']);
  });

  it('ne supprime que les séances futures encore non réalisées', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, UPDATE);

    const where = renderWhere(dbState.deletes[0]?.where);
    expect(where.params).toEqual([3, '2026-08-15']);
    expect(where.sql).toContain('"scheduled_on" >= $2');
    expect(where.sql).toContain('"completed_activity_id" is null');
  });

  it('borne la lecture du plan à son id, son athlète et son état actif', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, UPDATE);

    const where = renderWhere(dbState.selects.find((query) => query.table === 'plans')?.where);
    expect(where.params).toEqual([3, 1, 'active']);
  });

  it('efface le temps hebdomadaire quand le patch le met à `null`', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, { ...UPDATE, settings: { weeklyTimeMinutes: null, summary: null } });

    expect(dbState.updates[0]?.values).toMatchObject({ weeklyTimeMinutes: null, summary: null });
  });

  it('accepte une liste vide : elle vide la suite du plan sans rien insérer', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, { ...UPDATE, sessions: [] });

    expect(dbState.deletes).toHaveLength(1);
    expect(dbState.inserts).toEqual([]);
  });

  it('refuse un plan qui n’est pas celui, actif, de l’athlète', async () => {
    dbState.rows.plans = [];

    await expect(applyPlanUpdate(3, UPDATE)).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(dbState.deletes).toEqual([]);
    expect(dbState.inserts).toEqual([]);
    expect(dbState.updates).toEqual([]);
  });

  it('lève PlanNotFoundError si l’écriture des réglages ne touche aucune ligne', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [];

    await expect(applyPlanUpdate(3, UPDATE)).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it('valide les bornes des réglages avant d’ouvrir la transaction', async () => {
    dbState.rows.plans = [PLAN_ROW];

    await expect(
      applyPlanUpdate(3, { ...UPDATE, settings: { sessionsPerWeek: 0 } }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    // Aucune séance supprimée : un patch aberrant ne doit rien entamer.
    expect(dbState.transactions).toBe(0);
    expect(dbState.deletes).toEqual([]);
  });

  it('refuse une date de reprise malformée avant toute lecture', async () => {
    await expect(
      applyPlanUpdate(3, { ...UPDATE, fromDate: '15/08/2026' }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    expect(dbState.transactions).toBe(0);
  });

  it('refuse une séance antérieure à la date de reprise ou hors fenêtre', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await expect(
      applyPlanUpdate(3, {
        ...UPDATE,
        sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-08-14' }],
      }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    await expect(
      applyPlanUpdate(3, {
        ...UPDATE,
        sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-10-05' }],
      }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    expect(dbState.deletes).toEqual([]);
  });
});

describe('getPlannedSessionForActivity', () => {
  it('retourne la séance rapprochée, en DTO', async () => {
    dbState.rows.planned_sessions = [{ ...SESSION_ROW, completedActivityId: 42 }];

    const dto = await getPlannedSessionForActivity(42);

    expect(Object.keys(dto ?? {}).sort()).toEqual(SESSION_DTO_KEYS);
    expect(dto?.completedActivityId).toBe(42);
  });

  it('borne la recherche à l’athlète courant (anti-IDOR)', async () => {
    dbState.rows.planned_sessions = [SESSION_ROW];

    await getPlannedSessionForActivity(42);

    const where = renderWhere(
      dbState.selects.find((query) => query.table === 'planned_sessions')?.where,
    );
    expect(where.params).toEqual([42, 1]);
  });

  it('retourne null quand l’activité n’a réalisé aucune séance', async () => {
    dbState.rows.planned_sessions = [];

    await expect(getPlannedSessionForActivity(42)).resolves.toBeNull();
  });

  it('retourne null tant que l’onboarding n’a pas eu lieu', async () => {
    dbState.rows = { athlete: [] };

    await expect(getPlannedSessionForActivity(42)).resolves.toBeNull();
  });
});
