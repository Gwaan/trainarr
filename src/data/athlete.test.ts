import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAthleteProfile, toAthleteProfileDto } from './athlete';
import type { Athlete } from './db/schema';

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

const rawAthlete: Athlete = {
  id: 1,
  displayName: 'Gwen',
  maxHrBpm: 191,
  restingHrBpm: 48,
  weightKg: 68.4,
  birthDate: '1990-04-17',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-08-01T10:00:00.000Z'),
};

const PROFILE_KEYS = [
  'birthDate',
  'displayName',
  'id',
  'maxHrBpm',
  'restingHrBpm',
  'weightKg',
];

beforeEach(() => {
  queryState.rows = [];
});

describe('toAthleteProfileDto', () => {
  it("n'expose que les champs du DTO", () => {
    const dto = toAthleteProfileDto(rawAthlete);

    expect(Object.keys(dto).sort()).toEqual(PROFILE_KEYS);
    expect(dto).not.toHaveProperty('createdAt');
    expect(dto).not.toHaveProperty('updatedAt');
  });

  it('recopie les valeurs sans les transformer', () => {
    expect(toAthleteProfileDto(rawAthlete)).toEqual({
      id: 1,
      displayName: 'Gwen',
      maxHrBpm: 191,
      restingHrBpm: 48,
      weightKg: 68.4,
      birthDate: '1990-04-17',
    });
  });

  it('préserve les champs non renseignés en `null`', () => {
    const dto = toAthleteProfileDto({
      ...rawAthlete,
      maxHrBpm: null,
      restingHrBpm: null,
      weightKg: null,
      birthDate: null,
    });

    expect(dto.maxHrBpm).toBeNull();
    expect(dto.restingHrBpm).toBeNull();
    expect(dto.weightKg).toBeNull();
    expect(dto.birthDate).toBeNull();
  });

  it('ne laisse fuir aucun jeton Strava joint à la ligne', () => {
    const polluted: Athlete & { accessToken: string; refreshToken: string } = {
      ...rawAthlete,
      accessToken: 'strava-access-token',
      refreshToken: 'strava-refresh-token',
    };

    const dto = toAthleteProfileDto(polluted);

    expect(Object.keys(dto).sort()).toEqual(PROFILE_KEYS);
    expect(JSON.stringify(dto)).not.toContain('strava-');
  });
});

describe('getAthleteProfile', () => {
  it('retourne un DTO, jamais la ligne brute', async () => {
    queryState.rows = [rawAthlete];

    const dto = await getAthleteProfile();

    expect(dto).not.toBeNull();
    expect(Object.keys(dto ?? {}).sort()).toEqual(PROFILE_KEYS);
  });

  it("retourne null tant qu'aucun athlète n'est enregistré", async () => {
    await expect(getAthleteProfile()).resolves.toBeNull();
  });
});
