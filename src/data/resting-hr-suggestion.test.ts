import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { AthleteNotFoundError, getCurrentAthlete } from './athlete';
import type { Athlete } from './db/schema';
import {
  StaleRestingHrSuggestionError,
  acceptRestingHrSuggestion,
  dismissRestingHrSuggestion,
  getRestingHrSuggestion,
  selectRestingHrSuggestion,
} from './resting-hr-suggestion';

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
    /** Chaque `UPDATE` émis : ses valeurs. */
    updates: [] as { values: unknown }[],
  },
}));

vi.mock('./db/client', () => {
  /** La lecture des FC de repos s'arrête à `where` : la chaîne est attendable. */
  type SelectChain = {
    from: () => SelectChain;
    where: (where: unknown) => SelectChain;
    then: (
      resolve: (rows: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise<unknown>;
  };

  const selectChain: SelectChain = {
    from: () => selectChain,
    where: (where: unknown) => {
      queryState.selectWheres.push(where);
      return selectChain;
    },
    then: (resolve, reject) =>
      Promise.resolve(queryState.selects.shift() ?? []).then(resolve, reject),
  };

  return {
    db: {
      select: () => selectChain,
      update: () => ({
        set: (values: unknown) => ({
          where: () => {
            queryState.updates.push({ values });
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
  maxHrBpm: 188,
  restingHrBpm: 55,
  weightKg: 62,
  birthDate: '1990-01-01',
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
  pushSuggestions: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

/** Cinq nuits mesurées — le minimum — de médiane 47 bpm. */
const NIGHTS = [
  { restingHrBpm: 46 },
  { restingHrBpm: 47 },
  { restingHrBpm: 47 },
  { restingHrBpm: 48 },
  { restingHrBpm: 49 },
];

const TODAY = '2026-08-13';

beforeEach(() => {
  queryState.selects = [];
  queryState.selectWheres = [];
  queryState.updates = [];
  vi.clearAllMocks();
  getCurrentAthleteMock.mockResolvedValue(ATHLETE);
});

describe('selectRestingHrSuggestion', () => {
  it('propose la médiane des nuits mesurées quand elle s’écarte du profil', async () => {
    queryState.selects.push(NIGHTS);

    expect(await selectRestingHrSuggestion(ATHLETE, TODAY)).toEqual({
      bpm: 47,
      measuredNights: 5,
      profileBpm: 55,
    });
  });

  it('ne lit que les nuits de la fenêtre, et que celles qui portent une mesure', async () => {
    queryState.selects.push(NIGHTS);

    await selectRestingHrSuggestion(ATHLETE, TODAY);

    const where = queryState.selectWheres[0];
    if (!(where instanceof SQL)) throw new Error('Clause `WHERE` absente ou inattendue.');
    const query = dialect.sqlToQuery(where);

    expect(query.sql).toContain('is not null');
    // Quatorze jours, aujourd'hui compris : du 31 juillet au 13 août.
    expect(query.params).toContain('2026-07-31');
    expect(query.params).toContain(TODAY);
    expect(query.params).toContain(ATHLETE.id);
  });

  it('ne propose rien quand la médiane colle au profil', async () => {
    queryState.selects.push([
      { restingHrBpm: 54 },
      { restingHrBpm: 55 },
      { restingHrBpm: 55 },
      { restingHrBpm: 56 },
      { restingHrBpm: 57 },
    ]);

    expect(await selectRestingHrSuggestion(ATHLETE, TODAY)).toBeNull();
  });

  it('ne propose rien tant que trop peu de nuits ont été mesurées', async () => {
    queryState.selects.push([{ restingHrBpm: 46 }, { restingHrBpm: 47 }]);

    expect(await selectRestingHrSuggestion(ATHLETE, TODAY)).toBeNull();
  });

  it('ne repropose pas une valeur écartée', async () => {
    queryState.selects.push(NIGHTS);

    const suggestion = await selectRestingHrSuggestion(
      { ...ATHLETE, restingHrSuggestionDismissedBpm: 47 },
      TODAY,
    );

    expect(suggestion).toBeNull();
  });
});

describe('getRestingHrSuggestion', () => {
  it('ne rend rien sans athlète — et n’interroge pas la base', async () => {
    getCurrentAthleteMock.mockResolvedValue(null);

    expect(await getRestingHrSuggestion()).toBeNull();
    expect(queryState.selectWheres).toHaveLength(0);
  });
});

describe('acceptRestingHrSuggestion', () => {
  it('écrit la valeur que le serveur a calculée, jamais celle qu’on lui passe', async () => {
    queryState.selects.push(NIGHTS);

    await acceptRestingHrSuggestion(47);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toMatchObject({ restingHrBpm: 47 });
  });

  it('refuse une valeur qui n’est plus la proposition courante, sans rien écrire', async () => {
    queryState.selects.push(NIGHTS);

    await expect(acceptRestingHrSuggestion(42)).rejects.toBeInstanceOf(
      StaleRestingHrSuggestionError,
    );
    expect(queryState.updates).toHaveLength(0);
  });

  it('refuse sans athlète', async () => {
    getCurrentAthleteMock.mockResolvedValue(null);

    await expect(acceptRestingHrSuggestion(47)).rejects.toBeInstanceOf(AthleteNotFoundError);
  });

  it('ne touche pas au refus mémorisé', async () => {
    queryState.selects.push(NIGHTS);

    await acceptRestingHrSuggestion(47);

    expect(queryState.updates[0].values).not.toHaveProperty('restingHrSuggestionDismissedBpm');
  });
});

describe('dismissRestingHrSuggestion', () => {
  it('mémorise la valeur écartée, et ne touche pas au profil', async () => {
    queryState.selects.push(NIGHTS);

    await dismissRestingHrSuggestion(47);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toMatchObject({ restingHrSuggestionDismissedBpm: 47 });
    expect(queryState.updates[0].values).not.toHaveProperty('restingHrBpm');
  });

  it('refuse une proposition périmée, sans rien écrire', async () => {
    queryState.selects.push(NIGHTS);

    await expect(dismissRestingHrSuggestion(60)).rejects.toBeInstanceOf(
      StaleRestingHrSuggestionError,
    );
    expect(queryState.updates).toHaveLength(0);
  });
});
