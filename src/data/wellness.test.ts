import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  emptyWellnessSummary,
  getWellnessReadingDay,
  latestMeasure,
  listWellnessDays,
  saveWellnessDays,
  selectWellnessSummary,
  setWellnessReadingDay,
  type WellnessDayDto,
} from './wellness';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

// Aucune base : le client est remplacé par une chaîne de requête factice, qui
// enregistre ce qu'on lui demande.
const { queryState } = vi.hoisted(() => ({
  queryState: {
    /** Résultats servis aux `SELECT`, dans l'ordre où ils sont demandés. */
    selects: [] as unknown[][],
    /** Chaque `INSERT … ON CONFLICT` émis : ses valeurs et sa clause de mise à jour. */
    inserts: [] as { values: unknown; conflict: unknown }[],
    /** Chaque `UPDATE` émis : ses valeurs. */
    updates: [] as { values: unknown }[],
  },
}));

vi.mock('./db/client', () => {
  /** Une chaîne `select()` **attendable** : certaines lectures s'arrêtent à `where`. */
  type SelectChain = {
    from: () => SelectChain;
    where: () => SelectChain;
    orderBy: () => SelectChain;
    limit: () => SelectChain;
    then: (
      resolve: (rows: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise<unknown>;
  };

  const selectChain: SelectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => selectChain,
    then: (resolve, reject) =>
      Promise.resolve(queryState.selects.shift() ?? []).then(resolve, reject),
  };

  return {
    db: {
      select: () => selectChain,
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoUpdate: (conflict: unknown) => {
            queryState.inserts.push({ values, conflict });
            return Promise.resolve([]);
          },
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: () => {
            queryState.updates.push({ values });
            return Promise.resolve([]);
          },
        }),
      }),
    },
  };
});

const dialect = new PgDialect();

/** Une expression SQL capturée, telle que Postgres la recevrait. */
function render(value: unknown): string {
  if (!(value instanceof SQL)) throw new Error('Expression SQL absente ou inattendue.');
  return dialect.sqlToQuery(value).sql;
}

/** Une journée vide, dont chaque test ne renseigne que ce qu'il éprouve. */
function day(date: string, measures: Partial<WellnessDayDto> = {}): WellnessDayDto {
  return {
    day: date,
    restingHrBpm: null,
    hrvRmssdMs: null,
    sleepTimeS: null,
    sleepScore: null,
    avgSleepingHrBpm: null,
    weightKg: null,
    ...measures,
  };
}

beforeEach(() => {
  queryState.selects = [];
  queryState.inserts = [];
  queryState.updates = [];
  vi.clearAllMocks();
});

describe('saveWellnessDays', () => {
  it('n’écrit rien quand il n’y a rien à écrire', async () => {
    expect(await saveWellnessDays(7, [])).toBe(0);
    expect(queryState.inserts).toHaveLength(0);
  });

  it('écrit chaque journée sous son athlète, mesures absentes comprises', async () => {
    const written = await saveWellnessDays(
      7,
      [
        {
          day: '2026-08-13',
          restingHrBpm: 47,
          hrvRmssdMs: 63,
          sleepTimeS: null,
          sleepScore: null,
          avgSleepingHrBpm: null,
          weightKg: null,
        },
      ],
      new Date('2026-08-13T07:30:00Z'),
    );

    expect(written).toBe(1);
    expect(queryState.inserts).toHaveLength(1);
    expect(queryState.inserts[0].values).toEqual([
      expect.objectContaining({
        athleteId: 7,
        day: '2026-08-13',
        restingHrBpm: 47,
        hrvRmssdMs: 63,
        // Une mesure absente est `null`, jamais `0`.
        sleepTimeS: null,
        weightKg: null,
      }),
    ]);
  });

  it('complète une journée sans jamais remplacer une valeur connue par un trou', async () => {
    await saveWellnessDays(7, [
      {
        day: '2026-08-13',
        restingHrBpm: 47,
        hrvRmssdMs: null,
        sleepTimeS: null,
        sleepScore: null,
        avgSleepingHrBpm: null,
        weightKg: null,
      },
    ]);

    const conflict = queryState.inserts[0].conflict as { set: Record<string, unknown> };
    // `coalesce(nouvelle, ancienne)` sur chaque mesure : c'est ce qui permet
    // qu'un sommeil arrivé en retard complète une FC de repos déjà écrite.
    expect(render(conflict.set.sleepTimeS)).toContain('coalesce');
    expect(render(conflict.set.sleepTimeS)).toContain('excluded.sleep_time_s');
    expect(render(conflict.set.hrvRmssdMs)).toContain('excluded.hrv_rmssd_ms');
  });
});

describe('le marqueur du relevé', () => {
  it('rend `null` quand aucun relevé n’a jamais abouti', async () => {
    queryState.selects.push([{ readingDay: null }]);

    expect(await getWellnessReadingDay(7)).toBeNull();
  });

  it('rend `null` quand l’athlète n’existe pas', async () => {
    queryState.selects.push([]);

    expect(await getWellnessReadingDay(7)).toBeNull();
  });

  it('rend le marqueur mémorisé', async () => {
    queryState.selects.push([{ readingDay: '2026-08-12' }]);

    expect(await getWellnessReadingDay(7)).toBe('2026-08-12');
  });

  it('écrit le marqueur du jour', async () => {
    await setWellnessReadingDay(7, '2026-08-13');

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toMatchObject({ wellnessReadingDay: '2026-08-13' });
  });
});

describe('latestMeasure', () => {
  it('prend la première journée qui porte la mesure — les journées sont rendues du plus récent au plus ancien', () => {
    const days = [
      day('2026-08-13', { restingHrBpm: 47 }),
      day('2026-08-12', { restingHrBpm: 48 }),
    ];

    expect(latestMeasure(days, (entry) => entry.restingHrBpm)).toEqual({
      value: 47,
      day: '2026-08-13',
    });
  });

  it('cherche chaque mesure séparément : une absence n’en emporte aucune autre', () => {
    // La nuit d'hier a été portée sans ceinture : la HRV manque, la FC de repos
    // est là. Dater les deux du même jour jetterait la plus récente.
    const days = [
      day('2026-08-13', { restingHrBpm: 47 }),
      day('2026-08-11', { restingHrBpm: 49, hrvRmssdMs: 61 }),
    ];

    expect(latestMeasure(days, (entry) => entry.restingHrBpm)?.day).toBe('2026-08-13');
    expect(latestMeasure(days, (entry) => entry.hrvRmssdMs)?.day).toBe('2026-08-11');
  });

  it('rend `null` quand aucune journée ne porte la mesure', () => {
    expect(latestMeasure([day('2026-08-13')], (entry) => entry.weightKg)).toBeNull();
  });
});

describe('selectWellnessSummary', () => {
  it('rend la dernière valeur de chaque mesure, avec son jour', async () => {
    queryState.selects.push([
      day('2026-08-13', { restingHrBpm: 47, sleepTimeS: 25_800 }),
      day('2026-08-11', { restingHrBpm: 49, hrvRmssdMs: 61 }),
    ]);

    expect(await selectWellnessSummary(7, '2026-08-13', '2026-07-15')).toEqual({
      today: '2026-08-13',
      restingHr: { value: 47, day: '2026-08-13' },
      hrv: { value: 61, day: '2026-08-11' },
      sleep: { value: 25_800, day: '2026-08-13' },
    });
  });

  it('rend un résumé entièrement absent plutôt que des zéros', async () => {
    queryState.selects.push([]);

    expect(await selectWellnessSummary(7, '2026-08-13', '2026-07-15')).toEqual(
      emptyWellnessSummary('2026-08-13'),
    );
  });
});

describe('listWellnessDays', () => {
  it('rend les journées telles quelles, trous compris', async () => {
    const rows = [day('2026-08-12'), day('2026-08-13', { restingHrBpm: 47 })];
    queryState.selects.push(rows);

    expect(await listWellnessDays(7, '2026-08-01', '2026-08-13')).toEqual(rows);
  });
});
