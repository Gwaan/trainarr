import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ageYearsOn,
  buildRecentWeeks,
  getComparableActivities,
  getTrainingSnapshot,
  longestRunKm,
  recentRunPace,
  toComparableActivityDto,
  toSnapshotProfile,
} from './coach-context';
import type { Activity, Athlete } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : les lectures servent les lignes déclarées par table.
 * Le filtrage réel vit dans la clause `WHERE` (fenêtre de distance, sport,
 * antériorité) — le faux client ne l'applique pas, les tests l'inspectent
 * telle qu'elle partira (cf. `renderWhere`), exactement comme `plans.test.ts`.
 *
 * `queue` sert les lectures successives d'une même table : `getComparableActivities`
 * lit `activities` deux fois (la séance de référence, puis ses comparables).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    queue: {} as Record<string, unknown[][]>,
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
      then: (onFulfilled, onRejected) => {
        const queued = dbState.queue[name];
        const rows = queued && queued.length > 0 ? queued.shift() : dbState.rows[name];
        return Promise.resolve(rows ?? []).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  return {
    db: { select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }) },
  };
});

const dialect = new PgDialect();

/** Clause `WHERE` rendue en SQL + paramètres liés, pour l'affirmer telle qu'elle partira. */
function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée pour cette requête.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

const ATHLETE_ROW: Athlete = {
  id: 1,
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 188,
  restingHrBpm: 48,
  weightKg: 62,
  birthDate: '1990-06-15',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** Une course type — chaque test n'en modifie que ce qu'il éprouve. */
function run(overrides: Partial<Activity> & { startedAt: Date }): Activity {
  return {
    id: 1,
    athleteId: 1,
    fitFileHash: null,
    name: 'Footing',
    sportType: 'Run',
    distanceM: 10_000,
    movingTimeS: 3_000,
    elapsedTimeS: 3_100,
    elevationGainM: 80,
    avgHrBpm: 145,
    maxHrBpm: 168,
    avgPaceSecPerKm: 300,
    avgCadenceSpm: 172,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Un mardi : la semaine ISO en cours commence le lundi 10 août 2026.
  vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));
  dbState.rows = {};
  dbState.queue = {};
  dbState.selects = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ageYearsOn', () => {
  it('compte les années révolues', () => {
    expect(ageYearsOn('1990-06-15', '2026-08-11')).toBe(36);
  });

  it("ne compte pas l'année en cours tant que l'anniversaire n'est pas passé", () => {
    expect(ageYearsOn('1990-12-24', '2026-08-11')).toBe(35);
  });

  it("compte l'année le jour même de l'anniversaire", () => {
    expect(ageYearsOn('1990-08-11', '2026-08-11')).toBe(36);
  });
});

describe('toSnapshotProfile', () => {
  it('omet les champs non renseignés plutôt que de les rendre à `null`', () => {
    const profile = toSnapshotProfile(
      { ...ATHLETE_ROW, sex: null, restingHrBpm: null, weightKg: null, birthDate: null },
      '2026-08-11',
    );

    expect(profile).toEqual({ maxHrBpm: 188 });
    expect(Object.keys(profile)).not.toContain('sex');
  });

  it('rend le profil complet, âge dérivé de la date de naissance', () => {
    expect(toSnapshotProfile(ATHLETE_ROW, '2026-08-11')).toEqual({
      ageYears: 36,
      sex: 'female',
      maxHrBpm: 188,
      restingHrBpm: 48,
      weightKg: 62,
    });
  });
});

describe('buildRecentWeeks', () => {
  it('rend 4 semaines de la plus ancienne à la semaine en cours', () => {
    const weeks = buildRecentWeeks([], '2026-08-11');

    expect(weeks.map((week) => week.startsOn)).toEqual([
      '2026-07-20',
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
    ]);
    expect(weeks.every((week) => week.sessions === 0)).toBe(true);
  });

  it('cumule distance, temps et nombre de séances dans la bonne semaine', () => {
    const weeks = buildRecentWeeks(
      [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 12_000, movingTimeS: 3_600 }),
        run({ startedAt: new Date('2026-08-11T06:00:00.000Z'), distanceM: 8_000, movingTimeS: 2_400 }),
        run({ startedAt: new Date('2026-07-21T06:00:00.000Z'), distanceM: 5_000, movingTimeS: 1_500 }),
      ],
      '2026-08-11',
    );

    expect(weeks[3]).toEqual({
      startsOn: '2026-08-10',
      distanceKm: 20,
      movingTimeS: 6_000,
      sessions: 2,
    });
    expect(weeks[0].distanceKm).toBe(5);
  });

  it('ignore les autres sports, le futur et ce qui précède la fenêtre', () => {
    const weeks = buildRecentWeeks(
      [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), sportType: 'Ride', distanceM: 60_000 }),
        run({ startedAt: new Date('2026-08-14T06:00:00.000Z'), distanceM: 15_000 }),
        run({ startedAt: new Date('2026-07-01T06:00:00.000Z'), distanceM: 15_000 }),
      ],
      '2026-08-11',
    );

    expect(weeks.every((week) => week.sessions === 0)).toBe(true);
  });
});

/*
 * La plus longue course des 30 derniers jours : l'entrée du plafond de sortie
 * longue d'une reprise (Frandsen 2025). Un plafond calculé sur une donnée fausse
 * serait pire que pas de plafond du tout — d'où les trois gardes ci-dessous.
 */
describe('longestRunKm', () => {
  it('rend la plus longue course de la fenêtre, en km', () => {
    expect(
      longestRunKm(
        [
          run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 12_000 }),
          run({ startedAt: new Date('2026-07-20T06:00:00.000Z'), distanceM: 18_400 }),
          run({ startedAt: new Date('2026-08-01T06:00:00.000Z'), distanceM: 9_000 }),
        ],
        '2026-08-11',
      ),
    ).toBe(18.4);
  });

  it('ignore les autres sports, le futur et ce qui précède la fenêtre', () => {
    expect(
      longestRunKm(
        [
          // Une sortie vélo ne dit rien de ce qu'une sortie longue à pied coûte.
          run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), sportType: 'Ride', distanceM: 60_000 }),
          run({ startedAt: new Date('2026-08-14T06:00:00.000Z'), distanceM: 30_000 }),
          // 31 jours avant : hors fenêtre, donc muette.
          run({ startedAt: new Date('2026-07-11T06:00:00.000Z'), distanceM: 25_000 }),
          run({ startedAt: new Date('2026-07-12T06:00:00.000Z'), distanceM: 6_000 }),
        ],
        '2026-08-11',
      ),
    ).toBe(6);
  });

  it('rend `null` sans course exploitable — pas un plafond de zéro kilomètre', () => {
    expect(longestRunKm([], '2026-08-11')).toBeNull();
    expect(
      longestRunKm([run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 0 })], '2026-08-11'),
    ).toBeNull();
  });
});

describe('recentRunPace', () => {
  it('pondère par la distance plutôt que de moyenner les allures', () => {
    const pace = recentRunPace(
      [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 10_000, movingTimeS: 3_000 }),
        run({ startedAt: new Date('2026-08-08T06:00:00.000Z'), distanceM: 5_000, movingTimeS: 1_800 }),
      ],
      5,
    );

    // 15 km en 4 800 s → 320 s/km, et non la moyenne (300 + 360) / 2 = 330.
    expect(pace).toBe(320);
  });

  it('ne retient que les `limit` courses les plus récentes', () => {
    const pace = recentRunPace(
      [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 10_000, movingTimeS: 3_000 }),
        run({ startedAt: new Date('2026-01-01T06:00:00.000Z'), distanceM: 10_000, movingTimeS: 6_000 }),
      ],
      1,
    );

    expect(pace).toBe(300);
  });

  it('rend `null` sans aucune course exploitable', () => {
    expect(recentRunPace([run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), sportType: 'Ride' })])).toBeNull();
    expect(recentRunPace([run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 0 })])).toBeNull();
  });
});

describe('toComparableActivityDto', () => {
  it('rend un TRIMP calculé quand le profil le permet', () => {
    const dto = toComparableActivityDto(
      run({ startedAt: new Date('2026-08-04T06:00:00.000Z') }),
      ATHLETE_ROW,
    );

    expect(dto.date).toBe('2026-08-04');
    expect(dto.trimp).not.toBeNull();
    expect(dto.avgPaceSecPerKm).toBe(300);
  });

  it("laisse le TRIMP à `null` quand le sexe n'est pas renseigné (Banister est sexué)", () => {
    const dto = toComparableActivityDto(run({ startedAt: new Date('2026-08-04T06:00:00.000Z') }), {
      ...ATHLETE_ROW,
      sex: null,
    });

    expect(dto.trimp).toBeNull();
  });
});

describe('getTrainingSnapshot', () => {
  it("rend un instantané entièrement vide tant qu'aucun athlète n'existe", async () => {
    const snapshot = await getTrainingSnapshot();

    expect(snapshot).toEqual({
      today: '2026-08-11',
      profile: {},
      fitness: null,
      vo2max: null,
      weeks: [],
      longestSessionKm30d: null,
      recentAvgPaceSecPerKm: null,
    });
  });

  it('assemble profil, charge, volume hebdomadaire et allure de référence', async () => {
    dbState.rows = {
      athlete: [ATHLETE_ROW],
      activities: [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 12_000, movingTimeS: 3_600 }),
        run({ startedAt: new Date('2026-08-06T06:00:00.000Z'), distanceM: 8_000, movingTimeS: 2_400 }),
      ],
    };

    const snapshot = await getTrainingSnapshot();

    expect(snapshot.today).toBe('2026-08-11');
    expect(snapshot.profile.ageYears).toBe(36);
    expect(snapshot.fitness).not.toBeNull();
    expect(snapshot.weeks).toHaveLength(4);
    expect(snapshot.weeks[3].distanceKm).toBe(12);
    expect(snapshot.longestSessionKm30d).toBe(12);
    expect(snapshot.recentAvgPaceSecPerKm).toBe(300);
  });

  it("laisse la charge à `null` quand le sexe manque : le TRIMP n'est pas calculable", async () => {
    dbState.rows = {
      athlete: [{ ...ATHLETE_ROW, sex: null }],
      activities: [run({ startedAt: new Date('2026-08-10T06:00:00.000Z') })],
    };

    const snapshot = await getTrainingSnapshot();

    expect(snapshot.fitness).toBeNull();
    expect(snapshot.profile.sex).toBeUndefined();
  });
});

describe('getComparableActivities', () => {
  it('rend une liste vide sans athlète', async () => {
    expect(await getComparableActivities(7)).toEqual([]);
  });

  it("rend une liste vide quand l'activité n'est pas celle de l'athlète", async () => {
    dbState.rows = { athlete: [ATHLETE_ROW] };
    dbState.queue = { activities: [[]] };

    expect(await getComparableActivities(7)).toEqual([]);
  });

  it('borne la recherche au même sport, à ±25 % de distance et à l’antériorité', async () => {
    const reference = run({
      id: 7,
      startedAt: new Date('2026-08-11T06:00:00.000Z'),
      distanceM: 10_000,
      sportType: 'TrailRun',
    });
    const older = run({ id: 4, startedAt: new Date('2026-08-04T06:00:00.000Z'), distanceM: 9_500 });

    dbState.rows = { athlete: [ATHLETE_ROW] };
    dbState.queue = { activities: [[reference], [older]] };

    const comparables = await getComparableActivities(7, 5);

    const where = renderWhere(dbState.selects.at(-1)?.where);
    expect(where.params).toEqual(
      expect.arrayContaining([1, 'TrailRun', reference.startedAt.toISOString(), 7_500, 12_500]),
    );
    expect(where.sql).toContain('<');
    expect(comparables).toEqual([
      {
        date: '2026-08-04',
        distanceM: 9_500,
        movingTimeS: 3_000,
        avgPaceSecPerKm: 300,
        avgHrBpm: 145,
        elevationGainM: 80,
        trimp: expect.any(Number),
      },
    ]);
  });

  it('ne lit rien quand la limite demandée est nulle', async () => {
    expect(await getComparableActivities(7, 0)).toEqual([]);
    expect(dbState.selects).toHaveLength(0);
  });
});
