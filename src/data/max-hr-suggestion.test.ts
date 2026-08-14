import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { ActivityNotFoundError } from './activities';
import { AthleteNotFoundError, getCurrentAthlete } from './athlete';
import type { Athlete } from './db/schema';
import {
  StaleMaxHrSuggestionError,
  UnusableMaxHrSuggestionError,
  acceptMaxHrSuggestion,
  dismissMaxHrSuggestion,
  getMaxHrSuggestion,
  recordSustainedMaxHr,
  selectMaxHrSuggestion,
} from './max-hr-suggestion';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

vi.mock('./athlete', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./athlete')>()),
  getCurrentAthlete: vi.fn(),
}));

// Aucune base : le client est remplacé par une chaîne de requête factice, qui
// enregistre ce qu'on lui demande.
const { queryState } = vi.hoisted(() => ({
  queryState: {
    /** Résultats servis aux `SELECT`, dans l'ordre où ils sont demandés. */
    selects: [] as unknown[][],
    /** Clause `WHERE` de chaque `SELECT` émis. */
    selectWheres: [] as unknown[],
    /** Chaque `UPDATE` émis : sa table, ses valeurs, sa clause `WHERE`. */
    updates: [] as { values: unknown; where: unknown }[],
    /** Lignes rendues par `UPDATE … RETURNING`, dans l'ordre. */
    updateResults: [] as unknown[][],
  },
}));

vi.mock('./db/client', () => {
  type SelectChain = {
    from: () => SelectChain;
    where: (where: unknown) => SelectChain;
    orderBy: () => SelectChain;
    limit: () => Promise<unknown[]>;
  };
  const selectChain: SelectChain = {
    from: () => selectChain,
    where: (where: unknown) => {
      queryState.selectWheres.push(where);
      return selectChain;
    },
    orderBy: () => selectChain,
    limit: () => Promise.resolve(queryState.selects.shift() ?? []),
  };

  return {
    db: {
      select: () => selectChain,
      update: () => ({
        set: (values: unknown) => ({
          where: (where: unknown) => {
            queryState.updates.push({ values, where });
            const result = Promise.resolve(queryState.updateResults.shift() ?? []);
            return Object.assign(result, { returning: () => result });
          },
        }),
      }),
    },
  };
});

const getCurrentAthleteMock = vi.mocked(getCurrentAthlete);

const dialect = new PgDialect();

/** Une clause `WHERE` capturée, telle que Postgres la recevrait. */
function renderWhere(where: unknown): { sql: string; params: unknown[] } {
  if (!(where instanceof SQL)) throw new Error('Clause `WHERE` absente ou inattendue.');
  const { sql, params } = dialect.sqlToQuery(where);
  return { sql, params };
}

const ATHLETE: Athlete = {
  id: 7,
  userId: 'user-1',
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 185,
  restingHrBpm: 48,
  weightKg: 62,
  birthDate: '1990-03-04',
  intervalsAthleteId: null,
  intervalsApiKeyEncrypted: null,
  forecastLocationLabel: null,
  forecastLatitudeDeg: null,
  forecastLongitudeDeg: null,
  maxHrSuggestionDismissedBpm: null,
  restingHrSuggestionDismissedBpm: null,
  wellnessReadingDay: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** La ligne que Postgres rendrait, et le DTO qu'elle doit produire. */
const CANDIDATE_ROW = {
  id: 31,
  name: '10 km de Bordeaux',
  startedAt: new Date('2026-08-12T16:20:00.000Z'),
  sustainedMaxHrBpm: 192,
};

const CANDIDATE = {
  bpm: 192,
  activityId: 31,
  activityName: '10 km de Bordeaux',
  activityStartedAt: new Date('2026-08-12T16:20:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  queryState.selects = [];
  queryState.selectWheres = [];
  queryState.updates = [];
  queryState.updateResults = [];
});

describe('recordSustainedMaxHr', () => {
  it('écrit la valeur sous l’athlète donné', async () => {
    queryState.updateResults = [[{ id: 31 }]];

    await recordSustainedMaxHr(31, 7, 192);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toEqual({ sustainedMaxHrBpm: 192 });
    // L'appartenance est dans la même clause que l'identifiant : jamais une
    // lecture par `id` suivie d'une comparaison en mémoire.
    const where = renderWhere(queryState.updates[0].where).sql;
    expect(where).toContain('"activities"."id"');
    expect(where).toContain('"activities"."athlete_id"');
  });

  it('écrit `null` — la colonne suit les séries, elle ne les complète pas', async () => {
    queryState.updateResults = [[{ id: 31 }]];

    await recordSustainedMaxHr(31, 7, null);

    expect(queryState.updates[0].values).toEqual({ sustainedMaxHrBpm: null });
  });

  it('refuse une activité qui n’est pas celle de l’athlète', async () => {
    queryState.updateResults = [[]];

    await expect(recordSustainedMaxHr(31, 99, 192)).rejects.toBeInstanceOf(
      ActivityNotFoundError,
    );
  });
});

describe('selectMaxHrSuggestion', () => {
  it('rend la plus haute valeur soutenue au-dessus de la FC max du profil', async () => {
    queryState.selects = [[CANDIDATE_ROW]];

    await expect(selectMaxHrSuggestion(ATHLETE)).resolves.toEqual(CANDIDATE);
  });

  it('rend null quand aucune séance ne dépasse le profil', async () => {
    queryState.selects = [[]];

    await expect(selectMaxHrSuggestion(ATHLETE)).resolves.toBe(null);
  });

  it('cloisonne par athlète et borne la valeur proposable', async () => {
    queryState.selects = [[]];

    await selectMaxHrSuggestion(ATHLETE);

    const { sql, params } = renderWhere(queryState.selectWheres[0]);
    expect(sql).toContain('"activities"."athlete_id"');
    expect(sql).toContain('"sustained_max_hr_bpm" is not null');
    // Bornes du profil (100–230) et dépassement strict de la FC max courante.
    expect(params).toEqual([7, 100, 230, 185]);
  });

  it('ne propose que sous le seuil de refus', async () => {
    queryState.selects = [[]];

    await selectMaxHrSuggestion({ ...ATHLETE, maxHrSuggestionDismissedBpm: 215 });

    // Le seuil s'ajoute aux autres bornes : la proposition suivante est la plus
    // haute valeur **strictement inférieure** à ce qui a été écarté.
    expect(renderWhere(queryState.selectWheres[0]).params).toEqual([7, 100, 230, 185, 215]);
  });

  it('propose aussi quand le profil n’a pas encore de FC max', async () => {
    queryState.selects = [[CANDIDATE_ROW]];

    await expect(selectMaxHrSuggestion({ ...ATHLETE, maxHrBpm: null })).resolves.toEqual(
      CANDIDATE,
    );
    // Aucune borne de dépassement : il n'y a rien à dépasser.
    expect(renderWhere(queryState.selectWheres[0]).params).toEqual([7, 100, 230]);
  });
});

describe('getMaxHrSuggestion', () => {
  it('rend null sans athlète — donc sans session', async () => {
    getCurrentAthleteMock.mockResolvedValue(null);

    await expect(getMaxHrSuggestion()).resolves.toBe(null);
    expect(queryState.selectWheres).toHaveLength(0);
  });

  it('rend la proposition de l’athlète de la session', async () => {
    getCurrentAthleteMock.mockResolvedValue(ATHLETE);
    queryState.selects = [[CANDIDATE_ROW]];

    await expect(getMaxHrSuggestion()).resolves.toEqual(CANDIDATE);
  });
});

describe('acceptMaxHrSuggestion', () => {
  it('écrit la valeur observée dans le profil', async () => {
    getCurrentAthleteMock.mockResolvedValue(ATHLETE);
    queryState.selects = [[CANDIDATE_ROW]];

    await acceptMaxHrSuggestion(192);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toMatchObject({ maxHrBpm: 192 });
    // Le seuil de refus n'est pas remis à zéro : accepter 192 ne réhabilite pas
    // les valeurs déjà écartées au-dessus.
    expect(queryState.updates[0].values).not.toHaveProperty('maxHrSuggestionDismissedBpm');
  });

  it('refuse une valeur qui n’est pas la proposition courante', async () => {
    getCurrentAthleteMock.mockResolvedValue(ATHLETE);
    queryState.selects = [[CANDIDATE_ROW]];

    await expect(acceptMaxHrSuggestion(230)).rejects.toBeInstanceOf(StaleMaxHrSuggestionError);
    expect(queryState.updates).toHaveLength(0);
  });

  it('refuse quand la proposition a disparu entre l’affichage et le clic', async () => {
    getCurrentAthleteMock.mockResolvedValue(ATHLETE);
    queryState.selects = [[]];

    await expect(acceptMaxHrSuggestion(192)).rejects.toBeInstanceOf(StaleMaxHrSuggestionError);
  });

  it('refuse sans athlète', async () => {
    getCurrentAthleteMock.mockResolvedValue(null);

    await expect(acceptMaxHrSuggestion(192)).rejects.toBeInstanceOf(AthleteNotFoundError);
  });

  it('refuse une FC max qui passerait sous la FC de repos', async () => {
    const low = { ...CANDIDATE_ROW, sustainedMaxHrBpm: 100 };
    getCurrentAthleteMock.mockResolvedValue({ ...ATHLETE, maxHrBpm: null, restingHrBpm: 100 });
    queryState.selects = [[low]];

    await expect(acceptMaxHrSuggestion(100)).rejects.toBeInstanceOf(
      UnusableMaxHrSuggestionError,
    );
    expect(queryState.updates).toHaveLength(0);
  });
});

describe('dismissMaxHrSuggestion', () => {
  it('pose le seuil de refus à la valeur écartée', async () => {
    getCurrentAthleteMock.mockResolvedValue(ATHLETE);
    queryState.selects = [[CANDIDATE_ROW]];

    await dismissMaxHrSuggestion(192);

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0].values).toMatchObject({ maxHrSuggestionDismissedBpm: 192 });
    expect(queryState.updates[0].values).not.toHaveProperty('maxHrBpm');
  });

  it('refuse une valeur qui n’est pas la proposition courante', async () => {
    getCurrentAthleteMock.mockResolvedValue(ATHLETE);
    queryState.selects = [[CANDIDATE_ROW]];

    await expect(dismissMaxHrSuggestion(150)).rejects.toBeInstanceOf(StaleMaxHrSuggestionError);
    expect(queryState.updates).toHaveLength(0);
  });
});
