import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DailyTrimp,
  EffectiveVo2maxInput,
  LoadPoint,
  MonotonyPoint,
  TrimpInput,
} from '@/lib/metrics';

import { getProgression } from './progression';
import type { Activity, Athlete } from './db/schema';

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
 * déclarées par table.
 */
const { queryState } = vi.hoisted(() => ({
  queryState: { rows: {} as Record<string, unknown[]> },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    leftJoin: () => Chain;
    where: () => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const chain: Chain = {
      // La lecture des courses déclarées joint `activities` pour y prendre la FC
      // et le dénivelé (cf. `./race-results`).
      leftJoin: () => chain,
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

/**
 * `@/lib/metrics` est mocké : ce fichier teste l'agrégation (troncature de la
 * série de charge, découpage en seaux, fenêtre glissante de VO₂max), pas les
 * formules physio — elles ont leurs propres tests.
 *
 * Conventions du double, identiques à `dashboard.test.ts` : 1 point de TRIMP par
 * minute, CTL = index du jour dans la série **complète** (ce qui rend la
 * troncature observable), VO₂max effective = vitesse en m/s × 10.
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
  /*
   * Même mécanique de double que `computeLoadSeries` : un point par jour de la
   * série **complète**, dont les six premiers restent `null` — c'est ce que le
   * socle rend sur une fenêtre de sept jours incomplète, et la troncature à la
   * période ne doit pas les faire réapparaître au bord de la fenêtre.
   */
  computeMonotonySeries: vi.fn((daily: readonly DailyTrimp[]): MonotonyPoint[] =>
    daily.map((day, index) => ({
      date: day.date,
      monotony: index < 6 ? null : index,
      strain: index < 6 ? null : index * 10,
      weeklyLoad: day.trimp,
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
    elevationLossM: null,
    elevationScannedAt: null,
    bestSegmentsScannedAt: null,
    sustainedMaxHrBpm: null,
    lthrSampleBpm: null,
    lthrSampleSource: null,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
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

/** Instant d'une date civile, à 9 h UTC — soit 11 h à Paris, le même jour. */
function at(day: string): Date {
  return new Date(`${day}T09:00:00.000Z`);
}

beforeEach(() => {
  queryState.rows = {};
  nextActivityId = 1;
  vi.clearAllMocks();
});

describe('getProgression — base vide', () => {
  it('retourne un état vide explicite quand aucun athlète n’est enregistré', async () => {
    withoutSession();
    const progression = await getProgression('6m');

    expect(progression).toEqual({
      range: '6m',
      from: '2026-08-10',
      to: '2026-08-10',
      bucketKind: 'week',
      hasProfile: false,
      current: { fitness: null, vo2max: null },
      load: [],
      monotony: [],
      vo2max: null,
      trimpBuckets: [],
      volume: [],
      fitnessUnavailable: null,
      vo2maxUnavailable: null,
      // Sans athlète, aucune course déclarée : le facteur neutre, et la cause.
      vo2maxCorrection: {
        factor: 1,
        source: 'default',
        manualFactor: null,
        automaticFactor: 1,
        unavailable: 'no-race',
        calibratedOnRaceId: null,
        races: [],
      },
      // Sans athlète, aucune séance : rien qui reste à balayer, donc aucune
      // lecture provisoire à annoncer.
      pendingElevationActivities: 0,
      // Sans athlète, aucun relevé bien-être : la fenêtre se réduit au jour même.
      wellness: { from: '2026-08-10', to: '2026-08-10', days: [] },
    });
  });

  it('n’invente aucun seau quand l’athlète existe mais n’a aucune activité', async () => {
    queryState.rows.athlete = [ATHLETE];

    const progression = await getProgression('6m');

    expect(progression.hasProfile).toBe(true);
    expect(progression.load).toEqual([]);
    expect(progression.monotony).toEqual([]);
    expect(progression.trimpBuckets).toEqual([]);
    expect(progression.volume).toEqual([]);
    expect(progression.vo2max).toBeNull();
    expect(progression.fitnessUnavailable).toEqual({
      missingProfileFields: [],
      noHeartRateData: true,
    });
  });
});

describe('getProgression — troncature de la série de charge', () => {
  it('calcule la charge sur tout l’historique puis la tronque à la période', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-01-01', '2026-08-09');

    const progression = await getProgression('3m');

    // 90 jours avant le 10 août : la fenêtre s'ouvre le 12 mai.
    expect(progression.from).toBe('2026-05-12');
    expect(progression.load).toHaveLength(91);
    expect(progression.load[0].date).toBe('2026-05-12');

    /*
     * Le cœur de l'affaire : le double de `computeLoadSeries` numérote les jours
     * de la série **complète**, qui démarre le 1er janvier. Le premier point
     * affiché porte donc l'index 131 — s'il valait 0, la CTL aurait été relancée
     * au bord de la fenêtre et la page montrerait une montée en charge fictive.
     */
    expect(progression.load[0].ctl).toBe(131);
    expect(progression.load[progression.load.length - 1]).toEqual({
      date: '2026-08-10',
      ctl: 221,
      atl: 0,
      tsb: 221,
    });
  });

  it('tronque la monotonie comme la charge, sans redémarrer sa fenêtre', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-01-01', '2026-08-09');

    const progression = await getProgression('3m');

    expect(progression.monotony).toHaveLength(91);
    expect(progression.monotony[0].date).toBe('2026-05-12');
    /*
     * Le premier point affiché porte l'index 131 de la série complète : si la
     * monotonie était calculée à partir du 12 mai, les six premiers jours
     * affichés seraient `null` par pure construction — un trou qui ne dirait
     * rien de l'entraînement.
     */
    expect(progression.monotony[0].monotony).toBe(131);
  });

  it('laisse l’instantané indépendant de la période affichée', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-01-01', '2026-08-09');

    const [short, long] = await Promise.all([getProgression('3m'), getProgression('all')]);

    expect(short.current.fitness).toEqual(long.current.fitness);
    expect(short.current.fitness?.ctl).toBe(221);
  });
});

describe('getProgression — bascule du seau', () => {
  it('découpe en semaines ISO sur trois et six mois', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-01-01', '2026-08-09');

    const progression = await getProgression('3m');

    expect(progression.bucketKind).toBe('week');
    // Semaine du 11 mai (la fenêtre s'ouvre le 12) jusqu'à la semaine en cours.
    expect(progression.trimpBuckets.map((bucket) => bucket.label)).toEqual([
      'S20', 'S21', 'S22', 'S23', 'S24', 'S25', 'S26',
      'S27', 'S28', 'S29', 'S30', 'S31', 'S32', 'S33',
    ]);
  });

  it('découpe en mois civils sur un an et sur tout l’historique', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-03-01', '2026-08-09');

    const progression = await getProgression('all');

    expect(progression.bucketKind).toBe('month');
    expect(progression.volume.map((bucket) => bucket.label)).toEqual([
      'mars',
      'avr.',
      'mai',
      'juin',
      'juil.',
      'août',
    ]);
  });

  it('date les mois dès que la période couvre deux années', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: at('2025-11-20') }),
      makeActivity({ startedAt: at('2026-08-09') }),
    ];

    const progression = await getProgression('1y');

    // La fenêtre d'un an s'ouvre en août 2025, mais l'historique en novembre.
    expect(progression.volume[0].label).toBe('nov. 25');
    expect(progression.volume.at(-1)?.label).toBe('août 26');
  });
});

describe('getProgression — seaux', () => {
  it('marque « en cours » le seul seau non terminé', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = dailyActivities('2026-06-01', '2026-08-09');

    const progression = await getProgression('3m');
    const partials = progression.trimpBuckets.filter((bucket) => bucket.partial);

    // Le 10 août est un lundi : la semaine 33 court jusqu'au 16.
    expect(partials.map((bucket) => bucket.label)).toEqual(['S33']);
  });

  it('garde les seaux sans activité, à zéro', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: at('2026-07-27'), movingTimeS: 1_800 }),
      makeActivity({ startedAt: at('2026-08-09'), movingTimeS: 600 }),
    ];

    const progression = await getProgression('3m');
    const tail = progression.trimpBuckets.slice(-3);

    expect(tail).toEqual([
      { label: 'S31', trimp: 30, partial: false },
      { label: 'S32', trimp: 10, partial: false },
      { label: 'S33', trimp: 0, partial: true },
    ]);
  });

  it('vide les seaux de charge en disant que c’est le profil qui manque', async () => {
    queryState.rows.athlete = [{ ...ATHLETE, sex: null }];
    queryState.rows.activities = dailyActivities('2026-07-01', '2026-08-09');

    const progression = await getProgression('3m');

    /*
     * `buildDailyTrimp` renonce dès que le sexe manque, sans regarder les
     * activités : les seaux sont vides alors que les séances portent bien une
     * FC. C'est `fitnessUnavailable` — et lui seul — qui dit la vraie cause,
     * sans quoi la page accuserait des séances sans cardio.
     */
    expect(progression.trimpBuckets.every((bucket) => bucket.trimp === 0)).toBe(true);
    expect(progression.fitnessUnavailable).toEqual({
      missingProfileFields: ['sex'],
      noHeartRateData: false,
    });
    // Le volume, lui, n'a pas besoin du profil : il reste renseigné.
    expect(progression.volume.some((bucket) => bucket.count > 0)).toBe(true);
  });

  it('ne remonte pas avant la première séance importée', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [makeActivity({ startedAt: at('2026-07-27') })];

    const progression = await getProgression('3m');

    // La fenêtre s'ouvre le 12 mai, mais l'historique commence en semaine 31 :
    // des semaines à zéro antérieures à toute donnée diraient « pas d'entraînement »
    // là où il n'y a que « pas encore d'appli ».
    expect(progression.trimpBuckets.map((bucket) => bucket.label)).toEqual([
      'S31',
      'S32',
      'S33',
    ]);
  });

  it('cumule distance, durée et nombre de séances par seau', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: at('2026-08-04'), distanceM: 12_400, movingTimeS: 3_000 }),
      makeActivity({ startedAt: at('2026-08-06'), distanceM: 8_600, movingTimeS: 2_400 }),
      makeActivity({ startedAt: at('2026-08-10'), distanceM: 5_000, movingTimeS: 1_500 }),
    ];

    const progression = await getProgression('3m');

    expect(progression.volume.slice(-2)).toEqual([
      { label: 'S32', distanceKm: 21, movingTimeS: 5_400, count: 2, partial: false },
      { label: 'S33', distanceKm: 5, movingTimeS: 1_500, count: 1, partial: true },
    ]);
  });

  it('compte le vélo dans le volume comme dans la charge', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({
        startedAt: at('2026-08-04'),
        sportType: 'Ride',
        distanceM: 40_000,
        movingTimeS: 4_800,
      }),
    ];

    const progression = await getProgression('3m');

    expect(progression.volume.at(-2)).toEqual({
      label: 'S32',
      distanceKm: 40,
      movingTimeS: 4_800,
      count: 1,
      partial: false,
    });
  });
});

describe('getProgression — période « tout »', () => {
  it('ouvre la fenêtre sur la première séance', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: at('2026-08-09') }),
      makeActivity({ startedAt: at('2025-09-14') }),
    ];

    const progression = await getProgression('all');

    expect(progression.from).toBe('2025-09-14');
    expect(progression.to).toBe('2026-08-10');
    expect(progression.load[0].date).toBe('2025-09-14');
    expect(progression.volume[0].label).toBe('sept. 25');
  });
});

describe('getProgression — VO₂max', () => {
  it('donne un point par course et une tendance pondérée sur 30 jours', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: at('2026-08-01'), distanceM: 10_000, movingTimeS: 2_000 }),
      makeActivity({ startedAt: at('2026-08-05'), distanceM: 12_000, movingTimeS: 3_000 }),
    ];

    const progression = await getProgression('3m');

    expect(progression.vo2max?.points).toEqual([
      { date: '2026-08-01', value: 50 },
      { date: '2026-08-05', value: 40 },
    ]);

    const trend = progression.vo2max?.trend ?? [];
    // Aucune course dans la fenêtre avant le 1er août : la tendance commence là.
    expect(trend[0]).toEqual({ date: '2026-08-01', value: 50 });
    expect(trend).toHaveLength(10);
    // (50 × 2 000 + 40 × 3 000) / 5 000 = 44 — la pondération par la durée.
    expect(trend.at(-1)).toEqual({ date: '2026-08-10', value: 44 });
  });

  it('alimente la tendance du premier jour affiché avec les courses antérieures', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      // Hors période (elle s'ouvre le 12 mai), mais dans la fenêtre de 30 jours
      // du premier jour affiché : la tendance doit en tenir compte.
      makeActivity({ startedAt: at('2026-05-02'), distanceM: 10_000, movingTimeS: 2_000 }),
      makeActivity({ startedAt: at('2026-06-15'), distanceM: 12_000, movingTimeS: 3_000 }),
    ];

    const progression = await getProgression('3m');

    expect(progression.vo2max?.points).toEqual([{ date: '2026-06-15', value: 40 }]);
    expect(progression.vo2max?.trend[0]).toEqual({ date: '2026-05-12', value: 50 });
  });

  it('n’expose aucune courbe quand aucune course de la période n’est exploitable', async () => {
    queryState.rows.athlete = [ATHLETE];
    queryState.rows.activities = [
      makeActivity({ startedAt: at('2026-08-05'), distanceM: 1_200 }),
    ];

    const progression = await getProgression('3m');

    expect(progression.vo2max).toBeNull();
    expect(progression.current.vo2max).toBeNull();
    expect(progression.vo2maxUnavailable).toEqual({
      missingMaxHrBpm: false,
      noRecentRunWithHeartRate: false,
    });
  });
});
