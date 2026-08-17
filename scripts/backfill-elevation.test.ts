import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './backfill-elevation';

/**
 * Rattrapage du dénivelé, éprouvé sur une base en mémoire.
 *
 * **L'invariant sous test tient en une phrase** : après un passage du script, il
 * ne reste plus d'activité « en attente ». Ce n'est une propriété ni du prédicat
 * seul ni du calcul seul — elle n'existe que si **chaque** séance balayée reçoit
 * sa marque, y compris celles dont le flux d'altitude ne rend rien. C'est
 * exactement la leçon que le rattrapage des meilleurs efforts a coûtée, et ce
 * fichier est le garde-fou qui l'empêche d'être réapprise.
 *
 * D'où un test qui fait **tourner la boucle** au lieu d'inspecter une requête :
 * une régression sur la marque ne se manifeste pas dans une clause SQL, elle se
 * manifeste dans un balayage qui ne converge pas.
 */

/** L'état de la base factice, et les leviers de panne du test. */
const { base } = vi.hoisted(() => ({
  base: {
    activities: [] as {
      id: number;
      gainM: number | null;
      lossM: number | null;
      scannedAt: Date | null;
    }[],
    streams: [] as { activityId: number; data: unknown }[],
    /** Activités dont l'écriture doit lever, pour éprouver le cas en échec. */
    failing: new Set<number>(),
    /** Tours de sélection : un balayage qui ne converge pas doit échouer, pas pendre. */
    selections: 0,
  },
}));

/**
 * Les activités que le prédicat ramènerait, en mémoire.
 *
 * Reproduit les trois conditions de `pendingElevationWhere` : un flux d'altitude
 * en base, **les deux** sens manquants, et jamais balayée.
 */
function pending(cursor = 0) {
  return base.activities
    .filter(
      (activity) =>
        activity.id > cursor &&
        activity.scannedAt === null &&
        activity.gainM === null &&
        activity.lossM === null &&
        base.streams.some((stream) => stream.activityId === activity.id),
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

  /** Les paramètres liés d'une clause — de quoi lire ce que le `coalesce` écrit. */
  const params = (clause: unknown): unknown[] => {
    if (!(clause instanceof SQL)) throw new Error('Clause attendue.');
    return dialect.sqlToQuery(clause).params;
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

  return {
    drizzle: () => ({
      select: (fields: Record<string, unknown>) => ({
        from: (table: Table) => chainFor(fields, table),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (clause: unknown) => {
            const activityId = firstParam(clause);
            if (base.failing.has(activityId)) throw new Error('base injoignable');

            const activity = base.activities.find((row) => row.id === activityId);
            if (activity) {
              // `case when (D+ is null and D− is null) then <valeur> else
              // <colonne> end` : le repli ne remplit la paire que si elle est
              // entièrement vide. C'est la politique du DAL, reproduite ici pour
              // que le test éprouve la même chose que la base — un `coalesce`
              // par colonne mêlerait deux filtres dans une même paire.
              const pairIsEmpty = activity.gainM === null && activity.lossM === null;
              if (pairIsEmpty && 'elevationGainM' in values) {
                activity.gainM = Number(params(values.elevationGainM)[0]);
              }
              if (pairIsEmpty && 'elevationLossM' in values) {
                activity.lossM = Number(params(values.elevationLossM)[0]);
              }
              activity.scannedAt = values.elevationScannedAt as Date;
            }
            return Promise.resolve();
          },
        }),
      }),
    }),
  };
});

/** Une bosse de 12 m suivie d'une redescente de 5 m, plus du bruit sous le seuil. */
function usableAltitude(activityId: number): { activityId: number; data: unknown } {
  return { activityId, data: [100, 100.4, 99.6, 112, 111.7, 107] };
}

let logged: string[];
let warned: string[];
let errored: string[];

beforeEach(() => {
  base.activities = [];
  base.streams = [];
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

describe('rattrapage du dénivelé', () => {
  it('ne laisse aucune activité en attente, même celles dont rien ne se calcule', async () => {
    base.activities = [
      { id: 1, gainM: null, lossM: null, scannedAt: null },
      { id: 2, gainM: null, lossM: null, scannedAt: null },
      { id: 3, gainM: null, lossM: null, scannedAt: null },
    ];
    base.streams = [
      usableAltitude(1),
      // Le cas qui bloquerait tout : un canal `altitude` bien présent en base —
      // le prédicat le voit — mais entièrement `null`, comme en produit un
      // import indoor. Aucun dénivelé, donc autrefois « en attente » à
      // perpétuité.
      { activityId: 2, data: [null, null, null] },
      // Canal non numérique d'un import ancien : refusé par la lecture, jamais
      // deviné.
      { activityId: 3, data: ['100', '112'] },
    ];

    await main();

    expect(pending()).toEqual([]);
    expect(base.activities.every((activity) => activity.scannedAt !== null)).toBe(true);
    // Et seule celle qui en produisait a un dénivelé : la marque n'invente rien.
    expect(base.activities.map(({ id, gainM, lossM }) => ({ id, gainM, lossM }))).toEqual([
      { id: 1, gainM: 12, lossM: 5 },
      { id: 2, gainM: null, lossM: null },
      { id: 3, gainM: null, lossM: null },
    ]);
  });

  it('laisse intacte une paire qu’un appareil a dite à moitié', async () => {
    // La montre avait écrit `total_ascent` mais pas `total_descent`. Compléter
    // le seul D− depuis le flux persisterait un D+ de 30 (algorithme de la
    // montre) à côté d'un D− de 5 (notre hystérésis de 1 m) : deux filtres dans
    // la même paire, que la formule de Greif additionne pondérés. La paire
    // appartient donc au fichier, telle qu'il l'a dite — et la correction
    // d'altitude ne s'appliquera pas à cette séance, ce qui est la réponse
    // honnête d'un dénivelé à moitié inconnu.
    //
    // Elle n'est même plus « en attente » : le prédicat exige les deux sens
    // vides, il n'y a rien que le rattrapage puisse en faire.
    base.activities = [{ id: 1, gainM: 30, lossM: null, scannedAt: null }];
    base.streams = [usableAltitude(1)];

    await main();

    expect(base.activities[0]).toMatchObject({ gainM: 30, lossM: null });
    expect(logged[0]).toContain('Aucune activité en attente');
  });

  it('journalise l’identifiant et le motif de chaque séance sans dénivelé', async () => {
    base.activities = [
      { id: 7, gainM: null, lossM: null, scannedAt: null },
      { id: 9, gainM: null, lossM: null, scannedAt: null },
    ];
    base.streams = [
      { activityId: 7, data: [null, 100] },
      { activityId: 9, data: 'pas une série' },
    ];

    await main();

    // Sans l'identifiant, « 2 séances sans dénivelé » ne s'apprend rien et ne se
    // corrige pas.
    expect(warned).toEqual([
      expect.stringContaining('Activité 7'),
      expect.stringContaining('Activité 9'),
    ]);
    expect(warned[0]).toContain('moins de deux mesures');
    expect(warned[1]).toContain('absent ou mal formé');
    expect(logged.at(-1)).toContain('2 sans dénivelé calculable');
  });

  it('laisse en attente — et seulement elles — les séances dont l’écriture échoue', async () => {
    base.activities = [
      { id: 4, gainM: null, lossM: null, scannedAt: null },
      { id: 5, gainM: null, lossM: null, scannedAt: null },
    ];
    base.streams = [usableAltitude(4), usableAltitude(5)];
    base.failing = new Set([5]);

    await main();

    // L'écriture annulée n'a pas posé de marque : la séance repart en file, et
    // le script le dit au lieu de laisser croire à un rattrapage complet.
    expect(pending().map((activity) => activity.id)).toEqual([5]);
    expect(errored[0]).toContain('Activité 5');
    expect(logged.at(-1)).toContain('relancer la commande');
  });

  it('ne fait rien à un second passage', async () => {
    base.activities = [{ id: 1, gainM: null, lossM: null, scannedAt: null }];
    base.streams = [usableAltitude(1)];

    await main();
    logged.length = 0;
    await main();

    expect(logged).toEqual([
      'Aucune activité en attente : tous les dénivelés calculables sont en base.',
    ]);
  });
});
