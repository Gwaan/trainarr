import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getActivityFull } from './activities';
import type { Activity, ActivityStream, ActivityStreamType, Athlete } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : la chaîne de requête est factice et sert les lignes
 * déclarées par table (activité, streams et profil sont lus en parallèle).
 *
 * Les calculs de `@/lib/metrics` ne sont **pas** mockés : ce fichier vérifie
 * l'assemblage réel — le contrat du DTO et la dégradation bloc par bloc — sur
 * des séries construites à la main.
 */
const { queryState } = vi.hoisted(() => ({
  queryState: { rows: {} as Record<string, unknown[]> },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: () => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const chain: Chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(queryState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return { db: { select: () => ({ from: chainFor }) } };
});

const ATHLETE: Athlete = {
  id: 1,
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 190,
  restingHrBpm: 48,
  weightKg: 58,
  birthDate: '1990-05-12',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** 651 points à 1 Hz, 4 m/s, soit 2 600 m en 650 s. */
const POINT_COUNT = 651;
const SPEED_M_PER_S = 4;

const ACTIVITY: Activity = {
  id: 7,
  athleteId: 1,
  fitFileHash: 'b'.repeat(64),
  name: 'Footing',
  sportType: 'Run',
  startedAt: new Date('2026-08-09T06:00:00.000Z'),
  distanceM: 2_600,
  movingTimeS: 650,
  elapsedTimeS: 700,
  elevationGainM: 12,
  avgHrBpm: 150,
  maxHrBpm: 168,
  avgPaceSecPerKm: 250,
  avgCadenceSpm: 172,
  createdAt: new Date('2026-08-09T07:00:00.000Z'),
};

function indexes(): number[] {
  return Array.from({ length: POINT_COUNT }, (_, index) => index);
}

function stream(type: ActivityStreamType, data: ActivityStream['data']): ActivityStream {
  return { id: 0, activityId: ACTIVITY.id, type, data };
}

/** Jeu complet de streams : temps, distance (décalée), FC, altitude, cadence, vitesse, GPS. */
function fullStreams(): ActivityStream[] {
  const time = indexes();
  return [
    stream('time', time),
    // Cumul FIT démarrant à 420 m : le DTO doit repartir de 0.
    stream('distance', time.map((second) => 420 + second * SPEED_M_PER_S)),
    stream('heartrate', time.map((second) => (second < 300 ? 140 : 160))),
    stream('altitude', time.map((second) => (second < 250 ? 100 : 105))),
    stream('cadence', time.map(() => 172)),
    stream('velocity', time.map(() => SPEED_M_PER_S)),
    stream('latlng', time.map((second): [number, number] => [48.85 + second / 1e5, 2.35])),
  ];
}

beforeEach(() => {
  queryState.rows = {};
});

describe('getActivityFull', () => {
  it('rend null pour une activité inconnue', async () => {
    expect(await getActivityFull(404)).toBeNull();
  });

  it('assemble le détail, les graphes, les splits, les zones et les métriques', async () => {
    queryState.rows = {
      activities: [ACTIVITY],
      activity_streams: fullStreams(),
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);
    expect(full).not.toBeNull();
    if (full === null) return;

    expect(full.detail).toMatchObject({ id: 7, name: 'Footing', distanceM: 2_600 });
    // Le DTO du détail ne laisse pas fuir les champs internes.
    expect(Object.keys(full.detail)).not.toContain('athleteId');
    expect(Object.keys(full.detail)).not.toContain('fitFileHash');

    const charts = full.charts;
    expect(charts).not.toBeNull();
    if (charts === null) return;

    expect(charts.points.length).toBeLessThanOrEqual(600);
    expect(charts.points.length).toBeGreaterThan(1);
    expect(charts.points[0].timeS).toBe(0);
    // Distance rebasée sur le départ de la trace, pas le cumul brut du FIT.
    expect(charts.points[0].distanceM).toBe(0);
    expect(charts.points[charts.points.length - 1].distanceM).toBeCloseTo(2_600, 6);
    // 4 m/s constants → 250 s/km partout.
    for (const point of charts.points) {
      expect(point.paceSecPerKm).toBeCloseTo(250, 6);
      expect(point.cadenceSpm).toBe(172);
    }
    // La trace GPS n'est pas décimée.
    expect(charts.latlng).toHaveLength(POINT_COUNT);

    expect(full.splits.map((split) => split.km)).toEqual([1, 2, 3]);
    expect(full.splits.map((split) => split.distanceM)).toEqual([1000, 1000, 600]);
    expect(full.splits[0].avgHrBpm).toBe(140);
    expect(full.splits.map((split) => split.elevationGainM)).toEqual([0, 5, 0]);

    expect(full.hrZones).not.toBeNull();
    expect(full.hrZones?.map((zone) => zone.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(
      (full.hrZones ?? []).reduce((sum, zone) => sum + zone.share, 0),
    ).toBeCloseTo(1, 12);

    expect(full.trimp).toBeGreaterThan(0);
    expect(full.effectiveVo2max).toBeGreaterThan(20);
  });

  it('dégrade proprement une activité sans aucune série temporelle', async () => {
    queryState.rows = { activities: [ACTIVITY], athlete: [ATHLETE] };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.charts).toBeNull();
    expect(full?.splits).toEqual([]);
    expect(full?.hrZones).toBeNull();
    // Le TRIMP et la VO₂max viennent des colonnes de l'activité : ils restent.
    expect(full?.trimp).toBeGreaterThan(0);
    expect(full?.effectiveVo2max).toBeGreaterThan(20);
  });

  it('garde les graphes et les splits sans profil athlète', async () => {
    queryState.rows = { activities: [ACTIVITY], activity_streams: fullStreams() };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.charts?.points.length).toBeGreaterThan(1);
    expect(full?.splits).toHaveLength(3);
    // Sans FC max ni sexe au profil, rien n'est estimé.
    expect(full?.hrZones).toBeNull();
    expect(full?.trimp).toBeNull();
    expect(full?.effectiveVo2max).toBeNull();
  });

  it('garde la trace GPS et les zones sans stream de distance', async () => {
    const time = indexes();
    queryState.rows = {
      activities: [ACTIVITY],
      activity_streams: [
        stream('time', time),
        stream('heartrate', time.map(() => 150)),
        stream('latlng', time.map((): [number, number] => [48.85, 2.35])),
      ],
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.splits).toEqual([]);
    expect(full?.charts?.points[0].distanceM).toBeNull();
    expect(full?.charts?.points[0].paceSecPerKm).toBeNull();
    expect(full?.charts?.points[0].hrBpm).toBe(150);
    expect(full?.charts?.latlng).toHaveLength(POINT_COUNT);
    expect(full?.hrZones).not.toBeNull();
  });

  it('n’estime pas de VO₂max hors course à pied', async () => {
    queryState.rows = {
      activities: [{ ...ACTIVITY, sportType: 'Ride' }],
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.effectiveVo2max).toBeNull();
    expect(full?.trimp).toBeGreaterThan(0);
  });

  it('ignore une série dont la forme ne correspond pas au type déclaré', async () => {
    const time = indexes();
    queryState.rows = {
      activities: [ACTIVITY],
      activity_streams: [
        stream('time', time),
        stream('heartrate', time.map(() => 150)),
        // Écrit par erreur comme une série de couples : rejeté, pas planté.
        stream('latlng', time.map(() => 0)),
      ],
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.charts?.latlng).toBeNull();
    expect(full?.charts?.points[0].hrBpm).toBe(150);
  });
});
