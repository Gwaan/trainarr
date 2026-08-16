import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './backfill-best-segments';

/**
 * Rattrapage des meilleurs efforts, éprouvé sur une base en mémoire.
 *
 * **L'invariant sous test tient en une phrase** : après un passage du script, il
 * ne reste plus d'activité « en attente » — donc le compteur de l'écran des
 * records (`pendingActivities`) peut atteindre zéro, et l'écran cesse d'annoncer
 * des records provisoires. Ce n'est pas une propriété du DAL, ni du prédicat
 * seul : elle n'existe que si **chaque** séance balayée reçoit sa marque, y
 * compris celles dont le calcul ne rend rien. C'est exactement ce qui manquait
 * dans la première version — un flux de distance présent mais inexploitable
 * produisait zéro segment, donc zéro ligne, donc une séance éternellement
 * sélectionnée.
 *
 * D'où un test qui fait **tourner la boucle** au lieu d'inspecter une requête :
 * une régression sur la marque ne se manifeste pas dans une clause SQL, elle se
 * manifeste dans un balayage qui ne converge pas.
 */

/** L'état de la base factice, et les leviers de panne du test. */
const { base } = vi.hoisted(() => ({
  base: {
    activities: [] as { id: number; scannedAt: Date | null }[],
    streams: [] as { activityId: number; type: string; data: unknown }[],
    segments: [] as { activityId: number; targetM: number }[],
    /** Activités dont l'écriture doit lever, pour éprouver le cas en échec. */
    failing: new Set<number>(),
    /** Tours de sélection : un balayage qui ne converge pas doit échouer, pas pendre. */
    selections: 0,
  },
}));

/**
 * Les activités que le prédicat ramènerait, en mémoire.
 *
 * Reproduit les deux conditions qui font la terminaison — jamais balayée, et
 * aucune ligne de segment. Les trois conditions de possibilité (course à pied,
 * 400 m, flux de distance présent) sont supposées vraies pour toutes les
 * activités du test : ce n'est pas ce qui est éprouvé ici.
 */
function pending(cursor = 0): { id: number; scannedAt: Date | null }[] {
  return base.activities
    .filter(
      (activity) =>
        activity.id > cursor &&
        activity.scannedAt === null &&
        !base.segments.some((segment) => segment.activityId === activity.id),
    )
    .sort((left, right) => left.id - right.id);
}

vi.mock('postgres', () => ({
  // Le script ferme le pool dans un `finally` : la seule méthode utilisée.
  default: () => ({ end: () => Promise.resolve() }),
}));

vi.mock('drizzle-orm/postgres-js', async () => {
  const { SQL, getTableName } = await import('drizzle-orm');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  type Table = Parameters<typeof getTableName>[0];

  const dialect = new PgDialect();

  /** Premier paramètre d'une clause : le curseur, ou l'identifiant d'activité. */
  const firstParam = (clause: unknown): number => {
    if (!(clause instanceof SQL)) throw new Error('Clause attendue.');
    const [first] = dialect.sqlToQuery(clause).params;
    if (typeof first !== 'number') throw new Error('Premier paramètre numérique attendu.');
    return first;
  };

  type Chain = PromiseLike<unknown[]> & {
    where: (clause: unknown) => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (fields: Record<string, unknown>, table: Table): Chain => {
    const state = { table: getTableName(table), where: null as unknown };

    const rows = (): unknown[] => {
      if (state.table === 'activity_streams') {
        const activityId = firstParam(state.where);
        return base.streams.filter((stream) => stream.activityId === activityId);
      }
      // Deux lectures de `activities` : le comptage (`{ value }`) et la
      // pagination par curseur (`{ id }`). La forme du `select` les distingue.
      if ('value' in fields) return [{ value: pending().length }];

      base.selections += 1;
      if (base.selections > 20) {
        throw new Error(
          'Le balayage ne converge pas : des séances déjà balayées sont resélectionnées.',
        );
      }
      return pending(firstParam(state.where)).map((activity) => ({ id: activity.id }));
    };

    const chain: Chain = {
      where: (clause) => {
        state.where = clause;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      // Paresseux : la résolution ne doit lire l'état de la chaîne qu'une fois
      // celle-ci complète (`where` puis `orderBy` puis `limit`).
      then: (onFulfilled, onRejected) =>
        Promise.resolve()
          .then(() => rows())
          .then(onFulfilled, onRejected),
    };
    return chain;
  };

  const tx = {
    delete: () => ({
      where: (clause: unknown) => {
        const activityId = firstParam(clause);
        if (base.failing.has(activityId)) throw new Error('base injoignable');
        base.segments = base.segments.filter((segment) => segment.activityId !== activityId);
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (rows: { activityId: number; targetM: number }[]) => {
        base.segments.push(...rows);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (values: { bestSegmentsScannedAt: Date }) => ({
        where: (clause: unknown) => {
          const activityId = firstParam(clause);
          const activity = base.activities.find((row) => row.id === activityId);
          if (activity) activity.scannedAt = values.bestSegmentsScannedAt;
          return Promise.resolve();
        },
      }),
    }),
  };

  return {
    drizzle: () => ({
      select: (fields: Record<string, unknown>) => ({
        from: (table: Table) => chainFor(fields, table),
      }),
      // Transaction factice : la panne simulée lève dans le `delete`, donc avant
      // toute écriture — l'atomicité réelle est celle de Postgres, pas du test.
      transaction: (run: (transaction: typeof tx) => Promise<void>) => run(tx),
    }),
  };
});

/** Un flux de distance régulier : 2 000 m en 500 s, un point toutes les 25 s. */
function usableStreams(activityId: number): { activityId: number; type: string; data: unknown }[] {
  const distance = Array.from({ length: 21 }, (_, index) => index * 100);
  const time = Array.from({ length: 21 }, (_, index) => index * 25);
  return [
    { activityId, type: 'distance', data: distance },
    { activityId, type: 'time', data: time },
  ];
}

let logged: string[];
let warned: string[];
let errored: string[];

beforeEach(() => {
  base.activities = [];
  base.streams = [];
  base.segments = [];
  base.failing = new Set();
  base.selections = 0;

  logged = [];
  warned = [];
  errored = [];
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
    logged.push(String(message));
  });
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    warned.push(String(message));
  });
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    errored.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rattrapage des meilleurs efforts', () => {
  it('ne laisse aucune activité en attente, même celles dont rien ne se calcule', async () => {
    base.activities = [
      { id: 1, scannedAt: null },
      { id: 2, scannedAt: null },
      { id: 3, scannedAt: null },
    ];
    base.streams = [
      ...usableStreams(1),
      // Le cas qui bloquait tout : un canal `distance` bien présent en base — le
      // prédicat le voit — mais entièrement `null`, comme en produit un import
      // indoor. Zéro segment, donc zéro ligne, donc autrefois « en attente » à
      // perpétuité.
      { activityId: 2, type: 'distance', data: [null, null, null] },
      { activityId: 2, type: 'time', data: [0, 1, 2] },
      // Canal non numérique d'un import ancien : refusé par la lecture, jamais
      // deviné.
      { activityId: 3, type: 'distance', data: ['0', '100'] },
      { activityId: 3, type: 'time', data: [0, 25] },
    ];

    await main();

    // L'invariant : plus rien à rattraper. C'est ce que l'écran des records lit
    // pour cesser d'annoncer des records provisoires.
    expect(pending()).toEqual([]);
    expect(base.activities.every((activity) => activity.scannedAt !== null)).toBe(true);
    // Et seule celle qui en produisait a des segments : la marque n'invente rien.
    expect(new Set(base.segments.map((segment) => segment.activityId))).toEqual(new Set([1]));
  });

  it('journalise l’identifiant et le motif de chaque séance sans segment', async () => {
    base.activities = [
      { id: 7, scannedAt: null },
      { id: 9, scannedAt: null },
    ];
    base.streams = [
      { activityId: 7, type: 'distance', data: [null, null] },
      { activityId: 7, type: 'time', data: [0, 1] },
      { activityId: 9, type: 'time', data: [0, 1] },
    ];

    await main();

    // Sans l'identifiant, « 2 séances sans segment » ne se corrige pas : rien ne
    // permettrait d'aller regarder les lignes en cause.
    expect(warned).toEqual([
      expect.stringContaining('Activité 7'),
      expect.stringContaining('Activité 9'),
    ]);
    expect(warned[0]).toContain('aucune fenêtre de 400 m');
    expect(warned[1]).toContain('flux de distance absent ou mal formé');
    expect(logged.at(-1)).toContain('2 sans segment calculable');
  });

  it('laisse en attente — et seulement elles — les séances dont l’écriture échoue', async () => {
    base.activities = [
      { id: 4, scannedAt: null },
      { id: 5, scannedAt: null },
    ];
    base.streams = [...usableStreams(4), ...usableStreams(5)];
    base.failing = new Set([5]);

    await main();

    // La transaction annulée n'a pas posé de marque : la séance repart en file,
    // et le script le dit au lieu de laisser croire à un rattrapage complet.
    expect(pending().map((activity) => activity.id)).toEqual([5]);
    expect(errored[0]).toContain('Activité 5');
    expect(logged.at(-1)).toContain('relancer la commande');
  });

  it('ne fait rien à un second passage', async () => {
    base.activities = [{ id: 1, scannedAt: null }];
    base.streams = usableStreams(1);

    await main();
    logged.length = 0;
    await main();

    expect(logged).toEqual(['Aucune activité en attente : tous les meilleurs efforts sont en base.']);
  });
});
