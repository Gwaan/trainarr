import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActivityById,
  groupActivitiesByWeek,
  listActivitiesByWeek,
  listRecentActivities,
  toActivityDetailDto,
  toActivitySummaryDto,
} from './activities';
import type { Activity } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

// Aucune base de données : le client est remplacé par une chaîne de requête factice.
const { queryState } = vi.hoisted(() => ({
  queryState: { rows: [] as unknown[] },
}));

vi.mock('./db/client', () => {
  // La chaîne est elle-même « thenable » : toutes les requêtes ne se terminent
  // pas par `.limit()` (`listActivitiesByWeek` lit l'historique complet).
  type QueryChain = PromiseLike<unknown[]> & {
    from: () => QueryChain;
    where: () => QueryChain;
    orderBy: () => QueryChain;
    limit: () => QueryChain;
  };
  const chain: QueryChain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (onFulfilled, onRejected) =>
      Promise.resolve(queryState.rows).then(onFulfilled, onRejected),
  };
  return { db: { select: () => chain } };
});

const rawActivity: Activity = {
  id: 42,
  athleteId: 1,
  stravaId: 15_123_456_789,
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
  queryState.rows = [];
});

describe('toActivitySummaryDto', () => {
  it("n'expose que les champs du DTO", () => {
    const dto = toActivitySummaryDto(rawActivity);

    expect(Object.keys(dto).sort()).toEqual(SUMMARY_KEYS);
  });

  it('ne laisse fuir aucun identifiant interne', () => {
    const dto = toActivitySummaryDto(rawActivity);

    expect(dto).not.toHaveProperty('stravaId');
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
    const polluted: Activity & { accessToken: string } = {
      ...rawActivity,
      accessToken: 'strava-access-token',
    };

    const dto = toActivitySummaryDto(polluted);

    expect(Object.keys(dto).sort()).toEqual(SUMMARY_KEYS);
    expect(JSON.stringify(dto)).not.toContain('strava-access-token');
  });
});

describe('toActivityDetailDto', () => {
  it("n'expose que les champs du DTO détaillé", () => {
    const dto = toActivityDetailDto(rawActivity);

    expect(Object.keys(dto).sort()).toEqual(DETAIL_KEYS);
    expect(dto).not.toHaveProperty('stravaId');
    expect(dto).not.toHaveProperty('athleteId');
  });
});

describe('listRecentActivities', () => {
  it('retourne des DTOs, jamais les lignes brutes', async () => {
    queryState.rows = [rawActivity];

    const dtos = await listRecentActivities(10);

    expect(dtos).toHaveLength(1);
    expect(Object.keys(dtos[0] ?? {}).sort()).toEqual(SUMMARY_KEYS);
  });

  it('retourne un tableau vide quand il n’y a aucune activité', async () => {
    await expect(listRecentActivities()).resolves.toEqual([]);
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
    expect(weeks.map((week) => week.activities.length)).toEqual([1, 1]);
  });

  it('retourne un tableau vide sans activité ou avec une limite nulle', () => {
    expect(groupActivitiesByWeek([], 8)).toEqual([]);
    expect(groupActivitiesByWeek([toActivitySummaryDto(rawActivity)], 0)).toEqual([]);
  });
});

describe('listActivitiesByWeek', () => {
  it('retourne des DTOs, jamais les lignes brutes', async () => {
    queryState.rows = [rawActivity];

    const weeks = await listActivitiesByWeek(8);

    expect(weeks).toHaveLength(1);
    expect(Object.keys(weeks[0]?.activities[0] ?? {}).sort()).toEqual(SUMMARY_KEYS);
  });

  it('retourne un tableau vide quand il n’y a aucune activité', async () => {
    await expect(listActivitiesByWeek(8)).resolves.toEqual([]);
  });
});

describe('getActivityById', () => {
  it('retourne un DTO détaillé', async () => {
    queryState.rows = [rawActivity];

    const dto = await getActivityById(42);

    expect(dto).not.toBeNull();
    expect(Object.keys(dto ?? {}).sort()).toEqual(DETAIL_KEYS);
  });

  it('retourne null quand aucune activité ne correspond', async () => {
    await expect(getActivityById(999)).resolves.toBeNull();
  });
});
