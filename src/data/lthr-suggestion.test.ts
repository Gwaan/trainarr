import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { AthleteNotFoundError, getCurrentAthlete } from './athlete';
import type { Athlete } from './db/schema';
import {
  StaleLthrSuggestionError,
  acceptLthrSuggestion,
  dismissLthrSuggestion,
  getLthrSuggestion,
  recordThresholdBlockLthr,
  recordTimeTrialLthr,
  selectLthrSuggestion,
} from './lthr-suggestion';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

vi.mock('./athlete', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./athlete')>()),
  getCurrentAthlete: vi.fn(),
}));

const { queryState } = vi.hoisted(() => ({
  queryState: {
    /** Résultats servis aux `SELECT`, dans l'ordre où ils sont demandés. */
    selects: [] as unknown[][],
    /** Clause `WHERE` de chaque `SELECT` émis. */
    selectWheres: [] as unknown[],
    /** Chaque `UPDATE` émis : ses valeurs et sa clause `WHERE`. */
    updates: [] as { values: unknown; where: unknown }[],
  },
}));

vi.mock('./db/client', () => {
  /**
   * Une chaîne de requête factice, assez souple pour les trois formes émises
   * par ce module : `select().from().where()` (attendable), la même avec
   * `.limit()`, et la même avec un `innerJoin`.
   */
  type SelectChain = {
    from: () => SelectChain;
    innerJoin: () => SelectChain;
    where: (where: unknown) => SelectChain;
    limit: () => Promise<unknown[]>;
    then: (
      resolve: (rows: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise<unknown>;
  };

  const next = () => Promise.resolve(queryState.selects.shift() ?? []);

  const selectChain: SelectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: (where: unknown) => {
      queryState.selectWheres.push(where);
      return selectChain;
    },
    limit: () => next(),
    then: (resolve, reject) => next().then(resolve, reject),
  };

  return {
    db: {
      select: () => selectChain,
      update: () => ({
        set: (values: unknown) => ({
          where: (where: unknown) => {
            queryState.updates.push({ values, where });
            return Promise.resolve([]);
          },
        }),
      }),
    },
  };
});

const getCurrentAthleteMock = vi.mocked(getCurrentAthlete);

const dialect = new PgDialect();

const ATHLETE: Athlete = {
  id: 1,
  userId: 'user-1',
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 190,
  restingHrBpm: 48,
  lthrBpm: null,
  lthrSuggestionDismissedBpm: null,
  weightKg: 62,
  birthDate: '1990-01-01',
  intervalsAthleteId: null,
  intervalsApiKeyEncrypted: null,
  forecastLocationLabel: null,
  forecastLatitudeDeg: null,
  forecastLongitudeDeg: null,
  maxHrSuggestionDismissedBpm: null,
  restingHrSuggestionDismissedBpm: null,
  wellnessReadingDay: null,
  pushDailySession: true,
  pushActivityAnalyzed: true,
  pushSuggestions: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const NOW = new Date('2026-08-13T10:00:00.000Z');

/** Trois séances de seuil — le minimum — de médiane 172 bpm. */
const BLOCK_SAMPLES = [
  { bpm: 170, source: 'threshold-blocks', startedAt: new Date('2026-07-20T06:00:00Z') },
  { bpm: 172, source: 'threshold-blocks', startedAt: new Date('2026-07-27T06:00:00Z') },
  { bpm: 175, source: 'threshold-blocks', startedAt: new Date('2026-08-03T06:00:00Z') },
];

/** Les séries d'une séance de seuil : 3 × 2 km, la FC monte puis tient 172. */
function thresholdStreams(): { type: string; data: unknown[] }[] {
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];

  // 10 min d'échauffement à 3 m/s, puis 3 × (2 km à 4,4 m/s + 3 min de récup).
  let seconds = 0;
  let meters = 0;
  const push = (speed: number, bpm: number, forS: number) => {
    for (let step = 0; step < forS; step += 1) {
      time.push(seconds);
      distance.push(meters);
      heartrate.push(bpm);
      seconds += 1;
      meters += speed;
    }
  };

  push(3, 128, 600);
  for (let rep = 0; rep < 3; rep += 1) {
    // 2 000 m à 3,7 m/s ≈ 540 s (4:30/km) : la FC monte pendant 150 s, puis
    // tient son plateau — la seconde moitié du bloc ne voit que ce plateau.
    push(3.7, 150, 150);
    push(3.7, 172, 391);
    push(2.6, 130, 180);
  }

  return [
    { type: 'time', data: time },
    { type: 'distance', data: distance },
    { type: 'heartrate', data: heartrate },
  ];
}

/** Un test chronométré : échauffement, puis 5 km à fond, FC installée à 178. */
function timeTrialStreams(): { type: string; data: unknown[] }[] {
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];

  let seconds = 0;
  let meters = 0;
  const push = (speed: number, bpm: number, forS: number) => {
    for (let step = 0; step < forS; step += 1) {
      time.push(seconds);
      distance.push(meters);
      heartrate.push(bpm);
      seconds += 1;
      meters += speed;
    }
  };

  push(2.8, 125, 600);
  // 5 000 m à 3,4 m/s ≈ 1 470 s (24:30) : 300 s de montée en régime, puis 178.
  push(3.4, 160, 300);
  push(3.4, 178, 1_171);
  push(2.4, 120, 300);

  return [
    { type: 'time', data: time },
    { type: 'distance', data: distance },
    { type: 'heartrate', data: heartrate },
  ];
}

const THRESHOLD_SESSION = [
  {
    kind: 'Seuil',
    steps: [
      { repeat: 1, steps: [{ role: 'warmup', distanceM: 1_800, durationS: null, paceMinSecPerKm: null, paceMaxSecPerKm: null, hrZone: null, note: null }] },
      {
        repeat: 3,
        steps: [
          { role: 'run', distanceM: 2_000, durationS: null, paceMinSecPerKm: null, paceMaxSecPerKm: null, hrZone: null, note: null },
          { role: 'recover', distanceM: 468, durationS: null, paceMinSecPerKm: null, paceMaxSecPerKm: null, hrZone: null, note: null },
        ],
      },
    ],
  },
];

beforeEach(() => {
  queryState.selects = [];
  queryState.selectWheres = [];
  queryState.updates = [];
  vi.clearAllMocks();
  getCurrentAthleteMock.mockResolvedValue(ATHLETE);
});

describe('selectLthrSuggestion', () => {
  it('propose la médiane des séances de seuil, et dit d’où elle sort', async () => {
    queryState.selects.push(BLOCK_SAMPLES);

    expect(await selectLthrSuggestion(ATHLETE, NOW)).toEqual({
      bpm: 172,
      source: 'threshold-blocks',
      blocksBpm: 172,
      sessionCount: 3,
      timeTrialBpm: null,
      profileBpm: null,
    });
  });

  it('cite le test quand il existe, même quand la médiane l’emporte', async () => {
    queryState.selects.push([
      ...BLOCK_SAMPLES,
      { bpm: 180, source: 'time-trial', startedAt: new Date('2026-08-05T06:00:00Z') },
    ]);

    expect(await selectLthrSuggestion(ATHLETE, NOW)).toMatchObject({
      bpm: 172,
      source: 'threshold-blocks',
      timeTrialBpm: 180,
    });
  });

  it('retombe sur le test tant qu’il n’y a pas assez de séances de seuil', async () => {
    queryState.selects.push([
      BLOCK_SAMPLES[0],
      { bpm: 176, source: 'time-trial', startedAt: new Date('2026-08-05T06:00:00Z') },
    ]);

    expect(await selectLthrSuggestion(ATHLETE, NOW)).toMatchObject({
      bpm: 176,
      source: 'time-trial',
      blocksBpm: null,
      sessionCount: 1,
    });
  });

  it('retient le test le plus récent, jamais le plus flatteur', async () => {
    queryState.selects.push([
      { bpm: 190, source: 'time-trial', startedAt: new Date('2026-06-01T06:00:00Z') },
      { bpm: 174, source: 'time-trial', startedAt: new Date('2026-08-05T06:00:00Z') },
    ]);

    expect(await selectLthrSuggestion(ATHLETE, NOW)).toMatchObject({ bpm: 174 });
  });

  it('ne lit que les mesures de la fenêtre, et que celles qui en portent une', async () => {
    queryState.selects.push(BLOCK_SAMPLES);

    await selectLthrSuggestion(ATHLETE, NOW);

    const where = queryState.selectWheres[0];
    if (!(where instanceof SQL)) throw new Error('Clause `WHERE` absente ou inattendue.');
    const query = dialect.sqlToQuery(where);

    expect(query.sql).toContain('is not null');
    expect(query.params).toContain(ATHLETE.id);
    // 90 jours avant le 13 août 2026.
    expect(query.params).toContain('2026-05-15T10:00:00.000Z');
  });

  it('ne propose rien quand la mesure colle à la FC seuil du profil', async () => {
    queryState.selects.push(BLOCK_SAMPLES);

    expect(await selectLthrSuggestion({ ...ATHLETE, lthrBpm: 172 }, NOW)).toBeNull();
  });

  it('ne repropose pas une valeur écartée', async () => {
    queryState.selects.push(BLOCK_SAMPLES);

    expect(
      await selectLthrSuggestion({ ...ATHLETE, lthrSuggestionDismissedBpm: 172 }, NOW),
    ).toBeNull();
  });

  it('ne propose rien quand aucune séance n’a mesuré de seuil', async () => {
    queryState.selects.push([]);

    expect(await selectLthrSuggestion(ATHLETE, NOW)).toBeNull();
  });
});

describe('getLthrSuggestion', () => {
  it('ne rend rien sans athlète — et n’interroge pas la base', async () => {
    getCurrentAthleteMock.mockResolvedValue(null);

    expect(await getLthrSuggestion()).toBeNull();
    expect(queryState.selectWheres).toHaveLength(0);
  });
});

describe('acceptLthrSuggestion', () => {
  it('écrit la valeur que le serveur a calculée, jamais celle qu’on lui passe', async () => {
    queryState.selects.push(BLOCK_SAMPLES);

    await acceptLthrSuggestion(172);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toMatchObject({ lthrBpm: 172 });
  });

  it('refuse une valeur qui n’est plus la proposition courante, sans rien écrire', async () => {
    queryState.selects.push(BLOCK_SAMPLES);

    await expect(acceptLthrSuggestion(160)).rejects.toBeInstanceOf(StaleLthrSuggestionError);
    expect(queryState.updates).toHaveLength(0);
  });

  it('refuse sans athlète', async () => {
    getCurrentAthleteMock.mockResolvedValue(null);

    await expect(acceptLthrSuggestion(172)).rejects.toBeInstanceOf(AthleteNotFoundError);
  });

  it('ne touche pas au refus mémorisé', async () => {
    queryState.selects.push(BLOCK_SAMPLES);

    await acceptLthrSuggestion(172);

    expect(queryState.updates[0].values).not.toHaveProperty('lthrSuggestionDismissedBpm');
  });
});

describe('dismissLthrSuggestion', () => {
  it('mémorise la valeur écartée, et ne touche pas au profil', async () => {
    queryState.selects.push(BLOCK_SAMPLES);

    await dismissLthrSuggestion(172);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toMatchObject({ lthrSuggestionDismissedBpm: 172 });
    expect(queryState.updates[0].values).not.toHaveProperty('lthrBpm');
  });
});

describe('recordThresholdBlockLthr', () => {
  it('mesure le plateau du bloc de la séance de seuil réalisée', async () => {
    queryState.selects.push(THRESHOLD_SESSION);
    queryState.selects.push(thresholdStreams());

    await recordThresholdBlockLthr(7, ATHLETE.id);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toEqual({
      lthrSampleBpm: 172,
      lthrSampleSource: 'threshold-blocks',
    });
  });

  it('ne mesure rien quand l’activité ne réalise pas une séance de seuil', async () => {
    queryState.selects.push([{ kind: 'Endurance fondamentale', steps: THRESHOLD_SESSION[0].steps }]);

    await recordThresholdBlockLthr(7, ATHLETE.id);

    expect(queryState.updates).toHaveLength(0);
  });

  it('ne mesure rien quand l’activité n’est rapprochée d’aucune séance', async () => {
    queryState.selects.push([]);

    await recordThresholdBlockLthr(7, ATHLETE.id);

    expect(queryState.updates).toHaveLength(0);
  });

  it('ne mesure rien quand la séance de seuil n’a pas de déroulé', async () => {
    queryState.selects.push([{ kind: 'Seuil', steps: null }]);

    await recordThresholdBlockLthr(7, ATHLETE.id);

    expect(queryState.updates).toHaveLength(0);
  });

  it('efface sa propre mesure — et rien que la sienne — quand la trace ne dit plus rien', async () => {
    queryState.selects.push(THRESHOLD_SESSION);
    // Séries sans canal cardiaque : plus rien à mesurer.
    queryState.selects.push([{ type: 'time', data: [0, 1] }]);

    await recordThresholdBlockLthr(7, ATHLETE.id);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toEqual({
      lthrSampleBpm: null,
      lthrSampleSource: null,
    });

    // L'effacement est borné à la source : un réimport ne doit pas supprimer la
    // mesure qu'un test chronométré avait déposée sur la même activité.
    const where = queryState.updates[0].where;
    if (!(where instanceof SQL)) throw new Error('Clause `WHERE` absente ou inattendue.');
    expect(dialect.sqlToQuery(where).params).toContain('threshold-blocks');
  });
});

describe('recordTimeTrialLthr', () => {
  it('retient la FC des vingt dernières minutes de l’effort de 5 km', async () => {
    queryState.selects.push(timeTrialStreams());

    await recordTimeTrialLthr(9, ATHLETE.id);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toEqual({
      lthrSampleBpm: 178,
      lthrSampleSource: 'time-trial',
    });
  });

  it('efface sa propre mesure quand la séance ne porte plus de séries', async () => {
    queryState.selects.push([]);

    await recordTimeTrialLthr(9, ATHLETE.id);

    expect(queryState.updates[0].values).toEqual({
      lthrSampleBpm: null,
      lthrSampleSource: null,
    });
    const where = queryState.updates[0].where;
    if (!(where instanceof SQL)) throw new Error('Clause `WHERE` absente ou inattendue.');
    expect(dialect.sqlToQuery(where).params).toContain('time-trial');
  });
});
