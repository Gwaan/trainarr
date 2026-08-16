import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedFitActivity } from '@/lib/fit/parse';

import { completableFields, upsertActivityFromFit } from './activities';
import { ACTIVITIES_SESSION_UNIQUE_INDEX, activities, type Activity } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : les écritures sont enregistrées, les lectures servent
 * les jeux de lignes déclarés par le test, dans l'ordre où le DAL les demande —
 * d'abord la recherche par empreinte, puis celle par séance.
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    selectQueue: [] as unknown[][],
    returning: [] as unknown[],
    /** Erreur levée par l'insertion, pour rejouer une course en base. */
    insertError: null as unknown,
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
          returning: () =>
            dbState.insertError === null
              ? Promise.resolve(dbState.returning)
              : Promise.reject(dbState.insertError),
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

/** Ligne déjà en base, issue par défaut d'un import antérieur du même fichier. */
function existingRow(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 7,
    athleteId: 1,
    fitFileHash: PARSED.fileHash,
    name: 'Sortie longue',
    sportType: 'Run',
    startedAt: new Date('2026-08-02T06:30:00.000Z'),
    distanceM: 10_000,
    movingTimeS: 3_000,
    elapsedTimeS: 3_120,
    elevationGainM: null,
    avgHrBpm: null,
    maxHrBpm: null,
    sustainedMaxHrBpm: null,
    lthrSampleBpm: null,
    lthrSampleSource: null,
    avgPaceSecPerKm: null,
    avgCadenceSpm: null,
    bestSegmentsScannedAt: null,
    createdAt: new Date('2026-08-02T08:00:00.000Z'),
    ...overrides,
  };
}

/**
 * La même séance, arrivée sous un autre fichier : octets différents donc
 * empreinte différente — c'est le doublon que seule la clé de séance rapproche.
 */
function otherFileRow(overrides: Partial<Activity> = {}): Activity {
  return existingRow({ id: 9, fitFileHash: 'c'.repeat(64), ...overrides });
}

/**
 * Violation d'unicité telle qu'elle **remonte réellement** : drizzle enveloppe
 * l'erreur du pilote dans un `DrizzleQueryError` qui ne porte ni `code` ni nom
 * de contrainte — tout est dans la `cause`.
 */
function uniqueViolation(constraintName: string): unknown {
  return Object.assign(new Error('Failed query: insert into "activities" ...'), {
    name: 'DrizzleQueryError',
    cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint_name: constraintName,
    }),
  });
}

beforeEach(() => {
  dbState.selectQueue = [];
  dbState.returning = [{ id: 42 }];
  dbState.insertError = null;
  dbState.inserts = [];
  dbState.conflicts = [];
  dbState.updates = [];
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
  it('crée l’activité quand ni l’empreinte ni la séance ne sont connues', async () => {
    dbState.selectQueue = [[], []];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 42,
      outcome: 'created',
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
    dbState.selectQueue = [[]];

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
    dbState.selectQueue = [[]];

    await upsertActivityFromFit({ ...PARSED, name: null }, 1);

    expect(dbState.inserts[0]?.values).toMatchObject({ name: 'Course à pied' });
  });

  it('signale une mise à jour quand le même fichier a déjà été importé', async () => {
    // L'empreinte est connue et la ligne n'a aucun trou.
    dbState.selectQueue = [
      [
        existingRow({
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
      outcome: 'same-file',
    });

    // Rien à compléter : pas d'écriture du tout.
    expect(dbState.updates).toEqual([]);
    expect(dbState.inserts).toEqual([]);
  });

  it('ne réécrit que les trous quand un fichier déjà importé est redéposé', async () => {
    // La ligne porte un nom corrigé à la main et une FC déjà affinée ; seul le
    // dénivelé manque. Redéposer le fichier ne doit rien écraser d'autre.
    dbState.selectQueue = [
      [
        existingRow({
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
      outcome: 'same-file',
    });

    expect(dbState.inserts).toEqual([]);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]?.table).toBe(activities);
    expect(dbState.updates[0]?.values).toEqual({ elevationGainM: 120.5 });
  });

  it('privilégie l’empreinte sur la séance quand les deux correspondent', async () => {
    // Deux lignes pourraient accueillir cet import ; celle qui vient du *même*
    // fichier gagne, l'autre n'est même pas consultée.
    dbState.selectQueue = [[existingRow()], [otherFileRow()]];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 7,
      outcome: 'same-file',
    });
  });

  it('rapproche la même séance venue d’un autre fichier, sans toucher l’empreinte', async () => {
    // Le doublon amont : même athlète, même sport, même instant, autres octets.
    dbState.selectQueue = [[], [otherFileRow({ avgHrBpm: 152 })]];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 9,
      outcome: 'same-session',
    });

    // Aucune insertion : la séance existait déjà, sous une autre empreinte.
    expect(dbState.inserts).toEqual([]);
    expect(dbState.updates).toHaveLength(1);
    // Seuls les trous sont comblés, et `fitFileHash` n'en fait jamais partie :
    // le premier fichier importé reste l'origine canonique de la ligne.
    expect(dbState.updates[0]?.values).toEqual({
      elevationGainM: 120.5,
      maxHrBpm: 171,
      avgPaceSecPerKm: 300,
      avgCadenceSpm: 176.4,
    });
  });

  it('retient la séance la plus proche en temps parmi plusieurs candidates', async () => {
    dbState.selectQueue = [
      [],
      [
        otherFileRow({ id: 9, startedAt: new Date('2026-08-02T06:30:40.000Z') }),
        otherFileRow({ id: 11, startedAt: new Date('2026-08-02T06:30:05.000Z') }),
        otherFileRow({ id: 13, startedAt: new Date('2026-08-02T06:29:30.000Z') }),
      ],
    ];

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toMatchObject({
      activityId: 11,
      outcome: 'same-session',
    });
  });

  it('rattrape la course perdue sur l’index de séance et fusionne', async () => {
    // Aucune correspondance à la lecture, mais une ingestion concurrente a
    // inséré la séance entre-temps : c'est la contrainte qui tranche.
    dbState.selectQueue = [[], [], [otherFileRow()]];
    dbState.insertError = uniqueViolation(ACTIVITIES_SESSION_UNIQUE_INDEX);

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toEqual({
      activityId: 9,
      outcome: 'same-session',
    });

    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]?.values).toEqual({
      elevationGainM: 120.5,
      avgHrBpm: 149,
      maxHrBpm: 171,
      avgPaceSecPerKm: 300,
      avgCadenceSpm: 176.4,
    });
  });

  it('rattrape la course même si le pilote n’emballe pas son erreur', async () => {
    // Robustesse aux deux formes : l'erreur nue doit rester reconnue si une
    // version de drizzle cesse d'envelopper.
    dbState.selectQueue = [[], [], [otherFileRow()]];
    dbState.insertError = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: ACTIVITIES_SESSION_UNIQUE_INDEX,
    });

    await expect(upsertActivityFromFit(PARSED, 1)).resolves.toMatchObject({
      activityId: 9,
      outcome: 'same-session',
    });
  });

  it('n’absorbe pas une violation d’unicité venue d’une autre contrainte', async () => {
    dbState.selectQueue = [[], []];
    dbState.insertError = uniqueViolation('activities_fit_file_hash_unique');

    await expect(upsertActivityFromFit(PARSED, 1)).rejects.toThrowError(/Failed query/);
  });

  it('échoue explicitement si la course perdue ne laisse aucune séance derrière', async () => {
    // L'index et la recherche partagent les mêmes critères : ce qu'il rejette
    // est normalement toujours rapprochable. Reste le cas où la transaction
    // concurrente a été annulée entre-temps — jamais de silence.
    dbState.selectQueue = [[], [], []];
    dbState.insertError = uniqueViolation(ACTIVITIES_SESSION_UNIQUE_INDEX);

    await expect(upsertActivityFromFit(PARSED, 1)).rejects.toThrowError(/Course perdue/);
  });

  it('n’invente pas d’allure quand la distance est nulle', async () => {
    dbState.selectQueue = [[]];

    await upsertActivityFromFit({ ...PARSED, distanceM: 0 }, 1);

    expect(dbState.inserts[0]?.values).toMatchObject({ avgPaceSecPerKm: null });
  });

  it('échoue explicitement si l’écriture ne retourne aucune ligne', async () => {
    dbState.selectQueue = [[]];
    dbState.returning = [];

    await expect(upsertActivityFromFit(PARSED, 1)).rejects.toThrowError(/aaaa/);
  });
});
