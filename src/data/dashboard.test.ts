import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeLoadSeries, computeTrimp, estimateVdot } from '@/lib/metrics';
import type { DailyTrimp, EffortInput, LoadPoint, TrimpInput } from '@/lib/metrics';

import { getDashboardSummary } from './dashboard';
import type { Activity, Athlete, PlannedSession } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : la chaîne de requête est factice et sert les lignes
 * déclarées par table (les requêtes du dashboard visent des tables différentes).
 */
const { queryState } = vi.hoisted(() => ({
  queryState: {
    rows: {} as Record<string, unknown[]>,
    whereClauses: {} as Record<string, unknown>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: unknown) => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const chain: Chain = {
      where: (clause) => {
        queryState.whereClauses[name] = clause;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(queryState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return { db: { select: () => ({ from: chainFor }) } };
});

/**
 * `@/lib/metrics` est mocké : ce fichier teste l'agrégation (construction de la
 * série, propagation des `null`, découpage en semaines), pas les formules physio
 * — elles ont leurs propres tests.
 *
 * Conventions du double : 1 point de TRIMP par minute, CTL = index du jour dans
 * la série, VDOT = vitesse en m/s × 10.
 */
vi.mock('@/lib/metrics', () => ({
  computeTrimp: vi.fn((input: TrimpInput): number | null => {
    if (input.avgHrBpm === null || input.restingHrBpm === null || input.maxHrBpm === null) {
      return null;
    }
    return input.movingTimeS / 60;
  }),
  computeLoadSeries: vi.fn((daily: readonly DailyTrimp[]): LoadPoint[] =>
    daily.map((day, index) => ({
      date: day.date,
      ctl: index,
      atl: day.trimp,
      tsb: index - day.trimp,
    })),
  ),
  estimateVdot: vi.fn((effort: EffortInput): number | null =>
    effort.distanceM < 3_000 ? null : (effort.distanceM / effort.movingTimeS) * 10,
  ),
  paceSecPerKm: vi.fn(() => null),
}));

/** Aujourd'hui : lundi 10 août 2026 (semaine ISO 33), 11 h à Paris. */
const NOW = new Date('2026-08-10T09:00:00.000Z');

vi.useFakeTimers();
vi.setSystemTime(NOW);

afterAll(() => {
  vi.useRealTimers();
});

const ATHLETE: Athlete = {
  id: 1,
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 188,
  restingHrBpm: 48,
  weightKg: 58.5,
  birthDate: '1992-03-14',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-08-01T10:00:00.000Z'),
};

let nextActivityId = 1;

function makeActivity(overrides: Partial<Activity> & { startedAt: Date }): Activity {
  const id = nextActivityId++;
  return {
    id,
    athleteId: 1,
    fitFileHash: `hash-${id}`,
    name: 'Footing',
    sportType: 'Run',
    distanceM: 10_000,
    movingTimeS: 3_600,
    elapsedTimeS: 3_700,
    elevationGainM: 50,
    avgHrBpm: 140,
    maxHrBpm: 158,
    avgPaceSecPerKm: 360,
    avgCadenceSpm: 86,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

const PLANNED_SESSION: PlannedSession = {
  id: 7,
  athleteId: 1,
  scheduledOn: '2026-08-10',
  kind: 'VMA courte · piste',
  title: '6 × 800 m',
  targetPaceSecPerKm: 225,
  warmup: '20 min @ 5:30/km',
  recovery: '90 s en trot',
  cooldown: '10 min souple',
  volumeM: 12_400,
  durationS: 3_900,
  completedActivityId: null,
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
};

/** Valeurs liées aux paramètres d'une clause `where` Drizzle (hors morceaux SQL). */
function boundValues(node: unknown): unknown[] {
  if (node === null || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) return record.queryChunks.flatMap(boundValues);
  if ('value' in record && !Array.isArray(record.value)) return [record.value];
  return [];
}

/** Une activité par jour, du `from` au `to` inclus (dates civiles). */
function dailyActivities(from: string, to: string): Activity[] {
  const rows: Activity[] = [];
  for (
    let ms = Date.parse(`${to}T09:00:00.000Z`);
    ms >= Date.parse(`${from}T09:00:00.000Z`);
    ms -= 86_400_000
  ) {
    rows.push(makeActivity({ startedAt: new Date(ms) }));
  }
  return rows;
}

beforeEach(() => {
  queryState.rows = {};
  queryState.whereClauses = {};
  nextActivityId = 1;
  vi.clearAllMocks();
});

describe('getDashboardSummary — base vide', () => {
  it('retourne un état vide explicite quand aucun athlète n’est enregistré', async () => {
    const summary = await getDashboardSummary();

    expect(summary).toEqual({
      athleteName: null,
      fitness: null,
      vo2max: null,
      loadWeeks: [],
      todaySession: null,
      recentActivities: [],
    });
  });

  it('n’invente rien quand l’athlète existe mais n’a aucune activité', async () => {
    queryState.rows.athlete = [ATHLETE];

    const summary = await getDashboardSummary();

    expect(summary.athleteName).toBe('Gwen');
    expect(summary.fitness).toBeNull();
    expect(summary.vo2max).toBeNull();
    expect(summary.loadWeeks).toEqual([]);
    expect(summary.recentActivities).toEqual([]);
    expect(computeLoadSeries).not.toHaveBeenCalled();
  });
});

describe('getDashboardSummary — série TRIMP quotidienne', () => {
  it('agrège par jour civil, comble les jours de repos et s’arrête aujourd’hui', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-08T07:00:00.000Z'), movingTimeS: 1_800 }),
      // 00 h 30 à Paris le 6 août : c'est bien la journée du 6, pas celle du 5.
      makeActivity({ startedAt: new Date('2026-08-05T22:30:00.000Z'), movingTimeS: 600 }),
      makeActivity({ startedAt: new Date('2026-08-06T09:00:00.000Z'), movingTimeS: 3_000 }),
    ];

    await getDashboardSummary();

    expect(computeLoadSeries).toHaveBeenCalledWith([
      { date: '2026-08-06', trimp: 60 },
      { date: '2026-08-07', trimp: 0 },
      { date: '2026-08-08', trimp: 30 },
      { date: '2026-08-09', trimp: 0 },
      { date: '2026-08-10', trimp: 0 },
    ]);
  });

  it('transmet la FC de repos et la FC max de l’athlète à chaque calcul', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-08T07:00:00.000Z'), avgHrBpm: 151 }),
    ];

    await getDashboardSummary();

    expect(computeTrimp).toHaveBeenCalledWith({
      movingTimeS: 3_600,
      avgHrBpm: 151,
      restingHrBpm: 48,
      maxHrBpm: 188,
      sex: 'female',
    });
  });

  it('ignore les activités dont le TRIMP n’est pas calculable', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-08T07:00:00.000Z'), avgHrBpm: null }),
      makeActivity({ startedAt: new Date('2026-08-07T07:00:00.000Z'), movingTimeS: 1_200 }),
    ];

    await getDashboardSummary();

    expect(computeLoadSeries).toHaveBeenCalledWith([
      { date: '2026-08-07', trimp: 20 },
      { date: '2026-08-08', trimp: 0 },
      { date: '2026-08-09', trimp: 0 },
      { date: '2026-08-10', trimp: 0 },
    ]);
  });

  it('ne calcule aucune charge quand plus aucune activité n’a de FC', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-08T07:00:00.000Z'), avgHrBpm: null }),
    ];

    const summary = await getDashboardSummary();

    expect(computeLoadSeries).not.toHaveBeenCalled();
    expect(summary.fitness).toBeNull();
    expect(summary.loadWeeks).toEqual([]);
  });

  it('ne calcule aucune charge tant que le sexe de l’athlète n’est pas renseigné', async () => {
    queryState.rows.athlete = [{ ...ATHLETE, sex: null }];
    queryState.rows.activities = dailyActivities('2026-07-01', '2026-08-09');

    const summary = await getDashboardSummary();

    expect(computeTrimp).not.toHaveBeenCalled();
    expect(summary.fitness).toBeNull();
    expect(summary.loadWeeks).toEqual([]);
  });
});

describe('getDashboardSummary — fitness', () => {
  it('reprend le dernier point de la série et la variation de CTL sur 7 jours', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-07-01', '2026-08-09');

    const summary = await getDashboardSummary();

    // Série dense du 1er juillet au 10 août : 41 jours, dernier index 40.
    expect(summary.fitness).toEqual({ ctl: 40, atl: 0, tsb: 40, ctlDelta7d: 7 });
  });

  it('laisse `ctlDelta7d` à null quand l’historique fait moins de huit jours', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-08-05', '2026-08-09');

    const summary = await getDashboardSummary();

    expect(summary.fitness).toEqual({ ctl: 5, atl: 0, tsb: 5, ctlDelta7d: null });
  });
});

describe('getDashboardSummary — charge hebdomadaire', () => {
  it('donne la CTL de fin des six dernières semaines ISO', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-07-01', '2026-08-09');

    const summary = await getDashboardSummary();

    expect(summary.loadWeeks).toEqual([
      // Dimanches 12, 19, 26 juillet, 2 et 9 août ; puis le jour même pour la
      // semaine en cours, qui n'est pas terminée.
      { weekLabel: 'S28', ctl: 11 },
      { weekLabel: 'S29', ctl: 18 },
      { weekLabel: 'S30', ctl: 25 },
      { weekLabel: 'S31', ctl: 32 },
      { weekLabel: 'S32', ctl: 39 },
      { weekLabel: 'S33', ctl: 40 },
    ]);
  });

  it('omet les semaines antérieures au début de l’historique', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-08-03', '2026-08-09');

    const summary = await getDashboardSummary();

    expect(summary.loadWeeks).toEqual([
      { weekLabel: 'S32', ctl: 6 },
      { weekLabel: 'S33', ctl: 7 },
    ]);
  });
});

describe('getDashboardSummary — VO₂max', () => {
  it('retient le meilleur VDOT des 30 derniers jours et le compare aux 30 précédents', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-01T09:00:00.000Z'), movingTimeS: 2_000 }),
      makeActivity({ startedAt: new Date('2026-07-20T09:00:00.000Z'), movingTimeS: 2_500 }),
      makeActivity({ startedAt: new Date('2026-07-05T09:00:00.000Z'), movingTimeS: 2_500 }),
      // Plus de 60 jours : hors des deux fenêtres, malgré un VDOT bien meilleur.
      makeActivity({ startedAt: new Date('2026-06-05T09:00:00.000Z'), movingTimeS: 1_000 }),
    ];

    const summary = await getDashboardSummary();

    // 10 km en 2 000 s → 50 ; meilleur des 30 jours précédents : 10 km en 2 500 s → 40.
    expect(summary.vo2max).toEqual({ value: 50, delta30d: 10 });
  });

  it('ignore les sports qui ne sont pas de la course à pied', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({
        startedAt: new Date('2026-08-01T09:00:00.000Z'),
        sportType: 'Ride',
        distanceM: 60_000,
        movingTimeS: 6_000,
      }),
      makeActivity({ startedAt: new Date('2026-08-02T09:00:00.000Z'), movingTimeS: 2_500 }),
    ];

    const summary = await getDashboardSummary();

    expect(estimateVdot).toHaveBeenCalledTimes(1);
    expect(summary.vo2max).toEqual({ value: 40, delta30d: null });
  });

  it('retourne null quand aucun effort récent n’est exploitable', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-01T09:00:00.000Z'), distanceM: 1_200 }),
      makeActivity({ startedAt: new Date('2026-06-01T09:00:00.000Z'), movingTimeS: 2_000 }),
    ];

    const summary = await getDashboardSummary();

    expect(summary.vo2max).toBeNull();
  });
});

describe('getDashboardSummary — séance du jour', () => {
  it('interroge la table sur la date civile du jour et l’athlète courant', async () => {
    queryState.rows.athlete = [ATHLETE];

    await getDashboardSummary();

    expect(boundValues(queryState.whereClauses.planned_sessions)).toEqual(
      expect.arrayContaining([1, '2026-08-10']),
    );
  });

  it('expose un DTO minimal, sans identifiant interne', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.planned_sessions = [PLANNED_SESSION];

    const summary = await getDashboardSummary();

    expect(summary.todaySession).toEqual({
      id: 7,
      scheduledOn: '2026-08-10',
      kind: 'VMA courte · piste',
      title: '6 × 800 m',
      targetPaceSecPerKm: 225,
      warmup: '20 min @ 5:30/km',
      recovery: '90 s en trot',
      cooldown: '10 min souple',
      volumeM: 12_400,
      durationS: 3_900,
    });
    expect(summary.todaySession).not.toHaveProperty('athleteId');
    expect(summary.todaySession).not.toHaveProperty('completedActivityId');
  });

  it('retourne null quand rien n’est planifié aujourd’hui', async () => {
    queryState.rows.athlete = [ATHLETE];

    const summary = await getDashboardSummary();

    expect(summary.todaySession).toBeNull();
  });
});

describe('getDashboardSummary — dernières activités', () => {
  it('expose les trois plus récentes sous forme de DTO', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-08-01', '2026-08-09');

    const summary = await getDashboardSummary();

    expect(summary.recentActivities).toHaveLength(3);
    expect(summary.recentActivities.map((activity) => activity.startedAt)).toEqual([
      new Date('2026-08-09T09:00:00.000Z'),
      new Date('2026-08-08T09:00:00.000Z'),
      new Date('2026-08-07T09:00:00.000Z'),
    ]);
    expect(summary.recentActivities[0]).not.toHaveProperty('fitFileHash');
    expect(summary.recentActivities[0]).not.toHaveProperty('athleteId');
  });
});
