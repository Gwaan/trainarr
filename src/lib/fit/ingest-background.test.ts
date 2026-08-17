import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { ParsedFitActivity } from './parse';

/**
 * **Une ingestion complète, hors requête, ne doit produire aucun appel de
 * session.** C'est le test de non-régression du bug de production : le commit
 * `aa2b557` avait donné son athlète à `ingestFitBuffer`, mais pas aux
 * traitements qu'elle déclenche. Ceux-là le déduisaient d'une session — que le
 * watcher FIT n'a pas — et ne faisaient donc rien : les activités s'importaient
 * sans jamais être rattachées aux séances planifiées, sans test recalibré, sans
 * révision. Le seul symptôme était un `[auth] lecture de la session impossible`
 * par fichier importé.
 *
 * Contrairement à `ingest.test.ts`, qui remplace toute la chaîne par des
 * doublons pour éprouver l'ordre des étapes, celui-ci fait tourner le **vrai**
 * code de bout en bout — rapprochement, test chronométré, révision — sur une
 * base simulée. Ne sont remplacés que les trois bords du système : la base, le
 * modèle de langue, et l'écriture de l'activité elle-même (déjà éprouvée
 * ailleurs, et déjà porteuse de son athlète).
 *
 * La session, elle, est un **espion qui lève**. Elle ne devrait jamais être
 * atteinte ; si un chemin y revenait, ce test échouerait au lieu de laisser le
 * service repartir en silence — ce qui est exactement ce qui s'était produit.
 */

vi.mock('server-only', () => ({}));

const { getSessionSpy } = vi.hoisted(() => ({
  getSessionSpy: vi.fn(() => {
    throw new Error(
      "`getSession` a été appelée depuis une ingestion de fond : il n'y a pas de requête, " +
        "l'athlète doit être passé en paramètre.",
    );
  }),
}));

vi.mock('@/data/session', () => ({ getSession: getSessionSpy }));

/** L'athlète propriétaire du dossier d'inbox — celui que le watcher lit du chemin. */
const ATHLETE_ID = 7;

/** Le plan actif de cet athlète. */
const PLAN_ID = 3;

/** L'activité que l'ingestion vient d'écrire. */
const ACTIVITY_ID = 42;

const dialect = new PgDialect();

/*
 * La base : une file de jeux de résultats par table, consommée dans l'ordre des
 * requêtes (le dernier de la file resservant ensuite). Les écritures sont
 * enregistrées avec leur clause `WHERE` — c'est elle qui porte l'athlète, donc
 * c'est elle que le test inspecte.
 */

const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[][]>,
    returning: {} as Record<string, unknown[][]>,
    updates: [] as Array<{ table: string; values: unknown; where: unknown }>,
    selects: [] as Array<{ table: string; where: unknown }>,
  },
}));

vi.mock('@/data/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  const nextResult = (queues: Record<string, unknown[][]>, name: string): unknown[] => {
    const queue = queues[name];
    if (!queue || queue.length === 0) return [];
    return (queue.length > 1 ? queue.shift() : queue[0]) ?? [];
  };

  type SelectChain = PromiseLike<unknown[]> & {
    where: (clause: unknown) => SelectChain;
    innerJoin: () => SelectChain;
    leftJoin: () => SelectChain;
    orderBy: () => SelectChain;
    limit: () => SelectChain;
  };

  const selectChain = (name: string): SelectChain => {
    const chain: SelectChain = {
      where: (clause) => {
        dbState.selects.push({ table: name, where: clause });
        return chain;
      },
      innerJoin: () => chain,
      leftJoin: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(nextResult(dbState.rows, name)).then(onFulfilled, onRejected),
    };
    return chain;
  };

  const updateChain = (name: string) => ({
    set: (values: unknown) => {
      const write = (clause: unknown) => {
        dbState.updates.push({ table: name, values, where: clause });
        return nextResult(dbState.returning, name);
      };
      return {
        where: (clause: unknown) => {
          const rows = write(clause);
          return Object.assign(Promise.resolve(rows), {
            returning: () => Promise.resolve(rows),
          });
        },
      };
    },
  });

  return {
    db: {
      select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
      update: (table: Table) => updateChain(getTableName(table)),
    },
  };
});

/*
 * Les bords : l'écriture de l'activité (déjà éprouvée, déjà porteuse de son
 * athlète), la disponibilité du coach, et le modèle lui-même.
 */

const { activitiesDal } = vi.hoisted(() => ({
  activitiesDal: {
    upsertActivityFromFit: vi.fn(),
    saveActivityStreams: vi.fn(),
    hasActivityStreams: vi.fn(),
    // Doublé pour que le post-traitement du dénivelé ne parte pas en erreur
    // rattrapée : ce fichier éprouve la transmission de l'athlète, pas la
    // tolérance aux pannes (qui a ses propres tests dans `ingest.test.ts`).
    recordActivityElevation: vi.fn(),
    // `recordSustainedMaxHr`, lui, tourne pour de vrai : c'est un `UPDATE` de
    // plus qui doit porter l'athlète du fichier. Il n'a besoin que de l'erreur.
    ActivityNotFoundError: class ActivityNotFoundError extends Error {},
  },
}));

vi.mock('@/data/activities', () => activitiesDal);

/**
 * La météo est un bord réseau de plus : son DAL est remplacé, mais
 * `recordActivityWeather` tourne pour de vrai — c'est lui qui doit transmettre
 * l'athlète du fichier. La cible rendue est sans coordonnées (une séance sur
 * tapis), ce qui referme la chaîne avant tout appel à Open-Meteo.
 */
const { weatherDal } = vi.hoisted(() => ({
  weatherDal: {
    getWeatherLookupTarget: vi.fn(),
    listActivitiesAwaitingWeather: vi.fn(),
    saveActivityWeather: vi.fn(),
  },
}));

vi.mock('@/data/activity-weather', () => weatherDal);

const { chatCompletionJson } = vi.hoisted(() => ({ chatCompletionJson: vi.fn() }));
vi.mock('@/lib/ai/client', () => ({ chatCompletionJson }));

const { getAiAvailability } = vi.hoisted(() => ({ getAiAvailability: vi.fn() }));
vi.mock('@/lib/ai/availability', () => ({ getAiAvailability }));

const { parseFitActivity } = vi.hoisted(() => ({ parseFitActivity: vi.fn() }));
vi.mock('./parse', () => ({ parseFitActivity }));

const { ingestFitBuffer } = await import('./ingest');
const { resetReviewState } = await import('@/lib/ai/review-service');
const { resetFitnessTestState } = await import('@/lib/ai/fitness-test-service');

const PARSED: ParsedFitActivity = {
  fileHash: 'c'.repeat(64),
  name: 'Test 5 km',
  sportType: 'Run',
  startedAt: new Date('2026-08-11T06:30:00.000Z'),
  distanceM: 6_000,
  movingTimeS: 1_800,
  elapsedTimeS: 1_820,
  elevationGainM: 20,
  elevationLossM: null,
  avgHrBpm: 168,
  maxHrBpm: 182,
  avgCadenceSpm: 180,
  streams: { time: [0, 1], heartrate: [170, 171] },
  warnings: [],
};

/** La ligne d'athlète, telle que `getAthleteById` la rend. */
const ATHLETE_ROW = {
  id: ATHLETE_ID,
  userId: 'user_1',
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 188,
  restingHrBpm: 48,
  weightKg: 62,
  birthDate: '1990-06-15',
  intervalsAthleteId: null,
  intervalsApiKeyEncrypted: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** Le plan actif, tel que `plans.*` le rend. */
const PLAN_ROW = {
  id: PLAN_ID,
  athleteId: ATHLETE_ID,
  status: 'active',
  goalType: 'race',
  intent: 'race',
  returnInjuryHistory: false,
  level: 'intermediate',
  goalText: '10 km sous 50 min',
  raceDate: '2026-10-04',
  startsOn: '2026-07-27',
  weeks: 10,
  sessionsPerWeek: 4,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: '5k',
  referenceTimeS: 1_500,
  referenceUpdatedOn: null,
  lastTestNote: null,
  summary: null,
  reviewedSessionCount: 0,
  reviewedAt: null,
  createdAt: new Date('2026-07-20T10:00:00.000Z'),
  updatedAt: new Date('2026-08-01T10:00:00.000Z'),
};

/** Une séance du plan, telle que `planned_sessions` la rend. */
function plannedSession(overrides: Record<string, unknown>) {
  return {
    id: 11,
    planId: PLAN_ID,
    athleteId: ATHLETE_ID,
    scheduledOn: '2026-08-11',
    kind: 'Test 5 km',
    title: 'Test chronométré',
    warmup: null,
    recovery: null,
    cooldown: null,
    targetPaceSecPerKm: 300,
    volumeM: 8_000,
    durationS: null,
    steps: null,
    completedActivityId: null,
    ...overrides,
  };
}

/** Une séance déjà réalisée du bilan, jointure `planned_sessions` ⟕ `activities`. */
function reviewedSession(scheduledOn: string) {
  return {
    scheduledOn,
    kind: 'Endurance',
    title: 'Footing',
    targetPaceSecPerKm: 330,
    volumeM: 10_000,
    durationS: null,
    distanceM: 10_100,
    movingTimeS: 3_300,
    avgPaceSecPerKm: 327,
    avgHrBpm: 148,
  };
}

/**
 * Laisse le suivi de plan aller au bout : il part **sans être attendu**
 * (`scheduleActivePlanFollowUp`), c'est tout son objet — le watcher ne peut pas
 * se suspendre plusieurs minutes sur chaque fichier.
 */
async function drainFollowUp(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

/** Mardi 11 août 2026, 11 h à Paris — le jour du test chronométré. */
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetReviewState();
  resetFitnessTestState();

  dbState.rows = {};
  dbState.returning = {};
  dbState.updates = [];
  dbState.selects = [];

  parseFitActivity.mockReturnValue(PARSED);
  activitiesDal.upsertActivityFromFit.mockResolvedValue({
    activityId: ACTIVITY_ID,
    outcome: 'created',
  });
  activitiesDal.saveActivityStreams.mockResolvedValue(undefined);
  activitiesDal.hasActivityStreams.mockResolvedValue(false);

  weatherDal.getWeatherLookupTarget.mockResolvedValue({
    activityId: ACTIVITY_ID,
    startedAt: PARSED.startedAt,
    elapsedTimeS: PARSED.elapsedTimeS,
    coordinates: null,
  });
  weatherDal.saveActivityWeather.mockResolvedValue(true);

  getAiAvailability.mockResolvedValue({ available: true });
  chatCompletionJson.mockResolvedValue({ decision: 'keep', reason: 'Le plan tient.' });

  dbState.rows = {
    athlete: [[ATHLETE_ROW]],
    // 1. `linkActivityToPlannedSession` lit l'activité ;
    // 2. `getFitnessTestCandidate` lit la jointure activité ↔ séance ↔ plan ;
    // 3. `bestEffortOfDay` cherche les autres sorties du jour ;
    // 4. `getTrainingSnapshot` relit tout l'historique.
    activities: [
      [{ athleteId: ATHLETE_ID, sportType: 'Run', startedAt: PARSED.startedAt }],
      [
        {
          maxHrBpm: 182,
          sessionKind: 'Test 5 km',
          scheduledOn: '2026-08-11',
          planId: PLAN_ID,
          planStartsOn: PLAN_ROW.startsOn,
          referenceDistance: '5k',
          referenceTimeS: 1_500,
          referenceUpdatedOn: null,
        },
      ],
      [],
      [],
    ],
    activity_streams: [[]],
    // 1. plan actif du rapprochement ; 2. plan actif de la révision ;
    // 3. marqueur de révision.
    plans: [[{ id: PLAN_ID }], [PLAN_ROW], [PLAN_ROW]],
    planned_sessions: [
      // Le rapprochement : l'activité n'est encore liée à rien…
      [],
      // …et la séance du jour l'attend.
      [{ id: 11, planId: PLAN_ID }],
      // Les séances du plan actif, puis le bilan de la révision : quatre
      // réalisées, soit exactement le palier de déclenchement.
      [plannedSession({ completedActivityId: ACTIVITY_ID })],
      [
        reviewedSession('2026-08-03'),
        reviewedSession('2026-08-05'),
        reviewedSession('2026-08-07'),
        reviewedSession('2026-08-09'),
      ],
    ],
  };
  dbState.returning = {
    planned_sessions: [[{ id: 11 }]],
    plans: [[{ id: PLAN_ID }]],
    // L'écriture de la FC max soutenue rend sa ligne : sans elle, le DAL conclut
    // que l'activité n'appartient pas à l'athlète.
    activities: [[{ id: ACTIVITY_ID }]],
  };
});

afterEach(() => {
  // Le cœur du test : quelle qu'ait été la trajectoire, la session n'a pas été
  // interrogée une seule fois.
  expect(getSessionSpy).not.toHaveBeenCalled();
});

describe('ingestion de fond : la chaîne complète, sans session', () => {
  it('rapproche la séance planifiée sous l’athlète du fichier', async () => {
    await ingestFitBuffer(Buffer.from('fit'), ATHLETE_ID);
    await drainFollowUp();

    const claim = dbState.updates.find((update) => update.table === 'planned_sessions');
    expect(claim?.values).toEqual({ completedActivityId: ACTIVITY_ID });
  });

  it('évalue le test chronométré et écrit sa note sur le plan de cet athlète', async () => {
    await ingestFitBuffer(Buffer.from('fit'), ATHLETE_ID);
    await drainFollowUp();

    // Aucune série exploitable dans ce fichier : le verdict est « inexploitable »,
    // et il laisse quand même une note lisible sur le plan. Ce qui compte ici est
    // que l'écriture ait eu lieu — sans athlète, l'`UPDATE` ne touchait rien.
    const record = dbState.updates.find(
      (update) =>
        update.table === 'plans' &&
        (update.values as Record<string, unknown>).lastTestNote !== undefined,
    );
    expect(record).toBeDefined();
  });

  it('écrit la FC max soutenue sous l’athlète du fichier', async () => {
    await ingestFitBuffer(Buffer.from('fit'), ATHLETE_ID);
    await drainFollowUp();

    const write = dbState.updates.find(
      (update) =>
        update.table === 'activities' &&
        (update.values as Record<string, unknown>).sustainedMaxHrBpm !== undefined,
    );
    expect(write).toBeDefined();
    expect(dialect.sqlToQuery(write?.where as SQL).params).toContain(ATHLETE_ID);
  });

  it('relève la météo sous l’athlète du fichier, sans passer par une session', async () => {
    await ingestFitBuffer(Buffer.from('fit'), ATHLETE_ID);
    await drainFollowUp();

    expect(weatherDal.getWeatherLookupTarget).toHaveBeenCalledWith(ACTIVITY_ID, ATHLETE_ID);
    expect(weatherDal.saveActivityWeather).toHaveBeenCalledWith(ACTIVITY_ID, ATHLETE_ID, {
      status: 'no-location',
    });
  });

  it('déclenche la révision du plan et avance son marqueur', async () => {
    await ingestFitBuffer(Buffer.from('fit'), ATHLETE_ID);
    await drainFollowUp();

    // Le coach a bien été consulté : sans athlète, le bilan ressortait vide et
    // le seuil n'était jamais atteint.
    expect(chatCompletionJson).toHaveBeenCalledTimes(1);
    const marker = dbState.updates.find(
      (update) =>
        update.table === 'plans' &&
        (update.values as Record<string, unknown>).reviewedSessionCount !== undefined,
    );
    expect(marker?.values).toMatchObject({ reviewedSessionCount: 4 });
  });

  it('n’interroge la session à aucun moment, même quand tout échoue', async () => {
    // Une base indisponible ne doit pas faire retomber la chaîne sur une
    // déduction par session : elle échoue, et elle le dit.
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    activitiesDal.upsertActivityFromFit.mockRejectedValue(new Error('base indisponible'));

    await expect(ingestFitBuffer(Buffer.from('fit'), ATHLETE_ID)).rejects.toThrow(
      'base indisponible',
    );
    await drainFollowUp();

    errored.mockRestore();
  });
});
