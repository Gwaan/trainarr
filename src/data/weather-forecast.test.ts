import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getForecastRun,
  getWeatherForecast,
  listRecentStartCoordinates,
  saveForecastReading,
} from './weather-forecast';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Prévisions : cloisonnement, remplacement, et ce qui franchit la frontière.
 *
 * Trois propriétés, et elles ne se déduisent pas les unes des autres :
 *
 * 1. **rien ne se lit ni ne s'écrit hors de son athlète** — la lecture d'écran
 *    le tient de la session, le service le reçoit en paramètre ;
 * 2. **un relevé remplace, il n'ajoute pas** — sans quoi l'horizon d'hier
 *    survivrait à celui d'aujourd'hui ;
 * 3. **aucune coordonnée ne franchit la frontière client** — elles sont écrites
 *    comme provenance, et le DTO ne les porte pas.
 */

type RecordedQuery = { table: string; where: SQL | null; join: SQL | null };

const { dbState, athleteState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    queries: [] as RecordedQuery[],
    inserts: [] as Array<{
      table: string;
      values: unknown;
      conflictSet: Record<string, unknown> | null;
    }>,
    deletes: [] as Array<{ table: string; where: SQL | null }>,
    transactions: 0,
  },
  athleteState: { currentId: null as number | null, today: '2026-08-14' },
}));

vi.mock('./athlete', () => ({
  getCurrentAthleteId: () => Promise.resolve(athleteState.currentId),
  todayCivilDate: () => athleteState.today,
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => Chain;
    innerJoin: (table: Table, clause: SQL) => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const query: RecordedQuery = { table: getTableName(table), where: null, join: null };
    dbState.queries.push(query);

    const chain: Chain = {
      where: (clause) => {
        query.where = clause;
        return chain;
      },
      innerJoin: (_joined, clause) => {
        query.join = clause;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.rows[query.table] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  type InsertChain = PromiseLike<unknown> & {
    onConflictDoUpdate: (options: { set: Record<string, unknown> }) => InsertChain;
  };

  const client = {
    select: () => ({ from: chainFor }),
    insert: (table: Table) => ({
      values: (values: unknown) => {
        const record = {
          table: getTableName(table),
          values,
          conflictSet: null as Record<string, unknown> | null,
        };
        dbState.inserts.push(record);
        const chain: InsertChain = {
          onConflictDoUpdate: (options) => {
            record.conflictSet = options.set;
            return chain;
          },
          then: (onFulfilled, onRejected) =>
            Promise.resolve(undefined).then(onFulfilled, onRejected),
        };
        return chain;
      },
    }),
    delete: (table: Table) => ({
      where: (clause: SQL) => {
        dbState.deletes.push({ table: getTableName(table), where: clause });
        return Promise.resolve(undefined);
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

function render(clause: SQL | null | undefined): { sql: string; params: unknown[] } {
  if (clause == null) throw new Error('Aucune clause enregistrée pour cette requête.');
  const rendered = dialect.sqlToQuery(clause);
  return { sql: rendered.sql, params: rendered.params };
}

function queryOn(table: string): RecordedQuery {
  const query = dbState.queries.find((candidate) => candidate.table === table);
  if (query === undefined) throw new Error(`Aucune requête sur « ${table} ».`);
  return query;
}

const HOME = { latitudeDeg: 48.85, longitudeDeg: 2.35 };
const NOW = new Date('2026-08-14T04:00:12Z');

const DAY = {
  date: '2026-08-14',
  weatherCode: 3,
  temperatureMaxC: 24.7,
  temperatureMinC: 14.2,
  apparentTemperatureMaxC: 23.1,
  apparentTemperatureMinC: 13.4,
  precipitationSumMm: 0.9,
  precipitationProbabilityMaxPct: 14,
  windSpeedMaxKmh: 13.5,
};

beforeEach(() => {
  dbState.rows = {};
  dbState.queries = [];
  dbState.inserts = [];
  dbState.deletes = [];
  dbState.transactions = 0;
  athleteState.currentId = null;
  athleteState.today = '2026-08-14';
});

describe('listRecentStartCoordinates', () => {
  it('ne lit que les départs de l’athlète donné', async () => {
    dbState.rows.activity_weather = [HOME];

    await listRecentStartCoordinates(7, 30);

    const { sql, params } = render(queryOn('activity_weather').join);
    expect(sql).toContain('"athlete_id"');
    expect(params).toContain(7);
  });

  it('n’exige pas un relevé réussi : un échec a quand même un point de départ', async () => {
    dbState.rows.activity_weather = [HOME];

    await listRecentStartCoordinates(7, 30);

    const { sql } = render(queryOn('activity_weather').where);
    expect(sql).toContain('"latitude_deg" is not null');
    expect(sql).not.toContain('"status"');
  });

  it('écarte une ligne sans coordonnées plutôt que de supposer', async () => {
    dbState.rows.activity_weather = [
      { latitudeDeg: null, longitudeDeg: null },
      HOME,
      { latitudeDeg: 48.9, longitudeDeg: null },
    ];

    expect(await listRecentStartCoordinates(7, 30)).toEqual([HOME]);
  });

  it('ne lit rien quand on ne lui demande rien', async () => {
    expect(await listRecentStartCoordinates(7, 0)).toEqual([]);
    expect(dbState.queries).toHaveLength(0);
  });
});

describe('getForecastRun', () => {
  it('rend l’état du relevé de cet athlète', async () => {
    const run = {
      readingDay: '2026-08-14',
      status: 'forecast',
      attempts: 1,
      lastAttemptAt: NOW,
    };
    dbState.rows.weather_forecast_runs = [run];

    expect(await getForecastRun(7)).toEqual(run);
    const { params } = render(queryOn('weather_forecast_runs').where);
    expect(params).toEqual([7]);
  });

  it('rend `null` quand aucun relevé n’a jamais eu lieu', async () => {
    expect(await getForecastRun(7)).toBeNull();
  });
});

describe('saveForecastReading', () => {
  it('écrit l’état et remplace les prévisions, d’un seul tenant', async () => {
    await saveForecastReading(7, '2026-08-14', {
      status: 'forecast',
      coordinates: HOME,
      days: [DAY],
    }, NOW);

    expect(dbState.transactions).toBe(1);

    const run = dbState.inserts.find((insert) => insert.table === 'weather_forecast_runs');
    expect(run?.values).toMatchObject({
      athleteId: 7,
      readingDay: '2026-08-14',
      status: 'forecast',
      attempts: 1,
      latitudeDeg: 48.85,
      longitudeDeg: 2.35,
      failureReason: null,
    });

    // Effacé **puis** réécrit : l'horizon d'hier ne survit pas à celui du jour.
    expect(dbState.deletes.map((entry) => entry.table)).toEqual(['weather_forecasts']);
    const days = dbState.inserts.find((insert) => insert.table === 'weather_forecasts');
    expect(days?.values).toEqual([
      {
        athleteId: 7,
        forecastDate: '2026-08-14',
        fetchedAt: NOW,
        weatherCode: 3,
        temperatureMaxC: 24.7,
        temperatureMinC: 14.2,
        apparentTemperatureMaxC: 23.1,
        apparentTemperatureMinC: 13.4,
        precipitationSumMm: 0.9,
        precipitationProbabilityMaxPct: 14,
        windSpeedMaxKmh: 13.5,
      },
    ]);
  });

  it('n’efface les prévisions que sous l’athlète concerné', async () => {
    await saveForecastReading(7, '2026-08-14', {
      status: 'forecast',
      coordinates: HOME,
      days: [DAY],
    }, NOW);

    const { params } = render(dbState.deletes[0].where);
    expect(params).toEqual([7]);
  });

  it('fait repartir le compteur d’essais à chaque nouveau matin', async () => {
    await saveForecastReading(7, '2026-08-14', { status: 'no-location' }, NOW);

    const run = dbState.inserts.find((insert) => insert.table === 'weather_forecast_runs');
    const attempts = run?.conflictSet?.attempts;
    const { sql } = render(attempts instanceof SQL ? attempts : null);
    // Le compteur appartient au marqueur : il ne s'incrémente que si la ligne
    // existante porte le même matin, et repart à 1 sinon.
    expect(sql).toContain('excluded.reading_day');
    expect(sql).toContain('+ 1');
    expect(sql).toContain('else 1 end');
  });

  it('garde les prévisions de la veille quand le relevé échoue', async () => {
    await saveForecastReading(
      7,
      '2026-08-14',
      { status: 'failed', reason: 'WeatherUnavailableError: réseau', coordinates: HOME },
      NOW,
    );

    // Rien d'effacé, rien de réécrit : mieux vaut hier que rien, et
    // `fetched_at` dira de quand ça date.
    expect(dbState.deletes).toHaveLength(0);
    expect(dbState.inserts.map((insert) => insert.table)).toEqual(['weather_forecast_runs']);
    expect(dbState.inserts[0].values).toMatchObject({
      status: 'failed',
      failureReason: 'WeatherUnavailableError: réseau',
    });
  });

  it('n’écrit aucune coordonnée quand il n’y a pas de lieu', async () => {
    await saveForecastReading(7, '2026-08-14', { status: 'no-location' }, NOW);

    expect(dbState.inserts[0].values).toMatchObject({
      status: 'no-location',
      latitudeDeg: null,
      longitudeDeg: null,
      failureReason: null,
    });
  });
});

describe('getWeatherForecast', () => {
  it('ne rend rien sans athlète connecté', async () => {
    expect(await getWeatherForecast()).toEqual({ status: null, fetchedAt: null, days: [] });
    expect(dbState.queries).toHaveLength(0);
  });

  it('ne lit que les prévisions de l’athlète de la session, à partir d’aujourd’hui', async () => {
    athleteState.currentId = 7;

    await getWeatherForecast();

    const { sql, params } = render(queryOn('weather_forecasts').where);
    expect(sql).toContain('"forecast_date" >=');
    expect(params).toEqual([7, '2026-08-14']);
  });

  it('fait voyager le statut, même sans une seule prévision', async () => {
    athleteState.currentId = 7;
    dbState.rows.weather_forecast_runs = [
      { status: 'no-location', lastAttemptAt: NOW },
    ];

    expect(await getWeatherForecast()).toEqual({
      status: 'no-location',
      fetchedAt: NOW,
      days: [],
    });
  });

  it('date la prévision de son relevé, pas de la dernière tentative', async () => {
    athleteState.currentId = 7;
    const yesterday = new Date('2026-08-13T04:00:09Z');
    dbState.rows.weather_forecast_runs = [{ status: 'failed', lastAttemptAt: NOW }];
    dbState.rows.weather_forecasts = [{ ...DAY, fetchedAt: yesterday }];

    const forecast = await getWeatherForecast();
    expect(forecast.status).toBe('failed');
    expect(forecast.fetchedAt).toEqual(yesterday);
  });

  it('ne laisse passer ni coordonnées ni horodatage de ligne', async () => {
    athleteState.currentId = 7;
    dbState.rows.weather_forecasts = [{ ...DAY, fetchedAt: NOW }];

    const forecast = await getWeatherForecast();
    expect(forecast.days).toEqual([DAY]);
    expect(Object.keys(forecast.days[0])).not.toContain('fetchedAt');
    expect(Object.keys(forecast.days[0]).join()).not.toMatch(/latitude|longitude/);
  });
});
