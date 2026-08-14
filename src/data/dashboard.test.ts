import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeLoadSeries, computeTrimp, estimateEffectiveVo2max } from '@/lib/metrics';
import type {
  DailyTrimp,
  EffectiveVo2maxInput,
  LoadPoint,
  TrimpInput,
} from '@/lib/metrics';

import { getDashboardSummary } from './dashboard';
import type { Activity, Athlete, PlannedSession } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * L'athlète appartient à un compte : le DAL le résout depuis la session
 * (`getCurrentAthlete`). Les tests de ce fichier travaillent donc sous une
 * session ouverte, sauf ceux qui éprouvent le cas « pas encore d'athlète » —
 * ils appellent `withoutSession()`, et le DAL ne rend alors aucun athlète.
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

beforeEach(() => {
  sessionState.current = { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' };
});

/**
 * Aucune base de données : la chaîne de requête est factice et sert les lignes
 * déclarées par table (les requêtes du dashboard visent des tables différentes).
 */
const { queryState } = vi.hoisted(() => ({
  queryState: {
    rows: {} as Record<string, unknown[]>,
    whereClauses: {} as Record<string, SQL | undefined>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    leftJoin: () => Chain;
    innerJoin: () => Chain;
    where: (clause: SQL) => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const chain: Chain = {
      leftJoin: () => chain,
      innerJoin: () => chain,
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

const dialect = new PgDialect();

/** Clause `WHERE` rendue en SQL + paramètres liés, pour l'affirmer telle qu'elle partira. */
function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée pour cette requête.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

/**
 * `@/lib/metrics` est mocké : ce fichier teste l'agrégation (construction de la
 * série, propagation des `null`, découpage en semaines), pas les formules physio
 * — elles ont leurs propres tests.
 *
 * Conventions du double : 1 point de TRIMP par minute, CTL = index du jour dans
 * la série, VO₂max effective = vitesse en m/s × 10 (et `null` sans FC, ou sous
 * 3 km — de quoi vérifier la propagation des cas non calculables).
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
  estimateEffectiveVo2max: vi.fn((input: EffectiveVo2maxInput): number | null => {
    if (input.avgHrBpm === null || input.maxHrBpm === null) return null;
    if (input.distanceM < 3_000) return null;
    return (input.distanceM / input.movingTimeS) * 10;
  }),
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
  userId: 'user_1',
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 188,
  restingHrBpm: 48,
  weightKg: 58.5,
  birthDate: '1992-03-14',
  intervalsAthleteId: null,
  intervalsApiKeyEncrypted: null,
  forecastLocationLabel: null,
  forecastLatitudeDeg: null,
  forecastLongitudeDeg: null,
  maxHrSuggestionDismissedBpm: null,
  restingHrSuggestionDismissedBpm: null,
  wellnessReadingDay: null,
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
    sustainedMaxHrBpm: null,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

const PLANNED_SESSION: PlannedSession = {
  id: 7,
  athleteId: 1,
  planId: null,
  scheduledOn: '2026-08-10',
  kind: 'VMA courte · piste',
  title: '6 × 800 m',
  targetPaceSecPerKm: 225,
  warmup: '20 min @ 5:30/km',
  recovery: '90 s en trot',
  cooldown: '10 min souple',
  volumeM: 12_400,
  durationS: 3_900,
  steps: null,
  completedActivityId: null,
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
};

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
    withoutSession();
    const summary = await getDashboardSummary();

    expect(summary).toEqual({
      athleteName: null,
      fitness: null,
      fitnessUnavailable: null,
      vo2max: null,
      vo2maxUnavailable: null,
      loadWeeks: [],
      todaySession: null,
      // Le jour courant est rendu même sans athlète : c'est lui qui datera
      // l'écran, et il ne dépend d'aucune donnée.
      today: '2026-08-10',
      // Sans athlète, il n'y a ni séance ni lieu : rien à prévoir, et un état
      // explicite plutôt qu'un `null` de plus.
      forecast: { status: null, fetchedAt: null, location: { source: 'derived' }, days: [] },
      recentActivities: [],
      // Sans athlète, il n'y a aucune séance : rien à proposer.
      maxHrSuggestion: null,
      // Ni plan, donc aucune réévaluation en attente.
      planRevision: null,
      // Aucun relevé bien-être n'a pu être rapatrié : les trois mesures sont
      // absentes, et la tuile le dira plutôt que de rester blanche.
      wellness: { today: '2026-08-10', restingHr: null, hrv: null, sleep: null },
      restingHrSuggestion: null,
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
  it('moyenne les 30 derniers jours en pondérant par la durée, et compare aux 30 précédents', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-01T09:00:00.000Z'), movingTimeS: 2_000 }),
      makeActivity({
        startedAt: new Date('2026-07-20T09:00:00.000Z'),
        distanceM: 12_000,
        movingTimeS: 3_000,
      }),
      makeActivity({ startedAt: new Date('2026-07-05T09:00:00.000Z'), movingTimeS: 2_500 }),
      // Plus de 60 jours : hors des deux fenêtres, malgré une valeur bien meilleure.
      makeActivity({ startedAt: new Date('2026-06-05T09:00:00.000Z'), movingTimeS: 1_000 }),
    ];

    const summary = await getDashboardSummary();

    /*
     * Fenêtre courante : 50 sur 2 000 s et 40 sur 3 000 s
     * → (50 × 2 000 + 40 × 3 000) / 5 000 = 44 (le maximum brut aurait dit 50,
     * la moyenne simple 45 — la pondération est bien celle qui s'applique).
     * Fenêtre précédente : 10 km en 2 500 s → 40.
     */
    expect(summary.vo2max).toEqual({ value: 44, delta30d: 4 });
    expect(summary.vo2maxUnavailable).toBeNull();
  });

  it('empêche une séance courte et aberrante de dominer la moyenne', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      // Sortie longue, représentative.
      makeActivity({ startedAt: new Date('2026-08-01T09:00:00.000Z'), movingTimeS: 4_000 }),
      // Sprint de 5 min à allure GPS douteuse : quatorze fois moins lourd.
      makeActivity({
        startedAt: new Date('2026-08-02T09:00:00.000Z'),
        distanceM: 4_500,
        movingTimeS: 300,
      }),
    ];

    const summary = await getDashboardSummary();

    // (25 × 4 000 + 150 × 300) / 4 300 = 33.72… — loin des 150 du maximum brut.
    expect(summary.vo2max?.value).toBeCloseTo(33.721, 3);
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

    expect(estimateEffectiveVo2max).toHaveBeenCalledTimes(1);
    expect(summary.vo2max).toEqual({ value: 40, delta30d: null });
  });

  it('transmet la FC de la séance et la FC max du profil à l’estimation', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-01T09:00:00.000Z'), avgHrBpm: 151 }),
    ];

    await getDashboardSummary();

    expect(estimateEffectiveVo2max).toHaveBeenCalledWith({
      distanceM: 10_000,
      movingTimeS: 3_600,
      avgHrBpm: 151,
      maxHrBpm: 188,
    });
  });

  it('écarte de la moyenne les courses sans fréquence cardiaque', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-01T09:00:00.000Z'), movingTimeS: 2_000 }),
      makeActivity({
        startedAt: new Date('2026-08-02T09:00:00.000Z'),
        movingTimeS: 5_000,
        avgHrBpm: null,
      }),
    ];

    const summary = await getDashboardSummary();

    // Seule la première compte : sans elle, la seconde tirerait la moyenne à 20.
    expect(summary.vo2max).toEqual({ value: 50, delta30d: null });
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

describe('getDashboardSummary — causes d’indisponibilité', () => {
  it('ne renseigne aucune cause quand les deux indicateurs sont calculés', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-07-01', '2026-08-09');

    const summary = await getDashboardSummary();

    expect(summary.fitness).not.toBeNull();
    expect(summary.fitnessUnavailable).toBeNull();
    expect(summary.vo2max).not.toBeNull();
    expect(summary.vo2maxUnavailable).toBeNull();
  });

  it.each([
    ['sexe', { sex: null }, ['sex']],
    ['FC max', { maxHrBpm: null }, ['maxHrBpm']],
    ['FC de repos', { restingHrBpm: null }, ['restingHrBpm']],
    [
      'tout le profil physiologique',
      { sex: null, maxHrBpm: null, restingHrBpm: null },
      ['sex', 'maxHrBpm', 'restingHrBpm'],
    ],
  ])(
    'désigne le champ de profil manquant pour la charge (%s)',
    async (_label, missing, expected) => {
      queryState.rows.athlete = [{ ...ATHLETE, ...missing }];
      queryState.rows.activities = dailyActivities('2026-07-01', '2026-08-09');

      const summary = await getDashboardSummary();

      expect(summary.fitness).toBeNull();
      expect(summary.fitnessUnavailable).toEqual({
        missingProfileFields: expected,
        noHeartRateData: false,
      });
    },
  );

  it('signale l’absence totale de fréquence cardiaque plutôt qu’un profil incomplet', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-08T07:00:00.000Z'), avgHrBpm: null }),
    ];

    const summary = await getDashboardSummary();

    expect(summary.fitnessUnavailable).toEqual({
      missingProfileFields: [],
      noHeartRateData: true,
    });
  });

  it('signale les deux causes à la fois quand elles coexistent', async () => {
    queryState.rows.athlete = [{ ...ATHLETE, sex: null }];
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-08T07:00:00.000Z'), avgHrBpm: null }),
    ];

    const summary = await getDashboardSummary();

    expect(summary.fitnessUnavailable).toEqual({
      missingProfileFields: ['sex'],
      noHeartRateData: true,
    });
  });

  it('distingue la FC max manquante de l’absence de course avec FC', async () => {
    queryState.rows.athlete = [{ ...ATHLETE, maxHrBpm: null }];
    queryState.rows.activities = dailyActivities('2026-07-20', '2026-08-09');

    const summary = await getDashboardSummary();

    expect(summary.vo2max).toBeNull();
    expect(summary.vo2maxUnavailable).toEqual({
      missingMaxHrBpm: true,
      // Les courses avec FC existent bel et bien : c'est le profil qui bloque.
      noRecentRunWithHeartRate: false,
    });
  });

  it('signale l’absence de course avec FC sur les 30 derniers jours', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      // Course avec FC, mais vieille de plus de 30 jours.
      makeActivity({ startedAt: new Date('2026-06-20T09:00:00.000Z') }),
      // Récente, mais sans FC.
      makeActivity({ startedAt: new Date('2026-08-05T09:00:00.000Z'), avgHrBpm: null }),
      // Récente et avec FC, mais ce n'est pas de la course à pied.
      makeActivity({ startedAt: new Date('2026-08-06T09:00:00.000Z'), sportType: 'Ride' }),
    ];

    const summary = await getDashboardSummary();

    expect(summary.vo2maxUnavailable).toEqual({
      missingMaxHrBpm: false,
      noRecentRunWithHeartRate: true,
    });
  });

  it('ne pointe aucune cause franche quand les courses récentes sont simplement inexploitables', async () => {
    queryState.rows.athlete = [ATHLETE];
    // Avec FC et récentes, mais trop courtes pour l'estimation (< 3 km ici).
    queryState.rows.activities = [
      makeActivity({ startedAt: new Date('2026-08-05T09:00:00.000Z'), distanceM: 1_200 }),
    ];

    const summary = await getDashboardSummary();

    expect(summary.vo2max).toBeNull();
    expect(summary.vo2maxUnavailable).toEqual({
      missingMaxHrBpm: false,
      noRecentRunWithHeartRate: false,
    });
  });
});

describe('getDashboardSummary — séance du jour', () => {
  it('interroge la table sur la date civile du jour et l’athlète courant', async () => {
    queryState.rows.athlete = [ATHLETE];

    await getDashboardSummary();

    const where = renderWhere(queryState.whereClauses.planned_sessions);
    expect(where.params).toEqual(expect.arrayContaining([1, '2026-08-10']));
    expect(where.sql).toContain('"athlete_id" = $1');
    expect(where.sql).toContain('"scheduled_on" = $2');
  });

  it('écarte les séances d’un plan archivé, mais garde celles hors plan', async () => {
    queryState.rows.athlete = [ATHLETE];

    await getDashboardSummary();

    const where = renderWhere(queryState.whereClauses.planned_sessions);
    // Le cœur du filtre : soit la séance n'appartient à aucun plan, soit son plan
    // est encore actif — ni un plan archivé, ni une proposition en attente de
    // décision ne pilotent quoi que ce soit.
    expect(where.sql).toContain('"plan_id" is null or "plans"."status" = $3');
    expect(where.params).toEqual([1, '2026-08-10', 'active']);
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

describe('getDashboardSummary — proposition de FC max', () => {
  it('rend null quand aucune séance ne porte de FC max soutenue', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-08-01', '2026-08-09');

    await expect(getDashboardSummary()).resolves.toMatchObject({ maxHrSuggestion: null });
  });

  it('remonte la proposition du DAL, réduite à ce que la carte affiche', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({
        startedAt: new Date('2026-08-09T09:00:00.000Z'),
        name: '10 km de Bordeaux',
        sustainedMaxHrBpm: 194,
      }),
    ];

    const summary = await getDashboardSummary();

    expect(summary.maxHrSuggestion).toEqual({
      bpm: 194,
      activityId: expect.any(Number),
      activityName: '10 km de Bordeaux',
      activityStartedAt: new Date('2026-08-09T09:00:00.000Z'),
    });
  });
});
