import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { resolveAuthConfig } from '@/lib/auth/config';
import { SecretDecryptionError } from '@/lib/crypto/secret-box';

import {
  AthleteAlreadyExistsError,
  AthleteNotFoundError,
  AthleteOwnerRequiredError,
  InvalidAthleteProfileError,
  InvalidIntervalsSettingsError,
  createAthlete,
  getAthleteProfile,
  getCurrentAthleteId,
  getIntervalsCredentials,
  getIntervalsSettings,
  hasAthlete,
  saveIntervalsSettings,
  toAthleteProfileDto,
  updateAthleteProfile,
  validateAthleteProfile,
  validateIntervalsSettings,
  type AthleteProfileInput,
} from './athlete';
import type { Athlete } from './db/schema';
import { getSession } from './session';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

vi.mock('./session', () => ({ getSession: vi.fn() }));

/**
 * Le chiffrement n'est **pas** simulé : les tests des identifiants intervals
 * chiffrent et déchiffrent pour de vrai (`src/lib/crypto/`), seule la source du
 * secret est remplacée. C'est la seule façon de vérifier qu'aucune clé en clair
 * n'atteint la base.
 */
vi.mock('@/lib/auth/config', () => ({ resolveAuthConfig: vi.fn() }));

const INSTALLATION_SECRET = 'x'.repeat(44);

// Aucune base de données : le client est remplacé par une chaîne de requête factice.
const { queryState } = vi.hoisted(() => ({
  queryState: {
    /** Résultats servis aux `SELECT`, dans l'ordre où ils sont demandés. */
    selects: [] as unknown[][],
    /** Résultats servis aux `UPDATE ... RETURNING`, même principe. */
    updateResults: [] as unknown[][],
    /** Chaque `UPDATE` émis : ses valeurs et sa clause `WHERE`. */
    updates: [] as { values: unknown; where: unknown }[],
    inserted: [] as unknown[],
    /** Panne simulée du côté de l'`INSERT` (contrainte violée, base coupée…). */
    insertError: null as unknown,
  },
}));

vi.mock('./db/client', () => {
  type SelectChain = {
    from: () => SelectChain;
    where: () => SelectChain;
    orderBy: () => SelectChain;
    limit: () => Promise<unknown[]>;
  };
  const selectChain: SelectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => Promise.resolve(queryState.selects.shift() ?? []),
  };

  return {
    db: {
      select: () => selectChain,
      insert: () => ({
        values: (values: unknown) => {
          if (queryState.insertError !== null) return Promise.reject(queryState.insertError);
          queryState.inserted.push(values);
          return Promise.resolve();
        },
      }),
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

const getSessionMock = vi.mocked(getSession);
const resolveAuthConfigMock = vi.mocked(resolveAuthConfig);

const dialect = new PgDialect();

/** Le SQL d'une clause `WHERE` capturée, rendu tel que Postgres le recevrait. */
function renderWhere(where: unknown): string {
  if (!(where instanceof SQL)) throw new Error('Clause `WHERE` absente ou inattendue.');
  return dialect.sqlToQuery(where).sql;
}

const rawAthlete: Athlete = {
  id: 1,
  userId: 'user_1',
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 191,
  restingHrBpm: 48,
  weightKg: 68.4,
  birthDate: '1990-04-17',
  intervalsAthleteId: 'i123456',
  intervalsApiKeyEncrypted: null,
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

/** Personne n'est connecté. */
function withoutSession(): void {
  getSessionMock.mockResolvedValue(null);
}

/** Le compte connecté possède déjà un athlète : la lecture le trouve du premier coup. */
function withOwnedAthlete(id = 1): void {
  queryState.selects.push([{ id }]);
}

/** Le compte connecté n'a pas d'athlète, et il n'y a rien à réclamer. */
function withoutAthlete(): void {
  queryState.selects.push([]);
  queryState.updateResults.push([]);
}

beforeEach(() => {
  queryState.selects = [];
  queryState.updateResults = [];
  queryState.updates = [];
  queryState.inserted = [];
  queryState.insertError = null;

  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' });

  resolveAuthConfigMock.mockReset();
  resolveAuthConfigMock.mockReturnValue({ status: 'ready', secret: INSTALLATION_SECRET });
});

describe('toAthleteProfileDto', () => {
  it("n'expose que les champs du DTO", () => {
    const dto = toAthleteProfileDto(rawAthlete);

    expect(Object.keys(dto).sort()).toEqual(PROFILE_KEYS);
    expect(dto).not.toHaveProperty('createdAt');
    expect(dto).not.toHaveProperty('updatedAt');
  });

  it("n'expose ni l'identifiant interne, ni le compte propriétaire", () => {
    const dto = toAthleteProfileDto(rawAthlete);

    expect(dto).not.toHaveProperty('id');
    expect(dto).not.toHaveProperty('userId');
  });

  it("n'expose aucun identifiant intervals.icu, chiffré ou non", () => {
    const dto = toAthleteProfileDto({
      ...rawAthlete,
      intervalsApiKeyEncrypted: 'v1:enveloppe-secrete',
    });

    expect(dto).not.toHaveProperty('intervalsAthleteId');
    expect(dto).not.toHaveProperty('intervalsApiKeyEncrypted');
    expect(JSON.stringify(dto)).not.toContain('enveloppe-secrete');
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

describe('getCurrentAthleteId', () => {
  it("rend null sans session, et n'interroge même pas la base", async () => {
    withoutSession();

    await expect(getCurrentAthleteId()).resolves.toBeNull();
    expect(queryState.updates).toEqual([]);
  });

  it("rend l'athlète du compte connecté", async () => {
    withOwnedAthlete(7);

    await expect(getCurrentAthleteId()).resolves.toBe(7);
    // Athlète déjà rattaché : aucune réclamation ne part.
    expect(queryState.updates).toEqual([]);
  });

  it("rend null quand le compte n'a pas d'athlète et qu'il n'y a rien à réclamer", async () => {
    withoutAthlete();

    await expect(getCurrentAthleteId()).resolves.toBeNull();
  });

  it('ne rend jamais « le premier athlète venu » : un athlète existant mais déjà rattaché ailleurs reste invisible', async () => {
    // La lecture par `user_id` ne rend rien, et la réclamation ne touche aucune
    // ligne : l'athlète de quelqu'un d'autre n'est pas une option de repli.
    withoutAthlete();

    await expect(hasAthlete()).resolves.toBe(false);
  });
});

describe('réclamation d’un athlète orphelin', () => {
  it("attribue au compte connecté l'athlète sans propriétaire", async () => {
    queryState.selects.push([]);
    queryState.updateResults.push([{ id: 42 }]);

    await expect(getCurrentAthleteId()).resolves.toBe(42);
    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0]?.values).toMatchObject({ userId: 'user_1' });
  });

  it('tient en une seule mise à jour conditionnelle, bornée aux lignes sans propriétaire', async () => {
    queryState.selects.push([]);
    queryState.updateResults.push([{ id: 42 }]);

    await getCurrentAthleteId();

    const sql = renderWhere(queryState.updates[0]?.where);
    expect(sql).toContain('"user_id" is null');
    // Une seule ligne visée, la plus ancienne : plus rien n'interdit plusieurs
    // orphelins depuis la disparition du singleton.
    expect(sql).toContain('min(');
    expect(queryState.updates).toHaveLength(1);
  });

  it("perd la course sans rien casser : la seconde réclamation simultanée n'obtient aucune ligne", async () => {
    // Postgres réévalue `user_id IS NULL` sur la ligne verrouillée : la seconde
    // transaction ne met à jour aucune ligne, donc pas d'athlète — l'onboarding
    // lui en créera un, plutôt que de lui donner celui du voisin.
    queryState.selects.push([]);
    queryState.updateResults.push([]);

    await expect(getCurrentAthleteId()).resolves.toBeNull();
    expect(queryState.updates).toHaveLength(1);
  });

  it('ne réclame rien tant que personne n’est connecté', async () => {
    withoutSession();

    await expect(getCurrentAthleteId()).resolves.toBeNull();
    expect(queryState.updates).toEqual([]);
  });
});

describe('getAthleteProfile', () => {
  it('retourne un DTO, jamais la ligne brute', async () => {
    withOwnedAthlete();
    queryState.selects.push([rawAthlete]);

    const dto = await getAthleteProfile();

    expect(dto).not.toBeNull();
    expect(Object.keys(dto ?? {}).sort()).toEqual(PROFILE_KEYS);
  });

  it("retourne null tant que le compte n'a pas d'athlète", async () => {
    withoutAthlete();

    await expect(getAthleteProfile()).resolves.toBeNull();
  });

  it('retourne null sans session', async () => {
    withoutSession();

    await expect(getAthleteProfile()).resolves.toBeNull();
  });
});

describe('hasAthlete', () => {
  it("dit `true` dès que le compte connecté a un athlète", async () => {
    withOwnedAthlete();

    await expect(hasAthlete()).resolves.toBe(true);
  });

  it("dit `false` tant que l'onboarding n'a pas eu lieu", async () => {
    withoutAthlete();

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
  it('insère le profil validé, rattaché au compte connecté', async () => {
    withoutAthlete();

    await createAthlete({ ...VALID_INPUT, displayName: '  Gwen  ' });

    expect(queryState.inserted).toEqual([{ ...VALID_INPUT, userId: 'user_1' }]);
  });

  it("refuse de créer un athlète sans compte propriétaire", async () => {
    withoutSession();

    await expect(createAthlete(VALID_INPUT)).rejects.toBeInstanceOf(AthleteOwnerRequiredError);
    expect(queryState.inserted).toEqual([]);
  });

  it('refuse un second athlète pour le même compte', async () => {
    withOwnedAthlete();

    await expect(createAthlete(VALID_INPUT)).rejects.toBeInstanceOf(AthleteAlreadyExistsError);
    expect(queryState.inserted).toEqual([]);
  });

  it("réclame l'athlète orphelin plutôt que d'en créer un neuf par-dessus", async () => {
    queryState.selects.push([]);
    queryState.updateResults.push([{ id: 42 }]);

    await expect(createAthlete(VALID_INPUT)).rejects.toBeInstanceOf(AthleteAlreadyExistsError);
    expect(queryState.inserted).toEqual([]);
  });

  it("n'écrit rien si une valeur est hors bornes", async () => {
    await expect(createAthlete({ ...VALID_INPUT, maxHrBpm: 12 })).rejects.toBeInstanceOf(
      InvalidAthleteProfileError,
    );
    expect(queryState.inserted).toEqual([]);
  });

  it("traduit la violation d'unicité en erreur métier (deux onboardings simultanés)", async () => {
    // La lecture préalable ne voit rien : en READ COMMITTED, les deux
    // transactions lisent une table sans athlète pour ce compte. C'est l'unicité
    // de `user_id` qui tranche, avec le code Postgres 23505.
    withoutAthlete();
    queryState.insertError = Object.assign(
      new Error('duplicate key value violates unique constraint "athlete_user_id_unique"'),
      { code: '23505' },
    );

    await expect(createAthlete(VALID_INPUT)).rejects.toBeInstanceOf(AthleteAlreadyExistsError);
  });

  it("reconnaît la violation même emballée par drizzle", async () => {
    // Forme réelle en production : `DrizzleQueryError` ne porte pas le code, il
    // faut remonter sa `cause` — sans ça l'onboarding concurrent remontait une
    // panne brute au lieu du cas métier.
    withoutAthlete();
    queryState.insertError = Object.assign(new Error('Failed query: insert into "athlete" ...'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'athlete_user_id_unique',
      }),
    });

    await expect(createAthlete(VALID_INPUT)).rejects.toBeInstanceOf(AthleteAlreadyExistsError);
  });

  it("laisse remonter une panne qui n'est pas une violation d'unicité", async () => {
    withoutAthlete();
    queryState.insertError = Object.assign(new Error('connection terminated'), { code: '08006' });

    await expect(createAthlete(VALID_INPUT)).rejects.toThrow('connection terminated');
  });
});

describe('updateAthleteProfile', () => {
  it('met à jour le profil existant et horodate la modification', async () => {
    withOwnedAthlete();

    await updateAthleteProfile({ ...VALID_INPUT, weightKg: 67 });

    expect(queryState.updates).toHaveLength(1);
    expect(queryState.updates[0]?.values).toMatchObject({ ...VALID_INPUT, weightKg: 67 });
    expect(queryState.updates[0]?.values).toHaveProperty('updatedAt');
  });

  it("échoue explicitement quand l'onboarding n'a pas eu lieu", async () => {
    withoutAthlete();

    await expect(updateAthleteProfile(VALID_INPUT)).rejects.toBeInstanceOf(AthleteNotFoundError);
    // Seule la réclamation a écrit — aucune mise à jour de profil.
    expect(queryState.updates).toHaveLength(1);
  });

  it("n'écrit rien si une valeur est hors bornes", async () => {
    withOwnedAthlete();

    await expect(
      updateAthleteProfile({ ...VALID_INPUT, restingHrBpm: 200 }),
    ).rejects.toBeInstanceOf(InvalidAthleteProfileError);
    expect(queryState.updates).toEqual([]);
  });
});

describe('validateIntervalsSettings', () => {
  /** Récupère l'erreur typée d'une entrée qu'on attend refusée. */
  function rejectionOf(input: Parameters<typeof validateIntervalsSettings>[0]) {
    try {
      validateIntervalsSettings(input);
    } catch (error) {
      if (error instanceof InvalidIntervalsSettingsError) return error;
      throw error;
    }
    throw new Error('entrée acceptée alors quelle devait être refusée');
  }

  it('détoure les valeurs', () => {
    expect(validateIntervalsSettings({ intervalsAthleteId: ' i123 ', apiKey: ' cle ' })).toEqual({
      intervalsAthleteId: 'i123',
      apiKey: 'cle',
    });
  });

  it('ramène une saisie blanche à « pas renseigné », jamais à une chaîne vide', () => {
    expect(validateIntervalsSettings({ intervalsAthleteId: '   ', apiKey: '  ' })).toEqual({
      intervalsAthleteId: null,
      apiKey: null,
    });
  });

  it('distingue « ne touche pas à la clé » de « efface la clé »', () => {
    expect(validateIntervalsSettings({ intervalsAthleteId: null })).toEqual({
      intervalsAthleteId: null,
    });
    expect(validateIntervalsSettings({ intervalsAthleteId: null })).not.toHaveProperty('apiKey');
    expect(validateIntervalsSettings({ intervalsAthleteId: null, apiKey: null })).toEqual({
      intervalsAthleteId: null,
      apiKey: null,
    });
  });

  it.each([
    ['un identifiant trop long', { intervalsAthleteId: 'i'.repeat(65) }, 'intervalsAthleteId'],
    ['une clé trop longue', { intervalsAthleteId: null, apiKey: 'k'.repeat(257) }, 'apiKey'],
  ])('refuse %s', (_label, input, field) => {
    expect(rejectionOf(input).field).toBe(field);
  });

  it('ne cite jamais la clé reçue dans son message de refus', () => {
    const apiKey = 'k'.repeat(300);

    expect(rejectionOf({ intervalsAthleteId: null, apiKey }).message).not.toContain(apiKey);
  });
});

describe('identifiants intervals.icu', () => {
  const API_KEY = 'abcdef0123456789';

  /** L'enveloppe telle qu'elle serait en base pour {@link API_KEY}. */
  async function storedEnvelope(): Promise<string> {
    withOwnedAthlete();
    await saveIntervalsSettings({ intervalsAthleteId: 'i123456', apiKey: API_KEY });
    const values = queryState.updates[0]?.values;
    if (
      typeof values !== 'object' ||
      values === null ||
      !('intervalsApiKeyEncrypted' in values) ||
      typeof values.intervalsApiKeyEncrypted !== 'string'
    ) {
      throw new Error('aucune enveloppe chiffrée écrite');
    }
    const envelope = values.intervalsApiKeyEncrypted;
    queryState.updates = [];
    return envelope;
  }

  describe('saveIntervalsSettings', () => {
    it("chiffre la clé : la valeur écrite n'est jamais celle saisie", async () => {
      const envelope = await storedEnvelope();

      expect(envelope).not.toContain(API_KEY);
      expect(envelope.startsWith('v1:')).toBe(true);
    });

    it("laisse la clé enregistrée intacte quand la saisie ne la mentionne pas", async () => {
      withOwnedAthlete();

      await saveIntervalsSettings({ intervalsAthleteId: 'i999' });

      expect(queryState.updates[0]?.values).toMatchObject({ intervalsAthleteId: 'i999' });
      expect(queryState.updates[0]?.values).not.toHaveProperty('intervalsApiKeyEncrypted');
    });

    it('efface la clé sur demande explicite', async () => {
      withOwnedAthlete();

      await saveIntervalsSettings({ intervalsAthleteId: 'i999', apiKey: null });

      expect(queryState.updates[0]?.values).toMatchObject({ intervalsApiKeyEncrypted: null });
    });

    it("échoue explicitement quand le compte n'a pas d'athlète", async () => {
      withoutAthlete();

      await expect(
        saveIntervalsSettings({ intervalsAthleteId: null, apiKey: API_KEY }),
      ).rejects.toBeInstanceOf(AthleteNotFoundError);
    });

    it("n'écrit rien quand la saisie est hors bornes", async () => {
      await expect(
        saveIntervalsSettings({ intervalsAthleteId: 'i'.repeat(65) }),
      ).rejects.toBeInstanceOf(InvalidIntervalsSettingsError);
      expect(queryState.updates).toEqual([]);
    });
  });

  describe('getIntervalsSettings', () => {
    it('dit qu’une clé est configurée, sans jamais rendre sa valeur', async () => {
      const encrypted = await storedEnvelope();
      withOwnedAthlete();
      queryState.selects.push([{ intervalsAthleteId: 'i123456', encrypted }]);

      const dto = await getIntervalsSettings();

      expect(dto).toEqual({ intervalsAthleteId: 'i123456', apiKey: 'configured' });
      expect(JSON.stringify(dto)).not.toContain(API_KEY);
      expect(JSON.stringify(dto)).not.toContain(encrypted);
    });

    it('dit « absente » quand aucune clé n’est enregistrée', async () => {
      withOwnedAthlete();
      queryState.selects.push([{ intervalsAthleteId: null, encrypted: null }]);

      await expect(getIntervalsSettings()).resolves.toEqual({
        intervalsAthleteId: null,
        apiKey: 'absent',
      });
    });

    it('dit « illisible » quand le secret de l’installation a changé', async () => {
      const encrypted = await storedEnvelope();
      resolveAuthConfigMock.mockReturnValue({ status: 'ready', secret: 'y'.repeat(44) });
      withOwnedAthlete();
      queryState.selects.push([{ intervalsAthleteId: 'i123456', encrypted }]);

      await expect(getIntervalsSettings()).resolves.toMatchObject({ apiKey: 'unreadable' });
    });

    it("rend null quand le compte n'a pas d'athlète", async () => {
      withoutAthlete();

      await expect(getIntervalsSettings()).resolves.toBeNull();
    });
  });

  describe('getIntervalsCredentials', () => {
    it('rend la clé en clair pour un appel sortant depuis le serveur', async () => {
      const encrypted = await storedEnvelope();
      withOwnedAthlete();
      queryState.selects.push([{ intervalsAthleteId: 'i123456', encrypted }]);

      await expect(getIntervalsCredentials()).resolves.toEqual({
        intervalsAthleteId: 'i123456',
        apiKey: API_KEY,
      });
    });

    it('rend null quand aucune clé n’est enregistrée', async () => {
      withOwnedAthlete();
      queryState.selects.push([{ intervalsAthleteId: 'i123456', encrypted: null }]);

      await expect(getIntervalsCredentials()).resolves.toBeNull();
    });

    it('lève une erreur typée quand la clé ne se déchiffre plus, au lieu de la taire', async () => {
      const encrypted = await storedEnvelope();
      resolveAuthConfigMock.mockReturnValue({ status: 'ready', secret: 'y'.repeat(44) });
      withOwnedAthlete();
      queryState.selects.push([{ intervalsAthleteId: 'i123456', encrypted }]);

      await expect(getIntervalsCredentials()).rejects.toBeInstanceOf(SecretDecryptionError);
    });

    it("rend null quand le compte n'a pas d'athlète", async () => {
      withoutAthlete();

      await expect(getIntervalsCredentials()).resolves.toBeNull();
    });
  });
});
