import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StravaActivity, StravaStreamSet } from './client';
import { StravaApiError, StravaAuthError, StravaRateLimitError } from './errors';
import { syncRecentActivities, syncSingleActivity } from './sync';

// `sync.ts` et le DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { api, dal } = vi.hoisted(() => ({
  api: {
    listActivities: vi.fn(),
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
  },
  dal: {
    getFreshAccessToken: vi.fn(),
    getAthleteProfile: vi.fn(),
    getStravaAthleteId: vi.fn(),
    upsertActivityFromStrava: vi.fn(),
    findKnownStravaIds: vi.fn(),
    findActivityIdsWithoutStreams: vi.fn(),
    saveActivityStreams: vi.fn(),
  },
}));

vi.mock('./client', () => ({
  listActivities: api.listActivities,
  getActivity: api.getActivity,
  getActivityStreams: api.getActivityStreams,
}));

vi.mock('@/data/strava-tokens', () => ({ getFreshAccessToken: dal.getFreshAccessToken }));
vi.mock('@/data/athlete', () => ({
  getAthleteProfile: dal.getAthleteProfile,
  getStravaAthleteId: dal.getStravaAthleteId,
}));
vi.mock('@/data/activities', () => ({
  upsertActivityFromStrava: dal.upsertActivityFromStrava,
  findKnownStravaIds: dal.findKnownStravaIds,
  findActivityIdsWithoutStreams: dal.findActivityIdsWithoutStreams,
  saveActivityStreams: dal.saveActivityStreams,
}));

const STREAMS: StravaStreamSet = { time: [0, 1], heartrate: [120, 130] };

/** Identifiant Strava de Gwen, tel que `saveStravaTokens` l'a enregistré. */
const OWNER_ID = 987_654;

/** Activité Strava minimale : seuls l'id et le propriétaire comptent ici. */
function activity(id: number, athleteStravaId: number | null = OWNER_ID): StravaActivity {
  return {
    id,
    athleteStravaId,
    name: `Sortie ${id}`,
    sportType: 'Run',
    startedAt: new Date('2026-08-02T06:30:00.000Z'),
    distanceM: 10_000,
    movingTimeS: 3_600,
    elapsedTimeS: 3_700,
    elevationGainM: 50,
    avgHrBpm: 145,
    maxHrBpm: 168,
    avgCadenceSpm: 86,
  };
}

/** `n` activités, ids 1..n. */
function page(count: number, startId = 1): StravaActivity[] {
  return Array.from({ length: count }, (_unused, index) => activity(startId + index));
}

beforeEach(() => {
  vi.clearAllMocks();
  dal.getFreshAccessToken.mockResolvedValue('access-frais');
  dal.getAthleteProfile.mockResolvedValue({ id: 1, displayName: 'Gwen' });
  dal.getStravaAthleteId.mockResolvedValue(OWNER_ID);
  // Id local dérivé de l'id Strava : suffit à vérifier le chaînage des appels.
  dal.upsertActivityFromStrava.mockImplementation((item: StravaActivity) =>
    Promise.resolve(item.id + 1_000),
  );
  dal.findKnownStravaIds.mockResolvedValue(new Set<number>());
  // Par défaut : aucune activité n'a de streams en base, toutes sont à compléter.
  dal.findActivityIdsWithoutStreams.mockImplementation((ids: readonly number[]) =>
    Promise.resolve(new Set(ids)),
  );
  api.getActivityStreams.mockResolvedValue(STREAMS);
  api.listActivities.mockResolvedValue([]);
});

describe('syncRecentActivities — contexte', () => {
  it('échoue explicitement quand Strava n’est pas connecté', async () => {
    dal.getFreshAccessToken.mockResolvedValue(null);

    await expect(syncRecentActivities()).rejects.toBeInstanceOf(StravaAuthError);
    expect(api.listActivities).not.toHaveBeenCalled();
  });

  it('échoue quand aucun athlète n’est enregistré', async () => {
    dal.getAthleteProfile.mockResolvedValue(null);

    await expect(syncRecentActivities()).rejects.toThrowError(/athlète/i);
    expect(api.listActivities).not.toHaveBeenCalled();
  });

  it('utilise le jeton rafraîchi par le DAL', async () => {
    api.listActivities.mockResolvedValue(page(1));

    await syncRecentActivities();

    expect(api.listActivities).toHaveBeenCalledWith('access-frais', {
      page: 1,
      perPage: 100,
      after: undefined,
    });
  });

  it('transmet `after` à l’API', async () => {
    const after = new Date('2026-07-01T00:00:00.000Z');

    await syncRecentActivities({ after });

    expect(api.listActivities).toHaveBeenCalledWith('access-frais', {
      page: 1,
      perPage: 100,
      after,
    });
  });
});

describe('syncRecentActivities — pagination', () => {
  it('s’arrête à la première page incomplète', async () => {
    api.listActivities.mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(20, 101));

    const report = await syncRecentActivities();

    expect(api.listActivities).toHaveBeenCalledTimes(2);
    expect(report.fetched).toBe(120);
    expect(report.created).toBe(120);
  });

  it('s’arrête sur une page vide sans demander la suivante', async () => {
    api.listActivities.mockResolvedValueOnce(page(100)).mockResolvedValueOnce([]);

    const report = await syncRecentActivities();

    expect(api.listActivities).toHaveBeenCalledTimes(2);
    expect(report.fetched).toBe(100);
  });

  it('respecte une borne dure de pages même si l’API en renvoie toujours', async () => {
    // Chaque page est pleine : sans borne, la boucle ne s'arrêterait jamais.
    api.listActivities.mockImplementation(() => Promise.resolve(page(100)));

    const report = await syncRecentActivities();

    expect(api.listActivities).toHaveBeenCalledTimes(20);
    expect(report.fetched).toBe(2_000);
  });
});

describe('syncRecentActivities — idempotence et streams', () => {
  it('upsert chaque activité, y compris celles déjà connues', async () => {
    api.listActivities.mockResolvedValueOnce(page(3));
    dal.findKnownStravaIds.mockResolvedValue(new Set([2]));

    const report = await syncRecentActivities();

    expect(dal.upsertActivityFromStrava).toHaveBeenCalledTimes(3);
    expect(dal.upsertActivityFromStrava).toHaveBeenCalledWith(activity(2), 1);
    expect(report).toEqual({ fetched: 3, created: 2, updated: 1, rateLimited: false });
  });

  it('ne récupère les streams que des activités qui n’en ont pas en base', async () => {
    api.listActivities.mockResolvedValueOnce(page(3));
    // L'activité 2 a déjà ses séries : ids locaux = ids Strava + 1 000.
    dal.findActivityIdsWithoutStreams.mockResolvedValue(new Set([1_001, 1_003]));

    await syncRecentActivities();

    expect(dal.findActivityIdsWithoutStreams).toHaveBeenCalledWith([1_001, 1_002, 1_003]);
    expect(api.getActivityStreams.mock.calls).toEqual([
      ['access-frais', 1],
      ['access-frais', 3],
    ]);
    expect(dal.saveActivityStreams.mock.calls).toEqual([
      [1_001, STREAMS],
      [1_003, STREAMS],
    ]);
  });

  it('complète les streams d’une activité déjà connue mais sans séries', async () => {
    // Cas d'un backfill précédent coupé par le quota : la ligne d'activité
    // existe, ses streams non. L'ancien critère (« nouveauté ») les ignorait
    // définitivement.
    api.listActivities.mockResolvedValueOnce(page(1));
    dal.findKnownStravaIds.mockResolvedValue(new Set([1]));
    dal.findActivityIdsWithoutStreams.mockResolvedValue(new Set([1_001]));

    const report = await syncRecentActivities();

    expect(api.getActivityStreams).toHaveBeenCalledWith('access-frais', 1);
    expect(dal.saveActivityStreams).toHaveBeenCalledWith(1_001, STREAMS);
    expect(report).toEqual({ fetched: 1, created: 0, updated: 1, rateLimited: false });
  });

  it('n’écrit aucun stream quand l’activité n’en a pas (404)', async () => {
    api.listActivities.mockResolvedValueOnce(page(1));
    api.getActivityStreams.mockResolvedValue(null);

    const report = await syncRecentActivities();

    expect(dal.saveActivityStreams).not.toHaveBeenCalled();
    expect(report.created).toBe(1);
  });

  it('ne touche pas aux streams d’une base déjà à jour', async () => {
    api.listActivities.mockResolvedValueOnce(page(2));
    dal.findKnownStravaIds.mockResolvedValue(new Set([1, 2]));
    dal.findActivityIdsWithoutStreams.mockResolvedValue(new Set<number>());

    const report = await syncRecentActivities();

    expect(api.getActivityStreams).not.toHaveBeenCalled();
    expect(report).toEqual({ fetched: 2, created: 0, updated: 2, rateLimited: false });
  });
});

describe('syncRecentActivities — appartenance des activités', () => {
  it('écarte une activité que l’API attribue à un autre athlète', async () => {
    api.listActivities.mockResolvedValueOnce([activity(1), activity(2, 111_222), activity(3)]);

    const report = await syncRecentActivities();

    expect(dal.upsertActivityFromStrava.mock.calls.map(([item]) => (item as StravaActivity).id)) //
      .toEqual([1, 3]);
    expect(report).toEqual({ fetched: 3, created: 2, updated: 0, rateLimited: false });
  });

  it('n’écarte rien quand l’API n’expose pas le propriétaire', async () => {
    api.listActivities.mockResolvedValueOnce([activity(1, null)]);

    const report = await syncRecentActivities();

    expect(dal.upsertActivityFromStrava).toHaveBeenCalledTimes(1);
    expect(report.created).toBe(1);
  });
});

describe('syncRecentActivities — quotas', () => {
  function rateLimit(): StravaRateLimitError {
    return new StravaRateLimitError('quota', { retryAt: new Date('2026-08-10T09:15:00.000Z') });
  }

  it('s’arrête proprement et signale le quota, sans retenter', async () => {
    api.listActivities.mockResolvedValueOnce(page(100)).mockRejectedValueOnce(rateLimit());

    const report = await syncRecentActivities();

    expect(api.listActivities).toHaveBeenCalledTimes(2);
    expect(report).toEqual({ fetched: 100, created: 100, updated: 0, rateLimited: true });
  });

  it('conserve ce qui a été importé quand le quota tombe pendant les streams', async () => {
    api.listActivities.mockResolvedValueOnce(page(3));
    api.getActivityStreams.mockResolvedValueOnce(STREAMS).mockRejectedValueOnce(rateLimit());

    const report = await syncRecentActivities();

    // Les activités sont toutes écrites avant la passe de streams : celles qui
    // n'ont pas eu leurs séries les récupéreront au prochain appel (par absence
    // de streams, pas par nouveauté).
    expect(dal.saveActivityStreams).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ fetched: 3, created: 3, updated: 0, rateLimited: true });
  });

  it('laisse remonter les autres erreurs plutôt que de les avaler', async () => {
    api.listActivities.mockRejectedValueOnce(new StravaApiError('boum', { status: 500 }));

    await expect(syncRecentActivities()).rejects.toBeInstanceOf(StravaApiError);
  });
});

describe('syncSingleActivity', () => {
  it('récupère le détail, upsert puis importe les streams', async () => {
    api.getActivity.mockResolvedValue(activity(7));

    await syncSingleActivity(7, OWNER_ID);

    expect(api.getActivity).toHaveBeenCalledWith('access-frais', 7);
    expect(dal.upsertActivityFromStrava).toHaveBeenCalledWith(activity(7), 1);
    expect(api.getActivityStreams).toHaveBeenCalledWith('access-frais', 7);
    expect(dal.saveActivityStreams).toHaveBeenCalledWith(1_007, STREAMS);
  });

  it('échoue quand Strava n’est pas connecté', async () => {
    dal.getFreshAccessToken.mockResolvedValue(null);

    await expect(syncSingleActivity(7, OWNER_ID)).rejects.toBeInstanceOf(StravaAuthError);
    expect(api.getActivity).not.toHaveBeenCalled();
  });

  it('laisse remonter un quota dépassé : c’est à l’appelant de décider du retry', async () => {
    api.getActivity.mockRejectedValue(
      new StravaRateLimitError('quota', { retryAt: new Date('2026-08-10T09:15:00.000Z') }),
    );

    await expect(syncSingleActivity(7, OWNER_ID)).rejects.toBeInstanceOf(StravaRateLimitError);
  });
});

describe('syncSingleActivity — owner_id du webhook', () => {
  it('abandonne sans appeler l’API quand l’owner_id n’est pas notre athlète', async () => {
    // Webhook forgé : sans ce contrôle, l'activité d'un tiers entrerait en base
    // (et chaque POST consommerait notre quota API).
    await expect(syncSingleActivity(7, 111_222)).resolves.toBeUndefined();

    expect(api.getActivity).not.toHaveBeenCalled();
    expect(api.getActivityStreams).not.toHaveBeenCalled();
    expect(dal.upsertActivityFromStrava).not.toHaveBeenCalled();
    // Pas même un rafraîchissement de jeton : rien ne part vers Strava.
    expect(dal.getFreshAccessToken).not.toHaveBeenCalled();
  });

  it('abandonne quand aucun athlète Strava n’est connecté', async () => {
    dal.getStravaAthleteId.mockResolvedValue(null);

    await expect(syncSingleActivity(7, OWNER_ID)).resolves.toBeUndefined();

    expect(api.getActivity).not.toHaveBeenCalled();
    expect(dal.upsertActivityFromStrava).not.toHaveBeenCalled();
  });

  it('écarte l’activité si l’API la rattache à un autre athlète', async () => {
    // Défense en profondeur : l'owner_id concorde, mais pas le détail renvoyé.
    api.getActivity.mockResolvedValue(activity(7, 111_222));

    await expect(syncSingleActivity(7, OWNER_ID)).resolves.toBeUndefined();

    expect(dal.upsertActivityFromStrava).not.toHaveBeenCalled();
    expect(dal.saveActivityStreams).not.toHaveBeenCalled();
  });
});
