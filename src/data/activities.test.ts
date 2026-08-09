import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActivityById,
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
  type QueryChain = {
    from: () => QueryChain;
    where: () => QueryChain;
    orderBy: () => QueryChain;
    limit: () => Promise<unknown[]>;
  };
  const chain: QueryChain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(queryState.rows),
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
