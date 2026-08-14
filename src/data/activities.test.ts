import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVITY_WEEK_PAGE_LIMITS,
  getActivityById,
  groupActivitiesByWeek,
  listActivityWeekPage,
  listRecentActivities,
  toActivityDetailDto,
  toActivitySummaryDto,
} from './activities';
import type { Activity } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * L'athlète appartient à un compte : le DAL le résout depuis la session
 * (`getCurrentAthleteId`). Les tests de ce fichier travaillent donc sous une
 * session ouverte, sauf ceux qui éprouvent le cas « personne de connecté » —
 * ils appellent `withoutSession()`.
 */
const { sessionState } = vi.hoisted(() => {
  type Session = { userId: string; name: string; email: string } | null;
  const sessionState: { current: Session } = {
    current: { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' },
  };
  return { sessionState };
});

vi.mock('./session', () => ({ getSession: () => Promise.resolve(sessionState.current) }));

/** Personne n'est connecté : aucune lecture du DAL ne rend d'athlète. */
function withoutSession(): void {
  sessionState.current = null;
}

/**
 * Aucune base de données : chaque requête est enregistrée avec sa clause
 * `WHERE`, sa pagination et sa table, et sert soit la file de résultats de cette
 * table (une entrée par requête, dans l'ordre), soit son jeu de lignes par
 * défaut.
 */
type RecordedQuery = {
  table: string;
  where: SQL | null;
  limit: number | null;
  offset: number | null;
};

const { dbState } = vi.hoisted(() => ({
  dbState: {
    /** Lignes servies par défaut, par nom de table. */
    rows: {} as Record<string, unknown[]>,
    /** Résultats successifs d'une même table, prioritaires sur `rows`. */
    queues: {} as Record<string, unknown[][]>,
    queries: [] as RecordedQuery[],
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => Chain;
    groupBy: () => Chain;
    orderBy: () => Chain;
    innerJoin: () => Chain;
    limit: (count: number) => Chain;
    offset: (count: number) => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const query: RecordedQuery = { table: name, where: null, limit: null, offset: null };
    dbState.queries.push(query);

    const chain: Chain = {
      where: (clause) => {
        query.where = clause;
        return chain;
      },
      groupBy: () => chain,
      orderBy: () => chain,
      innerJoin: () => chain,
      limit: (count) => {
        query.limit = count;
        return chain;
      },
      offset: (count) => {
        query.offset = count;
        return chain;
      },
      then: (onFulfilled, onRejected) => {
        const queue = dbState.queues[name];
        const rows = queue && queue.length > 0 ? (queue.shift() ?? []) : (dbState.rows[name] ?? []);
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  return {
    db: {
      select: () => ({ from: chainFor }),
      // `claimOrphanAthlete` : jamais atteint ici, mais son absence ferait
      // échouer un test sur une erreur de mock plutôt que sur son objet.
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    },
  };
});

const dialect = new PgDialect();

/** Requêtes enregistrées sur une table, dans l'ordre où le DAL les a lancées. */
function queriesOn(table: string): RecordedQuery[] {
  return dbState.queries.filter((query) => query.table === table);
}

/** Clause `WHERE` rendue en SQL + paramètres liés, pour l'affirmer telle qu'elle partira. */
function renderWhere(query: RecordedQuery | undefined): { sql: string; params: unknown[] } {
  if (query?.where == null) {
    throw new Error('Aucune clause `WHERE` enregistrée pour cette requête.');
  }
  const rendered = dialect.sqlToQuery(query.where);
  return { sql: rendered.sql, params: rendered.params };
}

const rawActivity: Activity = {
  id: 42,
  athleteId: 1,
  fitFileHash: 'a'.repeat(64),
  name: 'Sortie longue',
  sportType: 'Run',
  startedAt: new Date('2026-08-02T06:30:00.000Z'),
  distanceM: 21_097.5,
  movingTimeS: 6_120,
  elapsedTimeS: 6_300,
  elevationGainM: 187.4,
  avgHrBpm: 152,
  maxHrBpm: 176,
  avgPaceSecPerKm: 290.1,
  avgCadenceSpm: 87.5,
  createdAt: new Date('2026-08-02T08:00:00.000Z'),
};

const SUMMARY_KEYS = [
  'avgHrBpm',
  'avgPaceSecPerKm',
  'distanceM',
  'elevationGainM',
  'id',
  'movingTimeS',
  'name',
  'sportType',
  'startedAt',
];

const DETAIL_KEYS = [...SUMMARY_KEYS, 'avgCadenceSpm', 'elapsedTimeS', 'maxHrBpm'].sort();

beforeEach(() => {
  sessionState.current = { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' };
  dbState.rows = { athlete: [{ id: 1 }] };
  dbState.queues = {};
  dbState.queries = [];
});

describe('toActivitySummaryDto', () => {
  it("n'expose que les champs du DTO", () => {
    const dto = toActivitySummaryDto(rawActivity);

    expect(Object.keys(dto).sort()).toEqual(SUMMARY_KEYS);
  });

  it('ne laisse fuir aucun identifiant interne', () => {
    const dto = toActivitySummaryDto(rawActivity);

    expect(dto).not.toHaveProperty('fitFileHash');
    expect(dto).not.toHaveProperty('athleteId');
    expect(dto).not.toHaveProperty('createdAt');
  });

  it('recopie les valeurs sans les transformer', () => {
    const dto = toActivitySummaryDto(rawActivity);

    expect(dto).toEqual({
      id: 42,
      name: 'Sortie longue',
      sportType: 'Run',
      startedAt: new Date('2026-08-02T06:30:00.000Z'),
      distanceM: 21_097.5,
      movingTimeS: 6_120,
      elevationGainM: 187.4,
      avgHrBpm: 152,
      avgPaceSecPerKm: 290.1,
    });
  });

  it('préserve les métriques absentes en `null` plutôt que de les inventer', () => {
    const dto = toActivitySummaryDto({
      ...rawActivity,
      avgHrBpm: null,
      avgPaceSecPerKm: null,
      elevationGainM: null,
    });

    expect(dto.avgHrBpm).toBeNull();
    expect(dto.avgPaceSecPerKm).toBeNull();
    expect(dto.elevationGainM).toBeNull();
  });

  it('ignore les champs surnuméraires présents sur la ligne', () => {
    const polluted: Activity & { internalNote: string } = {
      ...rawActivity,
      internalNote: 'ne-doit-pas-fuiter',
    };

    const dto = toActivitySummaryDto(polluted);

    expect(Object.keys(dto).sort()).toEqual(SUMMARY_KEYS);
    expect(JSON.stringify(dto)).not.toContain('ne-doit-pas-fuiter');
  });
});

describe('toActivityDetailDto', () => {
  it("n'expose que les champs du DTO détaillé", () => {
    const dto = toActivityDetailDto(rawActivity);

    expect(Object.keys(dto).sort()).toEqual(DETAIL_KEYS);
    expect(dto).not.toHaveProperty('fitFileHash');
    expect(dto).not.toHaveProperty('athleteId');
  });
});

describe('listRecentActivities', () => {
  it('retourne des DTOs, jamais les lignes brutes', async () => {
    dbState.rows.activities = [rawActivity];

    const dtos = await listRecentActivities(10);

    expect(dtos).toHaveLength(1);
    expect(Object.keys(dtos[0] ?? {}).sort()).toEqual(SUMMARY_KEYS);
  });

  it("ne lit que les activités de l'athlète du compte connecté", async () => {
    dbState.rows.activities = [rawActivity];

    await listRecentActivities(10);

    expect(renderWhere(queriesOn('activities')[0]).params).toEqual([1]);
  });

  it("ne lit rien tant que personne n'est connecté", async () => {
    withoutSession();
    dbState.rows.activities = [rawActivity];

    await expect(listRecentActivities()).resolves.toEqual([]);
    expect(queriesOn('activities')).toEqual([]);
  });
});

/**
 * Repères ISO utilisés ci-dessous (fuseau Europe/Paris) :
 * lundi 10 août 2026 ouvre la semaine 33, dimanche 9 août ferme la semaine 32.
 */
function activityAt(
  id: number,
  startedAt: string,
  { distanceM = 10_000, movingTimeS = 3_000 }: { distanceM?: number; movingTimeS?: number } = {},
): Activity {
  return { ...rawActivity, id, startedAt: new Date(startedAt), distanceM, movingTimeS };
}

describe('groupActivitiesByWeek', () => {
  it('regroupe par semaine ISO, semaines et activités en ordre décroissant', () => {
    const weeks = groupActivitiesByWeek(
      [
        activityAt(1, '2026-08-05T17:00:00.000Z'),
        activityAt(2, '2026-08-11T17:00:00.000Z'),
        activityAt(3, '2026-08-10T06:00:00.000Z'),
        activityAt(4, '2026-08-09T09:00:00.000Z'),
      ].map(toActivitySummaryDto),
      8,
    );

    expect(weeks.map((week) => week.weekLabel)).toEqual(['S33', 'S32']);
    expect(weeks[0]?.activities.map((activity) => activity.id)).toEqual([2, 3]);
    expect(weeks[1]?.activities.map((activity) => activity.id)).toEqual([4, 1]);
  });

  it('identifie chaque semaine par son lundi, pas par son seul numéro', () => {
    const weeks = groupActivitiesByWeek(
      [
        activityAt(1, '2026-08-11T17:00:00.000Z'),
        activityAt(2, '2026-08-05T17:00:00.000Z'),
      ].map(toActivitySummaryDto),
      8,
    );

    expect(weeks.map((week) => week.startsOn)).toEqual(['2026-08-10', '2026-08-03']);
  });

  it('cumule distance et temps de déplacement de chaque semaine', () => {
    const weeks = groupActivitiesByWeek(
      [
        activityAt(1, '2026-08-10T06:00:00.000Z', { distanceM: 10_500, movingTimeS: 3_000 }),
        activityAt(2, '2026-08-12T06:00:00.000Z', { distanceM: 5_250.5, movingTimeS: 1_500 }),
        activityAt(3, '2026-08-05T06:00:00.000Z', { distanceM: 8_000, movingTimeS: 2_400 }),
      ].map(toActivitySummaryDto),
      8,
    );

    expect(weeks[0]).toMatchObject({
      weekLabel: 'S33',
      totalDistanceM: 15_750.5,
      totalMovingTimeS: 4_500,
    });
    expect(weeks[1]).toMatchObject({
      weekLabel: 'S32',
      totalDistanceM: 8_000,
      totalMovingTimeS: 2_400,
    });
  });

  it('rattache une sortie nocturne au jour civil de l’athlète, pas à UTC', () => {
    // 9 août 22 h 30 UTC = lundi 10 août 00 h 30 à Paris → semaine 33.
    const weeks = groupActivitiesByWeek(
      [activityAt(1, '2026-08-09T22:30:00.000Z')].map(toActivitySummaryDto),
      8,
    );

    expect(weeks.map((week) => week.weekLabel)).toEqual(['S33']);
  });

  it('ne garde que les `limit` semaines les plus récentes', () => {
    const weeks = groupActivitiesByWeek(
      [
        activityAt(1, '2026-08-10T06:00:00.000Z'),
        activityAt(2, '2026-08-05T06:00:00.000Z'),
        activityAt(3, '2026-07-29T06:00:00.000Z'),
      ].map(toActivitySummaryDto),
      2,
    );

    expect(weeks.map((week) => week.weekLabel)).toEqual(['S33', 'S32']);
    // L'activité écartée ne doit pas être reversée dans une semaine conservée.
    expect(weeks.flatMap((week) => week.activities).map((activity) => activity.id)).toEqual([
      1, 2,
    ]);
  });

  it('saute les semaines sans activité au lieu de les afficher vides', () => {
    const weeks = groupActivitiesByWeek(
      [
        activityAt(1, '2026-08-10T06:00:00.000Z'),
        activityAt(2, '2026-07-20T06:00:00.000Z'),
      ].map(toActivitySummaryDto),
      8,
    );

    expect(weeks.map((week) => week.weekLabel)).toEqual(['S33', 'S30']);
  });

  it('ne fusionne pas deux semaines 1 d’années différentes', () => {
    const weeks = groupActivitiesByWeek(
      [
        activityAt(1, '2026-01-01T12:00:00.000Z'),
        activityAt(2, '2024-12-31T12:00:00.000Z'),
      ].map(toActivitySummaryDto),
      8,
    );

    expect(weeks.map((week) => week.weekLabel)).toEqual(['S1', 'S1']);
    expect(weeks.map((week) => week.startsOn)).toEqual(['2025-12-29', '2024-12-30']);
    expect(weeks.map((week) => week.activities.length)).toEqual([1, 1]);
  });

  it('retourne un tableau vide sans activité ou avec une limite nulle', () => {
    expect(groupActivitiesByWeek([], 8)).toEqual([]);
    expect(groupActivitiesByWeek([toActivitySummaryDto(rawActivity)], 0)).toEqual([]);
  });
});

describe('listActivityWeekPage', () => {
  /** Deux requêtes : les lundis paginés, puis les activités de la fenêtre. */
  function servePage(weekStarts: string[], rows: Activity[]): void {
    dbState.queues.activities = [weekStarts.map((weekStart) => ({ weekStart })), rows];
  }

  it('retourne des DTOs, jamais les lignes brutes', async () => {
    servePage(['2026-07-27'], [rawActivity]);

    const { weeks } = await listActivityWeekPage({ limit: 8, offset: 0 });

    expect(weeks).toHaveLength(1);
    expect(Object.keys(weeks[0]?.activities[0] ?? {}).sort()).toEqual(SUMMARY_KEYS);
  });

  it("ne pagine que les semaines de l'athlète du compte connecté", async () => {
    servePage(['2026-08-10'], [activityAt(1, '2026-08-10T06:00:00.000Z')]);

    await listActivityWeekPage({ limit: 8, offset: 0 });

    const [weekQuery, windowQuery] = queriesOn('activities');
    // La requête des semaines ne porte que le filtre d'athlète…
    expect(renderWhere(weekQuery).params).toEqual([1]);
    // …et celle des activités le porte aussi, en plus des bornes de la fenêtre.
    expect(renderWhere(windowQuery).params[0]).toBe(1);
  });

  it("ne lit rien tant que personne n'est connecté", async () => {
    withoutSession();
    servePage(['2026-08-10'], [rawActivity]);

    await expect(listActivityWeekPage({ limit: 8, offset: 0 })).resolves.toEqual({
      weeks: [],
      offset: 0,
      hasOlder: false,
    });
    expect(queriesOn('activities')).toEqual([]);
  });

  it('découpe les semaines dans le fuseau de l’athlète, côté Postgres', async () => {
    servePage(['2026-08-10'], [activityAt(1, '2026-08-10T06:00:00.000Z')]);

    await listActivityWeekPage({ limit: 8, offset: 0 });

    const window = renderWhere(queriesOn('activities')[1]);
    // Le lundi ISO (`date_trunc('week', …)`) dans le fuseau de l'athlète : la
    // même règle que le regroupement en mémoire, sans quoi une sortie du
    // dimanche soir tomberait dans deux semaines différentes.
    expect(window.sql).toContain("date_trunc('week'");
    expect(window.sql).toContain('at time zone');
    expect(window.params).toContain('Europe/Paris');
  });

  it('borne la fenêtre aux semaines de la page', async () => {
    servePage(
      ['2026-08-10', '2026-08-03'],
      [activityAt(1, '2026-08-10T06:00:00.000Z'), activityAt(2, '2026-08-05T06:00:00.000Z')],
    );

    const { weeks } = await listActivityWeekPage({ limit: 8, offset: 0 });

    const window = renderWhere(queriesOn('activities')[1]);
    // La plus ancienne borne en bas, la plus récente en haut.
    expect(window.params).toContain('2026-08-03');
    expect(window.params).toContain('2026-08-10');
    expect(weeks.map((week) => week.startsOn)).toEqual(['2026-08-10', '2026-08-03']);
  });

  it('lit une semaine de plus que la page pour savoir s’il en reste', async () => {
    servePage(
      ['2026-08-10', '2026-08-03', '2026-07-27'],
      [activityAt(1, '2026-08-10T06:00:00.000Z'), activityAt(2, '2026-08-05T06:00:00.000Z')],
    );

    const page = await listActivityWeekPage({ limit: 2, offset: 0 });

    // `limit + 1` : la semaine en trop répond « oui, il y a une suite » sans
    // qu'aucun comptage de l'historique ne soit fait.
    expect(queriesOn('activities')[0]?.limit).toBe(3);
    expect(page.hasOlder).toBe(true);
    expect(page.weeks).toHaveLength(2);
  });

  it('annonce la fin de l’historique quand la page n’est pas pleine', async () => {
    servePage(['2026-08-10'], [activityAt(1, '2026-08-10T06:00:00.000Z')]);

    const page = await listActivityWeekPage({ limit: 8, offset: 0 });

    expect(page.hasOlder).toBe(false);
  });

  it('décale la lecture du rang demandé', async () => {
    servePage(['2026-06-15'], [activityAt(1, '2026-06-15T06:00:00.000Z')]);

    const page = await listActivityWeekPage({ limit: 8, offset: 16 });

    expect(queriesOn('activities')[0]?.offset).toBe(16);
    expect(page.offset).toBe(16);
  });

  it('rend une page vide au-delà de l’historique, sans seconde requête', async () => {
    servePage([], []);

    const page = await listActivityWeekPage({ limit: 8, offset: 800 });

    expect(page).toEqual({ weeks: [], offset: 800, hasOlder: false });
    // Sans semaine, il n'y a pas de fenêtre à interroger.
    expect(queriesOn('activities')).toHaveLength(1);
  });

  it('ramène un rang ou une taille de page hors bornes dans la plage', async () => {
    servePage(['2026-08-10'], [activityAt(1, '2026-08-10T06:00:00.000Z')]);

    const page = await listActivityWeekPage({ limit: 10_000, offset: 10 ** 9 });

    expect(queriesOn('activities')[0]?.limit).toBe(
      ACTIVITY_WEEK_PAGE_LIMITS.maxWeeksPerPage + 1,
    );
    expect(queriesOn('activities')[0]?.offset).toBe(ACTIVITY_WEEK_PAGE_LIMITS.maxOffset);
    expect(page.offset).toBe(ACTIVITY_WEEK_PAGE_LIMITS.maxOffset);
  });

  it('refuse un rang négatif ou non numérique plutôt que de le passer à Postgres', async () => {
    servePage(['2026-08-10'], [activityAt(1, '2026-08-10T06:00:00.000Z')]);

    await listActivityWeekPage({ limit: Number.NaN, offset: -50 });

    expect(queriesOn('activities')[0]?.limit).toBe(2);
    expect(queriesOn('activities')[0]?.offset).toBe(0);
  });
});

describe('getActivityById', () => {
  it('retourne un DTO détaillé', async () => {
    dbState.rows.activities = [rawActivity];

    const dto = await getActivityById(42);

    expect(dto).not.toBeNull();
    expect(Object.keys(dto ?? {}).sort()).toEqual(DETAIL_KEYS);
  });

  it('retourne null quand aucune activité ne correspond', async () => {
    await expect(getActivityById(999)).resolves.toBeNull();
  });

  it('confronte l’identifiant reçu à l’athlète, dans la même clause', async () => {
    dbState.rows.activities = [rawActivity];

    await getActivityById(42);

    expect(renderWhere(queriesOn('activities')[0]).params).toEqual([42, 1]);
  });

  it('reste introuvable pour l’activité d’un autre athlète', async () => {
    // L'activité 42 existe, mais pas sous cet athlète : la requête filtrée ne
    // rend rien, et le DAL répond comme pour un identifiant inexistant.
    dbState.rows.activities = [];

    await expect(getActivityById(42)).resolves.toBeNull();
  });

  it("ne lit rien tant que personne n'est connecté", async () => {
    withoutSession();
    dbState.rows.activities = [rawActivity];

    await expect(getActivityById(42)).resolves.toBeNull();
    expect(queriesOn('activities')).toEqual([]);
  });
});
