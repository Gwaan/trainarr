import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActivityWeather,
  getWeatherLookupTarget,
  listActivitiesAwaitingWeather,
  listWeatherObservations,
  saveActivityWeather,
} from './activity-weather';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Cloisonnement de la météo d'activité.
 *
 * `activity_weather` n'a pas d'`athlete_id` : son propriétaire est celui de son
 * activité. Chaque lecture et chaque écriture doit donc **confronter** la séance
 * à l'athlète, et une séance qui n'est pas la sienne doit se comporter
 * exactement comme une séance inexistante — jamais un refus distinct, qui
 * révélerait l'existence de la ligne.
 *
 * Les fonctions de service reçoivent l'athlète en **paramètre** : le rattrapage
 * et l'ingestion tournent hors requête, il n'y a pas de session à interroger.
 */

/** Requête enregistrée : sa table, sa clause `WHERE` et sa condition de jointure. */
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
  },
  athleteState: { currentId: null as number | null },
}));

vi.mock('./athlete', () => ({
  getCurrentAthleteId: () => Promise.resolve(athleteState.currentId),
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => Chain;
    innerJoin: (table: Table, clause: SQL) => Chain;
    leftJoin: (table: Table, clause: SQL) => Chain;
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
      leftJoin: (_joined, clause) => {
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

  return {
    db: {
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
    },
  };
});

const dialect = new PgDialect();

function render(clause: SQL | null | undefined): { sql: string; params: unknown[] } {
  if (clause == null) throw new Error('Aucune clause enregistrée pour cette requête.');
  const rendered = dialect.sqlToQuery(clause);
  return { sql: rendered.sql, params: rendered.params };
}

beforeEach(() => {
  dbState.rows = {};
  dbState.queries = [];
  dbState.inserts = [];
  athleteState.currentId = null;
});

describe('getActivityWeather', () => {
  it('ne lit rien tant qu’il n’y a pas d’athlète en session', async () => {
    dbState.rows.activity_weather = [{ status: 'observed' }];

    await expect(getActivityWeather(42)).resolves.toBeNull();
    // Rien n'a même été demandé à la base.
    expect(dbState.queries).toEqual([]);
  });

  it('vérifie l’appartenance par la jointure, au lieu de la supposer', async () => {
    athleteState.currentId = 1;
    dbState.rows.activity_weather = [{ status: 'observed', temperatureC: 12.4 }];

    await getActivityWeather(42);

    const query = dbState.queries[0];
    expect(query?.table).toBe('activity_weather');
    expect(render(query?.join).params).toEqual([1]);
    expect(render(query?.where).params).toEqual([42]);
  });

  it('rend `null` pour la séance d’un autre athlète, comme pour une inexistante', async () => {
    athleteState.currentId = 2;
    // La jointure filtrante ne rend rien : les deux cas sont indistinguables.
    dbState.rows.activity_weather = [];

    await expect(getActivityWeather(42)).resolves.toBeNull();
  });

  it('ne rend que le DTO — ni coordonnées, ni mécanique de reprise', async () => {
    athleteState.currentId = 1;
    dbState.rows.activity_weather = [
      {
        status: 'observed',
        source: 'forecast',
        observedAt: new Date('2026-08-14T06:00:00Z'),
        temperatureC: 24.3,
        apparentTemperatureC: 25.1,
        precipitationMm: 0,
        windSpeedKmh: 1.3,
        windDirectionDeg: 326,
        relativeHumidityPct: 50,
        weatherCode: 1,
      },
    ];

    const dto = await getActivityWeather(42);

    expect(dto).not.toBeNull();
    // Les coordonnées arrondies ne franchissent pas la frontière client, et
    // `attempts` / `failure_reason` sont de la mécanique de service.
    expect(Object.keys(dto ?? {}).sort()).toEqual([
      'apparentTemperatureC',
      'observedAt',
      'precipitationMm',
      'relativeHumidityPct',
      'source',
      'status',
      'temperatureC',
      'weatherCode',
      'windDirectionDeg',
      'windSpeedKmh',
    ]);
  });
});

describe('listWeatherObservations', () => {
  it('confronte les sorties à l’athlète reçu, et borne la plage sur les instants', async () => {
    const oldest = new Date('2026-07-26T00:00:00Z');
    const newest = new Date('2026-09-08T00:00:00Z');

    await listWeatherObservations(7, oldest, newest);

    const query = dbState.queries[0];
    expect(query?.table).toBe('activity_weather');
    // L'appartenance vit dans la jointure : `activity_weather` n'a pas de
    // colonne `athlete_id`, c'est son activité qui porte le propriétaire.
    expect(render(query?.join).params).toEqual([7]);
    // Drizzle sérialise les bornes `timestamptz` avant de les passer au pilote.
    expect(render(query?.where).params).toEqual([oldest.toISOString(), newest.toISOString()]);
  });

  it('rend les relevés tels quels — l’instant de départ, pas un jour civil', async () => {
    const startedAt = new Date('2026-08-11T16:00:00Z');
    dbState.rows.activity_weather = [
      {
        startedAt,
        status: 'observed',
        temperatureC: 21.4,
        weatherCode: 3,
        observedAt: startedAt,
      },
    ];

    await expect(
      listWeatherObservations(7, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z')),
    ).resolves.toEqual([
      { startedAt, status: 'observed', temperatureC: 21.4, weatherCode: 3, observedAt: startedAt },
    ]);
  });
});

describe('getWeatherLookupTarget', () => {
  it('confronte la séance à l’athlète qu’on lui passe', async () => {
    dbState.rows.activities = [
      { activityId: 42, startedAt: new Date('2026-08-14T06:00:00Z'), elapsedTimeS: 3_600 },
    ];
    dbState.rows.activity_streams = [];

    await getWeatherLookupTarget(42, 7);

    expect(render(dbState.queries[0]?.where).params).toEqual([42, 7]);
  });

  it('prend le premier point du flux `latlng`, arrondi avant tout envoi', async () => {
    dbState.rows.activities = [
      { activityId: 42, startedAt: new Date('2026-08-14T06:00:00Z'), elapsedTimeS: 3_600 },
    ];
    dbState.rows.activity_streams = [
      {
        data: [
          null,
          [48.8566969, 2.3514616],
          [48.9, 2.4],
        ],
      },
    ];

    await expect(getWeatherLookupTarget(42, 7)).resolves.toEqual({
      activityId: 42,
      startedAt: new Date('2026-08-14T06:00:00Z'),
      elapsedTimeS: 3_600,
      coordinates: { latitudeDeg: 48.86, longitudeDeg: 2.35 },
    });
  });

  it('rend une cible sans coordonnées pour une séance sans GPS — un tapis', async () => {
    dbState.rows.activities = [
      { activityId: 42, startedAt: new Date('2026-08-14T06:00:00Z'), elapsedTimeS: 1_800 },
    ];
    dbState.rows.activity_streams = [];

    const target = await getWeatherLookupTarget(42, 7);
    expect(target?.coordinates).toBeNull();
  });

  it('lit le flux sous la même condition d’athlète que la séance', async () => {
    dbState.rows.activities = [
      { activityId: 42, startedAt: new Date('2026-08-14T06:00:00Z'), elapsedTimeS: 1_800 },
    ];
    dbState.rows.activity_streams = [];

    await getWeatherLookupTarget(42, 7);

    const streamQuery = dbState.queries.find((query) => query.table === 'activity_streams');
    expect(render(streamQuery?.join).params).toEqual([7]);
  });

  it('rend `null` pour la séance d’un autre athlète', async () => {
    dbState.rows.activities = [];

    await expect(getWeatherLookupTarget(42, 7)).resolves.toBeNull();
  });
});

describe('listActivitiesAwaitingWeather', () => {
  it('ne demande rien quand il n’y a pas de créneau', async () => {
    await expect(listActivitiesAwaitingWeather(7, 0)).resolves.toEqual([]);
    expect(dbState.queries).toEqual([]);
  });

  it('cherche d’abord les séances jamais relevées, sous cet athlète', async () => {
    dbState.rows.activities = [
      { activityId: 42, startedAt: new Date('2026-08-14T06:00:00Z'), elapsedTimeS: 3_600 },
    ];
    dbState.rows.activity_streams = [];
    dbState.rows.activity_weather = [];

    const targets = await listActivitiesAwaitingWeather(7, 20);

    expect(targets).toHaveLength(1);
    const first = dbState.queries[0];
    expect(first?.table).toBe('activities');
    // Athlète **et** absence de ligne de météo, dans la même clause.
    expect(render(first?.where).params).toEqual([7]);
    expect(render(first?.where).sql).toContain('is null');
  });

  it('complète avec les échecs de nouveau dus, athlète confronté par la jointure', async () => {
    dbState.rows.activities = [];
    dbState.rows.activity_weather = [
      { activityId: 9, startedAt: new Date('2026-08-01T06:00:00Z'), elapsedTimeS: 3_600 },
    ];
    dbState.rows.activity_streams = [];

    const targets = await listActivitiesAwaitingWeather(7, 20, new Date('2026-08-14T12:00:00Z'));

    expect(targets.map((target) => target.activityId)).toEqual([9]);
    const retry = dbState.queries.find((query) => query.table === 'activity_weather');
    expect(render(retry?.join).params).toEqual([7]);
    // Seuls les échecs sont redemandés : ni le tapis, ni le refus motivé.
    expect(render(retry?.where).params[0]).toBe('failed');
  });

  it('n’interroge pas les échecs quand les jamais-relevées remplissent le lot', async () => {
    dbState.rows.activities = [
      { activityId: 1, startedAt: new Date('2026-08-14T06:00:00Z'), elapsedTimeS: 60 },
      { activityId: 2, startedAt: new Date('2026-08-13T06:00:00Z'), elapsedTimeS: 60 },
    ];
    dbState.rows.activity_streams = [];

    await listActivitiesAwaitingWeather(7, 2);

    expect(dbState.queries.some((query) => query.table === 'activity_weather')).toBe(false);
  });
});

describe('saveActivityWeather', () => {
  const observed = {
    status: 'observed',
    source: 'forecast',
    coordinates: { latitudeDeg: 48.86, longitudeDeg: 2.35 },
    sample: {
      observedAt: new Date('2026-08-14T06:00:00Z'),
      temperatureC: 24.3,
      apparentTemperatureC: 25.1,
      precipitationMm: 0,
      windSpeedKmh: 1.3,
      windDirectionDeg: 326,
      relativeHumidityPct: 50,
      weatherCode: 1,
    },
  } as const;

  it('confronte la séance à l’athlète avant toute écriture', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await expect(saveActivityWeather(42, 7, observed)).resolves.toBe(true);
    expect(render(dbState.queries[0]?.where).params).toEqual([42, 7]);
  });

  it('n’écrit rien sur la séance d’un autre athlète, et le dit sans en dire plus', async () => {
    dbState.rows.activities = [];

    await expect(saveActivityWeather(42, 7, observed)).resolves.toBe(false);
    expect(dbState.inserts).toEqual([]);
  });

  it('écrit les mesures et compte la tentative', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityWeather(42, 7, observed);

    expect(dbState.inserts[0]?.table).toBe('activity_weather');
    expect(dbState.inserts[0]?.values).toMatchObject({
      activityId: 42,
      status: 'observed',
      source: 'forecast',
      latitudeDeg: 48.86,
      longitudeDeg: 2.35,
      temperatureC: 24.3,
      weatherCode: 1,
      attempts: 1,
      failureReason: null,
    });
  });

  it('écrit aussi quand il n’y a pas de météo — c’est la ligne qui mémorise la tentative', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityWeather(42, 7, { status: 'no-location' });

    // Sans cette ligne, la séance sur tapis reviendrait à chaque cycle.
    expect(dbState.inserts[0]?.values).toMatchObject({
      status: 'no-location',
      source: null,
      latitudeDeg: null,
      temperatureC: null,
      failureReason: null,
    });
  });

  it('garde le motif d’un échec, jamais les mesures d’une tentative précédente', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityWeather(42, 7, {
      status: 'failed',
      reason: 'WeatherUnavailableError: appel réseau impossible.',
      coordinates: { latitudeDeg: 48.86, longitudeDeg: 2.35 },
    });

    const values = dbState.inserts[0]?.values;
    expect(values).toMatchObject({
      status: 'failed',
      failureReason: 'WeatherUnavailableError: appel réseau impossible.',
      observedAt: null,
      temperatureC: null,
      windSpeedKmh: null,
    });
    // Le relevé d'une reprise remet toutes les mesures à `null` : jamais un
    // mélange entre une ancienne météo et un nouvel échec.
    expect(dbState.inserts[0]?.conflictSet).toMatchObject({ temperatureC: null });
  });

  it('incrémente le compteur en base plutôt que depuis une lecture', async () => {
    dbState.rows.activities = [{ id: 42 }];

    await saveActivityWeather(42, 7, observed);

    // `attempts + 1` côté SQL : deux tentatives concurrentes ne peuvent pas se
    // recouvrir et faire repartir le compteur en arrière.
    const attempts = dbState.inserts[0]?.conflictSet?.attempts;
    expect(attempts).toBeInstanceOf(SQL);
    expect(render(attempts instanceof SQL ? attempts : null).sql).toContain('+ 1');
  });
});
