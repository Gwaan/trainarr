import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import { AthleteNotFoundError } from './athlete';
import type { Plan, PlanLevel, PlanReferenceDistance, PlannedSession } from './db/schema';
import {
  ConcurrentDraftError,
  InvalidPlanError,
  PlanNotFoundError,
  acceptDraftPlan,
  applyPlanUpdate,
  archiveActivePlan,
  createDraftPlanWithSessions,
  discardDraftPlan,
  getActivePlanWithSessions,
  getDraftPlanWithSessions,
  getPlannedSessionForActivity,
  planEndExclusive,
  toPlanDto,
  toPlanSessionDto,
  validatePlanInput,
  type CreatePlanInput,
  type NewPlanSessionInput,
  type PlanUpdate,
} from './plans';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Aucune base de données : les lectures servent les lignes déclarées par table,
 * les écritures sont enregistrées avec leur clause `WHERE` — c'est elle qui
 * porte l'anti-IDOR et la préservation des séances réalisées, donc c'est elle
 * que les tests inspectent (rendue en SQL, cf. `renderWhere`).
 */
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: {} as Record<string, unknown[]>,
    returning: {} as Record<string, unknown[]>,
    /**
     * Retours successifs d'une même table, quand une transaction en écrit
     * plusieurs fois (adopter une proposition archive le plan actif *puis*
     * active le brouillon) : chaque `returning()` consomme le premier lot
     * restant, et retombe sur `returning[table]` une fois la file vide.
     */
    returningQueue: {} as Record<string, unknown[][]>,
    /**
     * Erreur que l'insertion dans une table doit lever — c'est ainsi qu'on
     * éprouve la traduction d'une violation d'unicité en erreur métier.
     */
    insertErrors: {} as Record<string, unknown>,
    inserts: [] as Array<{ table: string; values: unknown }>,
    updates: [] as Array<{ table: string; values: unknown; where: SQL }>,
    deletes: [] as Array<{ table: string; where: SQL }>,
    selects: [] as Array<{ table: string; where: SQL }>,
    /** Clauses d'ordre des lectures : sans elles, un `LIMIT 1` choisit au hasard. */
    orderBys: [] as Array<{ table: string; clauses: SQL[] }>,
    /** Nombre de transactions ouvertes — une écriture composite doit en ouvrir une. */
    transactions: 0,
  },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type SelectChain = PromiseLike<unknown[]> & {
    where: (clause: SQL) => SelectChain;
    orderBy: (...clauses: SQL[]) => SelectChain;
    limit: () => SelectChain;
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
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(dbState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  type WriteChain = PromiseLike<unknown> & { returning: () => Promise<unknown[]> };

  const writeChain = (name: string): WriteChain => ({
    returning: () => {
      const queued = dbState.returningQueue[name];
      if (queued !== undefined && queued.length > 0) {
        return Promise.resolve(queued.shift() ?? []);
      }
      return Promise.resolve(dbState.returning[name] ?? []);
    },
    then: (onFulfilled, onRejected) => Promise.resolve(undefined).then(onFulfilled, onRejected),
  });

  /** Une écriture que la base refuse, quelle que soit la façon de l'attendre. */
  const rejectingChain = (error: unknown): WriteChain => ({
    returning: () => Promise.reject(error),
    then: (onFulfilled, onRejected) => Promise.reject(error).then(onFulfilled, onRejected),
  });

  const client = {
    select: () => ({ from: (table: Table) => selectChain(getTableName(table)) }),
    insert: (table: Table) => ({
      values: (values: unknown) => {
        const name = getTableName(table);
        dbState.inserts.push({ table: name, values });
        const failure = dbState.insertErrors[name];
        return failure === undefined ? writeChain(name) : rejectingChain(failure);
      },
    }),
    update: (table: Table) => ({
      set: (values: unknown) => ({
        where: (clause: SQL) => {
          const name = getTableName(table);
          dbState.updates.push({ table: name, values, where: clause });
          return writeChain(name);
        },
      }),
    }),
    delete: (table: Table) => ({
      where: (clause: SQL) => {
        const name = getTableName(table);
        dbState.deletes.push({ table: name, where: clause });
        return writeChain(name);
      },
    }),
  };

  return {
    db: {
      ...client,
      transaction: (run: (tx: typeof client) => Promise<unknown>) => {
        dbState.transactions += 1;
        return run(client);
      },
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

/**
 * Une violation d'unicité telle que le pilote `postgres` la lève, enveloppée
 * comme drizzle 0.45 le fait (l'erreur d'origine n'est plus qu'une `cause`).
 */
function uniqueViolation(constraint: string): Error {
  const driverError = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: '23505', constraint_name: constraint },
  );
  return new Error("Failed query: insert into 'plans'", { cause: driverError });
}

/**
 * Aujourd'hui : lundi 10 août 2026, 11 h à Paris — premier jour du plan des
 * fixtures. C'est la date que l'archivage compare aux séances qu'il purge.
 */
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-08-10T09:00:00.000Z'));

afterAll(() => {
  vi.useRealTimers();
});

const PLAN_ROW: Plan = {
  id: 3,
  athleteId: 1,
  status: 'active',
  goalType: 'race',
  intent: 'race',
  returnInjuryHistory: false,
  level: 'intermediate',
  goalText: '10 km sous 50 min le 15 novembre',
  raceDate: '2026-11-15',
  startsOn: '2026-08-10',
  weeks: 8,
  sessionsPerWeek: 4,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: '10k',
  referenceTimeS: 2_910,
  referenceUpdatedOn: null,
  lastTestNote: null,
  summary: 'Bloc de 8 semaines, une séance de seuil par semaine.',
  reviewedSessionCount: 0,
  reviewedAt: null,
  createdAt: new Date('2026-08-09T10:00:00.000Z'),
  updatedAt: new Date('2026-08-09T10:00:00.000Z'),
};

const SESSION_ROW: PlannedSession = {
  id: 7,
  athleteId: 1,
  planId: 3,
  scheduledOn: '2026-08-12',
  kind: 'VMA courte · piste',
  title: '6 × 800 m',
  targetPaceSecPerKm: 225,
  warmup: '20 min @ 5:30/km',
  recovery: '90 s en trot',
  cooldown: '10 min souple',
  volumeM: 12_400,
  durationS: 3_900,
  steps: null,
  completedActivityId: null,
  createdAt: new Date('2026-08-09T10:00:00.000Z'),
};

/** « 2 km d'échauffement, puis 3 × (800 m + 2 min de récup) ». */
const SESSION_STEPS: PlanSessionSteps = [
  {
    repeat: 1,
    steps: [
      {
        role: 'warmup',
        distanceM: 2_000,
        durationS: null,
        paceMinSecPerKm: 330,
        paceMaxSecPerKm: 360,
        hrZone: null,
        note: null,
      },
    ],
  },
  {
    repeat: 3,
    steps: [
      {
        role: 'run',
        distanceM: 800,
        durationS: null,
        paceMinSecPerKm: 225,
        paceMaxSecPerKm: 230,
        hrZone: null,
        note: null,
      },
      {
        role: 'recover',
        distanceM: null,
        durationS: 120,
        paceMinSecPerKm: null,
        paceMaxSecPerKm: null,
        hrZone: null,
        note: 'trot souple',
      },
    ],
  },
];

/** Le même déroulé, mais tout en distance : ses totaux sont calculables. */
const DISTANCE_ONLY_STEPS: PlanSessionSteps = [
  {
    repeat: 2,
    steps: [
      {
        role: 'run',
        distanceM: 1_000,
        durationS: null,
        paceMinSecPerKm: 240,
        paceMaxSecPerKm: 250,
        hrZone: null,
        note: null,
      },
    ],
  },
];

const PLAN_DTO_KEYS = [
  'createdAt',
  'goalText',
  'goalType',
  'id',
  'intent',
  'lastTestNote',
  'level',
  'longRunDay',
  'raceDate',
  'referenceDistance',
  'referenceTimeS',
  'referenceUpdatedOn',
  'returnInjuryHistory',
  'reviewedAt',
  'sessionsPerWeek',
  'startsOn',
  'status',
  'summary',
  'weeklyTimeMinutes',
  'weeks',
];

const SESSION_DTO_KEYS = [
  'completedActivityId',
  'cooldown',
  'durationS',
  'id',
  'kind',
  'recovery',
  'scheduledOn',
  'steps',
  'targetPaceSecPerKm',
  'title',
  'volumeM',
  'warmup',
];

const SESSION_INPUT: NewPlanSessionInput = {
  scheduledOn: '2026-08-12',
  kind: 'VMA courte · piste',
  title: '6 × 800 m',
};

/** Plan valide — chaque test n'en modifie que ce qu'il éprouve. */
const VALID_INPUT: CreatePlanInput = {
  goalType: 'race',
  intent: 'race',
  level: 'intermediate',
  referenceDistance: '10k',
  referenceTimeS: 2_910,
  goalText: '10 km sous 50 min le 15 novembre',
  raceDate: '2026-11-15',
  startsOn: '2026-08-10',
  weeks: 8,
  sessionsPerWeek: 4,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  summary: 'Bloc de 8 semaines.',
  sessions: [SESSION_INPUT],
};

beforeEach(() => {
  dbState.rows = { athlete: [{ id: 1 }] };
  dbState.returning = {};
  dbState.returningQueue = {};
  dbState.insertErrors = {};
  dbState.inserts = [];
  dbState.updates = [];
  dbState.deletes = [];
  dbState.selects = [];
  dbState.orderBys = [];
  dbState.transactions = 0;
});

describe('planEndExclusive', () => {
  it('ouvre la fenêtre sur `weeks × 7` jours pleins', () => {
    expect(planEndExclusive('2026-08-10', 8)).toBe('2026-10-05');
    expect(planEndExclusive('2026-08-10', 1)).toBe('2026-08-17');
  });

  it('compte les semaines depuis le lundi de la semaine de départ', () => {
    // Plan démarré le jeudi 13 août : ses 8 semaines s'achèvent le dimanche de
    // la 8e semaine ISO, pas trois jours plus tard.
    expect(planEndExclusive('2026-08-13', 8)).toBe('2026-10-05');
    expect(planEndExclusive('2026-08-16', 1)).toBe('2026-08-17');
  });
});

describe('validatePlanInput', () => {
  it('normalise les facultatifs et détoure le texte de l’objectif', () => {
    const values = validatePlanInput({
      ...VALID_INPUT,
      goalType: 'free',
      intent: 'faster',
      goalText: '  améliorer mon endurance  ',
      raceDate: undefined,
      weeklyTimeMinutes: undefined,
      summary: undefined,
    });

    expect(values.goalText).toBe('améliorer mon endurance');
    expect(values.raceDate).toBeNull();
    expect(values.weeklyTimeMinutes).toBeNull();
    expect(values.summary).toBeNull();
  });

  it('recopie le niveau déclaré et accepte les trois', () => {
    expect(validatePlanInput(VALID_INPUT).level).toBe('intermediate');
    expect(validatePlanInput({ ...VALID_INPUT, level: 'beginner' }).level).toBe('beginner');
    expect(validatePlanInput({ ...VALID_INPUT, level: 'advanced' }).level).toBe('advanced');
  });

  it('refuse un niveau hors des trois, ou absent', () => {
    // Le DAL n'est pas la seule porte d'entrée (le coach écrit ici aussi) : la
    // garde vaut pour ce que le typage ne voit pas — d'où les valeurs forcées.
    const wrongLevels: readonly unknown[] = ['expert', '', undefined];
    for (const level of wrongLevels) {
      const input = { ...VALID_INPUT, level: level as PlanLevel };
      expect(() => validatePlanInput(input)).toThrow(InvalidPlanError);
      try {
        validatePlanInput(input);
      } catch (error) {
        expect((error as InvalidPlanError).field).toBe('level');
      }
    }
  });

  it('exige une date de course pour un objectif daté', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, raceDate: null })).toThrow(InvalidPlanError);
    try {
      validatePlanInput({ ...VALID_INPUT, raceDate: null });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPlanError);
      expect((error as InvalidPlanError).field).toBe('raceDate');
    }
  });

  it('refuse une date de course sur un objectif libre', () => {
    expect(() =>
      validatePlanInput({ ...VALID_INPUT, goalType: 'free', raceDate: '2026-11-15' }),
    ).toThrow(InvalidPlanError);
  });

  it('refuse une date de course inexistante au calendrier', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, raceDate: '2026-02-31' })).toThrow(
      InvalidPlanError,
    );
    expect(() => validatePlanInput({ ...VALID_INPUT, raceDate: '15/11/2026' })).toThrow(
      InvalidPlanError,
    );
  });

  it('refuse une date de début malformée', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, startsOn: '2026-8-10' })).toThrow(
      InvalidPlanError,
    );
  });

  it('accepte une note vide : c’est l’intention qui dit ce que le plan prépare', () => {
    expect(validatePlanInput({ ...VALID_INPUT, goalText: '   ' }).goalText).toBe('');
  });

  it('recopie l’intention, et refuse celle qui contredit le type d’objectif', () => {
    expect(validatePlanInput(VALID_INPUT).intent).toBe('race');
    // Une intention datée sans objectif daté (et l'inverse) laisserait un plan
    // qui s'affûte sans jour J, ou un jour J sans affûtage.
    expect(() =>
      validatePlanInput({ ...VALID_INPUT, intent: 'faster' }),
    ).toThrow(InvalidPlanError);
    expect(() =>
      validatePlanInput({ ...VALID_INPUT, goalType: 'free', raceDate: null }),
    ).toThrow(InvalidPlanError);
    expect(() =>
      // Le DAL n'est pas la seule porte d'entrée : la garde vaut pour ce que le
      // typage ne voit pas.
      validatePlanInput({ ...VALID_INPUT, intent: 'sprint' as unknown as CreatePlanInput['intent'] }),
    ).toThrow(InvalidPlanError);
  });

  it('n’enregistre l’antécédent de blessure que sur une reprise', () => {
    const resumption = validatePlanInput({
      ...VALID_INPUT,
      goalType: 'free',
      intent: 'return',
      raceDate: null,
      returnInjuryHistory: true,
    });
    expect(resumption.returnInjuryHistory).toBe(true);

    // Ailleurs il ne déplace aucun paramètre : le stocker ferait passer pour un
    // fait une donnée qui ne sert à rien.
    expect(validatePlanInput({ ...VALID_INPUT, returnInjuryHistory: true }).returnInjuryHistory).toBe(
      false,
    );
    expect(validatePlanInput(VALID_INPUT).returnInjuryHistory).toBe(false);
  });

  it('exige au moins une semaine, en nombre entier', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, weeks: 0 })).toThrow(InvalidPlanError);
    expect(() => validatePlanInput({ ...VALID_INPUT, weeks: -3 })).toThrow(InvalidPlanError);
    expect(() => validatePlanInput({ ...VALID_INPUT, weeks: 8.5 })).toThrow(InvalidPlanError);
  });

  it('borne les séances par semaine à 1..7', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, sessionsPerWeek: 0 })).toThrow(
      InvalidPlanError,
    );
    expect(() => validatePlanInput({ ...VALID_INPUT, sessionsPerWeek: 8 })).toThrow(
      InvalidPlanError,
    );
    expect(validatePlanInput({ ...VALID_INPUT, sessionsPerWeek: 7 }).sessionsPerWeek).toBe(7);
  });

  it('borne le jour de sortie longue aux jours ISO 1..7', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, longRunDay: 0 })).toThrow(InvalidPlanError);
    expect(() => validatePlanInput({ ...VALID_INPUT, longRunDay: 8 })).toThrow(InvalidPlanError);
    expect(validatePlanInput({ ...VALID_INPUT, longRunDay: 1 }).longRunDay).toBe(1);
  });

  it('refuse un temps hebdomadaire nul ou supérieur à une semaine réelle', () => {
    expect(() => validatePlanInput({ ...VALID_INPUT, weeklyTimeMinutes: 0 })).toThrow(
      InvalidPlanError,
    );
    expect(() => validatePlanInput({ ...VALID_INPUT, weeklyTimeMinutes: 10_081 })).toThrow(
      InvalidPlanError,
    );
  });

  describe('chrono de référence', () => {
    /** Le champ fautif d'une entrée refusée — c'est lui qui ramène l'erreur au bon champ du formulaire. */
    function fieldOf(input: CreatePlanInput): string {
      try {
        validatePlanInput(input);
        expect.unreachable('cette entrée devait être refusée');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidPlanError);
        return (error as InvalidPlanError).field;
      }
      return '';
    }

    it('accepte un plan sans chrono : les deux colonnes restent nulles', () => {
      const values = validatePlanInput({
        ...VALID_INPUT,
        referenceDistance: undefined,
        referenceTimeS: undefined,
      });

      expect(values.referenceDistance).toBeNull();
      expect(values.referenceTimeS).toBeNull();
    });

    it('recopie un chrono plausible', () => {
      const values = validatePlanInput({
        ...VALID_INPUT,
        referenceDistance: '10k',
        referenceTimeS: 2_910,
      });

      expect(values).toMatchObject({ referenceDistance: '10k', referenceTimeS: 2_910 });
    });

    it('exige les deux champs ensemble, jamais un seul', () => {
      // Une distance sans temps ne calcule rien, un temps sans distance non plus.
      expect(fieldOf({ ...VALID_INPUT, referenceDistance: '10k', referenceTimeS: null })).toBe(
        'referenceTimeS',
      );
      expect(fieldOf({ ...VALID_INPUT, referenceDistance: null, referenceTimeS: 2_910 })).toBe(
        'referenceDistance',
      );
    });

    it('refuse une distance inconnue', () => {
      const wrong = { ...VALID_INPUT, referenceDistance: '3k' as PlanReferenceDistance, referenceTimeS: 900 };
      expect(fieldOf(wrong)).toBe('referenceDistance');
    });

    it('refuse un temps hors des bornes de saisie', () => {
      expect(fieldOf({ ...VALID_INPUT, referenceDistance: '10k', referenceTimeS: 0 })).toBe(
        'referenceTimeS',
      );
      expect(fieldOf({ ...VALID_INPUT, referenceDistance: '10k', referenceTimeS: 36_001 })).toBe(
        'referenceTimeS',
      );
    });

    it('refuse un couple qui ne décrit pas une course', () => {
      // 5 km en 12 min : trois quarts de minute sous le record du monde.
      const input = { ...VALID_INPUT, referenceDistance: '5k' as PlanReferenceDistance, referenceTimeS: 720 };

      expect(fieldOf(input)).toBe('referenceTimeS');
      expect(() => validatePlanInput(input)).toThrow(/ne ressemble pas à une course/);
    });
  });

  it('refuse un plan sans aucune séance', () => {
    try {
      validatePlanInput({ ...VALID_INPUT, sessions: [] });
      expect.unreachable('un plan vide ne planifie rien');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPlanError);
      expect((error as InvalidPlanError).field).toBe('sessions');
    }
  });

  it('refuse une séance hors de la fenêtre du plan', () => {
    // Fenêtre : [2026-08-10, 2026-10-05[ pour 8 semaines.
    expect(() =>
      validatePlanInput({
        ...VALID_INPUT,
        sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-08-09' }],
      }),
    ).toThrow(InvalidPlanError);
    expect(() =>
      validatePlanInput({
        ...VALID_INPUT,
        sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-10-05' }],
      }),
    ).toThrow(InvalidPlanError);
  });

  it('accepte les deux bornes réellement couvertes', () => {
    const values = validatePlanInput({
      ...VALID_INPUT,
      sessions: [
        { ...SESSION_INPUT, scheduledOn: '2026-08-10' },
        { ...SESSION_INPUT, scheduledOn: '2026-10-04' },
      ],
    });

    expect(values.sessions).toHaveLength(2);
  });

  describe('plan démarré en milieu de semaine', () => {
    // Départ le jeudi 13 août, 8 semaines : fenêtre [2026-08-13, 2026-10-05[.
    const MIDWEEK: CreatePlanInput = { ...VALID_INPUT, startsOn: '2026-08-13' };

    it('refuse une séance placée avant le jour de départ', () => {
      // Le mercredi 12 appartient à la grille des semaines (l'ancre est le lundi
      // 10) mais pas au plan : rien n'y est planifiable.
      expect(() =>
        validatePlanInput({
          ...MIDWEEK,
          sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-08-12' }],
        }),
      ).toThrow(InvalidPlanError);
    });

    it('accepte le jour de départ et le dernier dimanche couvert', () => {
      const values = validatePlanInput({
        ...MIDWEEK,
        sessions: [
          { ...SESSION_INPUT, scheduledOn: '2026-08-13' },
          { ...SESSION_INPUT, scheduledOn: '2026-10-04' },
        ],
      });

      expect(values.sessions).toHaveLength(2);
    });

    it('refuse le lendemain de la dernière semaine, jour de départ ou non', () => {
      expect(() =>
        validatePlanInput({
          ...MIDWEEK,
          sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-10-05' }],
        }),
      ).toThrow(InvalidPlanError);
    });
  });

  it('refuse une séance sans type ni intitulé', () => {
    expect(() =>
      validatePlanInput({ ...VALID_INPUT, sessions: [{ ...SESSION_INPUT, title: '  ' }] }),
    ).toThrow(InvalidPlanError);
    expect(() =>
      validatePlanInput({ ...VALID_INPUT, sessions: [{ ...SESSION_INPUT, kind: '' }] }),
    ).toThrow(InvalidPlanError);
  });

  it('accepte une séance avec son déroulé structuré, ou sans', () => {
    expect(
      validatePlanInput({
        ...VALID_INPUT,
        sessions: [{ ...SESSION_INPUT, steps: SESSION_STEPS }],
      }).sessions,
    ).toHaveLength(1);
    expect(
      validatePlanInput({ ...VALID_INPUT, sessions: [{ ...SESSION_INPUT, steps: null }] }).sessions,
    ).toHaveLength(1);
  });

  it('refuse un déroulé qui viole un invariant des étapes', () => {
    const refused: PlanSessionSteps[] = [
      // Aucune étape.
      [{ repeat: 1, steps: [] }],
      // Deux mesures sur la même étape.
      [{ repeat: 1, steps: [{ ...SESSION_STEPS[1].steps[0], durationS: 300 }] }],
      // Allure et zone cardiaque à la fois.
      [{ repeat: 1, steps: [{ ...SESSION_STEPS[1].steps[0], hrZone: 4 }] }],
      // Répétitions hors bornes.
      [{ repeat: 0, steps: SESSION_STEPS[1].steps }],
    ];

    for (const steps of refused) {
      try {
        validatePlanInput({ ...VALID_INPUT, sessions: [{ ...SESSION_INPUT, steps }] });
        expect.unreachable('un déroulé incohérent ne doit pas passer la validation');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidPlanError);
        expect((error as InvalidPlanError).field).toBe('sessions');
        expect((error as InvalidPlanError).message).toContain('2026-08-12');
      }
    }
  });
});

describe('toPlanDto', () => {
  it("n'expose que les champs du DTO, sans identifiant d'athlète", () => {
    const dto = toPlanDto(PLAN_ROW);

    expect(Object.keys(dto).sort()).toEqual(PLAN_DTO_KEYS);
    expect(dto).not.toHaveProperty('athleteId');
    expect(dto).not.toHaveProperty('updatedAt');
  });

  it('sérialise la date de création en ISO et recopie le reste tel quel', () => {
    const dto = toPlanDto(PLAN_ROW);

    expect(dto.createdAt).toBe('2026-08-09T10:00:00.000Z');
    expect(dto).toMatchObject({
      id: 3,
      status: 'active',
      goalType: 'race',
      raceDate: '2026-11-15',
      startsOn: '2026-08-10',
      weeks: 8,
      sessionsPerWeek: 4,
      weeklyTimeMinutes: 300,
      longRunDay: 7,
    });
  });

  it('expose le niveau du plan', () => {
    expect(toPlanDto({ ...PLAN_ROW, level: 'advanced' }).level).toBe('advanced');
  });

  it('sérialise la dernière révision du coach, `null` tant qu’il n’y en a pas eu', () => {
    // Le compte de séances relues, lui, reste en base : c'est l'état d'un
    // service, il n'a rien à faire côté client.
    expect(toPlanDto(PLAN_ROW).reviewedAt).toBeNull();
    expect(
      toPlanDto({ ...PLAN_ROW, reviewedAt: new Date('2026-08-11T09:00:00.000Z') }).reviewedAt,
    ).toBe('2026-08-11T09:00:00.000Z');
  });

  it('expose le chrono de référence, sur lequel les allures du plan sont calées', () => {
    expect(toPlanDto(PLAN_ROW)).toMatchObject({ referenceDistance: '10k', referenceTimeS: 2_910 });
  });

  it('préserve les champs absents en `null`', () => {
    const dto = toPlanDto({
      ...PLAN_ROW,
      goalType: 'free',
      // Un plan antérieur au champ : le DTO le dit `null`, il n'en invente pas.
      level: null,
      raceDate: null,
      referenceDistance: null,
      referenceTimeS: null,
      weeklyTimeMinutes: null,
      summary: null,
    });

    expect(dto.raceDate).toBeNull();
    expect(dto.level).toBeNull();
    expect(dto.referenceDistance).toBeNull();
    expect(dto.referenceTimeS).toBeNull();
    expect(dto.weeklyTimeMinutes).toBeNull();
    expect(dto.summary).toBeNull();
  });
});

describe('toPlanSessionDto', () => {
  it("n'expose que les champs du DTO, ni `athleteId` ni `planId`", () => {
    const dto = toPlanSessionDto(SESSION_ROW);

    expect(Object.keys(dto).sort()).toEqual(SESSION_DTO_KEYS);
    expect(dto).not.toHaveProperty('athleteId');
    expect(dto).not.toHaveProperty('planId');
  });

  it('expose le déroulé structuré tel quel — c’est de l’affichage', () => {
    expect(toPlanSessionDto({ ...SESSION_ROW, steps: SESSION_STEPS }).steps).toEqual(SESSION_STEPS);
    expect(toPlanSessionDto(SESSION_ROW).steps).toBeNull();
  });
});

describe('getActivePlanWithSessions', () => {
  it('retourne null tant que l’onboarding n’a pas eu lieu', async () => {
    dbState.rows = { athlete: [] };

    await expect(getActivePlanWithSessions()).resolves.toBeNull();
  });

  it('retourne null quand aucun plan actif n’existe', async () => {
    dbState.rows.plans = [];

    await expect(getActivePlanWithSessions()).resolves.toBeNull();
  });

  it('retourne le plan et ses séances en DTOs', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.rows.planned_sessions = [SESSION_ROW];

    const result = await getActivePlanWithSessions();

    expect(Object.keys(result?.plan ?? {}).sort()).toEqual(PLAN_DTO_KEYS);
    expect(result?.sessions).toHaveLength(1);
    expect(Object.keys(result?.sessions[0] ?? {}).sort()).toEqual(SESSION_DTO_KEYS);
  });

  it('ne lit que le plan actif de l’athlète', async () => {
    dbState.rows.plans = [PLAN_ROW];

    await getActivePlanWithSessions();

    const where = renderWhere(dbState.selects.find((query) => query.table === 'plans')?.where);
    // `'active'` est dans le `WHERE`, donc une proposition en attente ne sort
    // jamais par cette porte — ni sur la page du plan, ni à l'ajustement, ni à
    // la synchronisation intervals.icu, qui passent tous par ici.
    expect(where.params).toEqual([1, 'active']);
  });
});

describe('getDraftPlanWithSessions', () => {
  it('retourne null tant que l’onboarding n’a pas eu lieu', async () => {
    dbState.rows = { athlete: [] };

    await expect(getDraftPlanWithSessions()).resolves.toBeNull();
  });

  it('retourne null quand aucune proposition n’attend', async () => {
    dbState.rows.plans = [];

    await expect(getDraftPlanWithSessions()).resolves.toBeNull();
  });

  it('ne lit que le brouillon de l’athlète, en DTOs', async () => {
    dbState.rows.plans = [{ ...PLAN_ROW, status: 'draft' }];
    dbState.rows.planned_sessions = [SESSION_ROW];

    const result = await getDraftPlanWithSessions();

    const where = renderWhere(dbState.selects.find((query) => query.table === 'plans')?.where);
    expect(where.params).toEqual([1, 'draft']);
    expect(Object.keys(result?.plan ?? {}).sort()).toEqual(PLAN_DTO_KEYS);
    expect(result?.plan.status).toBe('draft');
    expect(result?.sessions).toHaveLength(1);
  });

  it('sert le brouillon le plus récent, jamais celui que le hasard désigne', async () => {
    dbState.rows.plans = [{ ...PLAN_ROW, status: 'draft' }];

    await getDraftPlanWithSessions();

    // Ceinture derrière l'index partiel `plans_draft_per_athlete` : un `LIMIT 1`
    // sans ordre rendrait n'importe laquelle des lignes si la contrainte venait
    // à manquer.
    const order = renderOrder(dbState.orderBys.find((query) => query.table === 'plans'));
    expect(order).toBe('"plans"."created_at" desc, "plans"."id" desc');
  });
});

describe('createDraftPlanWithSessions', () => {
  it('refuse d’écrire tant qu’aucun athlète n’est enregistré', async () => {
    dbState.rows = { athlete: [] };

    await expect(createDraftPlanWithSessions(VALID_INPUT)).rejects.toBeInstanceOf(
      AthleteNotFoundError,
    );
    expect(dbState.inserts).toEqual([]);
  });

  it('valide avant toute écriture', async () => {
    await expect(
      createDraftPlanWithSessions({ ...VALID_INPUT, sessionsPerWeek: 9 }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    expect(dbState.transactions).toBe(0);
    expect(dbState.inserts).toEqual([]);
  });

  it('insère le plan en proposition, dans une transaction', async () => {
    dbState.returning.plans = [PLAN_ROW];

    const dto = await createDraftPlanWithSessions(VALID_INPUT);

    expect(dbState.transactions).toBe(1);

    expect(dbState.inserts[0]?.table).toBe('plans');
    expect(dbState.inserts[0]?.values).toMatchObject({
      athleteId: 1,
      status: 'draft',
      goalType: 'race',
      level: 'intermediate',
      raceDate: '2026-11-15',
      weeks: 8,
      // Le chrono part en base avec le plan : c'est lui qui a calculé ses allures.
      referenceDistance: '10k',
      referenceTimeS: 2_910,
    });

    expect(Object.keys(dto).sort()).toEqual(PLAN_DTO_KEYS);
  });

  it('ne touche pas au plan actif : ni archivage, ni purge de ses séances', async () => {
    dbState.returning.plans = [PLAN_ROW];

    await createDraftPlanWithSessions(VALID_INPUT);

    // Le cœur de la règle : le coach propose, il n'impose pas. Tant que
    // l'athlète n'a pas tranché, le plan qu'elle suit reste intact.
    expect(dbState.updates).toEqual([]);
    expect(dbState.deletes.some((row) => row.table === 'planned_sessions')).toBe(false);
  });

  it('remplace la proposition précédente : au plus un brouillon par athlète', async () => {
    dbState.returning.plans = [PLAN_ROW];

    await createDraftPlanWithSessions(VALID_INPUT);

    const purge = dbState.deletes.find((row) => row.table === 'plans');
    // Les seuls plans supprimés sont les brouillons de cet athlète ; leurs
    // séances partent par cascade (`plan_id … ON DELETE CASCADE`).
    expect(renderWhere(purge?.where).params).toEqual([1, 'draft']);
    expect(dbState.deletes).toHaveLength(1);
  });

  it('rattache chaque séance au plan créé et à l’athlète', async () => {
    dbState.returning.plans = [PLAN_ROW];

    await createDraftPlanWithSessions({
      ...VALID_INPUT,
      sessions: [SESSION_INPUT, { ...SESSION_INPUT, scheduledOn: '2026-08-15', warmup: '15 min' }],
    });

    const insert = dbState.inserts.find((row) => row.table === 'planned_sessions');
    expect(insert?.values).toEqual([
      {
        athleteId: 1,
        planId: 3,
        scheduledOn: '2026-08-12',
        kind: 'VMA courte · piste',
        title: '6 × 800 m',
        warmup: null,
        recovery: null,
        cooldown: null,
        targetPaceSecPerKm: null,
        volumeM: null,
        durationS: null,
        steps: null,
      },
      {
        athleteId: 1,
        planId: 3,
        scheduledOn: '2026-08-15',
        kind: 'VMA courte · piste',
        title: '6 × 800 m',
        warmup: '15 min',
        recovery: null,
        cooldown: null,
        targetPaceSecPerKm: null,
        volumeM: null,
        durationS: null,
        steps: null,
      },
    ]);
  });

  it('écrit le déroulé structuré dans la colonne `steps`', async () => {
    dbState.returning.plans = [PLAN_ROW];

    await createDraftPlanWithSessions({
      ...VALID_INPUT,
      sessions: [{ ...SESSION_INPUT, steps: SESSION_STEPS }],
    });

    const insert = dbState.inserts.find((row) => row.table === 'planned_sessions');
    expect(insert?.values).toMatchObject([{ steps: SESSION_STEPS }]);
  });

  it('ne stocke pas les clés inconnues glissées dans une étape', async () => {
    dbState.returning.plans = [PLAN_ROW];
    const step = { ...DISTANCE_ONLY_STEPS[0].steps[0], watts: 320 };

    await createDraftPlanWithSessions({
      ...VALID_INPUT,
      // Le déroulé vient du modèle : ce qui n'est pas au contrat n'entre pas en base.
      sessions: [{ ...SESSION_INPUT, steps: [{ repeat: 1, steps: [step] }] }],
    });

    const insert = dbState.inserts.find((row) => row.table === 'planned_sessions');
    expect(insert?.values).toMatchObject([
      { steps: [{ repeat: 1, steps: [DISTANCE_ONLY_STEPS[0].steps[0]] }] },
    ]);
  });

  it('dérive volume et durée des étapes quand la séance ne les déclare pas', async () => {
    dbState.returning.plans = [PLAN_ROW];

    await createDraftPlanWithSessions({
      ...VALID_INPUT,
      sessions: [
        { ...SESSION_INPUT, steps: DISTANCE_ONLY_STEPS },
        // Étapes mixtes (distance + durée) : aucun total n'est calculable sans
        // supposer une allure, la séance reste sans volume ni durée.
        { ...SESSION_INPUT, steps: SESSION_STEPS },
      ],
    });

    const insert = dbState.inserts.find((row) => row.table === 'planned_sessions');
    expect(insert?.values).toMatchObject([
      { volumeM: 2_000, durationS: null },
      { volumeM: null, durationS: null },
    ]);
  });

  it('laisse un volume déclaré primer sur le total des étapes', async () => {
    dbState.returning.plans = [PLAN_ROW];

    await createDraftPlanWithSessions({
      ...VALID_INPUT,
      // « ~2,5 km » annoncé pour 2 km d'étapes : l'arrondi du coach fait foi.
      sessions: [{ ...SESSION_INPUT, steps: DISTANCE_ONLY_STEPS, volumeM: 2_500 }],
    });

    const insert = dbState.inserts.find((row) => row.table === 'planned_sessions');
    expect(insert?.values).toMatchObject([{ volumeM: 2_500 }]);
  });

  it('échoue si l’insertion du plan ne rend aucune ligne, sans écrire de séance', async () => {
    dbState.returning.plans = [];

    await expect(createDraftPlanWithSessions(VALID_INPUT)).rejects.toThrow();
    expect(dbState.inserts.some((row) => row.table === 'planned_sessions')).toBe(false);
  });

  it('traduit la collision de deux générations concurrentes en erreur métier', async () => {
    // Deux transactions simultanées : celle qui perd ne voit pas le brouillon
    // que l'autre vient d'insérer, donc son `DELETE` ne l'a pas emporté et
    // l'index partiel `plans_draft_per_athlete` la rejette. C'est le
    // comportement voulu — un échec lisible plutôt qu'un doublon silencieux.
    dbState.insertErrors.plans = uniqueViolation('plans_draft_per_athlete');

    await expect(createDraftPlanWithSessions(VALID_INPUT)).rejects.toBeInstanceOf(
      ConcurrentDraftError,
    );
  });

  it('laisse remonter tel quel un échec qui n’est pas une collision', async () => {
    // Une panne n'est pas une course : la déguiser en conflit de propositions
    // ferait recharger la page pour rien.
    const failure = new Error('deadlock detected');
    dbState.insertErrors.plans = failure;

    await expect(createDraftPlanWithSessions(VALID_INPUT)).rejects.toBe(failure);
  });
});

describe('acceptDraftPlan', () => {
  /** Le brouillon tel que l'`UPDATE` d'activation le rend. */
  const ACTIVATED = { ...PLAN_ROW, id: 9, status: 'active' } satisfies Plan;

  it('archive le plan actif, purge ses séances à venir et active le brouillon, en une transaction', async () => {
    // Deux `returning` successifs sur `plans` : les ids archivés, puis la ligne
    // activée.
    dbState.returningQueue.plans = [[{ id: 3 }], [ACTIVATED]];

    const dto = await acceptDraftPlan(9);

    expect(dbState.transactions).toBe(1);

    // 1. L'archivage précède l'activation : l'index partiel
    //    `plans_active_per_athlete` refuserait deux lignes actives.
    const archive = dbState.updates[0];
    expect(archive?.values).toMatchObject({ status: 'archived' });
    expect(renderWhere(archive?.where).params).toEqual([1, 'active']);

    // 2. Les séances à venir non réalisées de l'ancien plan partent avec lui.
    const purge = renderWhere(dbState.deletes[0]?.where);
    expect(purge.params).toEqual([3, '2026-08-10']);
    expect(purge.sql).toContain('"plan_id" in ($1)');
    expect(purge.sql).toContain('"scheduled_on" >= $2');
    expect(purge.sql).toContain('"completed_activity_id" is null');

    // 3. Le brouillon devient le plan de l'athlète.
    const activation = dbState.updates[1];
    expect(activation?.values).toMatchObject({ status: 'active' });
    expect(Object.keys(dto).sort()).toEqual(PLAN_DTO_KEYS);
    expect(dto.id).toBe(9);
  });

  it('purge les séances du brouillon antérieures à aujourd’hui', async () => {
    dbState.returningQueue.plans = [[{ id: 3 }], [ACTIVATED]];

    await acceptDraftPlan(9);

    // Une proposition générée lundi et adoptée mercredi porte des séances déjà
    // passées, que les activités de ces jours-là ne pourront plus réaliser
    // (elles ont été rapprochées des séances du plan alors actif) : les laisser
    // afficherait « Manquée » sur des jours pourtant courus. Le plan adopté
    // prend la main à partir d'aujourd'hui, pas avant.
    const draftPurge = renderWhere(dbState.deletes[1]?.where);
    expect(draftPurge.params).toEqual([9, '2026-08-10']);
    expect(draftPurge.sql).toContain('"plan_id" = $1');
    expect(draftPurge.sql).toContain('"scheduled_on" < $2');
    // Pas de garde sur le rapprochement : un brouillon n'a jamais de séance
    // réalisée, il n'y a rien à préserver dans ce passé-là.
    expect(draftPurge.sql).not.toContain('completed_activity_id');

    // Les séances d'aujourd'hui et des jours suivants, elles, ne sont visées par
    // aucune des deux purges : celle de l'ancien plan ne cite que son id.
    expect(dbState.deletes).toHaveLength(2);
    expect(renderWhere(dbState.deletes[0]?.where).params).toEqual([3, '2026-08-10']);
  });

  it('purge le passé du brouillon seulement une fois qu’il est prouvé sien', async () => {
    // L'activation ne touche aucune ligne : rien n'a été supprimé au nom d'un
    // plan qui n'est pas celui de l'athlète (et la transaction annule le reste).
    dbState.returningQueue.plans = [[], []];

    await expect(acceptDraftPlan(404)).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(dbState.deletes).toEqual([]);
  });

  it('n’active qu’un brouillon appartenant à l’athlète (anti-IDOR)', async () => {
    dbState.returningQueue.plans = [[{ id: 3 }], [ACTIVATED]];

    await acceptDraftPlan(9);

    // Appartenance et état dans le `WHERE` de l'`UPDATE` lui-même : pas de
    // fenêtre entre le contrôle et l'écriture.
    expect(renderWhere(dbState.updates[1]?.where).params).toEqual([9, 1, 'draft']);
  });

  it('ne purge aucune séance d’ancien plan quand il n’y en avait pas', async () => {
    dbState.returningQueue.plans = [[], [ACTIVATED]];

    await expect(acceptDraftPlan(9)).resolves.toMatchObject({ id: 9 });
    // Seule reste la purge du passé du brouillon : sans plan archivé, il n'y a
    // pas de séance à venir à emporter.
    expect(dbState.deletes).toHaveLength(1);
    expect(renderWhere(dbState.deletes[0]?.where).params).toEqual([9, '2026-08-10']);
  });

  it('lève PlanNotFoundError quand l’id ne désigne pas un brouillon', async () => {
    // L'archivage a eu lieu dans la transaction, mais l'activation ne touche
    // aucune ligne : le `throw` annule tout, et l'athlète garde son plan.
    dbState.returningQueue.plans = [[{ id: 3 }], []];

    await expect(acceptDraftPlan(404)).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it('lève PlanNotFoundError sans athlète, sans rien écrire', async () => {
    dbState.rows = { athlete: [] };

    await expect(acceptDraftPlan(9)).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(dbState.transactions).toBe(0);
    expect(dbState.updates).toEqual([]);
  });
});

describe('discardDraftPlan', () => {
  it('supprime le brouillon de l’athlète, et lui seul', async () => {
    dbState.returning.plans = [{ id: 9 }];

    await expect(discardDraftPlan(9)).resolves.toBeUndefined();

    expect(dbState.deletes).toHaveLength(1);
    expect(dbState.deletes[0]?.table).toBe('plans');
    // Anti-IDOR : l'id seul ne suffit pas, il faut que ce soit un brouillon de
    // cet athlète. Les séances suivent par cascade.
    expect(renderWhere(dbState.deletes[0]?.where).params).toEqual([9, 1, 'draft']);
    expect(dbState.updates).toEqual([]);
  });

  it('lève PlanNotFoundError quand aucune ligne n’a été supprimée', async () => {
    dbState.returning.plans = [];

    await expect(discardDraftPlan(404)).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it('lève PlanNotFoundError sans athlète, sans rien supprimer', async () => {
    dbState.rows = { athlete: [] };

    await expect(discardDraftPlan(9)).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(dbState.deletes).toEqual([]);
  });
});

describe('archiveActivePlan', () => {
  it('archive le plan actif et le signale', async () => {
    dbState.returning.plans = [{ id: 3 }];

    await expect(archiveActivePlan()).resolves.toBe(true);
    expect(dbState.updates[0]?.values).toMatchObject({ status: 'archived' });
    expect(renderWhere(dbState.updates[0]?.where).params).toEqual([1, 'active']);
  });

  it('emporte les séances à venir non réalisées du plan archivé, en transaction', async () => {
    dbState.returning.plans = [{ id: 3 }];

    await archiveActivePlan();

    expect(dbState.transactions).toBe(1);
    expect(dbState.deletes).toHaveLength(1);
    const where = renderWhere(dbState.deletes[0]?.where);
    // Le passé du plan reste en base : seules les séances d'aujourd'hui et après,
    // encore non rapprochées d'une activité, disparaissent avec lui.
    expect(where.params).toEqual([3, '2026-08-10']);
    expect(where.sql).toContain('"plan_id" in ($1)');
    expect(where.sql).toContain('"scheduled_on" >= $2');
    expect(where.sql).toContain('"completed_activity_id" is null');
  });

  it('retourne false quand il n’y avait aucun plan actif, sans rien purger', async () => {
    dbState.returning.plans = [];

    await expect(archiveActivePlan()).resolves.toBe(false);
    expect(dbState.deletes).toEqual([]);
  });

  it('retourne false sans athlète, sans rien écrire', async () => {
    dbState.rows = { athlete: [] };

    await expect(archiveActivePlan()).resolves.toBe(false);
    expect(dbState.updates).toEqual([]);
  });
});

describe('applyPlanUpdate', () => {
  /** Ce qu'une instruction du coach produit : la suite du plan et ses réglages. */
  const UPDATE: PlanUpdate = {
    fromDate: '2026-08-15',
    sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-08-20' }],
    settings: { sessionsPerWeek: 3 },
  };

  it('réécrit les séances et les réglages dans une seule transaction', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, UPDATE);

    expect(dbState.transactions).toBe(1);
    expect(dbState.deletes).toHaveLength(1);
    expect(dbState.inserts[0]?.table).toBe('planned_sessions');
    expect(dbState.inserts[0]?.values).toEqual([
      expect.objectContaining({ athleteId: 1, planId: 3, scheduledOn: '2026-08-20' }),
    ]);

    // Une seule écriture sur le plan : elle porte les réglages *et* `updatedAt`.
    expect(dbState.updates).toHaveLength(1);
    const update = dbState.updates[0];
    expect(update?.table).toBe('plans');
    expect(update?.values).toEqual({ sessionsPerWeek: 3, updatedAt: expect.any(Date) });
    expect(renderWhere(update?.where).params).toEqual([3, 1, 'active']);
  });

  it('ne supprime que les séances futures encore non réalisées', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, UPDATE);

    const where = renderWhere(dbState.deletes[0]?.where);
    expect(where.params).toEqual([3, '2026-08-15']);
    expect(where.sql).toContain('"scheduled_on" >= $2');
    expect(where.sql).toContain('"completed_activity_id" is null');
  });

  it('borne la lecture du plan à son id, son athlète et son état actif', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, UPDATE);

    const where = renderWhere(dbState.selects.find((query) => query.table === 'plans')?.where);
    expect(where.params).toEqual([3, 1, 'active']);
  });

  it('efface le temps hebdomadaire quand le patch le met à `null`', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, { ...UPDATE, settings: { weeklyTimeMinutes: null, summary: null } });

    expect(dbState.updates[0]?.values).toMatchObject({ weeklyTimeMinutes: null, summary: null });
  });

  it('accepte une liste vide : elle vide la suite du plan sans rien insérer', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await applyPlanUpdate(3, { ...UPDATE, sessions: [] });

    expect(dbState.deletes).toHaveLength(1);
    expect(dbState.inserts).toEqual([]);
  });

  it('refuse un plan qui n’est pas celui, actif, de l’athlète', async () => {
    dbState.rows.plans = [];

    await expect(applyPlanUpdate(3, UPDATE)).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(dbState.deletes).toEqual([]);
    expect(dbState.inserts).toEqual([]);
    expect(dbState.updates).toEqual([]);
  });

  it('lève PlanNotFoundError si l’écriture des réglages ne touche aucune ligne', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [];

    await expect(applyPlanUpdate(3, UPDATE)).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it('valide les bornes des réglages avant d’ouvrir la transaction', async () => {
    dbState.rows.plans = [PLAN_ROW];

    await expect(
      applyPlanUpdate(3, { ...UPDATE, settings: { sessionsPerWeek: 0 } }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    // Aucune séance supprimée : un patch aberrant ne doit rien entamer.
    expect(dbState.transactions).toBe(0);
    expect(dbState.deletes).toEqual([]);
  });

  it('refuse une date de reprise malformée avant toute lecture', async () => {
    await expect(
      applyPlanUpdate(3, { ...UPDATE, fromDate: '15/08/2026' }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    expect(dbState.transactions).toBe(0);
  });

  it('refuse une séance antérieure à la date de reprise ou hors fenêtre', async () => {
    dbState.rows.plans = [PLAN_ROW];
    dbState.returning.plans = [{ id: 3 }];

    await expect(
      applyPlanUpdate(3, {
        ...UPDATE,
        sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-08-14' }],
      }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    await expect(
      applyPlanUpdate(3, {
        ...UPDATE,
        sessions: [{ ...SESSION_INPUT, scheduledOn: '2026-10-05' }],
      }),
    ).rejects.toBeInstanceOf(InvalidPlanError);
    expect(dbState.deletes).toEqual([]);
  });
});

describe('getPlannedSessionForActivity', () => {
  it('retourne la séance rapprochée, en DTO', async () => {
    dbState.rows.planned_sessions = [{ ...SESSION_ROW, completedActivityId: 42 }];

    const dto = await getPlannedSessionForActivity(42);

    expect(Object.keys(dto ?? {}).sort()).toEqual(SESSION_DTO_KEYS);
    expect(dto?.completedActivityId).toBe(42);
  });

  it('borne la recherche à l’athlète courant (anti-IDOR)', async () => {
    dbState.rows.planned_sessions = [SESSION_ROW];

    await getPlannedSessionForActivity(42);

    const where = renderWhere(
      dbState.selects.find((query) => query.table === 'planned_sessions')?.where,
    );
    expect(where.params).toEqual([42, 1]);
  });

  it('retourne null quand l’activité n’a réalisé aucune séance', async () => {
    dbState.rows.planned_sessions = [];

    await expect(getPlannedSessionForActivity(42)).resolves.toBeNull();
  });

  it('retourne null tant que l’onboarding n’a pas eu lieu', async () => {
    dbState.rows = { athlete: [] };

    await expect(getPlannedSessionForActivity(42)).resolves.toBeNull();
  });
});
