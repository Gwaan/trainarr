import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedFitActivity } from './parse';

vi.mock('server-only', () => ({}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    parseFitActivity: vi.fn(),
    getAthleteProfile: vi.fn(),
    upsertActivityFromFit: vi.fn(),
    findActivityIdsWithoutStreams: vi.fn(),
    saveActivityStreams: vi.fn(),
  },
}));

vi.mock('./parse', () => ({
  parseFitActivity: mocks.parseFitActivity,
}));

vi.mock('@/data/athlete', () => ({
  getAthleteProfile: mocks.getAthleteProfile,
}));

vi.mock('@/data/activities', () => ({
  upsertActivityFromFit: mocks.upsertActivityFromFit,
  findActivityIdsWithoutStreams: mocks.findActivityIdsWithoutStreams,
  saveActivityStreams: mocks.saveActivityStreams,
}));

const { ingestFitBuffer } = await import('./ingest');

const PARSED: ParsedFitActivity = {
  fileHash: 'b'.repeat(64),
  name: 'Footing',
  sportType: 'Run',
  startedAt: new Date('2026-08-02T06:30:00.000Z'),
  distanceM: 10_000,
  movingTimeS: 3_000,
  elapsedTimeS: 3_120,
  elevationGainM: 120,
  avgHrBpm: 149,
  maxHrBpm: 171,
  avgCadenceSpm: 176,
  streams: { time: [0, 1], heartrate: [130, 140] },
  warnings: [],
};

const BUFFER = Buffer.from('fit');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseFitActivity.mockReturnValue(PARSED);
  mocks.getAthleteProfile.mockResolvedValue({ id: 1, displayName: 'Gwen' });
  mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, created: true });
  mocks.findActivityIdsWithoutStreams.mockResolvedValue(new Set([42]));
  mocks.saveActivityStreams.mockResolvedValue(undefined);
});

describe('ingestFitBuffer', () => {
  it('importe une nouvelle activité et ses séries', async () => {
    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'created', activityId: 42 });

    expect(mocks.parseFitActivity).toHaveBeenCalledWith(BUFFER);
    expect(mocks.upsertActivityFromFit).toHaveBeenCalledWith(PARSED, 1);
    expect(mocks.saveActivityStreams).toHaveBeenCalledWith(42, PARSED.streams);
  });

  it('rapporte `updated` quand le fichier avait déjà été importé', async () => {
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, created: false });

    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'updated', activityId: 42 });
  });

  it('n’écrit pas les séries si l’activité en a déjà (celles en base font foi)', async () => {
    mocks.findActivityIdsWithoutStreams.mockResolvedValue(new Set());

    await ingestFitBuffer(BUFFER);

    expect(mocks.findActivityIdsWithoutStreams).toHaveBeenCalledWith([42]);
    expect(mocks.saveActivityStreams).not.toHaveBeenCalled();
  });

  it('échoue explicitement si aucun athlète n’est enregistré', async () => {
    mocks.getAthleteProfile.mockResolvedValue(null);

    await expect(ingestFitBuffer(BUFFER)).rejects.toThrowError(/athlète/);
    expect(mocks.upsertActivityFromFit).not.toHaveBeenCalled();
  });

  it('laisse remonter l’erreur de parsing sans rien écrire', async () => {
    const failure = new Error('En-tête FIT invalide.');
    mocks.parseFitActivity.mockImplementation(() => {
      throw failure;
    });

    await expect(ingestFitBuffer(BUFFER)).rejects.toBe(failure);
    expect(mocks.getAthleteProfile).not.toHaveBeenCalled();
    expect(mocks.upsertActivityFromFit).not.toHaveBeenCalled();
  });
});
