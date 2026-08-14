import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityWeatherObservation } from './activity-weather';
import type { Activity, Plan, PlannedSession } from './db/schema';
import {
  CALENDAR_RANGE_LIMITS,
  InvalidCalendarRangeError,
  calendarActivities,
  calendarDayWeather,
  getCalendarRange,
  toCalendarActivityDto,
  toCalendarSessionDto,
} from './calendar';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : les lectures servent les lignes déclarées par table,
 * et leur clause `WHERE` est enregistrée — c'est elle qui porte le filtre sur
 * l'athlète et les bornes de la plage, donc c'est elle que les tests inspectent.
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    wheres: {} as Record<string, SQL | undefined>,
    orderBys: {} as Record<string, SQL[]>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => Chain;
    orderBy: (...clauses: SQL[]) => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const chain: Chain = {
      where: (clause) => {
        dbState.wheres[name] = clause;
        return chain;
      },
      orderBy: (...clauses) => {
        dbState.orderBys[name] = clauses;
        return chain;
      },
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return { db: { select: () => ({ from: chainFor }) } };
});

/**
 * La météo relevée est lue par le DAL qui la possède (`./activity-weather.ts`,
 * dont les tests couvrent le cloisonnement de sa jointure) : ici, seul compte ce
 * que le calendrier en fait — un relevé par jour, recadré sur la plage demandée.
 */
const { weatherState } = vi.hoisted(() => ({
  weatherState: {
    observations: [] as import('./activity-weather').ActivityWeatherObservation[],
    calls: [] as Array<{ athleteId: number; oldest: Date; newest: Date }>,
  },
}));

vi.mock('./activity-weather', () => ({
  listWeatherObservations: (athleteId: number, oldest: Date, newest: Date) => {
    weatherState.calls.push({ athleteId, oldest, newest });
    return Promise.resolve(weatherState.observations);
  },
}));

const { athleteState } = vi.hoisted(() => ({ athleteState: { id: 1 as number | null } }));

vi.mock('./athlete', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./athlete')>()),
  getCurrentAthleteId: () => Promise.resolve(athleteState.id),
}));

const dialect = new PgDialect();

function renderWhere(table: string): { sql: string; params: unknown[] } {
  const clause = dbState.wheres[table];
  if (clause === undefined) throw new Error(`Aucune clause \`WHERE\` pour ${table}.`);
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

/** Aujourd'hui : mercredi 12 août 2026, 11 h à Paris. */
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-08-12T09:00:00.000Z'));

afterAll(() => {
  vi.useRealTimers();
});

const PLAN_ROW: Plan = {
  id: 3,
  athleteId: 1,
  status: 'active',
  goalType: 'race',
  intent: 'race',
  returnInjuryHistory: false,
  level: 'intermediate',
  goalText: '10 km sous 50 min',
  raceDate: '2026-09-13',
  // Lundi 10 août, 4 semaines : le plan couvre jusqu'au dimanche 6 septembre.
  startsOn: '2026-08-10',
  weeks: 4,
  sessionsPerWeek: 4,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: '10k',
  referenceTimeS: 2_910,
  referenceUpdatedOn: null,
  lastTestNote: null,
  summary: null,
  reviewedSessionCount: 0,
  reviewedAt: null,
  createdAt: new Date('2026-08-09T10:00:00.000Z'),
  updatedAt: new Date('2026-08-09T10:00:00.000Z'),
};

function sessionRow(overrides: Partial<PlannedSession> = {}): PlannedSession {
  return {
    id: 7,
    athleteId: 1,
    planId: 3,
    scheduledOn: '2026-08-14',
    kind: 'Seuil',
    title: '3 × 2 km',
    targetPaceSecPerKm: 245,
    warmup: null,
    recovery: null,
    cooldown: null,
    volumeM: 12_400,
    durationS: 3_900,
    steps: null,
    completedActivityId: null,
    createdAt: new Date('2026-08-09T10:00:00.000Z'),
    ...overrides,
  };
}

function activityRow(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 42,
    athleteId: 1,
    fitFileHash: 'a'.repeat(64),
    name: 'Footing du midi',
    sportType: 'Run',
    startedAt: new Date('2026-08-11T10:30:00.000Z'),
    distanceM: 8_120,
    movingTimeS: 2_700,
    elapsedTimeS: 2_760,
    elevationGainM: 42,
    avgHrBpm: 142,
    maxHrBpm: 161,
    avgPaceSecPerKm: 332.5,
    avgCadenceSpm: 86,
    sustainedMaxHrBpm: null,
    createdAt: new Date('2026-08-11T12:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  dbState.rows = {};
  dbState.wheres = {};
  dbState.orderBys = {};
  athleteState.id = 1;
  weatherState.observations = [];
  weatherState.calls = [];
});

describe('getCalendarRange — validation de la plage', () => {
  it('refuse une date mal formée', async () => {
    await expect(getCalendarRange('12/08/2026', '2026-08-16')).rejects.toBeInstanceOf(
      InvalidCalendarRangeError,
    );
  });

  it("refuse une date qui n'existe pas au calendrier", async () => {
    await expect(getCalendarRange('2026-02-31', '2026-03-05')).rejects.toBeInstanceOf(
      InvalidCalendarRangeError,
    );
  });

  it('refuse une fin antérieure au début', async () => {
    await expect(getCalendarRange('2026-08-16', '2026-08-10')).rejects.toBeInstanceOf(
      InvalidCalendarRangeError,
    );
  });

  it('refuse une amplitude au-delà de la borne, et accepte la borne elle-même', async () => {
    const from = '2026-01-01';
    const lastAllowed = new Date(
      Date.parse(`${from}T00:00:00Z`) + (CALENDAR_RANGE_LIMITS.maxDays - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const oneTooFar = new Date(
      Date.parse(`${from}T00:00:00Z`) + CALENDAR_RANGE_LIMITS.maxDays * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    await expect(getCalendarRange(from, lastAllowed)).resolves.toMatchObject({ from });
    await expect(getCalendarRange(from, oneTooFar)).rejects.toBeInstanceOf(
      InvalidCalendarRangeError,
    );
  });

  it('accepte un seul jour', async () => {
    await expect(getCalendarRange('2026-08-12', '2026-08-12')).resolves.toMatchObject({
      from: '2026-08-12',
      to: '2026-08-12',
    });
  });
});

describe('getCalendarRange — lecture', () => {
  it('rend une plage vide quand aucun athlète n’existe', async () => {
    athleteState.id = null;
    dbState.rows.planned_sessions = [sessionRow()];

    await expect(getCalendarRange('2026-08-10', '2026-08-16')).resolves.toEqual({
      from: '2026-08-10',
      to: '2026-08-16',
      plan: null,
      sessions: [],
      activities: [],
      weather: [],
    });
  });

  it("filtre les séances sur l'athlète et sur les bornes de la plage", async () => {
    await getCalendarRange('2026-08-10', '2026-08-16');

    const where = renderWhere('planned_sessions');
    expect(where.sql).toContain('"athlete_id"');
    expect(where.sql).toContain('"scheduled_on"');
    expect(where.params).toContain(1);
    expect(where.params).toContain('2026-08-10');
    expect(where.params).toContain('2026-08-16');
  });

  it('ordonne les séances par jour puis par id, pour un affichage stable', async () => {
    await getCalendarRange('2026-08-10', '2026-08-16');

    const order = (dbState.orderBys.planned_sessions ?? []).map(
      (clause) => dialect.sqlToQuery(clause).sql,
    );
    expect(order.join(', ')).toBe('"planned_sessions"."scheduled_on" asc, "planned_sessions"."id" asc');
  });

  it('rend les bornes du plan actif, dernier jour inclus', async () => {
    dbState.rows.plans = [PLAN_ROW];

    const range = await getCalendarRange('2026-08-10', '2026-08-16');

    expect(range.plan).toEqual({
      startsOn: '2026-08-10',
      // 4 semaines depuis le lundi d'ancrage : dernier jour = dimanche 6 septembre.
      endsOn: '2026-09-06',
      raceDate: '2026-09-13',
      longRunDay: 7,
    });
  });

  it('rend `plan: null` quand aucun plan n’est actif', async () => {
    const range = await getCalendarRange('2026-08-10', '2026-08-16');

    expect(range.plan).toBeNull();
  });

  it('rend un DTO minimal : ni athleteId, ni planId, ni date de création', async () => {
    dbState.rows.planned_sessions = [sessionRow()];

    const range = await getCalendarRange('2026-08-10', '2026-08-16');

    expect(range.sessions).toEqual([
      {
        id: 7,
        date: '2026-08-14',
        kind: 'Seuil',
        title: '3 × 2 km',
        steps: null,
        volumeM: 12_400,
        durationS: 3_900,
        completed: false,
        movable: true,
      },
    ]);
  });

  it('garde lisible une séance hors plan (`plan_id` nul)', async () => {
    dbState.rows.planned_sessions = [sessionRow({ id: 11, planId: null })];

    const range = await getCalendarRange('2026-08-10', '2026-08-16');

    expect(range.sessions).toHaveLength(1);
    expect(range.sessions[0]?.id).toBe(11);
  });

  it('soustrait des activités celles qu’une séance de la plage réalise', async () => {
    dbState.rows.planned_sessions = [sessionRow({ scheduledOn: '2026-08-11', completedActivityId: 42 })];
    dbState.rows.activities = [activityRow({ id: 42 }), activityRow({ id: 43 })];

    const range = await getCalendarRange('2026-08-10', '2026-08-16');

    expect(range.activities.map((activity) => activity.id)).toEqual([43]);
  });

  it('lit la météo des sorties sous le même athlète et la même plage', async () => {
    weatherState.observations = [
      {
        startedAt: new Date('2026-08-11T16:00:00.000Z'),
        status: 'observed',
        temperatureC: 21.4,
        weatherCode: 3,
        observedAt: new Date('2026-08-11T16:00:00.000Z'),
      },
    ];

    const range = await getCalendarRange('2026-08-10', '2026-08-16');

    expect(weatherState.calls).toHaveLength(1);
    expect(weatherState.calls[0]?.athleteId).toBe(1);
    expect(range.weather).toEqual([
      {
        date: '2026-08-11',
        status: 'observed',
        temperatureC: 21.4,
        weatherCode: 3,
        observedAt: new Date('2026-08-11T16:00:00.000Z'),
      },
    ]);
  });
});

/**
 * Une journée à plusieurs sorties n'a pas une météo unique, et une case de
 * calendrier n'a la place que d'une icône : c'est ici que le choix se fait.
 */
describe('calendarDayWeather', () => {
  const RANGE = { from: '2026-08-10', to: '2026-08-16' };

  function observation(
    startedAt: string,
    overrides: Partial<ActivityWeatherObservation> = {},
  ): ActivityWeatherObservation {
    return {
      startedAt: new Date(startedAt),
      status: 'observed',
      temperatureC: 21.4,
      weatherCode: 3,
      observedAt: new Date(startedAt),
      ...overrides,
    };
  }

  it('range les relevés par jour civil, dans le fuseau de l’athlète', () => {
    // 23 h 30 UTC le 11 août, soit 1 h 30 le 12 août à Paris.
    const days = calendarDayWeather([observation('2026-08-11T23:30:00.000Z')], RANGE);

    expect(days.map((day) => day.date)).toEqual(['2026-08-12']);
  });

  it('retient la première sortie du jour', () => {
    const days = calendarDayWeather(
      [
        observation('2026-08-11T06:00:00.000Z', { temperatureC: 14 }),
        observation('2026-08-11T18:00:00.000Z', { temperatureC: 27 }),
      ],
      RANGE,
    );

    expect(days).toHaveLength(1);
    expect(days[0]?.temperatureC).toBe(14);
  });

  it('préfère une sortie réellement mesurée à une première sans relevé', () => {
    // Tapis le matin, dehors le soir : la case doit dire le temps qu'il a fait,
    // pas « séance en intérieur ».
    const days = calendarDayWeather(
      [
        observation('2026-08-11T06:00:00.000Z', {
          status: 'no-location',
          temperatureC: null,
          weatherCode: null,
          observedAt: null,
        }),
        observation('2026-08-11T18:00:00.000Z', { temperatureC: 27 }),
      ],
      RANGE,
    );

    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ status: 'observed', temperatureC: 27 });
  });

  it('garde le statut d’un jour dont aucune sortie n’a été relevée', () => {
    const days = calendarDayWeather(
      [
        observation('2026-08-11T06:00:00.000Z', {
          status: 'failed',
          temperatureC: null,
          weatherCode: null,
          observedAt: null,
        }),
      ],
      RANGE,
    );

    expect(days[0]?.status).toBe('failed');
  });

  it('recadre la marge d’interrogation sur la plage demandée', () => {
    const days = calendarDayWeather(
      [
        observation('2026-08-09T06:00:00.000Z'),
        observation('2026-08-12T06:00:00.000Z'),
        observation('2026-08-17T06:00:00.000Z'),
      ],
      RANGE,
    );

    expect(days.map((day) => day.date)).toEqual(['2026-08-12']);
  });
});

describe('toCalendarSessionDto — ce qui se déplace', () => {
  const today = '2026-08-12';

  it('gèle une séance déjà courue, quelle que soit sa date', () => {
    const dto = toCalendarSessionDto(
      sessionRow({ scheduledOn: '2026-08-20', completedActivityId: 42 }),
      today,
    );

    expect(dto).toMatchObject({ completed: true, movable: false });
  });

  it('gèle une séance dont le jour est passé', () => {
    const dto = toCalendarSessionDto(sessionRow({ scheduledOn: '2026-08-11' }), today);

    expect(dto).toMatchObject({ completed: false, movable: false });
  });

  it("laisse déplaçable la séance du jour même", () => {
    const dto = toCalendarSessionDto(sessionRow({ scheduledOn: today }), today);

    expect(dto.movable).toBe(true);
  });
});

describe('calendarActivities', () => {
  it('recadre sur la plage demandée les jours ramenés par la marge de requête', () => {
    const kept = calendarActivities(
      [
        activityRow({ id: 1, startedAt: new Date('2026-08-09T18:00:00.000Z') }),
        activityRow({ id: 2, startedAt: new Date('2026-08-11T06:00:00.000Z') }),
        activityRow({ id: 3, startedAt: new Date('2026-08-17T06:00:00.000Z') }),
      ],
      [],
      { from: '2026-08-10', to: '2026-08-16' },
    );

    expect(kept.map((activity) => activity.id)).toEqual([2]);
  });

  it('ordonne par jour puis par id', () => {
    const ordered = calendarActivities(
      [
        activityRow({ id: 9, startedAt: new Date('2026-08-13T06:00:00.000Z') }),
        activityRow({ id: 4, startedAt: new Date('2026-08-11T06:00:00.000Z') }),
        activityRow({ id: 2, startedAt: new Date('2026-08-11T18:00:00.000Z') }),
      ],
      [],
      { from: '2026-08-10', to: '2026-08-16' },
    );

    expect(ordered.map((activity) => activity.id)).toEqual([2, 4, 9]);
  });
});

describe('toCalendarActivityDto', () => {
  it("rend le jour civil du départ dans le fuseau de l'athlète, et rien d'interne", () => {
    // 23 h 30 UTC le 11 août, soit 1 h 30 le 12 août à Paris.
    const dto = toCalendarActivityDto(
      activityRow({ startedAt: new Date('2026-08-11T23:30:00.000Z') }),
    );

    expect(dto).toEqual({
      id: 42,
      date: '2026-08-12',
      name: 'Footing du midi',
      sportType: 'Run',
      distanceM: 8_120,
      movingTimeS: 2_700,
      avgPaceSecPerKm: 332.5,
    });
  });
});
