import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Athlete } from './db/schema';
import { getPersonalBests } from './personal-bests';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * L'athlète appartient à un compte : le DAL le résout depuis la session. Les
 * tests travaillent donc sous une session ouverte, sauf celui qui éprouve le cas
 * « personne n'est connecté ».
 */
const { sessionState } = vi.hoisted(() => {
  type Session = { userId: string; name: string; email: string } | null;
  const sessionState: { current: Session } = {
    current: { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' },
  };
  return { sessionState };
});

vi.mock('./session', () => ({ getSession: () => Promise.resolve(sessionState.current) }));

/**
 * Aucune base : la chaîne de requête est factice et sert les lignes déclarées
 * par table. Elle enregistre au passage la clause `where`, la jointure et le
 * tri de chaque requête — c'est là que se lisent le cloisonnement et l'ordre du
 * `DISTINCT ON`.
 */
const { queryState } = vi.hoisted(() => {
  type RecordedQuery = {
    table: string;
    where: unknown;
    join: unknown;
    distinctOn: unknown[] | null;
    orderBy: unknown[];
  };
  return {
    queryState: {
      rows: {} as Record<string, unknown[]>,
      queries: [] as RecordedQuery[],
    },
  };
});

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: unknown) => Chain;
    innerJoin: (table: Table, clause: unknown) => Chain;
    orderBy: (...clauses: unknown[]) => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table, distinctOn: unknown[] | null): Chain => {
    const name = getTableName(table);
    const query = {
      table: name,
      where: null as unknown,
      join: null as unknown,
      distinctOn,
      orderBy: [] as unknown[],
    };
    queryState.queries.push(query);

    const chain: Chain = {
      where: (clause) => {
        query.where = clause;
        return chain;
      },
      innerJoin: (_joined, clause) => {
        query.join = clause;
        return chain;
      },
      orderBy: (...clauses) => {
        query.orderBy = clauses;
        return chain;
      },
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(queryState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return {
    db: {
      select: () => ({ from: (table: Table) => chainFor(table, null) }),
      selectDistinctOn: (on: unknown[]) => ({
        from: (table: Table) => chainFor(table, on),
      }),
    },
  };
});

const ATHLETE: Pick<Athlete, 'id' | 'userId'> = { id: 1, userId: 'user_1' };

const dialect = new PgDialect();

function render(clause: unknown): { sql: string; params: unknown[] } {
  if (!(clause instanceof SQL)) throw new Error('Aucune clause enregistrée pour cette requête.');
  const rendered = dialect.sqlToQuery(clause);
  return { sql: rendered.sql, params: rendered.params };
}

/** Un record tel que la requête agrégée le rend : segment + séance porteuse. */
function best(
  targetM: number,
  timeS: number,
  activityId: number,
  startedAt: string,
): Record<string, unknown> {
  return {
    targetM,
    timeS,
    paceSecPerKm: (timeS / targetM) * 1000,
    activityId,
    startedAt: new Date(startedAt),
  };
}

beforeEach(() => {
  sessionState.current = { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' };
  queryState.rows = {};
  queryState.queries = [];
});

describe('getPersonalBests', () => {
  it('ne lit rien tant que personne n’est connecté', async () => {
    sessionState.current = null;
    queryState.rows = { activity_best_segments: [best(1000, 240, 7, '2026-05-01T06:00:00.000Z')] };

    expect(await getPersonalBests()).toEqual({ bests: [], pendingActivities: 0 });
    expect(queryState.queries.some((query) => query.table === 'activity_best_segments')).toBe(
      false,
    );
  });

  it('rend un record par cible, daté et rattaché à sa séance', async () => {
    queryState.rows = {
      athlete: [ATHLETE],
      activity_best_segments: [
        best(400, 78, 12, '2026-04-18T17:30:00.000Z'),
        best(1000, 214, 31, '2026-06-02T06:15:00.000Z'),
      ],
      activities: [{ value: 0 }],
    };

    expect(await getPersonalBests()).toEqual({
      bests: [
        {
          targetM: 400,
          timeS: 78,
          paceSecPerKm: 195,
          achievedOn: '2026-04-18',
          activityId: 12,
        },
        {
          targetM: 1000,
          timeS: 214,
          paceSecPerKm: 214,
          achievedOn: '2026-06-02',
          activityId: 31,
        },
      ],
      pendingActivities: 0,
    });
  });

  it('date le record dans le fuseau de l’athlète, pas en UTC', async () => {
    // 23 h 30 UTC le 17 avril, c'est 1 h 30 le 18 à Paris : la date affichée est
    // celle qu'a vécue l'athlète.
    queryState.rows = {
      athlete: [ATHLETE],
      activity_best_segments: [best(400, 78, 12, '2026-04-17T23:30:00.000Z')],
      activities: [{ value: 0 }],
    };

    expect((await getPersonalBests()).bests[0].achievedOn).toBe('2026-04-18');
  });

  it('agrège en une seule requête, cloisonnée par la jointure', async () => {
    queryState.rows = {
      athlete: [ATHLETE],
      activity_best_segments: [best(400, 78, 12, '2026-04-18T17:30:00.000Z')],
      activities: [{ value: 0 }],
    };

    await getPersonalBests();

    const aggregate = queryState.queries.filter(
      (query) => query.table === 'activity_best_segments',
    );
    // Une seule lecture des segments : pas de N+1, pas de parcours en mémoire.
    expect(aggregate).toHaveLength(1);
    // `activity_best_segments` n'a pas d'`athlete_id` : c'est la jointure sur la
    // table parente qui porte le cloisonnement, et elle est dans la requête.
    expect(render(aggregate[0].join).params).toEqual([ATHLETE.id]);
    // Un record par cible, et le tri qui désigne le record : cible, puis chrono
    // croissant, puis la séance la plus ancienne pour départager les ex æquo.
    expect(aggregate[0].distinctOn).toHaveLength(1);
    expect(aggregate[0].orderBy).toHaveLength(3);
  });

  it('compte les activités de course encore à rattraper, sous son athlète', async () => {
    queryState.rows = {
      athlete: [ATHLETE],
      activity_best_segments: [],
      activities: [{ value: 137 }],
    };

    const result = await getPersonalBests();

    // Tant que ce compteur n'est pas nul, les records sont provisoires.
    expect(result).toEqual({ bests: [], pendingActivities: 137 });

    // La lecture de `activities` du comptage — la première est celle de
    // l'athlète, sur une autre table.
    const pending = queryState.queries.find((query) => query.table === 'activities');
    const rendered = render(pending?.where);
    expect(rendered.params).toContain(ATHLETE.id);
    // Le prédicat est celui du script de rattrapage : course à pied, distance
    // suffisante, flux de distance présent, jamais balayée, aucun segment écrit.
    expect(rendered.sql).toContain("like '%run%'");
    expect(rendered.sql).toContain('not exists');
    // La condition qui rend ce compteur capable d'atteindre zéro : une séance
    // balayée en sort, **qu'elle ait produit des segments ou non**. Sans elle,
    // un flux de distance inexploitable (canal entièrement `null`, canal non
    // numérique) restait compté en attente après chaque passage du rattrapage,
    // et l'écran réclamait la commande à perpétuité.
    expect(rendered.sql).toContain('"best_segments_scanned_at" is null');
  });
});
