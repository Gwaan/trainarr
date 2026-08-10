import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedFitActivity } from '@/lib/fit/parse';
import type { StravaActivity } from '@/lib/strava/client';

import {
  completableFields,
  isSameOuting,
  upsertActivityFromFit,
  upsertActivityFromStrava,
} from './activities';
import { activities, type Activity } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : les écritures sont enregistrées, les lectures servent
 * les jeux de lignes déclarés par le test, dans l'ordre où le code les demande
 * (1. recherche par empreinte, 2. candidats au rapprochement croisé).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    selectQueue: [] as unknown[][],
    returning: [] as unknown[],
    inserts: [] as Array<{ table: unknown; values: unknown }>,
    conflicts: [] as unknown[],
    updates: [] as Array<{ table: unknown; values: unknown }>,
  },
}));

vi.mock('./db/client', () => {
  type InsertChain = PromiseLike<unknown> & {
    onConflictDoUpdate: (config: unknown) => InsertChain;
    returning: () => Promise<unknown[]>;
  };

  type SelectChain = PromiseLike<unknown[]> & {
    where: (clause: unknown) => SelectChain;
    limit: (count: number) => SelectChain;
  };

  const selectChain = (): SelectChain => {
    const chain: SelectChain = {
      where: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.selectQueue.shift() ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  const db = {
    select: () => ({ from: selectChain }),
    selectDistinct: () => ({ from: selectChain }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        dbState.inserts.push({ table, values });
        const chain: InsertChain = {
          onConflictDoUpdate: (config) => {
            dbState.conflicts.push(config);
            return chain;
          },
          returning: () => Promise.resolve(dbState.returning),
          then: (onFulfilled, onRejected) =>
            Promise.resolve(undefined).then(onFulfilled, onRejected),
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => {
        dbState.updates.push({ table, values });
        return { where: () => Promise.resolve() };
      },
    }),
  };

  return { db };
});

/** Activité telle que la produit `@/lib/fit/parse`. */
const PARSED: ParsedFitActivity = {
  fileHash: 'a'.repeat(64),
  name: 'Sortie longue',
  sportType: 'Run',
  startedAt: new Date('2026-08-02T06:30:00.000Z'),
  distanceM: 10_000,
  movingTimeS: 3_000,
  elapsedTimeS: 3_120,
  elevationGainM: 120.5,
  avgHrBpm: 148.6,
  maxHrBpm: 171.2,
  avgCadenceSpm: 176.4,
  streams: { time: [0, 1], heartrate: [130, 140] },
  warnings: [],
};

/** Ligne Strava déjà en base, décrivant la même sortie. */
function stravaRow(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 7,
    athleteId: 1,
    stravaId: 15_123_456_789,
    fitFileHash: null,
    name: 'Sortie longue',
    sportType: 'Run',
    startedAt: new Date('2026-08-02T06:30:00.000Z'),
    distanceM: 10_000,
    movingTimeS: 3_000,
    elapsedTimeS: 3_120,
    elevationGainM: null,
    avgHrBpm: null,
    maxHrBpm: null,
    avgPaceSecPerKm: null,
    avgCadenceSpm: null,
    createdAt: new Date('2026-08-02T08:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  dbState.selectQueue = [];
  dbState.returning = [{ id: 42 }];
  dbState.inserts = [];
  dbState.conflicts = [];
  dbState.updates = [];
});

describe('isSameOuting', () => {
  const incoming = { startedAt: new Date('2026-08-02T06:30:00.000Z'), distanceM: 10_000 };

  it('accepte un écart de départ de 60 s exactement (borne incluse)', () => {
    expect(
      isSameOuting({ startedAt: new Date('2026-08-02T06:31:00.000Z'), distanceM: 10_000 }, incoming),
    ).toBe(true);
    expect(
      isSameOuting({ startedAt: new Date('2026-08-02T06:29:00.000Z'), distanceM: 10_000 }, incoming),
    ).toBe(true);
  });

  it('refuse au-delà de 60 s', () => {
    expect(
      isSameOuting(
        { startedAt: new Date('2026-08-02T06:31:00.001Z'), distanceM: 10_000 },
        incoming,
      ),
    ).toBe(false);
  });

  it('accepte un écart de distance de 2 % exactement (borne incluse)', () => {
    expect(isSameOuting({ ...incoming, distanceM: 10_200 }, incoming)).toBe(true);
    expect(isSameOuting({ ...incoming, distanceM: 9_800 }, incoming)).toBe(true);
  });

  it('refuse au-delà de 2 %', () => {
    expect(isSameOuting({ ...incoming, distanceM: 10_201 }, incoming)).toBe(false);
    expect(isSameOuting({ ...incoming, distanceM: 9_799 }, incoming)).toBe(false);
  });

  it('exige les deux critères à la fois', () => {
    expect(
      isSameOuting(
        { startedAt: new Date('2026-08-02T06:30:30.000Z'), distanceM: 12_000 },
        incoming,
      ),
    ).toBe(false);
  });
});

describe('completableFields', () => {
  const incoming = {
    elevationGainM: 120,
    avgHrBpm: 149,
    maxHrBpm: 171,
    avgPaceSecPerKm: 300,
    avgCadenceSpm: 176,
  };

  it('ne retient que les champs manquants', () => {
    expect(
      completableFields(
        { ...incoming, avgHrBpm: null, avgCadenceSpm: null, elevationGainM: 90 },
        incoming,
      ),
    ).toEqual({ avgHrBpm: 149, avgCadenceSpm: 176 });
  });

  it('n’écrase jamais une valeur déjà en base', () => {
    expect(completableFields({ ...incoming, avgHrBpm: 200 }, incoming)).toEqual({});
  });

  it('laisse le trou ouvert si le FIT n’a pas la donnée non plus', () => {
    const empty = {
      elevationGainM: null,
      avgHrBpm: null,
      maxHrBpm: null,
      avgPaceSecPerKm: null,
      avgCadenceSpm: null,
    };
    expect(completableFields(empty, empty)).toEqual({});
  });
});

describe('upsertActivityFromFit', () => {
  it('crée l’activité quand rien ne lui correspond en base', async () => {
    dbState.selectQueue = [[], []];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 42,
      created: true,
      merged: false,
    });

    const insert = dbState.inserts[0];
    expect(insert?.table).toBe(activities);
    expect(insert?.values).toEqual({
      athleteId: 1,
      fitFileHash: PARSED.fileHash,
      name: 'Sortie longue',
      sportType: 'Run',
      startedAt: new Date('2026-08-02T06:30:00.000Z'),
      distanceM: 10_000,
      movingTimeS: 3_000,
      elapsedTimeS: 3_120,
      elevationGainM: 120.5,
      // Colonnes entières : les moyennes du FIT sont arrondies.
      avgHrBpm: 149,
      maxHrBpm: 171,
      // 3 000 s pour 10 km.
      avgPaceSecPerKm: 300,
      avgCadenceSpm: 176.4,
    });
    expect(dbState.updates).toEqual([]);
  });

  it('est idempotent : conflit sur `fit_file_hash` → complète les trous, sans écraser', async () => {
    dbState.selectQueue = [[], []];

    await upsertActivityFromFit(PARSED, 1);

    const conflict = dbState.conflicts[0] as { target: unknown; set: Record<string, unknown> };
    expect(conflict.target).toBe(activities.fitFileHash);
    // Course entre deux imports du même fichier : les colonnes obligatoires (nom
    // en tête) ne sont pas réécrites, les nullables le sont par `coalesce`.
    expect(Object.keys(conflict.set).sort()).toEqual([
      'avgCadenceSpm',
      'avgHrBpm',
      'avgPaceSecPerKm',
      'elevationGainM',
      'maxHrBpm',
    ]);
  });

  it('nomme la sortie en français quand le fichier ne porte aucun titre', async () => {
    dbState.selectQueue = [[], []];

    await upsertActivityFromFit({ ...PARSED, name: null }, 1);

    expect(dbState.inserts[0]?.values).toMatchObject({ name: 'Course à pied' });
  });

  it('signale une mise à jour quand le même fichier a déjà été importé', async () => {
    // Première lecture : l'empreinte est connue, la ligne n'a aucun trou.
    dbState.selectQueue = [
      [
        stravaRow({
          fitFileHash: PARSED.fileHash,
          elevationGainM: 120.5,
          avgHrBpm: 149,
          maxHrBpm: 171,
          avgPaceSecPerKm: 300,
          avgCadenceSpm: 176.4,
        }),
      ],
    ];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 7,
      created: false,
      merged: false,
    });

    // Aucun rapprochement croisé n'est tenté : la file de lectures est intacte.
    expect(dbState.selectQueue).toEqual([]);
    // Rien à compléter : pas d'écriture du tout.
    expect(dbState.updates).toEqual([]);
    expect(dbState.inserts).toEqual([]);
  });

  it('ne réécrit que les trous quand un fichier déjà fusionné est redéposé', async () => {
    // La ligne porte le nom donné par Strava et une FC déjà affinée ; seul le
    // dénivelé manque. Redéposer le fichier ne doit rien écraser d'autre.
    dbState.selectQueue = [
      [
        stravaRow({
          fitFileHash: PARSED.fileHash,
          name: 'Sortie longue du dimanche',
          avgHrBpm: 152,
          maxHrBpm: 174,
          avgPaceSecPerKm: 299.4,
          avgCadenceSpm: 178,
        }),
      ],
    ];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 7,
      created: false,
      merged: false,
    });

    expect(dbState.inserts).toEqual([]);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]?.values).toEqual({ elevationGainM: 120.5 });
  });

  it('rapproche le FIT d’une activité Strava jumelle plutôt que de la dupliquer', async () => {
    dbState.selectQueue = [[], [stravaRow()]];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 7,
      created: false,
      merged: true,
    });

    // Aucune insertion : pas de doublon.
    expect(dbState.inserts).toEqual([]);
    const update = dbState.updates[0];
    expect(update?.table).toBe(activities);
    expect(update?.values).toEqual({
      fitFileHash: PARSED.fileHash,
      elevationGainM: 120.5,
      avgHrBpm: 149,
      maxHrBpm: 171,
      avgPaceSecPerKm: 300,
      avgCadenceSpm: 176.4,
    });
  });

  it('rapproche aux bornes : +60 s de décalage et +2 % de distance', async () => {
    dbState.selectQueue = [
      [],
      [stravaRow({ startedAt: new Date('2026-08-02T06:31:00.000Z'), distanceM: 10_200 })],
    ];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toMatchObject({ merged: true });
  });

  it('ne rapproche pas au-delà des bornes : la sortie est créée à part', async () => {
    dbState.selectQueue = [
      [],
      // Dans la fenêtre SQL (±60 s) mais 3 % plus longue : ce n'est pas la même sortie.
      [stravaRow({ distanceM: 10_300 })],
    ];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 42,
      created: true,
      merged: false,
    });
    expect(dbState.updates).toEqual([]);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('n’écrase pas les champs déjà renseignés de l’activité rapprochée', async () => {
    dbState.selectQueue = [
      [],
      [stravaRow({ avgHrBpm: 152, avgPaceSecPerKm: 299.4, elevationGainM: 118 })],
    ];

    await upsertActivityFromFit(PARSED, 1);

    expect(dbState.updates[0]?.values).toEqual({
      fitFileHash: PARSED.fileHash,
      maxHrBpm: 171,
      avgCadenceSpm: 176.4,
    });
  });

  it('n’invente pas d’allure quand la distance est nulle', async () => {
    dbState.selectQueue = [[], []];

    await upsertActivityFromFit({ ...PARSED, distanceM: 0 }, 1);

    expect(dbState.inserts[0]?.values).toMatchObject({ avgPaceSecPerKm: null });
  });

  it('échoue explicitement si l’écriture ne retourne aucune ligne', async () => {
    dbState.selectQueue = [[], []];
    dbState.returning = [];

    await expect(upsertActivityFromFit(PARSED, 1)).rejects.toThrowError(/aaaa/);
  });
});

/*
 * Commutativité des deux canaux.
 *
 * La même sortie arrive par le FIT (dépôt immédiat de la montre) et par Strava
 * (webhook quelques minutes plus tard), dans un ordre qui n'est pas garanti :
 * une seule ligne doit en sortir, portant les mêmes mesures des deux côtés.
 *
 * Limite assumée de la politique « ne combler que les trous » : les colonnes que
 * les deux canaux renseignent **avec des valeurs différentes** (la distance, et
 * donc l'allure, que Strava recalcule depuis les points GPS) gardent celle du
 * canal qui a inséré la ligne. Les métriques physio, elles, viennent du même
 * enregistrement de la montre des deux côtés : elles concordent.
 */
describe('rapprochement croisé — l’ordre d’arrivée ne change pas l’état final', () => {
  /**
   * La même sortie vue par Strava. Les mesures physio sont celles du fichier
   * (Strava les tient de la même montre) ; le départ et la distance, eux, sont
   * recalculés depuis les points GPS — d'où le léger écart, dans les tolérances.
   */
  const STRAVA: StravaActivity = {
    id: 15_123_456_789,
    athleteStravaId: 987_654,
    name: 'Sortie longue',
    sportType: 'Run',
    startedAt: new Date('2026-08-02T06:30:12.000Z'),
    distanceM: 10_040,
    movingTimeS: 3_000,
    elapsedTimeS: 3_120,
    elevationGainM: 120.5,
    avgHrBpm: 148.6,
    maxHrBpm: 171.2,
    // Strava ne renvoie pas toujours la cadence : ce trou-là, le FIT le comble.
    avgCadenceSpm: null,
  };

  /** Ligne telle qu'insérée puis mise à jour, à partir des appels enregistrés. */
  function writtenRow(): Record<string, unknown> {
    const inserted = dbState.inserts[0]?.values;
    expect(inserted).toBeDefined();

    return Object.assign(
      { id: 42 },
      inserted,
      ...dbState.updates.map((update) => update.values),
    ) as Record<string, unknown>;
  }

  /** Le FIT d'abord, le webhook Strava ensuite. */
  async function fitThenStrava(): Promise<Record<string, unknown>> {
    dbState.selectQueue = [[], []];
    await upsertActivityFromFit(PARSED, 1);

    const row = { ...stravaRow(), ...writtenRow(), stravaId: null } as unknown as Activity;
    const insertedByFit = dbState.inserts[0]?.values;
    dbState.inserts = [];
    dbState.updates = [];

    dbState.selectQueue = [[], [row]];
    const result = await upsertActivityFromStrava(STRAVA, 1);
    expect(result.merged).toBe(true);

    return Object.assign(
      { id: 42 },
      insertedByFit,
      ...dbState.updates.map((update) => update.values),
    ) as Record<string, unknown>;
  }

  /** Le webhook Strava d'abord, le FIT ensuite. */
  async function stravaThenFit(): Promise<Record<string, unknown>> {
    dbState.selectQueue = [[], []];
    await upsertActivityFromStrava(STRAVA, 1);

    const row = { ...stravaRow(), ...writtenRow(), fitFileHash: null } as unknown as Activity;
    const insertedByStrava = dbState.inserts[0]?.values;
    dbState.inserts = [];
    dbState.updates = [];

    dbState.selectQueue = [[], [row]];
    const result = await upsertActivityFromFit(PARSED, 1);
    expect(result.merged).toBe(true);

    return Object.assign(
      { id: 42 },
      insertedByStrava,
      ...dbState.updates.map((update) => update.values),
    ) as Record<string, unknown>;
  }

  it('aboutit aux mêmes métriques dans les deux sens', async () => {
    const first = await fitThenStrava();

    dbState.inserts = [];
    dbState.updates = [];
    const second = await stravaThenFit();

    // Les deux lignes portent les deux canaux…
    for (const row of [first, second]) {
      expect(row.stravaId).toBe(STRAVA.id);
      expect(row.fitFileHash).toBe(PARSED.fileHash);
    }

    // …et les mêmes mesures physio, quel que soit le canal qui a inséré.
    const metrics = (row: Record<string, unknown>) => ({
      elevationGainM: row.elevationGainM,
      avgHrBpm: row.avgHrBpm,
      maxHrBpm: row.maxHrBpm,
      avgCadenceSpm: row.avgCadenceSpm,
    });

    expect(metrics(first)).toEqual(metrics(second));
    // La cadence n'est portée que par le FIT : elle survit dans les deux sens.
    expect(first.avgCadenceSpm).toBe(176.4);
    expect(second.avgCadenceSpm).toBe(176.4);
  });

  it('ne crée jamais de doublon, quel que soit l’ordre', async () => {
    await fitThenStrava();
    expect(dbState.inserts).toEqual([]);

    dbState.inserts = [];
    await stravaThenFit();
    expect(dbState.inserts).toEqual([]);
  });
});
