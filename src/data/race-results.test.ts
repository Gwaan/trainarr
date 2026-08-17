import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InvalidRaceResultError,
  RACE_RESULT_LIMITS,
  RaceActivityNotFoundError,
  RaceResultNotSavedError,
  deleteRaceResult,
  getRaceResultForActivity,
  listRaceResults,
  saveRaceResult,
  validateRaceResult,
  type RaceResultInput,
} from './race-results';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { athlete } = vi.hoisted(() => ({ athlete: { getCurrentAthleteId: vi.fn() } }));

vi.mock('./athlete', async () => {
  const actual = await vi.importActual<typeof import('./athlete')>('./athlete');
  return { ...actual, getCurrentAthleteId: athlete.getCurrentAthleteId };
});

/**
 * Aucune base : les lectures servent les lignes déclarées par table, les
 * écritures sont enregistrées avec leur clause `WHERE` — c'est elle qui porte
 * l'anti-IDOR, donc c'est elle que les tests inspectent (même doublure que
 * `plan-revisions.test.ts`).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    inserts: [] as Array<{ table: string; values: unknown; conflict: unknown }>,
    /**
     * Ce que le `returning()` de l'écriture rend. Par défaut une ligne : c'est
     * le cas nominal. Le vider reproduit le seul cas qui compte — un `DO UPDATE`
     * dont le `WHERE` exclut la ligne en conflit, qui s'exécute sans rien écrire
     * et **sans lever**.
     */
    written: [{ id: 1 }] as unknown[],
    deletes: [] as Array<{ table: string; where: SQL }>,
    selects: [] as Array<{ table: string; where: SQL }>,
    joins: [] as Array<{ table: string; on: SQL }>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type SelectChain = PromiseLike<unknown[]> & {
    leftJoin: (table: Table, on: SQL) => SelectChain;
    where: (clause: SQL) => SelectChain;
    orderBy: () => SelectChain;
    limit: () => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      leftJoin: (table, on) => {
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

  const resolved = (): PromiseLike<unknown> => ({
    then: (onFulfilled, onRejected) => Promise.resolve(undefined).then(onFulfilled, onRejected),
  });

  /** Une écriture dont on peut lire ce qu'elle a touché — ou n'a pas touché. */
  const writeChain = () => ({
    ...resolved(),
    returning: () => Promise.resolve(dbState.written),
  });

  return {
    db: {
      select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
      insert: (table: Table) => ({
        values: (values: unknown) => {
          const name = getTableName(table);
          const entry = { table: name, values, conflict: null as unknown };
          dbState.inserts.push(entry);
          return {
            ...resolved(),
            onConflictDoUpdate: (config: unknown) => {
              entry.conflict = config;
              return writeChain();
            },
          };
        },
      }),
      delete: (table: Table) => ({
        where: (clause: SQL) => {
          dbState.deletes.push({ table: getTableName(table), where: clause });
          return resolved();
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

function input(overrides: Partial<RaceResultInput> = {}): RaceResultInput {
  return {
    racedOn: '2026-04-12',
    name: '10 km de Bordeaux',
    distanceM: 10_000,
    timeS: 2_700,
    activityId: 42,
    ...overrides,
  };
}

beforeEach(() => {
  dbState.rows = {};
  dbState.inserts = [];
  dbState.deletes = [];
  dbState.selects = [];
  dbState.joins = [];
  dbState.written = [{ id: 1 }];
  athlete.getCurrentAthleteId.mockResolvedValue(ATHLETE_ID);
});

describe('validateRaceResult', () => {
  it('accepte une course ordinaire et arrondit distance et chrono', () => {
    expect(validateRaceResult(input({ distanceM: 10_000.4, timeS: 2_700.6 }))).toEqual({
      racedOn: '2026-04-12',
      name: '10 km de Bordeaux',
      distanceM: 10_000,
      timeS: 2_701,
      activityId: 42,
    });
  });

  it('ramène un nom vide à l’absence de nom', () => {
    // Deux façons de dire « rien » finiraient par s'afficher différemment.
    expect(validateRaceResult(input({ name: '   ' })).name).toBeNull();
  });

  it('accepte une course sans activité liée : on peut courir sans montre', () => {
    expect(validateRaceResult(input({ activityId: null })).activityId).toBeNull();
  });

  it.each([
    ['date qui n’en est pas une', { racedOn: '12/04/2026' }, 'racedOn'],
    ['distance sous le plancher', { distanceM: 200 }, 'distanceM'],
    ['distance au-delà du plafond', { distanceM: 600_000 }, 'distanceM'],
    ['chrono trop court', { timeS: 5 }, 'timeS'],
    ['chrono au-delà de 48 h', { timeS: 200_000 }, 'timeS'],
  ])('refuse une %s', (_label, overrides, field) => {
    try {
      validateRaceResult(input(overrides));
      expect.unreachable('la validation aurait dû refuser cette saisie');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRaceResultError);
      expect((error as InvalidRaceResultError).field).toBe(field);
    }
  });

  it('refuse un couple distance / chrono qui ne décrit pas une course', () => {
    // 10 km en 20 minutes de plus que le record du monde n'est pas le sujet :
    // ce qui est refusé, c'est ce qui n'est pas une course à pied — ici 10 km
    // en 10 minutes, soit 16,7 m/s.
    expect(() => validateRaceResult(input({ timeS: 600 }))).toThrowError(
      InvalidRaceResultError,
    );
    expect(RACE_RESULT_LIMITS.speedMPerS.max).toBe(12);
  });

  it('laisse passer un ultra lent : les bornes ne jugent pas la performance', () => {
    // 100 km en 20 h, soit 1,39 m/s. Le domaine de Daniels & Gilbert le
    // refusera pour la calibration — c'est un autre étage, et cette course a
    // toute sa place dans l'historique.
    expect(() =>
      validateRaceResult(input({ distanceM: 100_000, timeS: 72_000 })),
    ).not.toThrow();
  });

  it('refuse un nom interminable', () => {
    expect(() =>
      validateRaceResult(input({ name: 'x'.repeat(RACE_RESULT_LIMITS.nameMaxChars + 1) })),
    ).toThrowError(InvalidRaceResultError);
  });
});

describe('listRaceResults', () => {
  it('borne la lecture à l’athlète, jointure comprise', async () => {
    await listRaceResults(ATHLETE_ID);

    const select = dbState.selects.find((entry) => entry.table === 'race_results');
    expect(renderWhere(select?.where).params).toContain(ATHLETE_ID);

    // La jointure **vérifie** l'appartenance de l'activité au lieu de la
    // supposer : une ligne qui pointerait ailleurs rendrait `null` sur la FC.
    const join = dbState.joins.find((entry) => entry.table === 'activities');
    expect(renderWhere(join?.on).params).toContain(ATHLETE_ID);
  });
});

describe('getRaceResultForActivity', () => {
  it('confronte l’identifiant d’activité à l’athlète dans la même clause', async () => {
    await getRaceResultForActivity(42);

    const { params } = renderWhere(dbState.selects[0]?.where);
    expect(params).toContain(42);
    expect(params).toContain(ATHLETE_ID);
  });

  it('rend `null` sans athlète, sans interroger la base', async () => {
    athlete.getCurrentAthleteId.mockResolvedValue(null);

    expect(await getRaceResultForActivity(42)).toBeNull();
    expect(dbState.selects).toEqual([]);
  });
});

describe('saveRaceResult', () => {
  it('refuse une activité qui n’est pas celle de l’athlète, sans rien écrire', async () => {
    // La lecture d'appartenance ne rend aucune ligne : l'activité existe
    // peut-être, mais pas pour ce compte — et le message ne le dit pas.
    dbState.rows.activities = [];

    await expect(saveRaceResult(input())).rejects.toBeInstanceOf(RaceActivityNotFoundError);
    expect(dbState.inserts).toEqual([]);
  });

  it('vérifie l’appartenance de l’activité par une clause, pas par confiance', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveRaceResult(input());

    const { params } = renderWhere(dbState.selects[0]?.where);
    expect(params).toContain(42);
    expect(params).toContain(ATHLETE_ID);
  });

  it('écrit la course sous l’athlète de la session, valeurs officielles comprises', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveRaceResult(input({ distanceM: 10_012, timeS: 2_698 }));

    expect(dbState.inserts[0]?.values).toEqual({
      athleteId: ATHLETE_ID,
      racedOn: '2026-04-12',
      name: '10 km de Bordeaux',
      // Les valeurs saisies, jamais celles de l'activité : le chrono officiel
      // est celui de la puce.
      distanceM: 10_012,
      timeS: 2_698,
      activityId: 42,
    });
  });

  it('corrige la course déjà déclarée sur la même séance au lieu d’en empiler une', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveRaceResult(input());

    const conflict = dbState.inserts[0]?.conflict as { where: SQL } | null;
    expect(conflict).not.toBeNull();
    // L'anti-IDOR ne repose pas sur un raisonnement à deux étapes : la clause
    // du `DO UPDATE` reborne l'écriture elle aussi.
    expect(renderWhere(conflict!.where).params).toContain(ATHLETE_ID);
  });

  it('n’interroge pas les activités pour une course sans montre', async () => {
    await saveRaceResult(input({ activityId: null }));

    expect(dbState.selects).toEqual([]);
    expect(dbState.inserts[0]?.values).toMatchObject({ activityId: null });
  });

  it('valide avant de résoudre l’athlète : une saisie absurde n’atteint jamais la base', async () => {
    await expect(saveRaceResult(input({ timeS: 1 }))).rejects.toBeInstanceOf(
      InvalidRaceResultError,
    );
    expect(dbState.inserts).toEqual([]);
    expect(dbState.selects).toEqual([]);
  });

  it('refuse d’écrire sans athlète', async () => {
    athlete.getCurrentAthleteId.mockResolvedValue(null);

    await expect(saveRaceResult(input())).rejects.toBeInstanceOf(RaceActivityNotFoundError);
    expect(dbState.inserts).toEqual([]);
  });

  it('échoue quand l’écriture n’a touché aucune ligne', async () => {
    // Le `WHERE` du `DO UPDATE` reborne à l'athlète : s'il exclut la ligne en
    // conflit, Postgres n'écrit rien **et ne lève pas**. Sans ce garde-fou,
    // l'action renvoyait « Course enregistrée » sur une déclaration qui n'existe
    // pas — le pire des deux mondes, l'athlète repartant convaincue que sa
    // course calibre sa VO₂max.
    dbState.rows.activities = [{ id: 42 }];
    dbState.written = [];

    await expect(saveRaceResult(input())).rejects.toBeInstanceOf(RaceResultNotSavedError);
  });
});

describe('deleteRaceResult', () => {
  it('supprime sous l’athlète, et ne dit pas si la ligne existait', async () => {
    await deleteRaceResult(9);

    const { params } = renderWhere(dbState.deletes[0]?.where);
    expect(params).toContain(9);
    expect(params).toContain(ATHLETE_ID);
  });

  it('ne supprime rien sans athlète', async () => {
    athlete.getCurrentAthleteId.mockResolvedValue(null);

    await deleteRaceResult(9);
    expect(dbState.deletes).toEqual([]);
  });
});
