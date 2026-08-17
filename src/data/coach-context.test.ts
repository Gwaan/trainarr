import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shiftCivilDate } from '@/lib/dates/civil';

import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import {
  COACH_RECENT_DAYS,
  COACH_UPCOMING_DAYS,
  ageYearsOn,
  buildRecentWeeks,
  buildUpcomingSessions,
  getComparableActivities,
  getPlanContext,
  getTrainingSnapshot,
  getWellnessContext,
  longestRunKm,
  recentRunPace,
  toComparableActivityDto,
  toSnapshotProfile,
} from './coach-context';
import type { Activity, Athlete } from './db/schema';
import type { PlanDto, PlanSessionDto } from './plans';

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

const { plansDal } = vi.hoisted(() => ({
  plansDal: { getActivePlanWithSessions: vi.fn() },
}));

vi.mock('./plans', async () => {
  // Seule la lecture qui touche la base est remplacée : `planEndExclusive`, dont
  // dépend l'échéance annoncée au coach, reste le vrai code.
  const actual = await vi.importActual<typeof import('./plans')>('./plans');
  return { ...actual, getActivePlanWithSessions: plansDal.getActivePlanWithSessions };
});

/**
 * Aucune base de données : les lectures servent les lignes déclarées par table.
 * Le filtrage réel vit dans la clause `WHERE` (fenêtre de distance, sport,
 * antériorité) — le faux client ne l'applique pas, les tests l'inspectent
 * telle qu'elle partira (cf. `renderWhere`), exactement comme `plans.test.ts`.
 *
 * `queue` sert les lectures successives d'une même table : `getComparableActivities`
 * lit `activities` deux fois (la séance de référence, puis ses comparables).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    queue: {} as Record<string, unknown[][]>,
    selects: [] as Array<{ table: string; where: SQL }>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type SelectChain = PromiseLike<unknown[]> & {
    leftJoin: () => SelectChain;
    where: (clause: SQL) => SelectChain;
    orderBy: () => SelectChain;
    limit: () => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      // La lecture des courses déclarées joint `activities` (cf. `./race-results`).
      leftJoin: () => chain,
      where: (clause) => {
        dbState.selects.push({ table: name, where: clause });
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) => {
        const queued = dbState.queue[name];
        const rows = queued && queued.length > 0 ? queued.shift() : dbState.rows[name];
        return Promise.resolve(rows ?? []).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  return {
    db: { select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }) },
  };
});

const dialect = new PgDialect();

/** Clause `WHERE` rendue en SQL + paramètres liés, pour l'affirmer telle qu'elle partira. */
function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée pour cette requête.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

const ATHLETE_ROW: Athlete = {
  id: 1,
  userId: 'user_1',
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 188,
  restingHrBpm: 48,
  weightKg: 62,
  birthDate: '1990-06-15',
  intervalsAthleteId: null,
  intervalsApiKeyEncrypted: null,
  forecastLocationLabel: null,
  forecastLatitudeDeg: null,
  forecastLongitudeDeg: null,
  maxHrSuggestionDismissedBpm: null,
  restingHrSuggestionDismissedBpm: null,
  lthrBpm: null,
  lthrSuggestionDismissedBpm: null,
  wellnessReadingDay: null,
  pushDailySession: true,
  pushActivityAnalyzed: true,
  vo2maxElevationCorrection: true,
  vo2maxAscentCoefM: 2,
  vo2maxDescentCoefM: -1,
  vo2maxCorrectionFactor: null,
  pushSuggestions: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** Une course type — chaque test n'en modifie que ce qu'il éprouve. */
function run(overrides: Partial<Activity> & { startedAt: Date }): Activity {
  return {
    id: 1,
    athleteId: 1,
    fitFileHash: null,
    name: 'Footing',
    sportType: 'Run',
    distanceM: 10_000,
    movingTimeS: 3_000,
    elapsedTimeS: 3_100,
    elevationGainM: 80,
    avgHrBpm: 145,
    maxHrBpm: 168,
    avgPaceSecPerKm: 300,
    avgCadenceSpm: 172,
    elevationLossM: null,
    elevationScannedAt: null,
    bestSegmentsScannedAt: null,
    sustainedMaxHrBpm: null,
    lthrSampleBpm: null,
    lthrSampleSource: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Un plan de course type — 8 semaines à partir du lundi 3 août 2026. */
const PLAN_ROW: PlanDto = {
  id: 3,
  status: 'active',
  goalType: 'race',
  intent: 'race',
  returnInjuryHistory: false,
  level: 'intermediate',
  goalText: 'Semi de Lyon en 1 h 45',
  raceDate: '2026-09-27',
  startsOn: '2026-08-03',
  weeks: 8,
  sessionsPerWeek: 4,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: '10k',
  referenceTimeS: 2_700,
  referenceUpdatedOn: null,
  lastTestNote: null,
  summary: null,
  reviewedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

/** Une séance planifiée type — chaque test n'en modifie que ce qu'il éprouve. */
function planSession(overrides: Partial<PlanSessionDto> & { scheduledOn: string }): PlanSessionDto {
  return {
    id: 1,
    kind: 'Endurance fondamentale',
    title: 'Footing 8 km',
    warmup: null,
    recovery: null,
    cooldown: null,
    targetPaceSecPerKm: null,
    volumeM: 8_000,
    durationS: null,
    steps: null,
    completedActivityId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Un mardi : la semaine ISO en cours commence le lundi 10 août 2026.
  vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));
  dbState.rows = {};
  dbState.queue = {};
  dbState.selects = [];
  plansDal.getActivePlanWithSessions.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ageYearsOn', () => {
  it('compte les années révolues', () => {
    expect(ageYearsOn('1990-06-15', '2026-08-11')).toBe(36);
  });

  it("ne compte pas l'année en cours tant que l'anniversaire n'est pas passé", () => {
    expect(ageYearsOn('1990-12-24', '2026-08-11')).toBe(35);
  });

  it("compte l'année le jour même de l'anniversaire", () => {
    expect(ageYearsOn('1990-08-11', '2026-08-11')).toBe(36);
  });
});

describe('toSnapshotProfile', () => {
  it('omet les champs non renseignés plutôt que de les rendre à `null`', () => {
    const profile = toSnapshotProfile(
      { ...ATHLETE_ROW, sex: null, restingHrBpm: null, weightKg: null, birthDate: null },
      '2026-08-11',
    );

    expect(profile).toEqual({ maxHrBpm: 188 });
    expect(Object.keys(profile)).not.toContain('sex');
  });

  it('rend le profil complet, âge dérivé de la date de naissance', () => {
    expect(toSnapshotProfile(ATHLETE_ROW, '2026-08-11')).toEqual({
      ageYears: 36,
      sex: 'female',
      maxHrBpm: 188,
      restingHrBpm: 48,
      weightKg: 62,
    });
  });
});

describe('buildRecentWeeks', () => {
  it('rend 4 semaines de la plus ancienne à la semaine en cours', () => {
    const weeks = buildRecentWeeks([], '2026-08-11');

    expect(weeks.map((week) => week.startsOn)).toEqual([
      '2026-07-20',
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
    ]);
    expect(weeks.every((week) => week.sessions === 0)).toBe(true);
  });

  it('cumule distance, temps et nombre de séances dans la bonne semaine', () => {
    const weeks = buildRecentWeeks(
      [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 12_000, movingTimeS: 3_600 }),
        run({ startedAt: new Date('2026-08-11T06:00:00.000Z'), distanceM: 8_000, movingTimeS: 2_400 }),
        run({ startedAt: new Date('2026-07-21T06:00:00.000Z'), distanceM: 5_000, movingTimeS: 1_500 }),
      ],
      '2026-08-11',
    );

    expect(weeks[3]).toEqual({
      startsOn: '2026-08-10',
      distanceKm: 20,
      movingTimeS: 6_000,
      sessions: 2,
    });
    expect(weeks[0].distanceKm).toBe(5);
  });

  it('ignore les autres sports, le futur et ce qui précède la fenêtre', () => {
    const weeks = buildRecentWeeks(
      [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), sportType: 'Ride', distanceM: 60_000 }),
        run({ startedAt: new Date('2026-08-14T06:00:00.000Z'), distanceM: 15_000 }),
        run({ startedAt: new Date('2026-07-01T06:00:00.000Z'), distanceM: 15_000 }),
      ],
      '2026-08-11',
    );

    expect(weeks.every((week) => week.sessions === 0)).toBe(true);
  });
});

/*
 * La plus longue course des 30 derniers jours : l'entrée du plafond de sortie
 * longue d'une reprise (Frandsen 2025). Un plafond calculé sur une donnée fausse
 * serait pire que pas de plafond du tout — d'où les trois gardes ci-dessous.
 */
describe('longestRunKm', () => {
  it('rend la plus longue course de la fenêtre, en km', () => {
    expect(
      longestRunKm(
        [
          run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 12_000 }),
          run({ startedAt: new Date('2026-07-20T06:00:00.000Z'), distanceM: 18_400 }),
          run({ startedAt: new Date('2026-08-01T06:00:00.000Z'), distanceM: 9_000 }),
        ],
        '2026-08-11',
      ),
    ).toBe(18.4);
  });

  it('ignore les autres sports, le futur et ce qui précède la fenêtre', () => {
    expect(
      longestRunKm(
        [
          // Une sortie vélo ne dit rien de ce qu'une sortie longue à pied coûte.
          run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), sportType: 'Ride', distanceM: 60_000 }),
          run({ startedAt: new Date('2026-08-14T06:00:00.000Z'), distanceM: 30_000 }),
          // 31 jours avant : hors fenêtre, donc muette.
          run({ startedAt: new Date('2026-07-11T06:00:00.000Z'), distanceM: 25_000 }),
          run({ startedAt: new Date('2026-07-12T06:00:00.000Z'), distanceM: 6_000 }),
        ],
        '2026-08-11',
      ),
    ).toBe(6);
  });

  it('rend `null` sans course exploitable — pas un plafond de zéro kilomètre', () => {
    expect(longestRunKm([], '2026-08-11')).toBeNull();
    expect(
      longestRunKm([run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 0 })], '2026-08-11'),
    ).toBeNull();
  });
});

describe('recentRunPace', () => {
  it('pondère par la distance plutôt que de moyenner les allures', () => {
    const pace = recentRunPace(
      [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 10_000, movingTimeS: 3_000 }),
        run({ startedAt: new Date('2026-08-08T06:00:00.000Z'), distanceM: 5_000, movingTimeS: 1_800 }),
      ],
      5,
    );

    // 15 km en 4 800 s → 320 s/km, et non la moyenne (300 + 360) / 2 = 330.
    expect(pace).toBe(320);
  });

  it('ne retient que les `limit` courses les plus récentes', () => {
    const pace = recentRunPace(
      [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 10_000, movingTimeS: 3_000 }),
        run({ startedAt: new Date('2026-01-01T06:00:00.000Z'), distanceM: 10_000, movingTimeS: 6_000 }),
      ],
      1,
    );

    expect(pace).toBe(300);
  });

  it('rend `null` sans aucune course exploitable', () => {
    expect(recentRunPace([run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), sportType: 'Ride' })])).toBeNull();
    expect(recentRunPace([run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 0 })])).toBeNull();
  });
});

describe('toComparableActivityDto', () => {
  it('rend un TRIMP calculé quand le profil le permet', () => {
    const dto = toComparableActivityDto(
      run({ startedAt: new Date('2026-08-04T06:00:00.000Z') }),
      ATHLETE_ROW,
    );

    expect(dto.date).toBe('2026-08-04');
    expect(dto.trimp).not.toBeNull();
    expect(dto.avgPaceSecPerKm).toBe(300);
  });

  it("laisse le TRIMP à `null` quand le sexe n'est pas renseigné (Banister est sexué)", () => {
    const dto = toComparableActivityDto(run({ startedAt: new Date('2026-08-04T06:00:00.000Z') }), {
      ...ATHLETE_ROW,
      sex: null,
    });

    expect(dto.trimp).toBeNull();
  });
});

describe('getTrainingSnapshot', () => {
  it("rend un instantané entièrement vide tant qu'aucun athlète n'existe", async () => {
    // Le snapshot ne résout plus l'athlète : il le reçoit, et `null` est l'état
    // « pas encore d'athlète » que la couche appelante lui transmet.
    const snapshot = await getTrainingSnapshot(null);

    expect(snapshot).toEqual({
      today: '2026-08-11',
      profile: {},
      fitness: null,
      vo2max: null,
      weeks: [],
      longestSessionKm30d: null,
      recentAvgPaceSecPerKm: null,
    });
  });

  it('assemble profil, charge, volume hebdomadaire et allure de référence', async () => {
    dbState.rows = {
      athlete: [ATHLETE_ROW],
      activities: [
        run({ startedAt: new Date('2026-08-10T06:00:00.000Z'), distanceM: 12_000, movingTimeS: 3_600 }),
        run({ startedAt: new Date('2026-08-06T06:00:00.000Z'), distanceM: 8_000, movingTimeS: 2_400 }),
      ],
    };

    const snapshot = await getTrainingSnapshot(1);

    expect(snapshot.today).toBe('2026-08-11');
    expect(snapshot.profile.ageYears).toBe(36);
    expect(snapshot.fitness).not.toBeNull();
    expect(snapshot.weeks).toHaveLength(4);
    expect(snapshot.weeks[3].distanceKm).toBe(12);
    expect(snapshot.longestSessionKm30d).toBe(12);
    expect(snapshot.recentAvgPaceSecPerKm).toBe(300);
  });

  it("laisse la charge à `null` quand le sexe manque : le TRIMP n'est pas calculable", async () => {
    dbState.rows = {
      athlete: [{ ...ATHLETE_ROW, sex: null }],
      activities: [run({ startedAt: new Date('2026-08-10T06:00:00.000Z') })],
    };

    const snapshot = await getTrainingSnapshot(1);

    expect(snapshot.fitness).toBeNull();
    expect(snapshot.profile.sex).toBeUndefined();
  });
});

describe('getComparableActivities', () => {
  it('rend une liste vide sans athlète', async () => {
    withoutSession();
    expect(await getComparableActivities(7)).toEqual([]);
  });

  it("rend une liste vide quand l'activité n'est pas celle de l'athlète", async () => {
    dbState.rows = { athlete: [ATHLETE_ROW] };
    dbState.queue = { activities: [[]] };

    expect(await getComparableActivities(7)).toEqual([]);
  });

  it('borne la recherche au même sport, à ±25 % de distance et à l’antériorité', async () => {
    const reference = run({
      id: 7,
      startedAt: new Date('2026-08-11T06:00:00.000Z'),
      distanceM: 10_000,
      sportType: 'TrailRun',
    });
    const older = run({ id: 4, startedAt: new Date('2026-08-04T06:00:00.000Z'), distanceM: 9_500 });

    dbState.rows = { athlete: [ATHLETE_ROW] };
    dbState.queue = { activities: [[reference], [older]] };

    const comparables = await getComparableActivities(7, 5);

    const where = renderWhere(dbState.selects.at(-1)?.where);
    expect(where.params).toEqual(
      expect.arrayContaining([1, 'TrailRun', reference.startedAt.toISOString(), 7_500, 12_500]),
    );
    expect(where.sql).toContain('<');
    expect(comparables).toEqual([
      {
        date: '2026-08-04',
        distanceM: 9_500,
        movingTimeS: 3_000,
        avgPaceSecPerKm: 300,
        avgHrBpm: 145,
        elevationGainM: 80,
        trimp: expect.any(Number),
      },
    ]);
  });

  it('ne lit rien quand la limite demandée est nulle', async () => {
    expect(await getComparableActivities(7, 0)).toEqual([]);
    expect(dbState.selects).toHaveLength(0);
  });
});

/*
 * La fenêtre des séances envoyées au chat. C'est le trou de contexte que ce bloc
 * répare : sans lui, le coach n'avait aucun moyen de connaître la prochaine
 * séance, et un petit modèle comblait en inventant.
 */
describe('buildUpcomingSessions', () => {
  it("garde le passé récent, écarte le passé lointain et l'au-delà de l'horizon", () => {
    const sessions = buildUpcomingSessions(
      [
        // `today − 4` : hors fenêtre, le chat n'est pas un journal.
        planSession({ scheduledOn: '2026-08-07', title: 'Trop vieux' }),
        // `today − 3` : le samedi d'un week-end sauté, vu depuis le mardi.
        planSession({ scheduledOn: '2026-08-08', title: 'Samedi dernier' }),
        planSession({ scheduledOn: '2026-08-11', title: "Aujourd'hui" }),
        // Dernier jour de la fenêtre : `today + 9`, aujourd'hui étant compté.
        planSession({ scheduledOn: '2026-08-20', title: 'Dernier jour' }),
        planSession({ scheduledOn: '2026-08-21', title: 'Hors fenêtre' }),
      ],
      '2026-08-11',
    );

    expect(sessions.map((session) => session.title)).toEqual([
      'Samedi dernier',
      "Aujourd'hui",
      'Dernier jour',
    ]);
  });

  it('couvre bien dix jours à venir et trois de passé, aujourd’hui compris', () => {
    const days = Array.from({ length: 20 }, (_unused, index) =>
      planSession({ scheduledOn: shiftCivilDate('2026-08-11', index - 5) }),
    );

    expect(buildUpcomingSessions(days, '2026-08-11')).toHaveLength(
      COACH_RECENT_DAYS + COACH_UPCOMING_DAYS,
    );
  });

  it('rend les séances dans l’ordre du calendrier', () => {
    const sessions = buildUpcomingSessions(
      [
        planSession({ scheduledOn: '2026-08-15', title: 'Samedi' }),
        planSession({ scheduledOn: '2026-08-13', title: 'Jeudi' }),
      ],
      '2026-08-11',
    );

    expect(sessions.map((session) => session.date)).toEqual(['2026-08-13', '2026-08-15']);
  });

  it('dit ce qui est déjà couru, et ne porte aucun identifiant interne', () => {
    const sessions = buildUpcomingSessions(
      [
        planSession({ scheduledOn: '2026-08-11', completedActivityId: 42 }),
        planSession({ scheduledOn: '2026-08-13' }),
      ],
      '2026-08-11',
    );

    expect(sessions[0].done).toBe(true);
    expect(sessions[1].done).toBe(false);
    // DTO minimal : ni `id`, ni `completedActivityId` ne franchissent la frontière.
    expect(Object.keys(sessions[0])).toEqual([
      'date',
      'kind',
      'title',
      'steps',
      'volumeM',
      'durationS',
      'done',
    ]);
  });

  /**
   * Le déroulé passe **brut**, et c'est la frontière des couches : le DAL rend
   * des données, la mise en forme des prompts appartient à `lib/ai/format`. Le
   * rendre ici forcerait `src/data/` à importer `src/lib/ai/`.
   */
  it('porte le déroulé brut, `null` quand la séance n’en porte pas', () => {
    const steps: PlanSessionSteps = [
      {
        repeat: 6,
        steps: [
          {
            role: 'run',
            distanceM: 400,
            durationS: null,
            paceMinSecPerKm: 220,
            paceMaxSecPerKm: 220,
            hrZone: null,
            note: null,
          },
        ],
      },
    ];

    const sessions = buildUpcomingSessions(
      [planSession({ scheduledOn: '2026-08-13', steps }), planSession({ scheduledOn: '2026-08-15' })],
      '2026-08-11',
    );

    expect(sessions[0].steps).toEqual(steps);
    expect(typeof sessions[0].steps).not.toBe('string');
    expect(sessions[1].steps).toBeNull();
  });
});

describe('getPlanContext', () => {
  // Lecture de **requête** (le chat) : c'est elle qui résout l'athlète de la
  // session, et le passe à la lecture du plan.
  beforeEach(() => {
    dbState.rows.athlete = [ATHLETE_ROW];
  });

  it("dit qu'il n'y a pas de plan plutôt que de rendre un contexte vide", async () => {
    expect(await getPlanContext()).toEqual({ hasPlan: false });
  });

  it("ne lit aucun plan tant qu'aucun athlète n'est enregistré", async () => {
    withoutSession();
    plansDal.getActivePlanWithSessions.mockClear();

    expect(await getPlanContext()).toEqual({ hasPlan: false });
    expect(plansDal.getActivePlanWithSessions).not.toHaveBeenCalled();
  });

  it("lit le plan sous l'athlète de la session", async () => {
    plansDal.getActivePlanWithSessions.mockClear();

    await getPlanContext();

    expect(plansDal.getActivePlanWithSessions).toHaveBeenCalledWith(1);
  });

  it("assemble l'objectif, l'échéance et les séances de la fenêtre", async () => {
    plansDal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN_ROW,
      sessions: [
        planSession({ scheduledOn: '2026-08-04', title: 'Trop vieux' }),
        // Dans la fenêtre depuis qu'elle remonte de trois jours : le coach peut
        // enfin voir qu'elle n'a pas été courue.
        planSession({ scheduledOn: '2026-08-09', title: 'Dimanche dernier' }),
        planSession({ scheduledOn: '2026-08-11', completedActivityId: 42 }),
        planSession({ scheduledOn: '2026-08-16', title: 'Sortie longue', volumeM: 16_000 }),
        planSession({ scheduledOn: '2026-09-05', title: 'Trop loin' }),
      ],
    });

    const context = await getPlanContext();

    expect(context).toEqual({
      hasPlan: true,
      // Le jour de la lecture voyage avec les séances : c'est lui qui situe une
      // séance passée non courue par rapport à une séance à venir.
      today: '2026-08-11',
      goal: { intent: 'race', note: 'Semi de Lyon en 1 h 45' },
      raceDate: '2026-09-27',
      // 8 semaines à partir du lundi 3 août : dernier jour couvert, le dimanche
      // 27 septembre. `planEndExclusive` rend le 28, non couvert.
      endsOn: '2026-09-27',
      upcoming: [
        expect.objectContaining({ date: '2026-08-09', title: 'Dimanche dernier', done: false }),
        expect.objectContaining({ date: '2026-08-11', done: true }),
        expect.objectContaining({ date: '2026-08-16', title: 'Sortie longue', done: false }),
      ],
    });
  });

  it('rend une fenêtre vide sur un plan actif sans séance à venir', async () => {
    plansDal.getActivePlanWithSessions.mockResolvedValue({
      plan: PLAN_ROW,
      sessions: [planSession({ scheduledOn: '2026-08-04' })],
    });

    const context = await getPlanContext();

    expect(context).toEqual(expect.objectContaining({ hasPlan: true, upcoming: [] }));
  });

  it('laisse la note à `null` quand l’athlète n’en a pas écrit', async () => {
    plansDal.getActivePlanWithSessions.mockResolvedValue({
      plan: { ...PLAN_ROW, goalType: 'free', intent: 'faster', goalText: '   ', raceDate: null },
      sessions: [],
    });

    const context = await getPlanContext();

    expect(context).toEqual(
      expect.objectContaining({
        goal: { intent: 'faster', note: null },
        raceDate: null,
      }),
    );
  });
});


describe('getWellnessContext', () => {
  // Lecture de **requête** (le chat) : elle résout l'athlète de la session.
  beforeEach(() => {
    dbState.rows.athlete = [ATHLETE_ROW];
  });

  /** Une journée de relevé, dont chaque test ne renseigne que ce qu'il éprouve. */
  function wellnessRow(day: string, measures: Record<string, number | null> = {}) {
    return {
      day,
      restingHrBpm: null,
      hrvRmssdMs: null,
      hrvSdnnMs: null,
      sleepTimeS: null,
      sleepScore: null,
      avgSleepingHrBpm: null,
      weightKg: null,
      ...measures,
    };
  }

  it("ne lit rien tant qu'aucun athlète n'est enregistré, et rend une fenêtre vide", async () => {
    withoutSession();

    expect(await getWellnessContext()).toEqual({ today: '2026-08-11', days: [] });
  });

  it('rend les journées de la plus récente à la plus ancienne', async () => {
    dbState.rows.wellness_days = [
      wellnessRow('2026-08-09', { restingHrBpm: 49 }),
      wellnessRow('2026-08-11', { restingHrBpm: 47 }),
    ];

    const context = await getWellnessContext();

    expect(context.days.map((day) => day.date)).toEqual(['2026-08-11', '2026-08-09']);
    expect(context.days[0]).toEqual({
      date: '2026-08-11',
      restingHrBpm: 47,
      hrvRmssdMs: null,
      hrvSdnnMs: null,
      sleepTimeS: null,
      sleepScore: null,
      weightKg: null,
    });
  });

  it('lit la fenêtre des sept derniers jours sous son athlète', async () => {
    dbState.rows.wellness_days = [wellnessRow('2026-08-11', { restingHrBpm: 47 })];

    await getWellnessContext();

    const read = dbState.selects.filter((select) => select.table === 'wellness_days');
    expect(read).toHaveLength(1);
    const { params } = renderWhere(read[0].where);
    expect(params).toContain(1);
    expect(params).toContain('2026-08-05');
    expect(params).toContain('2026-08-11');
  });

  it('écarte les journées entièrement muettes : elles coûteraient des tokens pour rien', async () => {
    dbState.rows.wellness_days = [
      wellnessRow('2026-08-10'),
      wellnessRow('2026-08-11', { hrvSdnnMs: 45 }),
    ];

    // La journée retenue ne porte que la HRV en SDNN : une mesure connue reste
    // une mesure, quelle que soit la variante que la montre pousse.
    expect((await getWellnessContext()).days.map((day) => day.date)).toEqual(['2026-08-11']);
  });
});
