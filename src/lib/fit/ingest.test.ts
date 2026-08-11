import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedFitActivity } from './parse';

vi.mock('server-only', () => ({}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    parseFitActivity: vi.fn(),
    getAthleteId: vi.fn(),
    upsertActivityFromFit: vi.fn(),
    saveActivityStreams: vi.fn(),
    hasActivityStreams: vi.fn(),
    linkActivityToPlannedSession: vi.fn(),
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
  hasActivityStreams: mocks.hasActivityStreams,
}));

vi.mock('@/data/plan-reconciliation', () => ({
  linkActivityToPlannedSession: mocks.linkActivityToPlannedSession,
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
  mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'created' });
  mocks.saveActivityStreams.mockResolvedValue(undefined);
  mocks.hasActivityStreams.mockResolvedValue(false);
  mocks.linkActivityToPlannedSession.mockResolvedValue(true);
});

describe('ingestFitBuffer', () => {
  it('importe une nouvelle activité et ses séries', async () => {
    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'created', activityId: 42 });

    expect(mocks.parseFitActivity).toHaveBeenCalledWith(BUFFER);
    expect(mocks.upsertActivityFromFit).toHaveBeenCalledWith(PARSED, 1);
    expect(mocks.saveActivityStreams).toHaveBeenCalledWith(42, PARSED.streams);
    // Création : la question « a-t-elle déjà des séries ? » ne se pose même pas.
    expect(mocks.hasActivityStreams).not.toHaveBeenCalled();
  });

  it('rapporte `updated` quand le fichier avait déjà été importé', async () => {
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-file' });

    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'updated', activityId: 42 });
  });

  it('remplace les séries au réimport du même fichier (parseur corrigé)', async () => {
    // Le fichier avait déjà été ingéré : même empreinte, donc `updated`. Les
    // séries doivent malgré tout être réécrites — sinon une correction du
    // parseur resterait sans effet sur l'historique, ce qui était le bug.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-file' });
    mocks.parseFitActivity.mockReturnValue(REPARSED);
    // Même avec des séries en place : le même fichier, relu, les rafraîchit.
    mocks.hasActivityStreams.mockResolvedValue(true);

    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'updated', activityId: 42 });

    expect(mocks.saveActivityStreams).toHaveBeenCalledWith(42, REPARSED.streams);
  });

  it('rapporte `merged` et préserve les séries quand la séance en a déjà', async () => {
    // Doublon amont : un autre fichier décrit la séance déjà en base. Il n'est
    // pas une meilleure version d'elle-même — il n'écrase pas des séries saines.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-session' });
    mocks.parseFitActivity.mockReturnValue(REPARSED);
    mocks.hasActivityStreams.mockResolvedValue(true);

    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'merged', activityId: 42 });

    expect(mocks.hasActivityStreams).toHaveBeenCalledWith(42);
    expect(mocks.saveActivityStreams).not.toHaveBeenCalled();
  });

  it('écrit les séries d’un rapprochement de séance quand l’activité n’en a aucune', async () => {
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-session' });
    mocks.hasActivityStreams.mockResolvedValue(false);

    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'merged', activityId: 42 });

    expect(mocks.saveActivityStreams).toHaveBeenCalledWith(42, PARSED.streams);
  });

  it('rapproche l’activité de sa séance planifiée, après les séries', async () => {
    await ingestFitBuffer(BUFFER);

    expect(mocks.linkActivityToPlannedSession).toHaveBeenCalledWith(42);
    // Les séries d'abord : le rapprochement est un enrichissement de fin de course.
    expect(mocks.saveActivityStreams.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.linkActivityToPlannedSession.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('rapproche aussi un doublon de séance, dont les séries n’ont pas bougé', async () => {
    // L'appel est idempotent : le refaire ne coûte rien, ne pas le faire
    // laisserait une séance « manquée » alors que la sortie est en base.
    mocks.upsertActivityFromFit.mockResolvedValue({ activityId: 42, outcome: 'same-session' });
    mocks.hasActivityStreams.mockResolvedValue(true);

    await ingestFitBuffer(BUFFER);

    expect(mocks.linkActivityToPlannedSession).toHaveBeenCalledWith(42);
  });

  it('journalise un rapprochement en échec sans faire échouer l’import', async () => {
    // L'activité est en base : la perdre dans `failed/` parce que la jointure
    // avec le plan a échoué serait une régression bien pire que le lien manquant.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.linkActivityToPlannedSession.mockRejectedValue(new Error('base indisponible'));

    await expect(ingestFitBuffer(BUFFER)).resolves.toEqual({ status: 'created', activityId: 42 });

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[fit]'));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('base indisponible'));
    logged.mockRestore();
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
