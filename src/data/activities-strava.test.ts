import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StravaActivity, StravaStreamSet } from '@/lib/strava/client';

import {
  findActivityIdsWithoutStreams,
  findKnownStravaIds,
  saveActivityStreams,
  upsertActivityFromStrava,
} from './activities';
import { activities, activityStreams } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : les écritures sont enregistrées, les lectures servent
 * les lignes déclarées par le test.
 *
 * Ce fichier couvre les écritures de la sync Strava ; les lectures et les DTOs
 * sont testés dans `activities.test.ts`.
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    selectRows: [] as unknown[],
    returning: [] as unknown[],
    inserts: [] as Array<{ table: unknown; values: unknown }>,
    conflicts: [] as unknown[],
    deletes: [] as unknown[],
    selectWheres: [] as unknown[],
  },
}));

vi.mock('./db/client', () => {
  type InsertChain = PromiseLike<unknown> & {
    onConflictDoUpdate: (config: unknown) => InsertChain;
    returning: () => Promise<unknown[]>;
  };

  const insertInto = (table: unknown) => ({
    values: (values: unknown) => {
      dbState.inserts.push({ table, values });
      const chain: InsertChain = {
        onConflictDoUpdate: (config) => {
          dbState.conflicts.push(config);
          return chain;
        },
        returning: () => Promise.resolve(dbState.returning),
        then: (onFulfilled, onRejected) => Promise.resolve(undefined).then(onFulfilled, onRejected),
      };
      return chain;
    },
  });

  const deleteFrom = (table: unknown) => ({
    where: (clause: unknown) => {
      dbState.deletes.push({ table, clause });
      return Promise.resolve();
    },
  });

  type SelectChain = PromiseLike<unknown[]> & { where: (clause: unknown) => SelectChain };

  const selectChain = (): SelectChain => {
    const chain: SelectChain = {
      where: (clause) => {
        dbState.selectWheres.push(clause);
        return chain;
      },
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.selectRows).then(onFulfilled, onRejected),
    };
    return chain;
  };

  const db = {
    select: () => ({ from: selectChain }),
    selectDistinct: () => ({ from: selectChain }),
    insert: insertInto,
    delete: deleteFrom,
    transaction: (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ insert: insertInto, delete: deleteFrom }),
  };

  return { db };
});

/** Activité telle que la produit `@/lib/strava/client` (déjà validée par Zod). */
const STRAVA_ACTIVITY: StravaActivity = {
  id: 15_123_456_789,
  athleteStravaId: 987_654,
  name: 'Sortie longue',
  sportType: 'Run',
  startedAt: new Date('2026-08-02T06:30:00.000Z'),
  distanceM: 21_097.5,
  movingTimeS: 6_120,
  elapsedTimeS: 6_300,
  elevationGainM: 187.4,
  avgHrBpm: 152.4,
  maxHrBpm: 176.6,
  avgCadenceSpm: 87.5,
};

beforeEach(() => {
  dbState.selectRows = [];
  dbState.returning = [{ id: 42 }];
  dbState.inserts = [];
  dbState.conflicts = [];
  dbState.deletes = [];
  dbState.selectWheres = [];
});

describe('upsertActivityFromStrava', () => {
  it('retourne l’id local de la ligne écrite', async () => {
    await expect(upsertActivityFromStrava(STRAVA_ACTIVITY, 1)).resolves.toBe(42);
  });

  it('mappe les champs Strava sur les colonnes du schéma', async () => {
    await upsertActivityFromStrava(STRAVA_ACTIVITY, 1);

    const insert = dbState.inserts[0];
    expect(insert?.table).toBe(activities);
    expect(insert?.values).toEqual({
      athleteId: 1,
      stravaId: 15_123_456_789,
      name: 'Sortie longue',
      sportType: 'Run',
      startedAt: new Date('2026-08-02T06:30:00.000Z'),
      distanceM: 21_097.5,
      movingTimeS: 6_120,
      elapsedTimeS: 6_300,
      elevationGainM: 187.4,
      // Colonnes entières : les moyennes flottantes de Strava sont arrondies.
      avgHrBpm: 152,
      maxHrBpm: 177,
      // 6 120 s pour 21,0975 km → 290,08 s/km.
      avgPaceSecPerKm: 6_120 / 21.0975,
      avgCadenceSpm: 87.5,
    });
  });

  it('est idempotent : conflit sur `strava_id` → mise à jour de la ligne', async () => {
    await upsertActivityFromStrava(STRAVA_ACTIVITY, 1);

    const conflict = dbState.conflicts[0] as { target: unknown; set: Record<string, unknown> };
    expect(conflict.target).toBe(activities.stravaId);
    // Ni `stravaId` ni `athleteId` ne sont réécrits : la ligne reste la même.
    expect(Object.keys(conflict.set).sort()).toEqual([
      'avgCadenceSpm',
      'avgHrBpm',
      'avgPaceSecPerKm',
      'distanceM',
      'elapsedTimeS',
      'elevationGainM',
      'maxHrBpm',
      'movingTimeS',
      'name',
      'sportType',
      'startedAt',
    ]);
  });

  it('n’invente pas d’allure quand la distance est nulle', async () => {
    await upsertActivityFromStrava({ ...STRAVA_ACTIVITY, distanceM: 0 }, 1);

    expect(dbState.inserts[0]?.values).toMatchObject({ avgPaceSecPerKm: null });
  });

  it('conserve les métriques absentes en `null`', async () => {
    await upsertActivityFromStrava(
      { ...STRAVA_ACTIVITY, avgHrBpm: null, maxHrBpm: null, avgCadenceSpm: null },
      1,
    );

    expect(dbState.inserts[0]?.values).toMatchObject({
      avgHrBpm: null,
      maxHrBpm: null,
      avgCadenceSpm: null,
    });
  });

  it('échoue explicitement si l’écriture ne retourne aucune ligne', async () => {
    dbState.returning = [];

    await expect(upsertActivityFromStrava(STRAVA_ACTIVITY, 1)).rejects.toThrowError(/15123456789/);
  });
});

describe('findKnownStravaIds', () => {
  it('retourne les identifiants déjà présents en base', async () => {
    dbState.selectRows = [{ stravaId: 1 }, { stravaId: 3 }];

    const known = await findKnownStravaIds([1, 2, 3]);

    expect([...known]).toEqual([1, 3]);
  });

  it('n’interroge pas la base pour une liste vide', async () => {
    const known = await findKnownStravaIds([]);

    expect(known.size).toBe(0);
    expect(dbState.selectWheres).toEqual([]);
  });
});

describe('findActivityIdsWithoutStreams', () => {
  it('retourne les activités dont aucune série n’est en base', async () => {
    dbState.selectRows = [{ activityId: 1 }, { activityId: 3 }];

    const missing = await findActivityIdsWithoutStreams([1, 2, 3, 4]);

    expect([...missing]).toEqual([2, 4]);
  });

  it('n’interroge pas la base pour une liste vide', async () => {
    const missing = await findActivityIdsWithoutStreams([]);

    expect(missing.size).toBe(0);
    expect(dbState.selectWheres).toEqual([]);
  });
});

describe('saveActivityStreams', () => {
  const STREAMS: StravaStreamSet = {
    time: [0, 1, 2],
    heartrate: [120, 130, 140],
    velocity: [3.1, 3.2, 3.3],
    latlng: [[48.85, 2.35]],
  };

  it('upsert sur (activity_id, type) plutôt que de supprimer puis réinsérer', async () => {
    // Deux imports concurrents de la même activité doivent converger vers une
    // seule ligne par type : c'est l'index unique du schéma qui l'impose, et
    // l'`ON CONFLICT` qui l'exploite.
    await saveActivityStreams(42, STREAMS);

    expect(dbState.inserts[0]?.table).toBe(activityStreams);
    const conflict = dbState.conflicts[0] as { target: unknown; set: Record<string, unknown> };
    expect(conflict.target).toEqual([activityStreams.activityId, activityStreams.type]);
    expect(Object.keys(conflict.set)).toEqual(['data']);
  });

  it('purge les types absents de la nouvelle réponse, après l’upsert', async () => {
    await saveActivityStreams(42, STREAMS);

    expect(dbState.deletes).toHaveLength(1);
    expect((dbState.deletes[0] as { table: unknown }).table).toBe(activityStreams);
  });

  it('écrit une ligne par série, typée comme le schéma', async () => {
    await saveActivityStreams(42, STREAMS);

    expect(dbState.inserts[0]?.values).toEqual([
      { activityId: 42, type: 'time', data: [0, 1, 2] },
      { activityId: 42, type: 'heartrate', data: [120, 130, 140] },
      { activityId: 42, type: 'velocity', data: [3.1, 3.2, 3.3] },
      { activityId: 42, type: 'latlng', data: [[48.85, 2.35]] },
    ]);
  });

  it('ignore les séries absentes ou vides', async () => {
    await saveActivityStreams(42, { time: [], heartrate: [130] });

    expect(dbState.inserts[0]?.values).toEqual([
      { activityId: 42, type: 'heartrate', data: [130] },
    ]);
  });

  it('purge quand même les anciens streams si la nouvelle réponse est vide', async () => {
    await saveActivityStreams(42, {});

    expect(dbState.deletes).toHaveLength(1);
    expect(dbState.inserts).toEqual([]);
  });
});
