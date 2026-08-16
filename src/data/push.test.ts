import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimNotice,
  countSubscriptions,
  dropSubscription,
  getPushPreferences,
  getPushPreferencesFor,
  listSubscriptions,
  NOTICE_RETENTION_DAYS,
  purgeStaleNotices,
  releaseNotice,
  removeSubscription,
  saveSubscription,
  setPushPreferences,
  touchSubscription,
} from './push';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Notifications : cloisonnement, upsert, et idempotence.
 *
 * Quatre propriétés, et elles ne se déduisent pas les unes des autres :
 *
 * 1. **rien ne se lit ni ne s'écrit hors de son athlète** — l'écran le tient de
 *    la session, l'envoi le reçoit en paramètre ;
 * 2. **une endpoint fournie par le client ne désigne jamais la ligne d'un
 *    autre** : le désabonnement est borné par l'athlète de la session ;
 * 3. **l'enregistrement est un upsert**, sans quoi chaque passage dans les
 *    réglages ajouterait un doublon et la notification partirait deux fois ;
 * 4. **la réservation est une insertion**, pas une lecture suivie d'une
 *    écriture : c'est ce qui la rend sûre entre deux cycles concurrents.
 */

type RecordedQuery = { table: string; where: SQL | null };

const { dbState, athleteState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    queries: [] as RecordedQuery[],
    inserts: [] as Array<{
      table: string;
      values: unknown;
      conflictTarget: unknown;
      conflictSet: Record<string, unknown> | null;
      /** Le garde-fou du `DO UPDATE` : sans lui, un conflit réattribue la ligne. */
      conflictSetWhere: SQL | null;
      conflictDoNothing: boolean;
      returned: unknown[];
    }>,
    deletes: [] as Array<{ table: string; where: SQL | null }>,
    updates: [] as Array<{ table: string; values: Record<string, unknown>; where: SQL | null }>,
    /** Ce que le prochain `insert(...).returning()` doit rendre. */
    nextReturning: [] as unknown[],
    /** Ce que le prochain `delete(...).returning()` doit rendre. */
    nextDeleteReturning: [] as unknown[],
  },
  athleteState: { currentId: null as number | null },
}));

vi.mock('./athlete', () => ({
  getCurrentAthleteId: () => Promise.resolve(athleteState.currentId),
  // Recopiée du vrai module : ce DAL la lève quand le compte n'a pas d'athlète,
  // et un test doit pouvoir la reconnaître sans charger le chiffrement et
  // better-auth avec elle.
  AthleteNotFoundError: class AthleteNotFoundError extends Error {
    constructor() {
      super("Aucun athlète enregistré : le profil doit d'abord être créé.");
      this.name = 'AthleteNotFoundError';
    }
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const query: RecordedQuery = { table: getTableName(table), where: null };
    dbState.queries.push(query);

    const chain: Chain = {
      where: (clause) => {
        query.where = clause;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.rows[query.table] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  type InsertChain = PromiseLike<unknown> & {
    onConflictDoUpdate: (options: {
      target: unknown;
      set: Record<string, unknown>;
      setWhere?: SQL;
    }) => InsertChain;
    onConflictDoNothing: () => InsertChain;
    returning: () => Promise<unknown[]>;
  };

  /** Une suppression : attendable telle quelle, ou suivie d'un `returning()`. */
  type DeleteChain = PromiseLike<unknown> & { returning: () => Promise<unknown[]> };

  return {
    db: {
      select: () => ({ from: chainFor }),
      insert: (table: Table) => ({
        values: (values: unknown) => {
          const record = {
            table: getTableName(table),
            values,
            conflictTarget: null as unknown,
            conflictSet: null as Record<string, unknown> | null,
            conflictSetWhere: null as SQL | null,
            conflictDoNothing: false,
            returned: dbState.nextReturning,
          };
          dbState.inserts.push(record);

          const chain: InsertChain = {
            onConflictDoUpdate: (options) => {
              record.conflictTarget = options.target;
              record.conflictSet = options.set;
              record.conflictSetWhere = options.setWhere ?? null;
              return chain;
            },
            onConflictDoNothing: () => {
              record.conflictDoNothing = true;
              return chain;
            },
            returning: () => Promise.resolve(record.returned),
            then: (onFulfilled, onRejected) =>
              Promise.resolve(undefined).then(onFulfilled, onRejected),
          };
          return chain;
        },
      }),
      delete: (table: Table) => ({
        where: (clause: SQL): DeleteChain => {
          dbState.deletes.push({ table: getTableName(table), where: clause });
          return {
            returning: () => Promise.resolve(dbState.nextDeleteReturning),
            then: (onFulfilled, onRejected) =>
              Promise.resolve(undefined).then(onFulfilled, onRejected),
          };
        },
      }),
      update: (table: Table) => ({
        set: (values: Record<string, unknown>) => ({
          where: (clause: SQL) => {
            dbState.updates.push({ table: getTableName(table), values, where: clause });
            return Promise.resolve(undefined);
          },
        }),
      }),
    },
  };
});

const dialect = new PgDialect();

function render(clause: SQL | null | undefined): { sql: string; params: unknown[] } {
  if (clause == null) throw new Error('Aucune clause enregistrée pour cette requête.');
  const rendered = dialect.sqlToQuery(clause);
  return { sql: rendered.sql, params: rendered.params };
}

function queryOn(table: string): RecordedQuery {
  const query = dbState.queries.find((candidate) => candidate.table === table);
  if (query === undefined) throw new Error(`Aucune requête sur « ${table} ».`);
  return query;
}

const DEVICE = {
  endpoint: 'https://web.push.apple.com/abc',
  p256dh: 'cle-publique-appareil',
  auth: 'secret-abonnement',
};

beforeEach(() => {
  dbState.rows = {};
  dbState.queries = [];
  dbState.inserts = [];
  dbState.deletes = [];
  dbState.updates = [];
  dbState.nextReturning = [];
  dbState.nextDeleteReturning = [];
  athleteState.currentId = null;
});

describe('saveSubscription', () => {
  it('enregistre l’appareil sous l’athlète de la session, en upsert sur l’endpoint', async () => {
    athleteState.currentId = 7;
    dbState.nextReturning = [{ athleteId: 7 }];

    await saveSubscription({ ...DEVICE, userAgent: 'Safari/iPhone' });

    const insert = dbState.inserts[0];
    expect(insert?.table).toBe('push_subscriptions');
    expect(insert?.values).toEqual({
      athleteId: 7,
      endpoint: DEVICE.endpoint,
      p256dh: DEVICE.p256dh,
      auth: DEVICE.auth,
      userAgent: 'Safari/iPhone',
    });
    // L'upsert est ce qui empêche un doublon — donc une notification en double.
    expect(insert?.conflictSet).toMatchObject({ p256dh: DEVICE.p256dh });
  });

  it('ne réattribue jamais un appareil à un autre compte', async () => {
    athleteState.currentId = 7;
    dbState.nextReturning = [{ athleteId: 7 }];

    await saveSubscription(DEVICE);

    const insert = dbState.inserts[0];
    // Deux moitiés d'une même garde : `athlete_id` n'est pas réécrit, et la
    // mise à jour est bornée à la ligne de cet athlète. Sans elles, le compte B
    // s'approprie l'appareil du compte A en postant son endpoint.
    expect(insert?.conflictSet).not.toHaveProperty('athleteId');
    const { sql, params } = render(insert?.conflictSetWhere);
    expect(sql).toContain('"athlete_id"');
    expect(params).toEqual([7]);
  });

  it('refuse quand l’endpoint appartient déjà à un autre athlète', async () => {
    athleteState.currentId = 7;
    // Le `setWhere` a écarté la mise à jour : la base ne rend aucune ligne.
    dbState.nextReturning = [];

    await expect(saveSubscription(DEVICE)).rejects.toThrow('déjà enregistré sous un autre compte');
  });

  it('n’efface pas la date du dernier envoi réussi en se réabonnant', async () => {
    athleteState.currentId = 7;
    dbState.nextReturning = [{ athleteId: 7 }];

    await saveSubscription(DEVICE);

    expect(dbState.inserts[0]?.conflictSet).not.toHaveProperty('lastSuccessAt');
  });

  it('note l’absence d’agent utilisateur plutôt que de l’inventer', async () => {
    athleteState.currentId = 7;
    dbState.nextReturning = [{ athleteId: 7 }];

    await saveSubscription(DEVICE);

    expect(dbState.inserts[0]?.values).toMatchObject({ userAgent: null });
  });

  it('refuse d’écrire quand le compte n’a pas d’athlète', async () => {
    await expect(saveSubscription(DEVICE)).rejects.toThrow('Aucun athlète enregistré');
    expect(dbState.inserts).toHaveLength(0);
  });
});

describe('removeSubscription', () => {
  it('borne la suppression à l’athlète de la session', async () => {
    athleteState.currentId = 7;

    await removeSubscription(DEVICE.endpoint);

    const removal = dbState.deletes[0];
    expect(removal?.table).toBe('push_subscriptions');
    const { sql, params } = render(removal?.where);
    // Sans le `athlete_id`, une endpoint devinée effacerait l'abonnement d'un
    // autre compte.
    expect(sql).toContain('"athlete_id"');
    expect(params).toEqual([7, DEVICE.endpoint]);
  });

  it('n’efface rien sans athlète', async () => {
    await expect(removeSubscription(DEVICE.endpoint)).rejects.toThrow('Aucun athlète');
    expect(dbState.deletes).toHaveLength(0);
  });
});

describe('listSubscriptions', () => {
  it('ne lit que les appareils de l’athlète demandé', async () => {
    dbState.rows.push_subscriptions = [{ id: 1, ...DEVICE }];

    expect(await listSubscriptions(7)).toEqual([{ id: 1, ...DEVICE }]);

    const { params } = render(queryOn('push_subscriptions').where);
    expect(params).toEqual([7]);
  });
});

describe('dropSubscription / touchSubscription', () => {
  it('efface un abonnement mort par son identifiant interne', async () => {
    await dropSubscription(42);

    const removal = dbState.deletes[0];
    expect(removal?.table).toBe('push_subscriptions');
    expect(render(removal?.where).params).toEqual([42]);
  });

  it('date le dernier envoi accepté', async () => {
    await touchSubscription(42);

    const update = dbState.updates[0];
    expect(update?.table).toBe('push_subscriptions');
    expect(update?.values.lastSuccessAt).toBeInstanceOf(Date);
    expect(render(update?.where).params).toEqual([42]);
  });
});

describe('countSubscriptions', () => {
  it('compte les appareils de l’athlète connecté', async () => {
    athleteState.currentId = 7;
    dbState.rows.push_subscriptions = [{ value: 3 }];

    expect(await countSubscriptions()).toBe(3);
    expect(render(queryOn('push_subscriptions').where).params).toEqual([7]);
  });

  it('rend zéro sans athlète, sans interroger la base', async () => {
    expect(await countSubscriptions()).toBe(0);
    expect(dbState.queries).toHaveLength(0);
  });
});

describe('les préférences', () => {
  it('lit les trois booléens de l’athlète demandé', async () => {
    dbState.rows.athlete = [{ dailySession: true, activityAnalyzed: false, suggestions: true }];

    expect(await getPushPreferencesFor(7)).toEqual({
      dailySession: true,
      activityAnalyzed: false,
      suggestions: true,
    });
    expect(render(queryOn('athlete').where).params).toEqual([7]);
  });

  it('rend les défauts quand il n’y a pas d’athlète du tout', async () => {
    // Sans athlète il n'existe aucun abonnement : ces trois booléens ne
    // décident de rien, et le défaut de la colonne est la réponse honnête.
    expect(await getPushPreferences()).toEqual({
      dailySession: true,
      activityAnalyzed: true,
      suggestions: true,
    });
    expect(dbState.queries).toHaveLength(0);
  });

  it('n’écrit que la catégorie demandée', async () => {
    athleteState.currentId = 7;

    await setPushPreferences({ activityAnalyzed: false });

    const update = dbState.updates[0];
    expect(update?.table).toBe('athlete');
    expect(update?.values).toMatchObject({ pushActivityAnalyzed: false });
    // Les deux autres ne sont pas touchées : un second onglet ouvert ne doit
    // pas se faire écraser par l'état qu'affichait celui-ci.
    expect(update?.values).not.toHaveProperty('pushDailySession');
    expect(update?.values).not.toHaveProperty('pushSuggestions');
    expect(render(update?.where).params).toEqual([7]);
  });

  it('ne fait aucune requête quand il n’y a rien à changer', async () => {
    athleteState.currentId = 7;

    await setPushPreferences({});

    expect(dbState.updates).toHaveLength(0);
  });

  it('refuse d’écrire sans athlète', async () => {
    await expect(setPushPreferences({ suggestions: false })).rejects.toThrow('Aucun athlète');
    expect(dbState.updates).toHaveLength(0);
  });
});

describe('claimNotice', () => {
  it('réserve par une insertion, et laisse la base trancher', async () => {
    dbState.nextReturning = [{ athleteId: 7 }];

    expect(await claimNotice(7, 'daily-session', '2026-08-16')).toBe(true);

    const insert = dbState.inserts[0];
    expect(insert?.table).toBe('push_notices');
    expect(insert?.values).toEqual({
      athleteId: 7,
      kind: 'daily-session',
      dedupeKey: '2026-08-16',
    });
    // Pas de lecture préalable : deux cycles concurrents concluraient tous les
    // deux « rien en base » et enverraient deux fois.
    expect(dbState.queries).toHaveLength(0);
    expect(insert?.conflictDoNothing).toBe(true);
  });

  it('répond « déjà émise » quand l’insertion ne rend aucune ligne', async () => {
    dbState.nextReturning = [];

    expect(await claimNotice(7, 'activity-analyzed', '42')).toBe(false);
  });
});

describe('releaseNotice', () => {
  /*
   * La moitié qui manquait aux propositions : leur clé est le **genre**, pas la
   * valeur, et c'est donc leur disparition qui doit rendre la clé. Sans cette
   * suppression, une proposition acceptée aujourd'hui interdirait d'annoncer la
   * suivante — dans six mois comme demain.
   */
  it('efface la réservation d’un athlète, d’un genre et d’une clé', async () => {
    await releaseNotice(7, 'suggestion', 'lthr');

    const removal = dbState.deletes[0];
    expect(removal?.table).toBe('push_notices');
    const { sql, params } = render(removal?.where);
    expect(sql).toContain('"athlete_id"');
    // Les trois colonnes de l'index unique : rien d'autre ne désigne une ligne,
    // et surtout pas la réservation du même genre chez un autre compte.
    expect(params).toEqual([7, 'suggestion', 'lthr']);
  });
});

describe('purgeStaleNotices', () => {
  it('n’efface que les réservations datées, et seulement les périmées', async () => {
    dbState.nextDeleteReturning = [{ athleteId: 7 }, { athleteId: 7 }];

    expect(await purgeStaleNotices(new Date('2026-08-16T10:00:00Z'))).toBe(2);

    const removal = dbState.deletes[0];
    expect(removal?.table).toBe('push_notices');
    const { params } = render(removal?.where);

    // Les deux catégories qui grossissent sans fin — et pas « suggestion »,
    // dont la clé dit « une proposition de ce genre est en cours » : elle vaut
    // tant que la carte est à l'écran, et sa disparition est un geste
    // (`releaseNotice`), jamais un effet du temps. L'effacer par ancienneté la
    // ferait renotifier sans que rien n'ait changé.
    expect(params.slice(0, 2)).toEqual(['daily-session', 'activity-analyzed']);

    // La borne est bien à 90 jours en arrière, pas à l'instant du balayage.
    // (Drizzle sérialise l'instant en ISO avant de le passer au pilote.)
    expect(params[2]).toBe(new Date('2026-05-18T10:00:00Z').toISOString());
  });

  it('garde une marge très large devant la plus longue fenêtre de déduplication', () => {
    // La plus longue est celle du rappel du matin : un jour civil. 90 jours
    // laissent la place à un fuseau, une panne, un redéploiement — sans jamais
    // approcher une fenêtre encore vivante.
    expect(NOTICE_RETENTION_DAYS).toBeGreaterThanOrEqual(30);
  });
});
