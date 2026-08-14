import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { takeInvitationClaim } from '@/lib/auth/invitation-claim';

import {
  INVITATION_LIFETIME_HOURS,
  INVITATION_UNUSABLE_MESSAGE,
  InvitationAdminRequiredError,
  InvitationUnusableError,
  canInvite,
  consumeInvitation,
  createInvitation,
  isInvitationUsable,
  listPendingInvitations,
  revokeInvitation,
} from './invitations';
import { getSession } from './session';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

vi.mock('./session', () => ({ getSession: vi.fn() }));

// Aucune base de données : le client est remplacé par une chaîne de requête
// factice, qui enregistre ce que Postgres aurait reçu.
const { queryState } = vi.hoisted(() => ({
  queryState: {
    /** Résultats servis aux `SELECT`, dans l'ordre où ils sont demandés. */
    selects: [] as unknown[][],
    /** Chaque `SELECT` émis : sa clause `WHERE`. */
    selectWheres: [] as unknown[],
    /** Résultats servis aux `INSERT ... RETURNING`. */
    insertResults: [] as unknown[][],
    inserted: [] as Record<string, unknown>[],
    /** Résultats servis aux `UPDATE ... RETURNING`. */
    updateResults: [] as unknown[][],
    updates: [] as { values: unknown; where: unknown }[],
    /** Résultats servis aux `DELETE ... RETURNING`. */
    deleteResults: [] as unknown[][],
    deletes: [] as unknown[],
  },
}));

vi.mock('./db/client', () => {
  type SelectChain = {
    from: () => SelectChain;
    where: (where: unknown) => SelectChain;
    orderBy: () => SelectChain;
    limit: () => Promise<unknown[]>;
    /** Une liste sans `LIMIT` s'attend telle quelle, comme la chaîne de Drizzle. */
    then: <T>(
      resolve: (rows: unknown[]) => T,
      reject: (error: unknown) => unknown,
    ) => Promise<T | unknown>;
  };
  const rows = () => Promise.resolve(queryState.selects.shift() ?? []);
  const selectChain: SelectChain = {
    from: () => selectChain,
    where: (where) => {
      queryState.selectWheres.push(where);
      return selectChain;
    },
    orderBy: () => selectChain,
    limit: rows,
    then: (resolve, reject) => rows().then(resolve, reject),
  };

  return {
    db: {
      select: () => selectChain,
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          queryState.inserted.push(values);
          const result = Promise.resolve(queryState.insertResults.shift() ?? []);
          return Object.assign(result, { returning: () => result });
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
      delete: () => ({
        where: (where: unknown) => {
          queryState.deletes.push(where);
          const result = Promise.resolve(queryState.deleteResults.shift() ?? []);
          return Object.assign(result, { returning: () => result });
        },
      }),
    },
  };
});

const getSessionMock = vi.mocked(getSession);

const dialect = new PgDialect();

/** Le SQL d'une clause capturée, rendu tel que Postgres le recevrait. */
function render(clause: unknown): { sql: string; params: unknown[] } {
  if (!(clause instanceof SQL)) throw new Error('Clause SQL absente ou inattendue.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

const FIRST_ACCOUNT = { userId: 'u-first', name: 'Gwen', email: 'gwen@example.test' };
const EXPIRES_AT = new Date('2026-08-16T18:42:00Z');

/** Le compte connecté est le compte d'amorçage : la lecture d'habilitation le trouve. */
function signedInAsFirstAccount(): void {
  getSessionMock.mockResolvedValue(FIRST_ACCOUNT);
  queryState.selects.push([{ id: FIRST_ACCOUNT.userId }]);
}

/** Le compte connecté n'est pas le premier : la lecture d'habilitation ne trouve rien. */
function signedInAsInvitedAccount(): void {
  getSessionMock.mockResolvedValue({ ...FIRST_ACCOUNT, userId: 'u-invited' });
  queryState.selects.push([]);
}

beforeEach(() => {
  vi.restoreAllMocks();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue(null);
  queryState.selects = [];
  queryState.selectWheres = [];
  queryState.insertResults = [];
  queryState.inserted = [];
  queryState.updateResults = [];
  queryState.updates = [];
  queryState.deleteResults = [];
  queryState.deletes = [];
});

describe("qui peut inviter", () => {
  it('personne, sans session', async () => {
    await expect(canInvite()).resolves.toBe(false);
    // Aucune lecture inutile : sans session, il n'y a pas de compte à qualifier.
    expect(queryState.selectWheres).toHaveLength(0);
  });

  it("le compte d'amorçage, reconnu à sa marque `is_first_account`", async () => {
    signedInAsFirstAccount();

    await expect(canInvite()).resolves.toBe(true);
    const { sql } = render(queryState.selectWheres[0]);
    expect(sql).toContain('"is_first_account"');
  });

  it('pas un compte invité', async () => {
    signedInAsInvitedAccount();

    await expect(canInvite()).resolves.toBe(false);
  });

  it("refuse l'émission à un compte invité, sans rien écrire", async () => {
    signedInAsInvitedAccount();

    await expect(createInvitation()).rejects.toBeInstanceOf(InvitationAdminRequiredError);
    expect(queryState.inserted).toHaveLength(0);
  });

  it("refuse l'émission hors session", async () => {
    await expect(createInvitation()).rejects.toBeInstanceOf(InvitationAdminRequiredError);
  });

  it('refuse la liste à un compte invité', async () => {
    signedInAsInvitedAccount();

    await expect(listPendingInvitations()).rejects.toBeInstanceOf(
      InvitationAdminRequiredError,
    );
  });

  it('refuse la révocation à un compte invité, sans rien supprimer', async () => {
    signedInAsInvitedAccount();

    await expect(revokeInvitation(1)).rejects.toBeInstanceOf(InvitationAdminRequiredError);
    expect(queryState.deletes).toHaveLength(0);
  });
});

describe('createInvitation', () => {
  it("n'écrit que l'empreinte du jeton, jamais le jeton", async () => {
    signedInAsFirstAccount();
    queryState.insertResults.push([{ expiresAt: EXPIRES_AT }]);

    const { token } = await createInvitation();

    const values = queryState.inserted[0];
    expect(values?.tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    // Le jeton n'apparaît dans aucune colonne écrite — pas même de biais.
    expect(JSON.stringify(values)).not.toContain(token);
  });

  it('rattache le lien au compte qui l\'émet', async () => {
    signedInAsFirstAccount();
    queryState.insertResults.push([{ expiresAt: EXPIRES_AT }]);

    await createInvitation();

    expect(queryState.inserted[0]?.createdByUserId).toBe(FIRST_ACCOUNT.userId);
  });

  it("laisse la base calculer l'échéance, et la relit d'elle", async () => {
    signedInAsFirstAccount();
    queryState.insertResults.push([{ expiresAt: EXPIRES_AT }]);

    const invitation = await createInvitation();

    // `now()` côté Postgres : la même horloge que celle qui jugera l'expiration.
    const { sql, params } = render(queryState.inserted[0]?.expiresAt);
    expect(sql).toContain('now()');
    expect(sql).toContain('make_interval');
    expect(params).toContain(INVITATION_LIFETIME_HOURS);
    expect(invitation.expiresAt).toBe(EXPIRES_AT);
  });

  it('tire un jeton neuf à chaque émission', async () => {
    signedInAsFirstAccount();
    queryState.insertResults.push([{ expiresAt: EXPIRES_AT }]);
    const first = await createInvitation();
    signedInAsFirstAccount();
    queryState.insertResults.push([{ expiresAt: EXPIRES_AT }]);
    const second = await createInvitation();

    expect(first.token).not.toBe(second.token);
  });

  it("tient deux jours — assez pour un lien envoyé par message, pas assez pour qu'il traîne", () => {
    expect(INVITATION_LIFETIME_HOURS).toBe(48);
  });
});

describe('listPendingInvitations', () => {
  it('ne rend que l\'échéance et la poignée de révocation', async () => {
    signedInAsFirstAccount();
    queryState.selects.push([{ id: 3, expiresAt: EXPIRES_AT }]);

    await expect(listPendingInvitations()).resolves.toEqual([
      { id: 3, expiresAt: EXPIRES_AT },
    ]);
  });

  it('écarte les liens consommés et expirés, et ceux des autres comptes', async () => {
    signedInAsFirstAccount();
    queryState.selects.push([]);

    await listPendingInvitations();

    const { sql, params } = render(queryState.selectWheres[1]);
    expect(sql).toContain('"created_by_user_id" = $1');
    expect(sql).toContain('"consumed_at" is null');
    expect(sql).toContain('"expires_at" > now()');
    expect(params).toContain(FIRST_ACCOUNT.userId);
  });
});

describe('revokeInvitation', () => {
  it('supprime le lien désigné, s\'il appartient au compte et n\'a pas servi', async () => {
    signedInAsFirstAccount();
    queryState.deleteResults.push([{ id: 5 }]);

    await expect(revokeInvitation(5)).resolves.toBe(true);

    const { sql, params } = render(queryState.deletes[0]);
    expect(sql).toContain('"id" = $1');
    expect(sql).toContain('"created_by_user_id" = $2');
    // La condition est portée par le DELETE lui-même : un lien en cours de
    // consommation ne s'efface pas sous les pieds de qui crée son compte.
    expect(sql).toContain('"consumed_at" is null');
    expect(params).toEqual([5, FIRST_ACCOUNT.userId]);
  });

  it('rend « non » quand il n\'y avait rien à révoquer — inexistant, déjà servi ou déjà révoqué', async () => {
    signedInAsFirstAccount();
    queryState.deleteResults.push([]);

    await expect(revokeInvitation(404)).resolves.toBe(false);
  });
});

describe('isInvitationUsable', () => {
  it('cherche par empreinte, jamais par jeton', async () => {
    queryState.selects.push([{ id: 1 }]);

    await expect(isInvitationUsable('jeton-de-test')).resolves.toBe(true);

    const { sql, params } = render(queryState.selectWheres[0]);
    expect(sql).toContain('"token_hash" = $1');
    expect(params).toContain(
      createHash('sha256').update('jeton-de-test', 'utf8').digest('hex'),
    );
    expect(params).not.toContain('jeton-de-test');
  });

  it('exige que le lien soit ni consommé ni expiré', async () => {
    queryState.selects.push([]);

    await expect(isInvitationUsable('jeton-de-test')).resolves.toBe(false);

    const { sql } = render(queryState.selectWheres[0]);
    expect(sql).toContain('"consumed_at" is null');
    expect(sql).toContain('"expires_at" > now()');
  });
});

describe('consumeInvitation', () => {
  const createAccount = () => Promise.resolve({ userId: 'u-new' });

  it("verrouille le lien d'une seule mise à jour conditionnelle, sans lecture préalable", async () => {
    queryState.updateResults.push([{ id: 9 }]);

    await consumeInvitation('jeton-de-test', createAccount);

    // Pas de `SELECT` : une lecture suivie d'une écriture laisserait passer deux
    // consommations simultanées (READ COMMITTED).
    expect(queryState.selectWheres).toHaveLength(0);

    const { sql, params } = render(queryState.updates[0]?.where);
    expect(sql).toContain('"token_hash" = $1');
    expect(sql).toContain('"consumed_at" is null');
    expect(sql).toContain('"expires_at" > now()');
    expect(params).not.toContain('jeton-de-test');
  });

  it("date la consommation à l'horloge de la base", async () => {
    queryState.updateResults.push([{ id: 9 }]);

    await consumeInvitation('jeton-de-test', createAccount);

    const values = queryState.updates[0]?.values;
    expect(values).toBeTypeOf('object');
    expect(
      render(values instanceof Object ? Object.values(values)[0] : null).sql,
    ).toContain('now()');
  });

  it('crée le compte, puis lui rattache le lien consommé', async () => {
    queryState.updateResults.push([{ id: 9 }]);

    await consumeInvitation('jeton-de-test', createAccount);

    expect(queryState.updates[1]?.values).toEqual({ consumedByUserId: 'u-new' });
    expect(render(queryState.updates[1]?.where).params).toContain(9);
  });

  it("exécute la création sous la marque de contexte, et elle seule", async () => {
    queryState.updateResults.push([{ id: 9 }]);
    let claimInside: number | null = null;

    await consumeInvitation('jeton-de-test', async () => {
      claimInside = takeInvitationClaim();
      return { userId: 'u-new' };
    });

    // C'est cette marque, et rien d'autre, qui autorise le crochet d'inscription
    // à laisser passer une création alors que la porte est fermée.
    expect(claimInside).toBe(9);
    expect(takeInvitationClaim()).toBeNull();
  });

  /**
   * La course du sujet : deux navigateurs soumettent le même lien à la même
   * seconde. La base n'accorde la ligne qu'à la première mise à jour ; la
   * seconde réévalue sa clause et ne touche rien.
   */
  it('ne laisse créer qu\'un seul compte quand le même lien est soumis deux fois', async () => {
    queryState.updateResults.push([{ id: 9 }], []);
    const createdAccounts = vi.fn(() => Promise.resolve({ userId: 'u-new' }));

    const [first, second] = await Promise.allSettled([
      consumeInvitation('jeton-de-test', createdAccounts),
      consumeInvitation('jeton-de-test', createdAccounts),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.reason).toBeInstanceOf(InvitationUnusableError);
    }
    expect(createdAccounts).toHaveBeenCalledTimes(1);
  });

  it("refuse un lien inconnu, expiré, révoqué ou déjà servi — du même refus", async () => {
    const createdAccounts = vi.fn(createAccount);
    queryState.updateResults.push([]);

    const error = await consumeInvitation('jeton-de-test', createdAccounts).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(InvitationUnusableError);
    if (!(error instanceof Error)) throw error;
    // Le message ne dit pas lequel des quatre cas, et ne cite pas le lien.
    expect(error.message).toBe(INVITATION_UNUSABLE_MESSAGE);
    expect(error.message).not.toContain('jeton-de-test');
    expect(createdAccounts).not.toHaveBeenCalled();
  });

  it("rend le lien quand la création échoue — soit les deux, soit aucun", async () => {
    queryState.updateResults.push([{ id: 9 }]);
    const failure = new Error('e-mail déjà pris');

    await expect(
      consumeInvitation('jeton-de-test', () => Promise.reject(failure)),
    ).rejects.toThrow(failure);

    const release = queryState.updates[1];
    expect(release?.values).toEqual({ consumedAt: null });
    // On ne rouvre jamais un lien qui a effectivement produit un compte.
    expect(render(release?.where).sql).toContain('"consumed_by_user_id" is null');
  });

  it("ne rattache aucun compte quand la création a échoué", async () => {
    queryState.updateResults.push([{ id: 9 }]);

    await consumeInvitation('jeton-de-test', () =>
      Promise.reject(new Error('panne')),
    ).catch(() => undefined);

    expect(queryState.updates).toHaveLength(2);
    expect(queryState.updates[1]?.values).toEqual({ consumedAt: null });
  });
});

describe("consumeInvitation, quand le rattachement échoue après coup", () => {
  it('ne fait pas échouer une création qui a bien eu lieu', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryState.updateResults.push([{ id: 9 }]);
    // Le second `UPDATE` (traçabilité) tombe ; le compte, lui, existe déjà et sa
    // session est ouverte — annoncer un échec à ce stade serait mentir.
    const { db } = await import('./db/client');
    const realUpdate = db.update;
    vi.spyOn(db, 'update')
      .mockImplementationOnce(realUpdate)
      .mockImplementationOnce(() => {
        throw new Error('base coupée');
      });

    await expect(
      consumeInvitation('jeton-de-test', () => Promise.resolve({ userId: 'u-new' })),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
