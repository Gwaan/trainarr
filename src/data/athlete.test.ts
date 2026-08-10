import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AthleteAlreadyExistsError,
  AthleteNotFoundError,
  InvalidAthleteProfileError,
  createAthlete,
  getAthleteId,
  getAthleteProfile,
  hasAthlete,
  toAthleteProfileDto,
  updateAthleteProfile,
  validateAthleteProfile,
  type AthleteProfileInput,
} from './athlete';
import type { Athlete } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

// Aucune base de données : le client est remplacé par une chaîne de requête factice.
const { queryState } = vi.hoisted(() => ({
  queryState: {
    rows: [] as unknown[],
    inserted: [] as unknown[],
    updated: [] as unknown[],
    /** Panne simulée du côté de l'`INSERT` (contrainte violée, base coupée…). */
    insertError: null as unknown,
  },
}));

vi.mock('./db/client', () => {
  type QueryChain = {
    from: () => QueryChain;
    where: () => QueryChain;
    orderBy: () => QueryChain;
    limit: () => Promise<unknown[]>;
  };
  const chain: QueryChain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(queryState.rows),
  };

  const writer = {
    select: () => chain,
    insert: () => ({
      values: (values: unknown) => {
        if (queryState.insertError !== null) return Promise.reject(queryState.insertError);
        queryState.inserted.push(values);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: () => {
          queryState.updated.push(values);
          return Promise.resolve();
        },
      }),
    }),
  };

  return {
    db: {
      ...writer,
      transaction: (run: (tx: typeof writer) => Promise<void>) => run(writer),
    },
  };
});

const rawAthlete: Athlete = {
  id: 1,
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 191,
  restingHrBpm: 48,
  weightKg: 68.4,
  birthDate: '1990-04-17',
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  updatedAt: new Date('2026-08-01T10:00:00.000Z'),
};

const PROFILE_KEYS = [
  'birthDate',
  'displayName',
  'maxHrBpm',
  'restingHrBpm',
  'sex',
  'weightKg',
];

/** Profil complet et valide — chaque test n'en modifie que le champ qu'il éprouve. */
const VALID_INPUT: AthleteProfileInput = {
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 191,
  restingHrBpm: 48,
  weightKg: 68.4,
  birthDate: '1990-04-17',
};

beforeEach(() => {
  queryState.rows = [];
  queryState.inserted = [];
  queryState.updated = [];
  queryState.insertError = null;
});

describe('toAthleteProfileDto', () => {
  it("n'expose que les champs du DTO", () => {
    const dto = toAthleteProfileDto(rawAthlete);

    expect(Object.keys(dto).sort()).toEqual(PROFILE_KEYS);
    expect(dto).not.toHaveProperty('createdAt');
    expect(dto).not.toHaveProperty('updatedAt');
  });

  it("n'expose pas l'identifiant interne", () => {
    expect(toAthleteProfileDto(rawAthlete)).not.toHaveProperty('id');
  });

  it('recopie les valeurs sans les transformer', () => {
    expect(toAthleteProfileDto(rawAthlete)).toEqual({
      displayName: 'Gwen',
      sex: 'female',
      maxHrBpm: 191,
      restingHrBpm: 48,
      weightKg: 68.4,
      birthDate: '1990-04-17',
    });
  });

  it('préserve les champs non renseignés en `null`', () => {
    const dto = toAthleteProfileDto({
      ...rawAthlete,
      sex: null,
      maxHrBpm: null,
      restingHrBpm: null,
      weightKg: null,
      birthDate: null,
    });

    expect(dto.sex).toBeNull();
    expect(dto.maxHrBpm).toBeNull();
    expect(dto.restingHrBpm).toBeNull();
    expect(dto.weightKg).toBeNull();
    expect(dto.birthDate).toBeNull();
  });

  it('ne laisse fuir aucune colonne jointe à la ligne', () => {
    const polluted: Athlete & { internalNote: string } = {
      ...rawAthlete,
      internalNote: 'ne-doit-pas-fuiter',
    };

    const dto = toAthleteProfileDto(polluted);

    expect(Object.keys(dto).sort()).toEqual(PROFILE_KEYS);
    expect(JSON.stringify(dto)).not.toContain('ne-doit-pas-fuiter');
  });
});

describe('getAthleteProfile', () => {
  it('retourne un DTO, jamais la ligne brute', async () => {
    queryState.rows = [rawAthlete];

    const dto = await getAthleteProfile();

    expect(dto).not.toBeNull();
    expect(Object.keys(dto ?? {}).sort()).toEqual(PROFILE_KEYS);
  });

  it("retourne null tant qu'aucun athlète n'est enregistré", async () => {
    await expect(getAthleteProfile()).resolves.toBeNull();
  });
});

describe('getAthleteId / hasAthlete', () => {
  it("rend l'identifiant interne au serveur, et lui seul", async () => {
    queryState.rows = [rawAthlete];

    await expect(getAthleteId()).resolves.toBe(1);
    await expect(hasAthlete()).resolves.toBe(true);
  });

  it("rend null tant que l'onboarding n'a pas eu lieu", async () => {
    await expect(getAthleteId()).resolves.toBeNull();
    await expect(hasAthlete()).resolves.toBe(false);
  });
});

describe('validateAthleteProfile', () => {
  /** Récupère l'erreur typée d'une entrée qu'on attend refusée. */
  function rejectionOf(input: AthleteProfileInput): InvalidAthleteProfileError {
    try {
      validateAthleteProfile(input);
    } catch (error) {
      if (error instanceof InvalidAthleteProfileError) return error;
      throw error;
    }
    throw new Error('entrée acceptée alors quelle devait être refusée');
  }

  it('accepte un profil complet et détoure le nom', () => {
    expect(validateAthleteProfile({ ...VALID_INPUT, displayName: '  Gwen  ' })).toEqual(
      VALID_INPUT,
    );
  });

  it('accepte un profil réduit au seul nom (les métriques se diront non calculables)', () => {
    const minimal: AthleteProfileInput = {
      displayName: 'Gwen',
      sex: null,
      maxHrBpm: null,
      restingHrBpm: null,
      weightKg: null,
      birthDate: null,
    };

    expect(validateAthleteProfile(minimal)).toEqual(minimal);
  });

  it('refuse un nom vide ou trop long', () => {
    expect(rejectionOf({ ...VALID_INPUT, displayName: '   ' }).field).toBe('displayName');
    expect(rejectionOf({ ...VALID_INPUT, displayName: 'a'.repeat(101) }).field).toBe('displayName');
  });

  it('accepte un nom de 100 caractères', () => {
    expect(validateAthleteProfile({ ...VALID_INPUT, displayName: 'a'.repeat(100) })).toMatchObject({
      displayName: 'a'.repeat(100),
    });
  });

  it.each([
    ['FC max sous la borne', { maxHrBpm: 99 }, 'maxHrBpm'],
    ['FC max au-dessus de la borne', { maxHrBpm: 231 }, 'maxHrBpm'],
    ['FC max non entière', { maxHrBpm: 190.5 }, 'maxHrBpm'],
    ['FC de repos sous la borne', { restingHrBpm: 24 }, 'restingHrBpm'],
    ['FC de repos au-dessus de la borne', { restingHrBpm: 101 }, 'restingHrBpm'],
    ['poids sous la borne', { weightKg: 29.9 }, 'weightKg'],
    ['poids au-dessus de la borne', { weightKg: 200.1 }, 'weightKg'],
    ['date de naissance mal formée', { birthDate: '17/04/1990' }, 'birthDate'],
    ['date de naissance inexistante', { birthDate: '1990-02-31' }, 'birthDate'],
    ['date de naissance antérieure à 1900', { birthDate: '1899-12-31' }, 'birthDate'],
    ['date de naissance future', { birthDate: '2999-01-01' }, 'birthDate'],
  ])('refuse %s', (_label, patch, field) => {
    expect(rejectionOf({ ...VALID_INPUT, ...patch }).field).toBe(field);
  });

  it.each([
    ['FC max minimale', { maxHrBpm: 100, restingHrBpm: 25 }],
    ['FC max maximale', { maxHrBpm: 230 }],
    ['poids minimal', { weightKg: 30 }],
    ['poids maximal', { weightKg: 200 }],
  ])('accepte %s (bornes incluses)', (_label, patch) => {
    expect(() => validateAthleteProfile({ ...VALID_INPUT, ...patch })).not.toThrow();
  });

  it('refuse une FC de repos supérieure ou égale à la FC max', () => {
    expect(rejectionOf({ ...VALID_INPUT, maxHrBpm: 100, restingHrBpm: 100 }).field).toBe(
      'restingHrBpm',
    );
  });

  it("n'oppose pas les deux FC quand une seule est renseignée", () => {
    expect(() =>
      validateAthleteProfile({ ...VALID_INPUT, maxHrBpm: null, restingHrBpm: 100 }),
    ).not.toThrow();
  });
});

describe('createAthlete', () => {
  it('insère le profil validé', async () => {
    await createAthlete({ ...VALID_INPUT, displayName: '  Gwen  ' });

    expect(queryState.inserted).toEqual([VALID_INPUT]);
  });

  it('refuse un second athlète (application mono-utilisateur)', async () => {
    queryState.rows = [rawAthlete];

    await expect(createAthlete(VALID_INPUT)).rejects.toBeInstanceOf(AthleteAlreadyExistsError);
    expect(queryState.inserted).toEqual([]);
  });

  it("n'écrit rien si une valeur est hors bornes", async () => {
    await expect(createAthlete({ ...VALID_INPUT, maxHrBpm: 12 })).rejects.toBeInstanceOf(
      InvalidAthleteProfileError,
    );
    expect(queryState.inserted).toEqual([]);
  });

  it("traduit la violation du singleton en erreur métier (deux onboardings simultanés)", async () => {
    // La lecture préalable ne voit rien : en READ COMMITTED, les deux
    // transactions lisent une table encore vide. C'est l'index unique
    // `athlete_singleton` qui tranche, avec le code Postgres 23505.
    queryState.insertError = Object.assign(
      new Error('duplicate key value violates unique constraint "athlete_singleton"'),
      { code: '23505' },
    );

    await expect(createAthlete(VALID_INPUT)).rejects.toBeInstanceOf(AthleteAlreadyExistsError);
  });

  it("reconnaît la violation même emballée par drizzle", async () => {
    // Forme réelle en production : `DrizzleQueryError` ne porte pas le code, il
    // faut remonter sa `cause` — sans ça l'onboarding concurrent remontait une
    // panne brute au lieu du cas métier.
    queryState.insertError = Object.assign(new Error('Failed query: insert into "athlete" ...'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'athlete_singleton',
      }),
    });

    await expect(createAthlete(VALID_INPUT)).rejects.toBeInstanceOf(AthleteAlreadyExistsError);
  });

  it("laisse remonter une panne qui n'est pas une violation d'unicité", async () => {
    queryState.insertError = Object.assign(new Error('connection terminated'), { code: '08006' });

    await expect(createAthlete(VALID_INPUT)).rejects.toThrow('connection terminated');
  });
});

describe('updateAthleteProfile', () => {
  it('met à jour le profil existant et horodate la modification', async () => {
    queryState.rows = [rawAthlete];

    await updateAthleteProfile({ ...VALID_INPUT, weightKg: 67 });

    expect(queryState.updated).toHaveLength(1);
    expect(queryState.updated[0]).toMatchObject({ ...VALID_INPUT, weightKg: 67 });
    expect(queryState.updated[0]).toHaveProperty('updatedAt');
  });

  it("échoue explicitement quand l'onboarding n'a pas eu lieu", async () => {
    await expect(updateAthleteProfile(VALID_INPUT)).rejects.toBeInstanceOf(AthleteNotFoundError);
    expect(queryState.updated).toEqual([]);
  });

  it("n'écrit rien si une valeur est hors bornes", async () => {
    queryState.rows = [rawAthlete];

    await expect(
      updateAthleteProfile({ ...VALID_INPUT, restingHrBpm: 200 }),
    ).rejects.toBeInstanceOf(InvalidAthleteProfileError);
    expect(queryState.updated).toEqual([]);
  });
});
