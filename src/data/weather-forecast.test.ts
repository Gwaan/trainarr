import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearForecastLocation,
  getForecastLocation,
  getForecastLocationLabel,
  getForecastRun,
  getWeatherForecast,
  InvalidForecastLocationError,
  listRecentStartCoordinates,
  saveForecastLocation,
  saveForecastReading,
  selectWeatherForecast,
  validateForecastLocation,
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
    updates: [] as Array<{ table: string; values: Record<string, unknown>; where: SQL | null }>,
    transactions: 0,
  },
  athleteState: { currentId: null as number | null, today: '2026-08-14' },
}));

vi.mock('./athlete', () => ({
  getCurrentAthleteId: () => Promise.resolve(athleteState.currentId),
  todayCivilDate: () => athleteState.today,
  // Recopiée du vrai module : le DAL des prévisions la lève quand le compte n'a
  // pas d'athlète, et un test doit pouvoir la reconnaître sans charger le
  // chiffrement et better-auth avec elle.
  AthleteNotFoundError: class AthleteNotFoundError extends Error {
    constructor() {
      super("Aucun athlète enregistré : le profil doit d'abord être créé.");
      this.name = 'AthleteNotFoundError';
    }
  },
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
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: (clause: SQL) => {
          dbState.updates.push({ table: getTableName(table), values, where: clause });
          return Promise.resolve(undefined);
        },
      }),
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
  dbState.updates = [];
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

/**
 * Le lieu réglé — la seule partie du DAL qui écrit sur `athlete`.
 *
 * Trois propriétés s'y jouent :
 *
 * 1. **les trois colonnes vont ensemble** : un libellé sans coordonnées n'est
 *    pas un demi-réglage, c'est une ligne qu'on ne sait pas lire ;
 * 2. **rien ne s'écrit hors de l'athlète de la session** ;
 * 3. **changer de lieu périme le relevé en cours** — sinon la prévision d'une
 *    autre ville s'afficherait sous le nom de la nouvelle.
 */
describe('validateForecastLocation', () => {
  it('arrondit les coordonnées comme partout ailleurs', () => {
    expect(
      validateForecastLocation({ label: 'Bordeaux', latitudeDeg: 44.84124, longitudeDeg: -0.58046 }),
    ).toEqual({ label: 'Bordeaux', coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 } });
  });

  it('détoure le libellé et refuse un nom vide', () => {
    expect(
      validateForecastLocation({ label: '  Bordeaux ', latitudeDeg: 44.84, longitudeDeg: -0.58 })
        .label,
    ).toBe('Bordeaux');

    expect(() =>
      validateForecastLocation({ label: '   ', latitudeDeg: 44.84, longitudeDeg: -0.58 }),
    ).toThrow(InvalidForecastLocationError);
  });

  it('refuse un point qu’Open-Meteo ne saurait pas interroger', () => {
    expect(() =>
      validateForecastLocation({ label: 'Nulle part', latitudeDeg: 0, longitudeDeg: 0 }),
    ).toThrow(InvalidForecastLocationError);

    expect(() =>
      validateForecastLocation({ label: 'Ailleurs', latitudeDeg: 148.85, longitudeDeg: 2.35 }),
    ).toThrow(InvalidForecastLocationError);
  });
});

describe('getForecastLocation', () => {
  it('rend le lieu réglé de l’athlète demandé', async () => {
    dbState.rows.athlete = [{ label: 'Bordeaux', latitudeDeg: 44.84, longitudeDeg: -0.58 }];

    expect(await getForecastLocation(7)).toEqual({
      label: 'Bordeaux',
      coordinates: { latitudeDeg: 44.84, longitudeDeg: -0.58 },
    });

    const { params } = render(queryOn('athlete').where);
    expect(params).toEqual([7]);
  });

  it('rend `null` dès qu’une des trois colonnes manque', async () => {
    dbState.rows.athlete = [{ label: 'Bordeaux', latitudeDeg: null, longitudeDeg: -0.58 }];
    expect(await getForecastLocation(7)).toBeNull();

    dbState.rows.athlete = [{ label: null, latitudeDeg: 44.84, longitudeDeg: -0.58 }];
    expect(await getForecastLocation(7)).toBeNull();
  });

  it('rend `null` quand aucun lieu n’est réglé', async () => {
    expect(await getForecastLocation(7)).toBeNull();
  });
});

describe('getForecastLocationLabel', () => {
  it('ne lit rien sans athlète connecté', async () => {
    expect(await getForecastLocationLabel()).toBeNull();
    expect(dbState.queries).toHaveLength(0);
  });

  it('ne rend que le nom — jamais les coordonnées', async () => {
    athleteState.currentId = 7;
    dbState.rows.athlete = [{ label: 'Bordeaux', latitudeDeg: 44.84, longitudeDeg: -0.58 }];

    expect(await getForecastLocationLabel()).toBe('Bordeaux');
  });
});

describe('saveForecastLocation', () => {
  const BORDEAUX = { label: 'Bordeaux', latitudeDeg: 44.84124, longitudeDeg: -0.58046 };

  it('écrit sous l’athlète de la session, coordonnées arrondies', async () => {
    athleteState.currentId = 7;

    await saveForecastLocation(BORDEAUX);

    const update = dbState.updates.find((entry) => entry.table === 'athlete');
    expect(update?.values).toMatchObject({
      forecastLocationLabel: 'Bordeaux',
      forecastLatitudeDeg: 44.84,
      forecastLongitudeDeg: -0.58,
    });
    expect(render(update?.where ?? null).params).toEqual([7]);
  });

  it('périme le relevé en cours — son état et ses jours, d’un seul tenant', async () => {
    athleteState.currentId = 7;

    await saveForecastLocation(BORDEAUX);

    expect(dbState.transactions).toBe(1);
    expect(dbState.deletes.map((entry) => entry.table)).toEqual([
      'weather_forecast_runs',
      'weather_forecasts',
    ]);
    for (const entry of dbState.deletes) {
      expect(render(entry.where).params).toEqual([7]);
    }
  });

  it('refuse un lieu inexploitable sans rien écrire', async () => {
    athleteState.currentId = 7;

    await expect(
      saveForecastLocation({ label: 'Nulle part', latitudeDeg: 0, longitudeDeg: 0 }),
    ).rejects.toBeInstanceOf(InvalidForecastLocationError);

    expect(dbState.updates).toHaveLength(0);
    expect(dbState.deletes).toHaveLength(0);
  });

  it('refuse d’écrire quand le compte n’a pas d’athlète', async () => {
    await expect(saveForecastLocation(BORDEAUX)).rejects.toThrow(/Aucun athlète/);
    expect(dbState.updates).toHaveLength(0);
  });
});

describe('clearForecastLocation', () => {
  it('remet les trois colonnes à null et périme le relevé', async () => {
    athleteState.currentId = 7;

    await clearForecastLocation();

    const update = dbState.updates.find((entry) => entry.table === 'athlete');
    expect(update?.values).toMatchObject({
      forecastLocationLabel: null,
      forecastLatitudeDeg: null,
      forecastLongitudeDeg: null,
    });
    expect(render(update?.where ?? null).params).toEqual([7]);
    expect(dbState.deletes.map((entry) => entry.table)).toEqual([
      'weather_forecast_runs',
      'weather_forecasts',
    ]);
  });

  it('refuse d’écrire quand le compte n’a pas d’athlète', async () => {
    await expect(clearForecastLocation()).rejects.toThrow(/Aucun athlète/);
    expect(dbState.updates).toHaveLength(0);
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
    expect(await getWeatherForecast()).toEqual({
      status: null,
      fetchedAt: null,
      location: { source: 'derived' },
      days: [],
    });
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
      location: { source: 'derived' },
      days: [],
    });
  });

  it('porte le nom du lieu réglé, jamais ses coordonnées', async () => {
    athleteState.currentId = 7;
    dbState.rows.athlete = [{ label: 'Bordeaux', latitudeDeg: 44.84, longitudeDeg: -0.58 }];

    const dto = await getWeatherForecast();

    expect(dto.location).toEqual({ source: 'configured', label: 'Bordeaux' });
    expect(JSON.stringify(dto)).not.toContain('44.84');
  });

  it('annonce un lieu déduit sans lui inventer de nom', async () => {
    athleteState.currentId = 7;

    expect((await getWeatherForecast()).location).toEqual({ source: 'derived' });
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

/**
 * La lecture jumelle de {@link getWeatherForecast}, celle du **rappel matinal**.
 *
 * Elle existe pour une raison unique : la boucle des notifications tourne hors
 * requête, il n'y a aucune session à interroger — et un repli « le premier
 * athlète venu » est exactement ce que le cloisonnement par compte interdit.
 * Elle doit donc lire sous l'athlète qu'on lui donne, **sans jamais** consulter
 * la session.
 */
describe('selectWeatherForecast', () => {
  it('lit sous l’athlète donné, sans aucune session', async () => {
    // Personne n'est connecté : la lecture doit fonctionner quand même.
    athleteState.currentId = null;

    await selectWeatherForecast(9, '2026-08-14');

    expect(render(queryOn('weather_forecasts').where).params).toEqual([9, '2026-08-14']);
    expect(render(queryOn('weather_forecast_runs').where).params).toEqual([9]);
  });

  /*
   * Le jour est **passé**, jamais relu de l'horloge : c'est le même
   * « aujourd'hui » qui a sélectionné la séance du jour, et deux lectures à
   * cheval sur minuit annonceraient la météo de la veille sous la séance du
   * lendemain.
   */
  it('prend le jour qu’on lui donne pour borne', async () => {
    athleteState.currentId = null;

    await selectWeatherForecast(9, '2026-12-25');

    expect(render(queryOn('weather_forecasts').where).params).toEqual([9, '2026-12-25']);
  });

  it('rend le même contrat que la lecture d’écran', async () => {
    dbState.rows.weather_forecast_runs = [{ status: 'forecast', lastAttemptAt: NOW }];
    dbState.rows.weather_forecasts = [{ ...DAY, fetchedAt: NOW }];

    expect(await selectWeatherForecast(9, '2026-08-14')).toEqual({
      status: 'forecast',
      fetchedAt: NOW,
      location: { source: 'derived' },
      days: [DAY],
    });
  });
});
