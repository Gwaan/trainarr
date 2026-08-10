import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedFitActivity } from './parse';

vi.mock('server-only', () => ({}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    parseFitActivity: vi.fn(),
    getAthleteId: vi.fn(),
    upsertActivityFromFit: vi.fn(),
    saveActivityStreams: vi.fn(),
  },
}));

vi.mock('./parse', () => ({
  parseFitActivity: mocks.parseFitActivity,
}));

vi.mock('@/data/athlete', () => ({
  getAthleteId: mocks.getAthleteId,
}));

vi.mock('@/data/activities', () => ({
  upsertActivityFromFit: mocks.upsertActivityFromFit,
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

/**
 * Le même fichier relu par un parseur corrigé : les canaux clairsemés que
 * l'ancienne version écartait sont là, avec leurs trous explicites.
 */
const REPARSED: ParsedFitActivity = {
  ...PARSED,
  streams: {
    time: [0, 1],
    heartrate: [130, null],
    cadence: [null, 174],
    latlng: [[48.85, 2.35], null],
  },
};

const BUFFER = Buffer.from('fit');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseFitActivity.mockReturnValue(PARSED);
  mocks.getAthleteId.mockResolvedValue(1);
  mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, created: true });
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

  it('remplace les séries au réimport du même fichier (parseur corrigé)', async () => {
    // Le fichier avait déjà été ingéré : même empreinte, donc `updated`. Les
    // séries doivent malgré tout être réécrites — sinon une correction du
    // parseur resterait sans effet sur l'historique, ce qui était le bug.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, created: false });
    mocks.parseFitActivity.mockReturnValue(REPARSED);

    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'updated', activityId: 42 });

    expect(mocks.saveActivityStreams).toHaveBeenCalledWith(42, REPARSED.streams);
  });

  it('échoue explicitement si aucun athlète n’est enregistré', async () => {
    mocks.getAthleteId.mockResolvedValue(null);

    await expect(ingestFitBuffer(BUFFER)).rejects.toThrowError(/athlète/);
    expect(mocks.upsertActivityFromFit).not.toHaveBeenCalled();
  });

  it('laisse remonter l’erreur de parsing sans rien écrire', async () => {
    const failure = new Error('En-tête FIT invalide.');
    mocks.parseFitActivity.mockImplementation(() => {
      throw failure;
    });

    await expect(ingestFitBuffer(BUFFER)).rejects.toBe(failure);
    expect(mocks.getAthleteId).not.toHaveBeenCalled();
    expect(mocks.upsertActivityFromFit).not.toHaveBeenCalled();
  });
});
