import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REFERENCE_DISTANCES, vdotFromRace } from '@/lib/metrics';

import type { Athlete } from './db/schema';
import { getRacePredictions } from './race-prediction';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/** L'athlète appartient à un compte : le DAL le résout depuis la session. */
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
 * par table, en enregistrant au passage la clause `where` — c'est là que se lit
 * le cloisonnement.
 */
const { queryState } = vi.hoisted(() => ({
  queryState: {
    rows: {} as Record<string, unknown[]>,
    queries: [] as { table: string; where: unknown }[],
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: unknown) => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const query = { table: name, where: null as unknown };
    queryState.queries.push(query);

    const chain: Chain = {
      where: (clause) => {
        query.where = clause;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(queryState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return { db: { select: () => ({ from: (table: Table) => chainFor(table) }) } };
});

const ATHLETE: Pick<Athlete, 'id' | 'userId'> = { id: 1, userId: 'user_1' };

/** Un 10 km en 48:30, déclaré à l'ouverture d'un plan démarré le 1ᵉʳ juin. */
function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startsOn: '2026-06-01',
    referenceDistance: '10k',
    referenceTimeS: 2_910,
    referenceUpdatedOn: null,
    ...overrides,
  };
}

const dialect = new PgDialect();

function renderWhere(table: string): string {
  const clause = queryState.queries.find((query) => query.table === table)?.where;
  if (!(clause instanceof SQL)) throw new Error(`Aucune clause pour « ${table} ».`);
  return dialect.sqlToQuery(clause).sql;
}

beforeEach(() => {
  sessionState.current = { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' };
  queryState.rows = {};
  queryState.queries = [];
});

describe('getRacePredictions', () => {
  it('ne lit aucun plan tant que personne n’est connecté', async () => {
    sessionState.current = null;
    queryState.rows = { plans: [plan()] };

    expect(await getRacePredictions()).toEqual({
      anchor: null,
      races: [],
      unavailable: null,
    });
    expect(queryState.queries.some((query) => query.table === 'plans')).toBe(false);
  });

  it('prend le chrono de référence du plan actif pour ancre', async () => {
    queryState.rows = { athlete: [ATHLETE], plans: [plan()] };

    const { anchor, races, unavailable } = await getRacePredictions();

    expect(unavailable).toBeNull();
    expect(anchor).toEqual({
      distance: '10k',
      distanceM: REFERENCE_DISTANCES['10k'],
      timeS: 2_910,
      vdot: vdotFromRace(REFERENCE_DISTANCES['10k'], 2_910),
      // Sans test, l'ancre est le premier jour du plan : c'est là que le chrono
      // a été déclaré.
      since: '2026-06-01',
      fromTest: false,
    });
    expect(races.map((race) => race.distance)).toEqual(['5k', '10k', 'half', 'marathon']);
  });

  it('date l’ancre du dernier test dès qu’il y en a eu un', async () => {
    queryState.rows = {
      athlete: [ATHLETE],
      plans: [plan({ referenceDistance: '5k', referenceTimeS: 1_380, referenceUpdatedOn: '2026-07-12' })],
    };

    const { anchor } = await getRacePredictions();

    expect(anchor?.since).toBe('2026-07-12');
    expect(anchor?.fromTest).toBe(true);
  });

  it('ne lit que le plan actif de l’athlète de la session', async () => {
    queryState.rows = { athlete: [ATHLETE], plans: [plan()] };

    await getRacePredictions();

    const where = renderWhere('plans');
    expect(where).toContain('"athlete_id"');
    expect(where).toContain('"status"');
  });

  it('dit qu’il n’y a pas de plan plutôt que de prédire sur autre chose', async () => {
    queryState.rows = { athlete: [ATHLETE], plans: [] };

    expect(await getRacePredictions()).toEqual({
      anchor: null,
      races: [],
      unavailable: { noActivePlan: true },
    });
  });

  it('distingue le plan sans chrono du plan absent', async () => {
    queryState.rows = {
      athlete: [ATHLETE],
      plans: [plan({ referenceDistance: null, referenceTimeS: null })],
    };

    expect(await getRacePredictions()).toEqual({
      anchor: null,
      races: [],
      unavailable: { noActivePlan: false },
    });
  });
});
