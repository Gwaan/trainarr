import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AthleteNotFoundError } from './athlete';
import {
  COACH_HISTORY_LIMIT,
  COACH_HISTORY_LIMIT_MAX,
  COACH_MESSAGE_LIMITS,
  InvalidCoachHistoryLimitError,
  InvalidCoachMessageError,
  appendCoachExchange,
  appendCoachMessage,
  clearCoachConversation,
  listCoachMessages,
  resolveHistoryLimit,
  validateCoachMessageContent,
  type CoachMessageRole,
} from './coach-chat';
import type { CoachMessage } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : les lectures servent les lignes déclarées par table,
 * les écritures sont enregistrées avec leur clause `WHERE`. L'ordre et le
 * `LIMIT` des lectures sont enregistrés eux aussi — c'est là que se joue « les N
 * **derniers** messages », donc c'est là que les tests regardent.
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    returning: {} as Record<string, unknown[]>,
    inserts: [] as Array<{ table: string; values: unknown }>,
    deletes: [] as Array<{ table: string; where: SQL }>,
    selects: [] as Array<{ table: string; where: SQL }>,
    orderBys: [] as Array<{ table: string; clauses: SQL[] }>,
    limits: [] as Array<{ table: string; value: number }>,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type SelectChain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => SelectChain;
    orderBy: (...clauses: SQL[]) => SelectChain;
    limit: (value: number) => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      where: (clause) => {
        dbState.selects.push({ table: name, where: clause });
        return chain;
      },
      orderBy: (...clauses) => {
        dbState.orderBys.push({ table: name, clauses });
        return chain;
      },
      limit: (value) => {
        dbState.limits.push({ table: name, value });
        return chain;
      },
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  type WriteChain = PromiseLike<unknown> & { returning: () => Promise<unknown[]> };

  const writeChain = (name: string): WriteChain => ({
    returning: () => Promise.resolve(dbState.returning[name] ?? []),
    then: (onFulfilled, onRejected) => Promise.resolve(undefined).then(onFulfilled, onRejected),
  });

  return {
    db: {
      select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
      insert: (table: Table) => ({
        values: (values: unknown) => {
          const name = getTableName(table);
          dbState.inserts.push({ table: name, values });
          return writeChain(name);
        },
      }),
      delete: (table: Table) => ({
        where: (clause: SQL) => {
          const name = getTableName(table);
          dbState.deletes.push({ table: name, where: clause });
          return writeChain(name);
        },
      }),
    },
  };
});

const dialect = new PgDialect();

/** Clause `WHERE` rendue en SQL + paramètres liés, pour l'affirmer telle qu'elle partira. */
function renderWhere(clause: SQL | undefined): { sql: string; params: unknown[] } {
  if (clause === undefined) throw new Error('Aucune clause `WHERE` enregistrée pour cette requête.');
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

/** Clauses `ORDER BY` d'une lecture, rendues en SQL. */
function renderOrder(entry: { clauses: SQL[] } | undefined): string {
  if (entry === undefined) throw new Error('Aucun `ORDER BY` enregistré pour cette requête.');
  return entry.clauses.map((clause) => dialect.sqlToQuery(clause).sql).join(', ');
}

const MESSAGE_DTO_KEYS = ['content', 'createdAt', 'id', 'role'];

function messageRow(overrides: Partial<CoachMessage> = {}): CoachMessage {
  return {
    id: 1,
    athleteId: 1,
    role: 'user',
    content: 'Comment je gère ma semaine de reprise ?',
    createdAt: new Date('2026-08-12T08:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Le fil tel que la base le rend : **du plus récent au plus ancien**, puisque
 * c'est ainsi qu'on attrape la fin d'un fil.
 */
const NEWEST_FIRST: CoachMessage[] = [
  messageRow({ id: 3, role: 'assistant', content: 'Trois sorties faciles.', createdAt: new Date('2026-08-12T08:00:02.000Z') }),
  messageRow({ id: 2, role: 'user', content: 'Et cette semaine ?', createdAt: new Date('2026-08-12T08:00:01.000Z') }),
  messageRow({ id: 1, role: 'user', content: 'Salut coach', createdAt: new Date('2026-08-12T08:00:00.000Z') }),
];

beforeEach(() => {
  dbState.rows = { athlete: [{ id: 1 }] };
  dbState.returning = {};
  dbState.inserts = [];
  dbState.deletes = [];
  dbState.selects = [];
  dbState.orderBys = [];
  dbState.limits = [];
});

describe('validateCoachMessageContent', () => {
  it('détoure le contenu avant toute chose', () => {
    expect(validateCoachMessageContent('  Salut coach\n')).toBe('Salut coach');
  });

  it('refuse un message vide ou tout en blancs', () => {
    for (const content of ['', '   ', '\n\t ']) {
      try {
        validateCoachMessageContent(content);
        expect.unreachable('un message vide ne dit rien au coach');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidCoachMessageError);
        expect((error as InvalidCoachMessageError).field).toBe('content');
      }
    }
  });

  it('accepte exactement la borne haute, refuse le caractère de trop', () => {
    const max = COACH_MESSAGE_LIMITS.content.max;

    expect(validateCoachMessageContent('a'.repeat(max))).toHaveLength(max);
    expect(() => validateCoachMessageContent('a'.repeat(max + 1))).toThrow(
      InvalidCoachMessageError,
    );
  });

  it('mesure la longueur après détourage, pas avant', () => {
    // Un copier-coller entouré d'espaces ne doit pas être refusé pour des
    // caractères qui ne partiront jamais au modèle.
    const padded = `  ${'a'.repeat(COACH_MESSAGE_LIMITS.content.max)}  `;

    expect(validateCoachMessageContent(padded)).toHaveLength(COACH_MESSAGE_LIMITS.content.max);
  });
});

describe('resolveHistoryLimit', () => {
  it('retombe sur le défaut quand rien n’est demandé', () => {
    expect(resolveHistoryLimit()).toBe(COACH_HISTORY_LIMIT);
    expect(resolveHistoryLimit(undefined)).toBe(COACH_HISTORY_LIMIT);
  });

  it('accepte les bornes utiles', () => {
    expect(resolveHistoryLimit(1)).toBe(1);
    expect(resolveHistoryLimit(12)).toBe(12);
    expect(resolveHistoryLimit(COACH_HISTORY_LIMIT_MAX)).toBe(COACH_HISTORY_LIMIT_MAX);
  });

  it('refuse tout ce qui n’est pas un entier de 1 au plafond', () => {
    // Rejet plutôt que rabattement silencieux : un appelant qui demande le fil
    // entier se trompe, lui rendre le défaut masquerait l'erreur.
    const refused = [0, -1, 1.5, COACH_HISTORY_LIMIT_MAX + 1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const limit of refused) {
      expect(() => resolveHistoryLimit(limit)).toThrow(InvalidCoachHistoryLimitError);
    }
  });
});

describe('listCoachMessages', () => {
  it('rend les messages du plus ancien au plus récent', async () => {
    dbState.rows.coach_messages = NEWEST_FIRST;

    const messages = await listCoachMessages();

    // C'est l'ordre d'affichage et celui d'un historique envoyé au modèle : la
    // base a servi la fin du fil à l'envers, le DAL la remet à l'endroit.
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(messages.map((message) => message.content)).toEqual([
      'Salut coach',
      'Et cette semaine ?',
      'Trois sorties faciles.',
    ]);
    expect(messages.map((message) => message.createdAt)).toEqual([
      '2026-08-12T08:00:00.000Z',
      '2026-08-12T08:00:01.000Z',
      '2026-08-12T08:00:02.000Z',
    ]);
  });

  it('demande à la base les **derniers** messages, pas les premiers', async () => {
    dbState.rows.coach_messages = NEWEST_FIRST;

    await listCoachMessages();

    // Le piège que ce test existe pour fermer : un `ORDER BY … ASC LIMIT n`
    // rendrait le *début* du fil, et le coach répondrait à une conversation
    // qu'il a quittée depuis longtemps. L'`id` départage deux messages écrits
    // dans la même seconde (une question et sa réponse peuvent l'être).
    expect(renderOrder(dbState.orderBys.find((query) => query.table === 'coach_messages'))).toBe(
      '"coach_messages"."created_at" desc, "coach_messages"."id" desc',
    );
  });

  it('ne lit que le fil de l’athlète, et pas plus que le défaut', async () => {
    dbState.rows.coach_messages = NEWEST_FIRST;

    await listCoachMessages();

    expect(renderWhere(dbState.selects.find((query) => query.table === 'coach_messages')?.where).params).toEqual([1]);
    expect(dbState.limits.find((query) => query.table === 'coach_messages')?.value).toBe(
      COACH_HISTORY_LIMIT,
    );
  });

  it('respecte le nombre de messages demandé', async () => {
    dbState.rows.coach_messages = NEWEST_FIRST;

    await listCoachMessages(5);

    expect(dbState.limits.find((query) => query.table === 'coach_messages')?.value).toBe(5);
  });

  it('refuse un nombre de messages hors bornes, sans rien lire', async () => {
    await expect(listCoachMessages(0)).rejects.toBeInstanceOf(InvalidCoachHistoryLimitError);
    await expect(listCoachMessages(COACH_HISTORY_LIMIT_MAX + 1)).rejects.toBeInstanceOf(
      InvalidCoachHistoryLimitError,
    );
    await expect(listCoachMessages(2.5)).rejects.toBeInstanceOf(InvalidCoachHistoryLimitError);
    expect(dbState.selects).toEqual([]);
  });

  it('n’expose que les champs du DTO, sans identifiant d’athlète', async () => {
    dbState.rows.coach_messages = [messageRow()];

    const messages = await listCoachMessages();

    expect(Object.keys(messages[0] ?? {}).sort()).toEqual(MESSAGE_DTO_KEYS);
    expect(messages[0]).not.toHaveProperty('athleteId');
  });

  it('rend une liste vide tant que l’onboarding n’a pas eu lieu', async () => {
    dbState.rows = { athlete: [] };

    await expect(listCoachMessages()).resolves.toEqual([]);
  });

  it('rend une liste vide sur un fil vierge', async () => {
    dbState.rows.coach_messages = [];

    await expect(listCoachMessages()).resolves.toEqual([]);
  });
});

describe('appendCoachMessage', () => {
  it('écrit le message détouré, rattaché à l’athlète, et le rend en DTO', async () => {
    const row = messageRow({ id: 7, role: 'assistant', content: 'Trois sorties faciles.' });
    dbState.returning.coach_messages = [row];

    const dto = await appendCoachMessage({
      role: 'assistant',
      content: '  Trois sorties faciles.  ',
    });

    expect(dbState.inserts).toEqual([
      {
        table: 'coach_messages',
        values: { athleteId: 1, role: 'assistant', content: 'Trois sorties faciles.' },
      },
    ]);
    expect(Object.keys(dto).sort()).toEqual(MESSAGE_DTO_KEYS);
    expect(dto).toMatchObject({ id: 7, role: 'assistant', content: 'Trois sorties faciles.' });
    expect(dto.createdAt).toBe('2026-08-12T08:00:00.000Z');
  });

  it('accepte les deux rôles du fil', async () => {
    dbState.returning.coach_messages = [messageRow()];

    for (const role of ['user', 'assistant'] as const) {
      await appendCoachMessage({ role, content: 'Salut coach' });
    }

    expect(dbState.inserts.map((insert) => insert.values)).toMatchObject([
      { role: 'user' },
      { role: 'assistant' },
    ]);
  });

  it('valide le contenu avant toute écriture', async () => {
    for (const content of ['', '   ', 'a'.repeat(COACH_MESSAGE_LIMITS.content.max + 1)]) {
      await expect(appendCoachMessage({ role: 'user', content })).rejects.toBeInstanceOf(
        InvalidCoachMessageError,
      );
    }
    expect(dbState.inserts).toEqual([]);
  });

  it('refuse un rôle inattendu', async () => {
    // Le DAL n'est pas la seule porte d'entrée (le service du coach écrit ici
    // aussi) : la garde vaut pour ce que le typage ne voit pas.
    const input = { role: 'system' as CoachMessageRole, content: 'Tu es un coach.' };

    await expect(appendCoachMessage(input)).rejects.toBeInstanceOf(InvalidCoachMessageError);
    try {
      await appendCoachMessage(input);
    } catch (error) {
      expect((error as InvalidCoachMessageError).field).toBe('role');
    }
    expect(dbState.inserts).toEqual([]);
  });

  it('refuse d’écrire tant qu’aucun athlète n’est enregistré', async () => {
    dbState.rows = { athlete: [] };

    await expect(
      appendCoachMessage({ role: 'user', content: 'Salut coach' }),
    ).rejects.toBeInstanceOf(AthleteNotFoundError);
    expect(dbState.inserts).toEqual([]);
  });

  it('échoue si l’insertion ne rend aucune ligne', async () => {
    dbState.returning.coach_messages = [];

    await expect(appendCoachMessage({ role: 'user', content: 'Salut coach' })).rejects.toThrow();
  });
});

describe('appendCoachExchange', () => {
  /** Les deux lignes telles que la base les rend, dans l'ordre d'insertion. */
  const EXCHANGE: CoachMessage[] = [
    messageRow({ id: 8, role: 'user', content: 'Et cette semaine ?' }),
    messageRow({ id: 9, role: 'assistant', content: 'Trois sorties faciles.' }),
  ];

  it('écrit la question et la réponse en une seule insertion, dans cet ordre', async () => {
    dbState.returning.coach_messages = EXCHANGE;

    const written = await appendCoachExchange({
      question: '  Et cette semaine ?  ',
      answer: '  Trois sorties faciles.  ',
    });

    // Un seul `INSERT` à deux lignes : il n'existe pas d'état où la question
    // serait écrite sans sa réponse.
    expect(dbState.inserts).toEqual([
      {
        table: 'coach_messages',
        values: [
          { athleteId: 1, role: 'user', content: 'Et cette semaine ?' },
          { athleteId: 1, role: 'assistant', content: 'Trois sorties faciles.' },
        ],
      },
    ]);
    expect(written.question).toMatchObject({ id: 8, role: 'user' });
    expect(written.answer).toMatchObject({ id: 9, role: 'assistant' });
    expect(Object.keys(written.answer).sort()).toEqual(MESSAGE_DTO_KEYS);
  });

  it('valide les deux contenus avant toute écriture', async () => {
    const trop = 'a'.repeat(COACH_MESSAGE_LIMITS.content.max + 1);

    for (const input of [
      { question: '   ', answer: 'Trois sorties faciles.' },
      { question: 'Et cette semaine ?', answer: '' },
      { question: trop, answer: 'Trois sorties faciles.' },
      { question: 'Et cette semaine ?', answer: trop },
    ]) {
      await expect(appendCoachExchange(input)).rejects.toBeInstanceOf(InvalidCoachMessageError);
    }
    expect(dbState.inserts).toEqual([]);
  });

  it('refuse d’écrire tant qu’aucun athlète n’est enregistré', async () => {
    dbState.rows = { athlete: [] };

    await expect(
      appendCoachExchange({ question: 'Et cette semaine ?', answer: 'Trois sorties.' }),
    ).rejects.toBeInstanceOf(AthleteNotFoundError);
    expect(dbState.inserts).toEqual([]);
  });

  it('échoue si l’insertion ne rend pas ses deux lignes', async () => {
    dbState.returning.coach_messages = [EXCHANGE[0]];

    await expect(
      appendCoachExchange({ question: 'Et cette semaine ?', answer: 'Trois sorties.' }),
    ).rejects.toThrow();
  });

  it('rend un échange que la relecture remet dans l’ordre malgré un `created_at` commun', async () => {
    // Les deux lignes d'un même `INSERT` partagent leur horodatage : c'est
    // l'`id`, second critère du tri, qui garantit que la réponse ne s'affiche pas
    // avant la question.
    const sameSecond = new Date('2026-08-12T08:00:00.000Z');
    dbState.rows.coach_messages = [
      messageRow({ id: 9, role: 'assistant', content: 'Trois sorties.', createdAt: sameSecond }),
      messageRow({ id: 8, role: 'user', content: 'Et cette semaine ?', createdAt: sameSecond }),
    ];

    const fil = await listCoachMessages();

    expect(renderOrder(dbState.orderBys.find((query) => query.table === 'coach_messages'))).toBe(
      '"coach_messages"."created_at" desc, "coach_messages"."id" desc',
    );
    expect(fil.map((entry) => entry.id)).toEqual([8, 9]);
  });
});

describe('clearCoachConversation', () => {
  it('vide le fil de l’athlète, et lui seul', async () => {
    await expect(clearCoachConversation()).resolves.toBeUndefined();

    expect(dbState.deletes).toHaveLength(1);
    expect(dbState.deletes[0]?.table).toBe('coach_messages');
    expect(renderWhere(dbState.deletes[0]?.where).params).toEqual([1]);
  });

  it('est idempotent : effacer un fil déjà vide réussit', async () => {
    dbState.rows.coach_messages = [];

    await expect(clearCoachConversation()).resolves.toBeUndefined();
    await expect(clearCoachConversation()).resolves.toBeUndefined();

    // La suppression ne compte pas ses lignes : deux appels de suite se valent.
    expect(dbState.deletes).toHaveLength(2);
    expect(renderWhere(dbState.deletes[1]?.where).params).toEqual([1]);
  });

  it('réussit sans rien supprimer tant que l’onboarding n’a pas eu lieu', async () => {
    dbState.rows = { athlete: [] };

    await expect(clearCoachConversation()).resolves.toBeUndefined();
    expect(dbState.deletes).toEqual([]);
  });
});
