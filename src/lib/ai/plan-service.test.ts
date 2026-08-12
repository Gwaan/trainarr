import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { TrainingSnapshotDto } from '@/data/coach-context';
import { InvalidPlanError, PlanNotFoundError, type PlanDto, type PlanSessionDto } from '@/data/plans';
import type { PlanStep, PlanStepRole } from '@/lib/plan-steps/schema';

import { AiInvalidOutputError, AiResponseError, AiUnavailableError, type AiOutputIssue } from './errors';
import {
  MAX_PLAN_WEEKS,
  MIN_RACE_PLAN_WEEKS,
  generatePlan,
  InvalidGeneratedPlanError,
  planVolumeTargets,
  planWeeklyVolumeKm,
  planWindow,
  remainingPlanWindow,
  remainingVolumeTargets,
  rewriteRemainingPlan,
  updatePlanFromInstruction,
  type PlanRequest,
} from './plan-service';
import {
  VOLUME_RULES,
  validatePlanBusinessRules,
  type PlanWeekOutput,
  type WeeklyVolumeTarget,
} from './plan-schema';
// Le registre n'est pas mocké : ce qu'on éprouve, c'est ce que la route lira.
import { getPlanProgress, type PlanProgress } from './progress';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

const { chatCompletionJson } = vi.hoisted(() => ({ chatCompletionJson: vi.fn() }));
const { requireAi } = vi.hoisted(() => ({ requireAi: vi.fn() }));
const { dal } = vi.hoisted(() => ({
  dal: {
    getTrainingSnapshot: vi.fn(),
    createDraftPlanWithSessions: vi.fn(),
    getActivePlanWithSessions: vi.fn(),
    applyPlanUpdate: vi.fn(),
    reconcilePlanSessions: vi.fn(),
  },
}));

const { syncPlanToIntervalsSafely } = vi.hoisted(() => ({
  syncPlanToIntervalsSafely: vi.fn(),
}));

/**
 * `after` exige un contexte de requête Next : hors serveur, le vrai lève. Le
 * doublon exécute la tâche immédiatement — ce que les tests éprouvent, c'est le
 * branchement et le fait qu'il passe par `after`, pas le moment de l'exécution.
 */
const { scheduleAfter } = vi.hoisted(() => ({ scheduleAfter: vi.fn() }));

/**
 * Le crochet qui permet de **forcer une violation métier** sur un plan écrit par
 * l'appli.
 *
 * Il n'y a pas d'autre moyen : depuis la bascule sur squelette, une création
 * écrit ses volumes elle-même et le remplissage ramène chaque créneau sur son
 * budget au mètre près — aucune entrée de test ne peut produire un plan que
 * `validatePlanBusinessRules` refuse. Or c'est précisément ce cas-là que la
 * dégradation en escalier existe pour traiter, et le laisser non éprouvé
 * reviendrait à ne pas l'avoir écrite.
 *
 * Rendre `undefined` (le défaut) laisse la **vraie** règle décider : tous les
 * autres tests du fichier voient donc le module réel.
 */
const { businessRuleViolations } = vi.hoisted(() => ({ businessRuleViolations: vi.fn() }));

vi.mock('./plan-schema', async () => {
  const actual = await vi.importActual<typeof import('./plan-schema')>('./plan-schema');
  return {
    ...actual,
    validatePlanBusinessRules: (
      ...args: Parameters<typeof actual.validatePlanBusinessRules>
    ): string[] =>
      (businessRuleViolations(...args) as string[] | undefined) ??
      actual.validatePlanBusinessRules(...args),
  };
});

vi.mock('./client', () => ({ chatCompletionJson }));
vi.mock('next/server', () => ({ after: scheduleAfter }));
vi.mock('@/lib/intervals/push-plan', () => ({ syncPlanToIntervalsSafely }));
vi.mock('./availability', () => ({ requireAi }));
vi.mock('@/data/coach-context', () => ({ getTrainingSnapshot: dal.getTrainingSnapshot }));
vi.mock('@/data/plan-reconciliation', () => ({
  reconcilePlanSessions: dal.reconcilePlanSessions,
}));
vi.mock('@/data/plans', async () => {
  // Les erreurs et les bornes sont du vrai code métier : seules les fonctions
  // qui touchent la base sont remplacées.
  const actual = await vi.importActual<typeof import('@/data/plans')>('@/data/plans');
  return {
    ...actual,
    createDraftPlanWithSessions: dal.createDraftPlanWithSessions,
    getActivePlanWithSessions: dal.getActivePlanWithSessions,
    applyPlanUpdate: dal.applyPlanUpdate,
  };
});

const SNAPSHOT: TrainingSnapshotDto = {
  today: '2026-08-11',
  profile: { ageYears: 36, sex: 'female', maxHrBpm: 188, restingHrBpm: 48, weightKg: 62 },
  fitness: { ctl: 52.4, atl: 61.2, tsb: -8.8 },
  vo2max: 48.6,
  weeks: [{ startsOn: '2026-08-03', distanceKm: 42.1, movingTimeS: 13_500, sessions: 4 }],
  longestSessionKm30d: 14.2,
  recentAvgPaceSecPerKm: 324,
};

/** Une date civile décalée de `days` jours — l'arithmétique des fixtures, sans dépendance. */
function shiftDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

const PLAN: PlanDto = {
  id: 3,
  status: 'active',
  goalType: 'race',
  intent: 'race',
  returnInjuryHistory: false,
  level: 'intermediate',
  goalText: '10 km sous 50 min',
  raceDate: '2026-09-13',
  startsOn: '2026-08-03',
  weeks: 6,
  sessionsPerWeek: 3,
  weeklyTimeMinutes: 300,
  longRunDay: 7,
  referenceDistance: null,
  referenceTimeS: null,
  summary: 'Bloc de 6 semaines.',
  reviewedAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
};

/** Ce qu'une génération écrit : une proposition, pas un plan en cours. */
const DRAFT: PlanDto = { ...PLAN, id: 9, status: 'draft' };

function planSession(overrides: Partial<PlanSessionDto> & { scheduledOn: string }): PlanSessionDto {
  return {
    id: 1,
    kind: 'Endurance',
    title: 'Footing',
    warmup: null,
    recovery: null,
    cooldown: null,
    targetPaceSecPerKm: null,
    volumeM: null,
    durationS: null,
    steps: null,
    completedActivityId: null,
    ...overrides,
  };
}

/** Une étape complète : le contrat porte ses sept clés, `null` pour absent. */
function step(role: PlanStepRole, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    role,
    distanceM: null,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note: null,
    ...overrides,
  };
}

/** Un chrono de référence : 10 km en 48:30 → VDOT 41,5 (cf. `lib/metrics/vdot`). */
const REFERENCE_RACE = { distance: '10k', timeS: 2_910 } as const;

const REQUEST: PlanRequest = {
  intent: 'faster',
  level: 'intermediate',
  goalText: 'reprendre le volume',
  weeks: 2,
  sessionsPerWeek: 3,
  longRunDay: 7,
};

/*
 * Le coach simulé de la **création**.
 *
 * Depuis la bascule sur squelette, une génération n'appelle plus le modèle que
 * deux fois par nature : une par créneau de qualité (`quality_session`) et une
 * pour le résumé (`plan_summary`). Le doublon ci-dessous répond aux deux, sans
 * réseau et sans horloge — c'est le seul moyen d'éprouver le chemin de bout en
 * bout, et c'est ce que la tâche exige.
 */

/** Ce que le service envoie, réduit à ce que le doublon consomme. */
type CoachCall = {
  schemaName: string;
  messages: { role: string; content: string }[];
  onProgress?: (receivedChars: number) => void;
};

/** Une étape normalisée, telle que le contrat la porte : sept clés, `null` pour absent. */
function fillStep(role: PlanStepRole, distanceM: number): PlanStep {
  return step(role, { distanceM });
}

/**
 * Le budget que le prompt d'un créneau annonce, en km.
 *
 * Relu dans le message plutôt que passé de côté : c'est exactement ce que le
 * modèle voit, et un doublon qui devinerait le budget autrement ne prouverait
 * rien du contrat entre le squelette et le remplissage.
 */
function slotBudgetKm(call: CoachCall): number {
  const asked = /compris : ([\d,]+) km/.exec(call.messages[1].content);
  if (asked === null) throw new Error(`budget introuvable dans : ${call.messages[1].content}`);
  return Number(asked[1].replace(',', '.'));
}

/**
 * Le déroulé qu'un coach compétent rendrait : échauffement, quatre efforts avec
 * leur récupération, retour au calme — et la somme **tombe pile sur le budget**,
 * le retour au calme absorbant le reliquat des divisions.
 */
function qualityOutputFor(budgetKm: number) {
  const totalM = Math.round(budgetKm * 1_000);
  const warmupM = Math.round(totalM * 0.25);
  const cooldownM = Math.round(totalM * 0.25);
  const bodyM = totalM - warmupM - cooldownM;
  const runM = Math.round((bodyM * 0.6) / 4);
  const recoverM = Math.round((bodyM * 0.4) / 4);

  return {
    title: 'Séance écrite par le coach',
    steps: [
      { repeat: 1, steps: [fillStep('warmup', warmupM)] },
      { repeat: 4, steps: [fillStep('run', runM), fillStep('recover', recoverM)] },
      {
        repeat: 1,
        steps: [fillStep('cooldown', cooldownM + bodyM - 4 * (runM + recoverM))],
      },
    ],
  };
}

/** Le résumé que le coach simulé rend, reconnaissable dans les assertions. */
const COACH_SUMMARY = 'Huit semaines pour arriver frais le jour J.';

/**
 * Le coach simulé : il remplit chaque créneau au budget demandé et rédige le
 * résumé. Aucun autre schéma ne devrait lui parvenir sur ce chemin — s'il en
 * arrive un, c'est le test qui doit le dire.
 */
function coachAnswers(): void {
  chatCompletionJson.mockImplementation(async (call: CoachCall) => {
    if (call.schemaName === 'plan_summary') return { summary: COACH_SUMMARY };
    if (call.schemaName === 'quality_session') return qualityOutputFor(slotBudgetKm(call));
    throw new Error(`schéma inattendu sur le chemin de création : ${call.schemaName}`);
  });
}

/** Les séances écrites en base par la dernière génération. */
type WrittenSession = {
  scheduledOn: string;
  kind: string;
  title: string;
  volumeM: number | null;
  durationS: number | null;
  targetPaceSecPerKm: number | null;
  steps: { repeat: number; steps: PlanStep[] }[] | null;
};

function writtenSessions(): WrittenSession[] {
  return dal.createDraftPlanWithSessions.mock.calls[0][0].sessions as WrittenSession[];
}

/** Le volume total d'un jeu de séances écrites, en km. */
function totalKm(sessions: readonly WrittenSession[]): number {
  return sessions.reduce((total, session) => total + (session.volumeM ?? 0), 0) / 1_000;
}

/** Le temps planifié par semaine ISO, en secondes — la mesure du budget temps. */
function secondsByWeek(sessions: readonly WrittenSession[]): Map<string, number> {
  const byWeek = new Map<string, number>();
  for (const session of sessions) {
    // Les semaines du plan sont des semaines ISO à partir d'un lundi : le lundi
    // de la semaine suffit à les distinguer.
    const day = new Date(`${session.scheduledOn}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    const week = day.toISOString().slice(0, 10);
    byWeek.set(week, (byWeek.get(week) ?? 0) + (session.durationS ?? 0));
  }
  return byWeek;
}

/**
 * Les rejets du modèle sont journalisés : la console est muselée pour tous les
 * tests, et inspectée par ceux qui éprouvent la trace elle-même.
 */
let consoleError: MockInstance<typeof console.error>;

/** Le diagnostic du suivi de progression, lui, part en `console.info`. */
let consoleInfo: MockInstance<typeof console.info>;

/** Tout ce qui est parti dans un espion de console, en un seul texte. */
function textOf(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

/** Tout ce qui est parti dans `console.error`, en un seul texte. */
function loggedText(): string {
  return textOf(consoleError);
}

beforeEach(() => {
  vi.useFakeTimers();
  // Un mardi : un plan sans date de départ commence donc ce jour-là, sur la
  // semaine du lundi 10 août 2026.
  vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));
  // `reset` et non `clear` : ce dernier n'efface que les appels enregistrés, pas
  // les implémentations. Le crochet qui l'impose est
  // `businessRuleViolations.mockReturnValue([VIOLATION])`, posé par les cas de
  // dégradation en escalier : sous `clearAllMocks`, il survit au test et force
  // une violation sur **tous** les suivants — vérifié par exécution, les 30
  // échecs sont tous situés après lui, et aucun avant.
  vi.resetAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  requireAi.mockResolvedValue(undefined);
  dal.getTrainingSnapshot.mockResolvedValue(SNAPSHOT);
  dal.createDraftPlanWithSessions.mockResolvedValue(DRAFT);
  dal.getActivePlanWithSessions.mockResolvedValue({ plan: PLAN, sessions: [] });
  dal.applyPlanUpdate.mockResolvedValue(undefined);
  dal.reconcilePlanSessions.mockResolvedValue(0);
  syncPlanToIntervalsSafely.mockResolvedValue(undefined);
  scheduleAfter.mockImplementation((task: () => unknown) => {
    void task();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Un départ un lundi : la fenêtre d'avant la première semaine partielle. */
const MONDAY = { startsOn: '2026-08-17' } as const;

describe('planWindow', () => {
  it("déduit la durée de la date de course, jour de course compris", () => {
    // Du lundi 17 août au dimanche 13 septembre : 4 semaines pleines.
    expect(
      planWindow({ ...REQUEST, ...MONDAY, intent: 'race', raceDate: '2026-09-13' }, '2026-08-11'),
    ).toEqual({ startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 4, firstWeekFromDay: 1 });
    // Course un lundi : la semaine qui la porte compte quand même.
    expect(
      planWindow({ ...REQUEST, ...MONDAY, intent: 'race', raceDate: '2026-09-14' }, '2026-08-11'),
    ).toEqual({ startsOn: '2026-08-17', anchor: '2026-08-17', weeks: 5, firstWeekFromDay: 1 });
  });

  it('refuse une course trop proche pour être périodisée', () => {
    // Du lundi 17 au dimanche 30 : deux semaines, et le message dit les jours
    // réellement disponibles plutôt qu'un compte de cases du calendrier.
    expect(() =>
      planWindow({ ...REQUEST, ...MONDAY, intent: 'race', raceDate: '2026-08-30' }, '2026-08-11'),
    ).toThrow(new RegExp(`13 jours avant la course.*${MIN_RACE_PLAN_WEEKS} semaines au minimum`));
  });

  it('refuse une course trop lointaine pour tenir dans un plan', () => {
    // Le plan démarre le lundi 17 août 2026 : sa 52e semaine finit le 15 août
    // 2027. Un jour de plus et la fenêtre déborde — la tronquer produirait un
    // plan qui s'arrête avant la course qu'il prépare.
    expect(
      planWindow({ ...REQUEST, ...MONDAY, intent: 'race', raceDate: '2027-08-15' }, '2026-08-11')
        .weeks,
    ).toBe(MAX_PLAN_WEEKS);

    expect(() =>
      planWindow({ ...REQUEST, ...MONDAY, intent: 'race', raceDate: '2027-08-16' }, '2026-08-11'),
    ).toThrow(new RegExp(`Course trop lointaine.*${MAX_PLAN_WEEKS} au plus`));
  });

  it('refuse un objectif course sans date exploitable', () => {
    expect(() => planWindow({ ...REQUEST, ...MONDAY, intent: 'race' }, '2026-08-11')).toThrow(
      /date de la course/,
    );
    expect(() =>
      planWindow({ ...REQUEST, ...MONDAY, intent: 'race', raceDate: '2026-02-31' }, '2026-08-11'),
    ).toThrow(/date de la course/);
  });

  it('exige une durée pour un objectif libre', () => {
    expect(() => planWindow({ ...REQUEST, weeks: undefined }, '2026-08-11')).toThrow(
      /durée en semaines/,
    );
  });

  describe('date de démarrage choisie', () => {
    it('démarre le lundi demandé, objectif libre', () => {
      expect(planWindow({ ...REQUEST, startsOn: '2026-08-31' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-31',
        anchor: '2026-08-31',
        weeks: 2,
        firstWeekFromDay: 1,
      });
    });

    it('recompte les semaines d’une course depuis ce lundi-là', () => {
      const race = { ...REQUEST, intent: 'race', raceDate: '2026-09-27' } as const;

      // Départ le lundi 17 août : 6 semaines jusqu'à la course.
      expect(planWindow({ ...race, ...MONDAY }, '2026-08-11').weeks).toBe(6);
      // Départ repoussé de deux semaines : le plan raccourcit d'autant.
      expect(planWindow({ ...race, startsOn: '2026-08-31' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-31',
        anchor: '2026-08-31',
        weeks: 4,
        firstWeekFromDay: 1,
      });
    });

    it('refuse une course devenue trop proche du démarrage choisi', () => {
      expect(() =>
        planWindow(
          { ...REQUEST, intent: 'race', raceDate: '2026-09-13', startsOn: '2026-08-31' },
          '2026-08-11',
        ),
      ).toThrow(/trop court/);
    });

    it('démarre aujourd’hui quand rien n’est demandé', () => {
      // Un mardi : le plan commence le jour même, sa première semaine est donc
      // entamée et la grille reste ancrée sur le lundi 10.
      expect(planWindow(REQUEST, '2026-08-11')).toEqual({
        startsOn: '2026-08-11',
        anchor: '2026-08-10',
        weeks: 2,
        firstWeekFromDay: 2,
      });
      expect(planWindow({ ...REQUEST, startsOn: undefined }, '2026-08-11').startsOn).toBe(
        '2026-08-11',
      );
    });

    it('refuse un démarrage passé', () => {
      expect(() => planWindow({ ...REQUEST, startsOn: '2026-08-10' }, '2026-08-11')).toThrow(
        /ne peut pas démarrer dans le passé/,
      );
    });

    it('refuse une date inexploitable', () => {
      expect(() => planWindow({ ...REQUEST, startsOn: '2026-02-31' }, '2026-08-11')).toThrow(
        /AAAA-MM-JJ/,
      );
    });
  });

  describe('départ en milieu de semaine', () => {
    it('ancre la grille sur le lundi de la semaine du départ', () => {
      // Jeudi 13 août : la première semaine est celle du lundi 10, mais le plan
      // ne commence que le 13.
      expect(planWindow({ ...REQUEST, weeks: 8, startsOn: '2026-08-13' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-13',
        anchor: '2026-08-10',
        weeks: 8,
        firstWeekFromDay: 4,
      });
    });

    it('ajoute la semaine entamée aux semaines demandées quand elle est trop courte', () => {
      // Samedi : deux jours restants, ils ne valent pas une semaine
      // d'entraînement — les 8 semaines demandées restent entières.
      expect(planWindow({ ...REQUEST, weeks: 8, startsOn: '2026-08-15' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-15',
        anchor: '2026-08-10',
        weeks: 9,
        firstWeekFromDay: 6,
      });
      // Dimanche : un seul jour, même arbitrage.
      expect(planWindow({ ...REQUEST, weeks: 8, startsOn: '2026-08-16' }, '2026-08-11').weeks).toBe(9);
      // Jeudi : quatre jours, sortie longue du week-end comprise — la semaine
      // entamée compte parmi les huit.
      expect(planWindow({ ...REQUEST, weeks: 8, startsOn: '2026-08-13' }, '2026-08-11').weeks).toBe(8);
    });

    it('exclut une semaine entamée trop courte du minimum d’un plan course', () => {
      const race = { ...REQUEST, intent: 'race' } as const;

      // Dimanche 16 août, course le lundi 24 : trois semaines ISO depuis l'ancre,
      // mais huit jours de préparation — la semaine entamée d'un jour ne prépare
      // pas une course, et le message le dit.
      expect(() => planWindow({ ...race, raceDate: '2026-08-24', startsOn: '2026-08-16' }, '2026-08-11')).toThrow(
        /ne laisse que 8 jours avant la course/,
      );
      // Une semaine de plus et la préparation tient : quatre semaines ISO, dont
      // trois qui comptent.
      expect(
        planWindow({ ...race, raceDate: '2026-08-31', startsOn: '2026-08-16' }, '2026-08-11').weeks,
      ).toBe(MIN_RACE_PLAN_WEEKS + 1);
      // Jeudi 13 août, même course : quatre jours dans la semaine entamée, elle
      // compte — le seuil ne bouge pas pour un départ du lundi au jeudi.
      expect(
        planWindow({ ...race, raceDate: '2026-08-24', startsOn: '2026-08-13' }, '2026-08-11').weeks,
      ).toBe(MIN_RACE_PLAN_WEEKS);
    });

    it('compte les semaines d’une course depuis l’ancre, semaine entamée comprise', () => {
      const race = { ...REQUEST, intent: 'race', raceDate: '2026-09-13' } as const;

      // Jeudi 13 août → dimanche 13 septembre : 5 semaines ISO depuis le lundi 10.
      expect(planWindow({ ...race, startsOn: '2026-08-13' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-13',
        anchor: '2026-08-10',
        weeks: 5,
        firstWeekFromDay: 4,
      });
      // Départ le dimanche : même ancre, donc même compte — la semaine entamée
      // d'un seul jour reste la première du plan.
      expect(planWindow({ ...race, startsOn: '2026-08-16' }, '2026-08-11')).toEqual({
        startsOn: '2026-08-16',
        anchor: '2026-08-10',
        weeks: 5,
        firstWeekFromDay: 7,
      });
    });
  });
});

describe('remainingPlanWindow', () => {
  it('découpe à partir de la semaine en cours, entamée', () => {
    // Plan démarré le lundi 3 août, reprise le mercredi 12 : semaine 2 du plan.
    expect(remainingPlanWindow({ startsOn: '2026-08-03', weeks: 6 }, '2026-08-12')).toEqual({
      firstWeekStart: '2026-08-10',
      weeks: 5,
      firstWeekFromDay: 3,
    });
  });

  it("rend le plan entier quand il n'a pas encore commencé", () => {
    expect(remainingPlanWindow({ startsOn: '2026-08-17', weeks: 6 }, '2026-08-12')).toEqual({
      firstWeekStart: '2026-08-17',
      weeks: 6,
      firstWeekFromDay: 1,
    });
  });

  it('découpe un plan démarré en milieu de semaine sur sa grille ISO', () => {
    // Plan démarré le jeudi 13 août : sa première semaine est celle du lundi 10.
    // Reprise le lundi 17 : c'est déjà la deuxième semaine du plan.
    expect(remainingPlanWindow({ startsOn: '2026-08-13', weeks: 5 }, '2026-08-17')).toEqual({
      firstWeekStart: '2026-08-17',
      weeks: 4,
      firstWeekFromDay: 1,
    });
    // Reprise le samedi 15 : toujours la première semaine, entamée depuis samedi.
    expect(remainingPlanWindow({ startsOn: '2026-08-13', weeks: 5 }, '2026-08-15')).toEqual({
      firstWeekStart: '2026-08-10',
      weeks: 5,
      firstWeekFromDay: 6,
    });
  });

  it('rend la semaine entamée du départ quand le plan ne commence pas encore', () => {
    // Reprise avant le départ : rien n'est à replanifier avant le jeudi 13.
    expect(remainingPlanWindow({ startsOn: '2026-08-13', weeks: 5 }, '2026-08-12')).toEqual({
      firstWeekStart: '2026-08-10',
      weeks: 5,
      firstWeekFromDay: 4,
    });
  });

  it('refuse de régénérer un plan arrivé à son terme', () => {
    expect(() => remainingPlanWindow({ startsOn: '2026-08-03', weeks: 1 }, '2026-08-12')).toThrow(
      /arrivé à son terme/,
    );
  });
});

/**
 * La création, de bout en bout et sans réseau.
 *
 * Le modèle n'y écrit plus que deux choses : le déroulé de chaque créneau de
 * qualité (`quality-fill.ts`) et le résumé. Tout le reste — périodisation,
 * volumes, jours, séances — est écrit par l'appli, et c'est ce que ces cas
 * constatent sur les séances réellement enregistrées.
 */
describe('generatePlan', () => {
  /** Une préparation marathon datée : 8 semaines, jour J le dimanche 11 octobre. */
  const RACE_REQUEST: PlanRequest = {
    intent: 'race',
    level: 'intermediate',
    goalText: 'Marathon de Nantes',
    raceDate: '2026-10-11',
    sessionsPerWeek: 4,
    // Sortie longue le samedi : elle **diffère** du jour J, ce qui est le cas
    // que le squelette doit réorganiser sur sa dernière semaine.
    longRunDay: 6,
    startsOn: '2026-08-17',
    referenceRace: REFERENCE_RACE,
  };

  it('écrit une proposition complète quand le coach répond', async () => {
    coachAnswers();

    const plan = await generatePlan(REQUEST);

    // Une proposition, pas un plan en cours : c'est l'athlète qui l'active.
    expect(plan).toBe(DRAFT);

    const input = dal.createDraftPlanWithSessions.mock.calls[0][0];
    expect(input.level).toBe('intermediate');
    // Sans date demandée, le plan démarre aujourd'hui (mardi 11 août) et sa
    // grille de jours ISO s'ancre sur le lundi 10.
    expect(input.startsOn).toBe('2026-08-11');
    expect(input.weeks).toBe(2);
    expect(input.raceDate).toBeNull();
    expect(input.summary).toBe(COACH_SUMMARY);
    // Deux semaines de trois séances, moins ce que la semaine entamée perd.
    expect(input.sessions.length).toBeGreaterThan(0);
    for (const session of writtenSessions()) {
      expect(session.scheduledOn >= '2026-08-11').toBe(true);
      expect(session.scheduledOn <= '2026-08-23').toBe(true);
      expect(session.volumeM).not.toBeNull();
    }
  });

  it('ne demande au modèle que les créneaux de qualité et le résumé', async () => {
    coachAnswers();

    await generatePlan(REQUEST);

    const schemas = chatCompletionJson.mock.calls.map(
      (call: { schemaName: string }[]) => call[0].schemaName,
    );
    // Le résumé ferme la marche : le plan est écrit et validé avant qu'on le
    // fasse décrire.
    expect(schemas[schemas.length - 1]).toBe('plan_summary');
    expect(new Set(schemas.slice(0, -1))).toEqual(new Set(['quality_session']));
    // Plus aucun plan entier ne part au modèle.
    expect(schemas).not.toContain('training_plan');
    expect(schemas).not.toContain('training_plan_chunk');
  });

  /**
   * Le cas qui justifie toute la bascule : un coach injoignable ne coûte plus
   * qu'un peu de sur-mesure. Le plan sort quand même — écrit, complet, valide,
   * et **entièrement déterministe**.
   */
  it('écrit un plan valide, et le même, quand le coach échoue systématiquement', async () => {
    chatCompletionJson.mockRejectedValue(new AiResponseError('502 Bad Gateway', 502));

    await expect(generatePlan(REQUEST)).resolves.toBe(DRAFT);
    const first = writtenSessions();
    expect(first.length).toBeGreaterThan(0);

    dal.createDraftPlanWithSessions.mockClear();
    await generatePlan(REQUEST);

    expect(writtenSessions()).toEqual(first);
    // Le résumé aussi : il vient du gabarit de l'appli, pas du modèle.
    expect(dal.createDraftPlanWithSessions.mock.calls[0][0].summary).toContain(
      'Plan de 2 semaines',
    );
  });

  it("n'engage rien : ni rapprochement, ni publication au calendrier", async () => {
    coachAnswers();

    await generatePlan(REQUEST);

    // Une proposition ne pilote rien tant qu'elle n'est pas adoptée : rapprocher
    // ses séances des activités ou les publier sur la montre reviendrait à
    // l'imposer. Les deux effets partent de l'adoption (`_lib/actions.ts`).
    expect(dal.reconcilePlanSessions).not.toHaveBeenCalled();
    expect(syncPlanToIntervalsSafely).not.toHaveBeenCalled();
    expect(scheduleAfter).not.toHaveBeenCalled();
  });

  it('propage une indisponibilité du coach sans rien lire ni écrire', async () => {
    requireAi.mockRejectedValue(new AiUnavailableError('unreachable'));

    await expect(generatePlan(REQUEST)).rejects.toThrow(AiUnavailableError);
    expect(dal.getTrainingSnapshot).not.toHaveBeenCalled();
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  it('refuse une fenêtre invalide avant tout appel au modèle', async () => {
    await expect(generatePlan({ ...REQUEST, weeks: undefined })).rejects.toThrow(
      /durée en semaines/,
    );
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  /**
   * Le refus d'infaisabilité, traduit pour l'athlète.
   *
   * Une coureuse à 3 km par semaine qui demande 6 séances demande 500 m par
   * séance : ce n'est pas un plan, c'est une configuration que le squelette
   * refuse d'écrire (`PlanSkeletonInfeasibleError`). Le service le lui dit sur le
   * champ qu'elle peut changer, et n'appelle pas le modèle pour rien.
   */
  /*
   * L'intention **reprise**, de bout en bout : ce qu'elle écrit en base, le
   * régime de volume qu'elle applique, et le plafond qu'elle tire des données
   * réelles de l'athlète.
   *
   * Les trois se décident dans ce service et nulle part ailleurs : le squelette
   * ne voit ni l'historique ni le plan enregistré.
   */
  describe('une reprise', () => {
    const RETURN_REQUEST: PlanRequest = {
      ...REQUEST,
      intent: 'return',
      returnInjuryHistory: true,
      goalText: '',
      weeks: 8,
      sessionsPerWeek: 4,
      // Départ un lundi : la première semaine est pleine, donc son volume se lit
      // sans proratisation.
      startsOn: '2026-08-17',
    };

    it('écrit son intention et son antécédent dans le plan', async () => {
      coachAnswers();

      await generatePlan(RETURN_REQUEST);

      const input = dal.createDraftPlanWithSessions.mock.calls[0][0];
      expect(input.intent).toBe('return');
      expect(input.returnInjuryHistory).toBe(true);
      // `goal_type` reste solidaire : seule une intention datée porte une date.
      expect(input.goalType).toBe('free');
      expect(input.raceDate).toBeNull();
      // La note est facultative : rien n'oblige l'athlète à en écrire une.
      expect(input.goalText).toBe('');
    });

    /*
     * Le niveau **de charge** d'une reprise est celui d'une débutante, quel que
     * soit le niveau déclaré : ce qui se perd à l'arrêt n'est pas ce qui met le
     * plus longtemps à revenir, et une confirmée qui reprend a le tissu
     * conjonctif d'une débutante avec le moteur d'une confirmée.
     */
    it('vise les volumes d’une débutante, quel que soit le niveau déclaré', () => {
      const window = planWindow(RETURN_REQUEST, '2026-08-11');
      const asAdvanced = planVolumeTargets(
        { ...RETURN_REQUEST, level: 'advanced' },
        window,
        SNAPSHOT,
      );

      expect(asAdvanced).toEqual(
        planVolumeTargets({ ...RETURN_REQUEST, level: 'beginner' }, window, SNAPSHOT),
      );
      // Et c'est bien un changement de régime : à niveau déclaré égal, une
      // recherche de vitesse monte plus vite.
      expect(asAdvanced).not.toEqual(
        planVolumeTargets({ ...RETURN_REQUEST, intent: 'faster', level: 'advanced' }, window, SNAPSHOT),
      );
    });

    it('démarre au volume d’une débutante quand rien n’ancre la reprise', () => {
      // `defaultStartKm` du niveau débutant : sans historique, une reprise
      // démarre bas, et c'est voulu.
      const empty: TrainingSnapshotDto = { ...SNAPSHOT, weeks: [], longestSessionKm30d: null };
      const window = planWindow(RETURN_REQUEST, '2026-08-11');

      // `defaultStartKm` vaut 12 km pour une débutante et 32 pour une
      // confirmée : à niveau déclaré identique, une reprise démarre presque
      // trois fois plus bas, et c'est exactement ce qu'on veut d'une reprise.
      expect(planVolumeTargets({ ...RETURN_REQUEST, level: 'advanced' }, window, empty)[0].targetKm)
        .toBe(11.9);
      expect(
        planVolumeTargets({ ...RETURN_REQUEST, intent: 'faster', level: 'advanced' }, window, empty)[0]
          .targetKm,
      ).toBe(31.9);
    });

    /*
     * Le plafond de sortie longue vient des **données**, pas d'une constante :
     * la plus longue séance des trente derniers jours, majorée de 10 %
     * (Frandsen 2025). Sans donnée, pas de plafond — on n'invente pas un chiffre
     * pour combler un historique vide.
     */
    it('plafonne sa première sortie longue à la plus longue séance récente + 10 %', async () => {
      coachAnswers();
      dal.getTrainingSnapshot.mockResolvedValue({ ...SNAPSHOT, longestSessionKm30d: 12 });

      await generatePlan(RETURN_REQUEST);
      const capped = firstLongRunKm();

      expect(capped).toBeLessThanOrEqual(12 * 1.1 + 1e-9);

      // Sans historique de séance longue, le même plan repart sans plafond.
      dal.createDraftPlanWithSessions.mockClear();
      dal.getTrainingSnapshot.mockResolvedValue({ ...SNAPSHOT, longestSessionKm30d: null });
      await generatePlan(RETURN_REQUEST);

      expect(firstLongRunKm()).toBeGreaterThan(capped);
    });

    it('ne plafonne rien sous les autres intentions', async () => {
      coachAnswers();
      dal.getTrainingSnapshot.mockResolvedValue({ ...SNAPSHOT, longestSessionKm30d: 12 });

      await generatePlan({ ...RETURN_REQUEST, intent: 'faster', returnInjuryHistory: false });

      // La plus longue séance récente est une donnée de reprise : ailleurs, elle
      // n'a aucun titre à rogner la sortie longue.
      expect(firstLongRunKm()).toBeGreaterThan(12 * 1.1);
    });

    /** La sortie longue de la première semaine écrite, en km. */
    function firstLongRunKm(): number {
      const sessions = writtenSessions();
      const first = sessions[0].scheduledOn;
      const week = sessions.filter((session) => session.scheduledOn < shiftDays(first, 7));
      return Math.max(...week.map((session) => (session.volumeM ?? 0) / 1_000));
    }
  });

  describe('quand le volume ne finance pas les séances demandées', () => {
    /** Le cas de la revue : 3 km récents, 6 séances, marathon dans 8 semaines. */
    const TOO_MANY_SESSIONS: PlanRequest = {
      ...RACE_REQUEST,
      level: 'beginner',
      sessionsPerWeek: 6,
      referenceRace: undefined,
    };

    beforeEach(() => {
      dal.getTrainingSnapshot.mockResolvedValue({
        ...SNAPSHOT,
        weeks: [{ startsOn: '2026-08-03', distanceKm: 3, movingTimeS: 1_200, sessions: 2 }],
      });
      coachAnswers();
    });

    it('refuse sur le nombre de séances, avec un repli chiffré', async () => {
      const failure = await generatePlan(TOO_MANY_SESSIONS).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(InvalidPlanError);
      const error = failure as InstanceType<typeof InvalidPlanError>;
      expect(error.field).toBe('sessionsPerWeek');
      expect(error.message).toContain('6 séances par semaine ne tiennent pas');
      expect(error.message).toMatch(/séances? par semaine au plus|Aucun nombre de séances/);
      expect(error.message).toContain('0,5 km par séance');
    });

    it('ne dérange pas le modèle et n’écrit rien', async () => {
      await expect(generatePlan(TOO_MANY_SESSIONS)).rejects.toThrow(InvalidPlanError);

      expect(chatCompletionJson).not.toHaveBeenCalled();
      expect(dal.createDraftPlanWithSessions).not.toHaveBeenCalled();
    });

    it('journalise le diagnostic chiffré, que le formulaire ne peut pas montrer', async () => {
      await expect(generatePlan(TOO_MANY_SESSIONS)).rejects.toThrow(InvalidPlanError);

      // Les numéros de semaine ne veulent rien dire dans un formulaire de
      // création : ils partent au journal, où ils rendent le cas rejouable.
      expect(loggedText()).toContain('[plan] squelette infaisable : Semaine');
    });
  });

  /**
   * La dégradation en escalier.
   *
   * Elle ne devrait jamais servir — le squelette est mesuré à zéro violation sur
   * des dizaines de milliers de combinaisons —, mais il n'y a personne à qui
   * redemander un plan que l'appli a écrit : le seul geste interdit est de
   * rendre un plan invalide.
   */
  describe('quand le plan assemblé viole malgré tout une règle', () => {
    /** Une violation quelconque : ce qu'elle dit n'importe pas, seul son existence compte. */
    const VIOLATION = 'Semaine 1 : quelque chose ne va pas.';

    it('réécrit tous les créneaux par l’appli, puis revalide', async () => {
      coachAnswers();
      // Le premier passage — celui des créneaux écrits par le modèle — est
      // refusé ; le second, tout déterministe, retrouve la vraie règle.
      businessRuleViolations.mockReturnValueOnce([VIOLATION]);

      await expect(generatePlan(REQUEST)).resolves.toBe(DRAFT);

      // Les séances de qualité ne portent plus le titre du modèle : elles ont été
      // réécrites par le déroulé déterministe.
      const titles = writtenSessions().map((session) => session.title);
      expect(titles).not.toContain('Séance écrite par le coach');
      expect(loggedText()).toContain('réécriture de tous les créneaux');
      expect(loggedText()).toContain(VIOLATION);
    });

    it('lève plutôt que d’écrire un plan invalide, et dit de quoi le rejouer', async () => {
      coachAnswers();
      businessRuleViolations.mockReturnValue([VIOLATION]);

      await expect(generatePlan(REQUEST)).rejects.toThrow(InvalidGeneratedPlanError);

      expect(dal.createDraftPlanWithSessions).not.toHaveBeenCalled();
      const logged = loggedText();
      expect(logged).toContain('plan tout-déterministe encore hors règles');
      expect(logged).toContain(VIOLATION);
      // La configuration exacte, pour rejouer le cas.
      expect(logged).toContain('intention faster');
      expect(logged).toContain('note « reprendre le volume »');
      expect(logged).toContain('3 séances/semaine');
    });
  });

  /**
   * Le jour J.
   *
   * Le défaut corrigé : le squelette posait une « Sortie longue » sur le jour de
   * sortie longue de l'athlète en semaine de course, et l'athlète lisait 8,5 km
   * en endurance sur la case de son marathon.
   */
  describe('la semaine de la course', () => {
    it('écrit la course le bon jour, au bon libellé, à l’allure de l’objectif', async () => {
      coachAnswers();

      await generatePlan(RACE_REQUEST);

      const raceDay = writtenSessions().filter(
        (session) => session.scheduledOn === '2026-10-11',
      );
      expect(raceDay).toHaveLength(1);
      expect(raceDay[0].kind).toBe('Course');
      expect(raceDay[0].title).toBe('Jour J : la course');
      // Zone M de la table (5:08–5:37/km), et non l'endurance (5:56–6:32/km) que
      // le libellé « Sortie longue » lui valait.
      expect(raceDay[0].targetPaceSecPerKm).toBeGreaterThanOrEqual(308);
      expect(raceDay[0].targetPaceSecPerKm).toBeLessThanOrEqual(337);
    });

    it('ne double pas la course d’une sortie longue', async () => {
      coachAnswers();

      await generatePlan(RACE_REQUEST);

      const lastWeek = writtenSessions().filter(
        (session) => session.scheduledOn >= '2026-10-05' && session.scheduledOn <= '2026-10-11',
      );
      expect(lastWeek.map((session) => session.kind)).not.toContain('Sortie longue');
      // Et la course reste la plus longue séance de sa semaine.
      const raceVolume = lastWeek.find((s) => s.scheduledOn === '2026-10-11')?.volumeM ?? 0;
      for (const session of lastWeek) expect(raceVolume).toBeGreaterThanOrEqual(session.volumeM ?? 0);
    });

    it('laisse les autres semaines à leur sortie longue du samedi', async () => {
      coachAnswers();

      await generatePlan(RACE_REQUEST);

      // Le samedi 3 octobre, une semaine avant la course : encore une sortie
      // longue, au jour réglé par l'athlète.
      const saturday = writtenSessions().find((session) => session.scheduledOn === '2026-10-03');
      expect(saturday?.kind).toBe('Sortie longue');
    });

    /*
     * Le jour J est une **borne** : rien ne se programme après lui.
     *
     * Mesuré avant correction, marathon un lundi et 6 séances : le plan portait
     * 5 séances et 23,3 km après la course, dont une le lendemain de l'épreuve.
     * Ce n'est pas une semaine d'affûtage.
     */
    it('n’écrit rien après le jour J, même quand la course tombe un lundi', async () => {
      coachAnswers();

      // Lundi 12 octobre 2026 : la semaine de course n'a qu'un seul jour utile.
      await generatePlan({ ...RACE_REQUEST, raceDate: '2026-10-12', sessionsPerWeek: 6 });

      const after = writtenSessions().filter((session) => session.scheduledOn > '2026-10-12');
      expect(after).toEqual([]);
      const raceDay = writtenSessions().filter(
        (session) => session.scheduledOn === '2026-10-12',
      );
      expect(raceDay).toHaveLength(1);
      expect(raceDay[0].kind).toBe('Course');
    });

    it('n’écrit pas de jour J sur un objectif libre', async () => {
      coachAnswers();

      await generatePlan(REQUEST);

      expect(writtenSessions().map((session) => session.kind)).not.toContain('Course');
    });
  });

  /**
   * Un objectif **libre** ne se prépare pas comme une course, même quand son
   * texte nomme une distance.
   *
   * La règle est écrite depuis longtemps du côté du prompt (`coachRuleTailLines`,
   * « sur un objectif libre, il n'y a pas d'allure objectif à travailler, et
   * prescrire un bloc à une allure qui n'existe pas ferait fabriquer une
   * échéance ») ; le chemin du squelette, lui, lisait la distance dans le texte
   * sans regarder l'intention.
   *
   * Mesuré avant correction : « me remettre après mon semi » recevait 3 sorties
   * longues découpées en « Mise en route / Bloc à allure objectif / Retour au
   * calme », et « préparer un marathon un jour » 8 séances « Spécifique allure
   * course » — pour des objectifs qui n'ont ni date ni chrono.
   */
  describe('objectif libre dont le texte nomme une distance', () => {
    /** Assez long pour porter une phase de spécificité, seule à prescrire du spécifique. */
    const FREE: PlanRequest = { ...REQUEST, weeks: 12, sessionsPerWeek: 5 };

    /** Le plan écrit pour ce texte, réduit à ce qui décrit sa spécificité. */
    async function planFor(goalText: string): Promise<string[]> {
      dal.createDraftPlanWithSessions.mockClear();
      await generatePlan({ ...FREE, goalText });
      return writtenSessions().map((session) => `${session.kind} — ${session.title}`);
    }

    beforeEach(() => {
      coachAnswers();
    });

    it('ne découpe aucune sortie longue en bloc à allure objectif', async () => {
      for (const goalText of ['me remettre après mon semi', 'préparer un marathon un jour']) {
        expect(await planFor(goalText), goalText).not.toContain(
          'Sortie longue — Sortie longue avec bloc à allure objectif',
        );
      }
    });

    it('écrit le même plan que si le texte ne nommait aucune distance', async () => {
      // Le seul contrat qui vaille : sur un objectif libre, le **texte** ne
      // décide de rien. C'est la préparation polyvalente du repli
      // (`goalFamily(null)`), la même pour « reprendre le volume » que pour un
      // texte où traîne le mot « marathon ».
      const neutral = await planFor('reprendre le volume');

      expect(await planFor('me remettre après mon semi')).toEqual(neutral);
      expect(await planFor('préparer un marathon un jour')).toEqual(neutral);
    });
  });

  /** Le résumé : le seul texte libre du plan, et le seul qui puisse manquer. */
  describe('résumé', () => {
    it('prend celui du modèle quand il répond', async () => {
      coachAnswers();

      await generatePlan(REQUEST);

      expect(dal.createDraftPlanWithSessions.mock.calls[0][0].summary).toBe(COACH_SUMMARY);
    });

    it('décrit le plan sans lui donner de séance à recopier', async () => {
      coachAnswers();

      await generatePlan(RACE_REQUEST);

      const summaryCall = chatCompletionJson.mock.calls
        .map((call: CoachCall[]) => call[0])
        .find((call: CoachCall) => call.schemaName === 'plan_summary') as CoachCall;
      const user = summaryCall.messages[1].content;

      expect(summaryCall.messages[0].content).toContain('DÉJÀ ÉCRIT');
      expect(summaryCall.messages[0].content).toContain("Tu n'écris aucune allure");
      expect(user).toContain('Intention : préparer une course datée');
      expect(user).toContain('Course le dimanche 11 octobre 2026.');
      // La note de l'athlète est transmise **comme une note**, pas comme
      // l'objectif du plan : c'est l'intention qui dit ce qu'il prépare.
      expect(user).toContain("Note de l'athlète : « Marathon de Nantes »");
      expect(user).toContain('Plan écrit : 8 semaines');
      expect(user).toContain('Périodisation :');
      expect(user).toContain('Volume hebdomadaire :');
      expect(user).toContain('Séances de qualité :');
      // Aucune séance : le résumé décrit une forme, il ne recopie pas un plan.
      expect(user).not.toContain('Jour J : la course');
      // Le plafond a monté de 600 à 800 caractères avec la ligne d'intention,
      // qui vient d'une table figée (`INTENT_SUMMARY_CONTEXT`) : ce que ce
      // plafond interdit reste ce qui grandirait avec le plan — les séances.
      expect(user.length).toBeLessThan(800);
    });

    it('retombe sur un résumé écrit par l’appli quand le modèle échoue', async () => {
      chatCompletionJson.mockImplementation(async (call: CoachCall) => {
        if (call.schemaName === 'plan_summary') throw new AiResponseError('503', 503);
        return qualityOutputFor(slotBudgetKm(call));
      });

      await generatePlan(REQUEST);

      const { summary } = dal.createDraftPlanWithSessions.mock.calls[0][0];
      expect(summary).toContain('Plan de 2 semaines à partir du mardi 11 août 2026');
      expect(summary).toContain('3 séances par semaine');
      expect(summary).toContain('sortie longue le dimanche');
      // Le repli est journalisé : sans trace, un coach en panne depuis des
      // semaines est indiscernable d'un coach qui écrit bien.
      expect(loggedText()).toContain("[plan] résumé écrit par l'appli");
    });

    it('n’échoue pas le plan entier pour un paragraphe', async () => {
      chatCompletionJson.mockImplementation(async (call: CoachCall) => {
        if (call.schemaName === 'plan_summary') throw new AiUnavailableError('unreachable');
        return qualityOutputFor(slotBudgetKm(call));
      });

      await expect(generatePlan(REQUEST)).resolves.toBe(DRAFT);
      expect(writtenSessions().length).toBeGreaterThan(0);
    });
  });

  it('tient le budget temps de la requête dans le plan qu’elle écrit', async () => {
    // Une création ne demande plus rien au modèle en matière de volume : ses
    // cibles sont calculées sous le budget déclaré (`weeklyVolumeTargets`) et le
    // squelette les répartit sans les défaire. Le budget n'est donc plus une
    // règle qu'on vérifie après coup, c'est une entrée du calcul — et ce test
    // constate le résultat **semaine par semaine**, de bout en bout. C'est la
    // seule assertion du fichier qui le fasse sur le chemin de création.
    coachAnswers();

    // Départ un lundi : deux semaines pleines, aucun prorata à démêler.
    await generatePlan({ ...REQUEST, ...MONDAY, weeklyTimeMinutes: 120 });

    const byWeek = secondsByWeek(writtenSessions());
    expect([...byWeek.keys()]).toEqual(['2026-08-17', '2026-08-24']);
    for (const [week, seconds] of byWeek) {
      // 2 h déclarées, tolérance de 20 % comprise (cf. `VOLUME_RULES`).
      expect(seconds, week).toBeLessThanOrEqual(120 * 60 * 1.2);
    }
    expect(dal.createDraftPlanWithSessions).toHaveBeenCalledTimes(1);
  });
});

describe('generatePlan — chrono de référence', () => {
  it('écrit le chrono avec le plan', async () => {
    coachAnswers();

    await generatePlan({ ...REQUEST, referenceRace: REFERENCE_RACE });

    // Le chrono part en base avec le plan : c'est lui qui rejugera les allures
    // au prochain ajustement, et que l'écran du plan affiche.
    const input = dal.createDraftPlanWithSessions.mock.calls[0][0];
    expect(input.referenceDistance).toBe('10k');
    expect(input.referenceTimeS).toBe(2_910);
  });

  it('laisse les deux colonnes nulles quand aucun chrono n’est donné', async () => {
    coachAnswers();

    await generatePlan(REQUEST);

    const input = dal.createDraftPlanWithSessions.mock.calls[0][0];
    expect(input.referenceDistance).toBeNull();
    expect(input.referenceTimeS).toBeNull();
  });

  it('refuse un chrono implausible avant d’appeler le modèle', async () => {
    // 5 km en 12 min : plus rapide que le record du monde. La table d'allures
    // calculée dessus serait aberrante — mieux vaut le dire tout de suite.
    await expect(
      generatePlan({ ...REQUEST, referenceRace: { distance: '5k', timeS: 720 } }),
    ).rejects.toThrow(/ne ressemble pas à une course/);

    expect(chatCompletionJson).not.toHaveBeenCalled();
    expect(dal.createDraftPlanWithSessions).not.toHaveBeenCalled();
  });

  /**
   * Le renversement, mené à son terme : le modèle n'écrit plus aucune allure —
   * son schéma ne lui en offre même plus le champ —, et c'est l'appli qui les
   * pose depuis la table VDOT.
   */
  it('pose les allures depuis la table, séance par séance selon son `kind`', async () => {
    coachAnswers();

    await generatePlan({ ...REQUEST, referenceRace: REFERENCE_RACE });

    const sessions = writtenSessions();
    // Milieu de [E] (5:56–6:32/km) pour tout ce qui est endurance.
    for (const session of sessions.filter((s) => s.kind.includes('ndurance'))) {
      expect(session.targetPaceSecPerKm).toBe(374);
    }
    for (const session of sessions.filter((s) => s.kind === 'Sortie longue')) {
      expect(session.targetPaceSecPerKm).toBe(374);
    }
  });

  it('écrit les allures des étapes selon leur rôle, la séance donnant le créneau', async () => {
    coachAnswers();

    await generatePlan({ ...REQUEST, referenceRace: REFERENCE_RACE });

    // Une séance de **qualité**, et pas simplement la première à porter un
    // déroulé : l'instantané de ce fichier déclare une FC max, donc les séances
    // faciles se prescrivent en fréquence cardiaque et portent désormais toutes
    // un déroulé (cf. `applyImposedPaces`). Ce sont les allures de la qualité
    // qui sont en jeu ici.
    const EASY_KINDS = ['Endurance fondamentale', 'Récupération', 'Sortie longue'];
    const quality = writtenSessions().find(
      (session) => session.steps !== null && !EASY_KINDS.includes(session.kind),
    );
    const [warmup, block, cooldown] = quality?.steps ?? [];

    // L'échauffement se court en endurance, pas à l'allure de la séance.
    expect(warmup.steps[0]).toMatchObject({ paceMinSecPerKm: 356, paceMaxSecPerKm: 392 });
    // L'effort : les bornes du créneau de la séance.
    expect(block.steps[0].paceMinSecPerKm).not.toBeNull();
    // Sa récupération : aucune cible.
    expect(block.steps[1]).toMatchObject({ paceMinSecPerKm: null, paceMaxSecPerKm: null });
    // Le retour au calme se court en endurance, pas à l'allure de l'effort.
    expect(cooldown.steps[0]).toMatchObject({ paceMinSecPerKm: 356, paceMaxSecPerKm: 392 });
  });

  it('ne cible aucune allure quand il n’y a pas de table', async () => {
    coachAnswers();

    await generatePlan(REQUEST);

    // Sans chrono, `applyDerivedMeasures` ne complète que la comptabilité : le
    // squelette n'écrit aucune allure, donc aucune n'est prescrite.
    for (const session of writtenSessions()) {
      expect(session.targetPaceSecPerKm).toBeNull();
      expect(session.volumeM).not.toBeNull();
      expect(session.durationS).not.toBeNull();
    }
  });
});

/*
 * ------------------------------------------------------------------------
 * Ajustement du plan actif.
 * ------------------------------------------------------------------------
 *
 * Depuis la bascule, un ajustement n'appelle plus le modèle que trois fois par
 * nature : une pour **lire l'instruction** (`plan_instruction`), une par créneau
 * de qualité (`quality_session`), une pour le **résumé** (`plan_summary`). Tout
 * le calendrier est écrit par l'appli.
 */

/**
 * Le plan actif de référence : seize semaines commencées le lundi 1er juin,
 * course le dimanche 20 septembre. Aujourd'hui est le mardi 11 août, la reprise
 * part donc de demain — **six semaines restantes**, la première déjà entamée.
 *
 * Ce n'est pas une fixture décorative : c'est un plan qui a déjà consommé ses
 * blocs de base et de développement, et c'est ce qui rend la conservation de la
 * périodisation observable.
 */
const ACTIVE_PLAN: PlanDto = {
  ...PLAN,
  startsOn: '2026-06-01',
  weeks: 16,
  raceDate: '2026-09-20',
};

const ACTIVE = {
  plan: ACTIVE_PLAN,
  sessions: [
    // Déjà courue, et dans le passé : elle ne doit ni partir au modèle ni être
    // réécrite.
    planSession({ scheduledOn: '2026-08-10', id: 1, completedActivityId: 42 }),
    planSession({ scheduledOn: '2026-08-16', id: 2 }),
    planSession({ scheduledOn: '2026-09-06', id: 3 }),
  ],
};

/** Ce que le coach répond sur le chemin d'un ajustement — et rien d'autre. */
function coachAdjusts(settings?: Record<string, unknown>): void {
  chatCompletionJson.mockImplementation(async (call: CoachCall) => {
    if (call.schemaName === 'plan_instruction') return settings === undefined ? {} : { settings };
    if (call.schemaName === 'plan_summary') return { summary: COACH_SUMMARY };
    if (call.schemaName === 'quality_session') return qualityOutputFor(slotBudgetKm(call));
    throw new Error(`schéma inattendu sur le chemin d'ajustement : ${call.schemaName}`);
  });
}

/** Les séances écrites en base par le dernier ajustement. */
function updatedSessions(): WrittenSession[] {
  return dal.applyPlanUpdate.mock.calls[0][1].sessions as WrittenSession[];
}

/** Ce que l'ajustement a fait enregistrer comme réglages. */
function updatedSettings(): Record<string, unknown> {
  return dal.applyPlanUpdate.mock.calls[0][1].settings as Record<string, unknown>;
}

/** Le contenu du message utilisateur du n-ième appel au coach. */
function userMessage(index: number): string {
  return chatCompletionJson.mock.calls[index][0].messages[1].content as string;
}

/** Le message utilisateur de l'appel portant ce schéma — `null` s'il n'y en a pas. */
function userMessageOf(schemaName: string): string | null {
  const call = (chatCompletionJson.mock.calls as [CoachCall][]).find(
    ([options]) => options.schemaName === schemaName,
  );
  return call === undefined ? null : call[0].messages[1].content;
}

describe('updatePlanFromInstruction', () => {
  beforeEach(() => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
  });

  it('recalcule les semaines restantes et les écrit avec le résumé du coach', async () => {
    coachAdjusts();

    const plan = await updatePlanFromInstruction('je me sens un peu fatiguée');

    expect(plan).toBe(ACTIVE_PLAN);
    // Séances et réglages partent en un seul appel : le DAL les écrit dans la
    // même transaction.
    expect(dal.applyPlanUpdate).toHaveBeenCalledTimes(1);
    const [planId, update] = dal.applyPlanUpdate.mock.calls[0];
    expect(planId).toBe(ACTIVE_PLAN.id);
    expect(update.fromDate).toBe('2026-08-12');
    expect(update.settings).toEqual({ summary: COACH_SUMMARY });
    // Six semaines couvertes, jusqu'au jour de la course incluse.
    expect(updatedSessions().length).toBeGreaterThan(0);
  });

  it('ne réécrit aucune journée déjà écoulée', async () => {
    coachAdjusts();

    await updatePlanFromInstruction('rien de spécial');

    // La reprise est demain : la semaine en cours n'est replanifiée qu'à partir
    // de là, et le DAL protège de toute façon les séances réalisées.
    for (const session of updatedSessions()) {
      expect(session.scheduledOn >= '2026-08-12').toBe(true);
    }
    expect(updatedSessions()[0].scheduledOn.startsWith('2026-08-1')).toBe(true);
  });

  it('conserve la position dans la périodisation : pas de retour en phase de base', async () => {
    // Le défaut que ce test ferme : recalculer les phases sur la seule fenêtre
    // restante rendrait « quelques semaines de base » à une athlète qui est dans
    // son bloc spécifique — et la périodisation redémarrerait à chaque
    // ajustement.
    coachAdjusts();

    await updatePlanFromInstruction('rien de spécial');

    const summaryPrompt = userMessageOf('plan_summary');
    expect(summaryPrompt).toContain(
      'Périodisation : 1 × reprise, 3 × spécificité, 1 × affûtage, 1 × semaine de course.',
    );
    expect(summaryPrompt).not.toContain('base');
  });

  it('écrit la course le jour J, et rien après elle', async () => {
    coachAdjusts();

    await updatePlanFromInstruction('rien de spécial');

    const last = updatedSessions()[updatedSessions().length - 1];
    expect(last).toMatchObject({ scheduledOn: '2026-09-20', kind: 'Course' });
  });

  it('applique les réglages durables que le modèle lit dans l’instruction', async () => {
    coachAdjusts({ sessionsPerWeek: 4 });

    await updatePlanFromInstruction('je peux passer à 4 séances par semaine');

    expect(updatedSettings()).toMatchObject({ sessionsPerWeek: 4 });
    // Et le calendrier suit : une semaine pleine porte bien quatre séances.
    const week = updatedSessions().filter(
      (session) => session.scheduledOn >= '2026-08-17' && session.scheduledOn <= '2026-08-23',
    );
    expect(week).toHaveLength(4);
  });

  it('ancre les volumes sur ce que l’athlète a réellement couru', async () => {
    // La décision de conception : la progression repart du réel, pas du volume
    // théorique du plan d'origine. Deux historiques, deux fenêtres de volumes.
    coachAdjusts();
    await updatePlanFromInstruction('rien de spécial');
    const strong = totalKm(updatedSessions());

    vi.resetAllMocks();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    requireAi.mockResolvedValue(undefined);
    dal.applyPlanUpdate.mockResolvedValue(undefined);
    dal.reconcilePlanSessions.mockResolvedValue(0);
    syncPlanToIntervalsSafely.mockResolvedValue(undefined);
    scheduleAfter.mockImplementation((task: () => unknown) => void task());
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    dal.getTrainingSnapshot.mockResolvedValue({
      ...SNAPSHOT,
      // Un mois nettement plus creux : trois semaines à 15 km.
      weeks: [{ startsOn: '2026-08-03', distanceKm: 15, movingTimeS: 5_400, sessions: 3 }],
    });
    coachAdjusts();
    await updatePlanFromInstruction('rien de spécial');
    const weak = totalKm(updatedSessions());

    // Le plan d'origine est le même dans les deux cas : seul le réalisé change.
    expect(weak).toBeLessThan(strong * 0.6);
  });

  it('rapproche les séances recalculées et republie le calendrier', async () => {
    coachAdjusts();

    await updatePlanFromInstruction('rien de spécial');

    expect(dal.reconcilePlanSessions).toHaveBeenCalledWith(ACTIVE_PLAN.id);
    expect(syncPlanToIntervalsSafely).toHaveBeenCalledWith(`plan ${ACTIVE_PLAN.id}`);
    // Différée : un ajustement rend la main dès que la base est écrite.
    expect(scheduleAfter).toHaveBeenCalledTimes(1);
  });

  it('ajuste quand même le plan si le rapprochement échoue', async () => {
    coachAdjusts();
    dal.reconcilePlanSessions.mockRejectedValue(new Error('deadlock detected'));

    await expect(updatePlanFromInstruction('rien de spécial')).resolves.toBe(ACTIVE_PLAN);
    expect(loggedText()).toContain('rapprochement des séances');
  });

  it('ne montre au modèle que le plan et sa consigne — aucune séance à réécrire', async () => {
    coachAdjusts();

    await updatePlanFromInstruction('plutôt 3 séances');

    const instruction = userMessage(0);
    expect(chatCompletionJson.mock.calls[0][0].schemaName).toBe('plan_instruction');
    expect(instruction).toContain(
      'Plan en cours : préparation de course — « 10 km sous 50 min »',
    );
    expect(instruction).toContain('Semaines restantes : 6.');
    expect(instruction).toContain("Consigne de l'athlète : « plutôt 3 séances »");
  });

  it("échoue proprement quand aucun plan n'est actif", async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(null);

    await expect(updatePlanFromInstruction('allège')).rejects.toThrow(PlanNotFoundError);
    expect(chatCompletionJson).not.toHaveBeenCalled();
  });

  it('propage une indisponibilité du coach', async () => {
    requireAi.mockRejectedValue(new AiUnavailableError('unconfigured'));

    await expect(updatePlanFromInstruction('allège')).rejects.toThrow(AiUnavailableError);
    expect(dal.getActivePlanWithSessions).not.toHaveBeenCalled();
  });
});

/**
 * Ce qu'un coach défaillant coûte à un ajustement : du sur-mesure, jamais le
 * plan.
 *
 * Trois régimes, et le même verdict dans les trois : un plan **valide** est
 * écrit. C'est tout l'objet de l'inversion — ce que le modèle ne produit pas, il
 * ne peut pas le produire de travers.
 */
describe('updatePlanFromInstruction — coach incohérent ou en panne', () => {
  beforeEach(() => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
  });

  it('écrit un plan entièrement déterministe quand le coach ne répond plus', async () => {
    chatCompletionJson.mockRejectedValue(new AiResponseError('Service Unavailable', 503));

    await expect(updatePlanFromInstruction('rien de spécial')).resolves.toBe(ACTIVE_PLAN);

    // Le calendrier est écrit, complet, et aucun titre ne vient du modèle.
    const sessions = updatedSessions();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.map((session) => session.title)).not.toContain('Séance écrite par le coach');
    // Réglages inchangés (l'instruction n'a pas pu être lue) et résumé de repli.
    const settings = updatedSettings();
    expect(Object.keys(settings)).toEqual(['summary']);
    expect(settings.summary).toContain('recalculées');
    expect(loggedText()).toContain('[plan] instruction non interprétée, réglages inchangés');
  });

  it('écrit un plan valide quand le coach rend n’importe quoi', async () => {
    // Sortie hors schéma sur tous les appels : chacun a son repli, et aucun ne
    // remonte.
    chatCompletionJson.mockRejectedValue(
      new AiInvalidOutputError('Sortie hors schéma.', [
        { code: 'custom', path: ['settings'], message: 'inattendu' } as AiOutputIssue,
      ]),
    );

    await expect(updatePlanFromInstruction('rien de spécial')).resolves.toBe(ACTIVE_PLAN);

    expect(dal.applyPlanUpdate).toHaveBeenCalledTimes(1);
    expect(updatedSessions().every((session) => session.volumeM !== null)).toBe(true);
  });

  it('garde le calendrier de l’appli même quand seul le résumé échoue', async () => {
    chatCompletionJson.mockImplementation(async (call: CoachCall) => {
      if (call.schemaName === 'plan_summary') throw new AiResponseError('boom', 500);
      if (call.schemaName === 'plan_instruction') return {};
      return qualityOutputFor(slotBudgetKm(call));
    });

    await updatePlanFromInstruction('rien de spécial');

    expect(updatedSettings().summary).toContain('Périodisation :');
    // Les créneaux, eux, viennent bien du coach.
    expect(updatedSessions().map((session) => session.title)).toContain(
      'Séance écrite par le coach',
    );
  });
});

/**
 * Aucun plan invalide ne sort de ce chemin non plus — ni par une fenêtre
 * infaisable, ni par une règle métier qui casserait malgré le squelette.
 */
describe('updatePlanFromInstruction — refus et dégradation', () => {
  it('traduit une fenêtre infaisable en erreur de formulaire actionnable', async () => {
    // Six séances par semaine sur un volume réel de 3 km : le squelette refuse
    // d'écrire des séances de moins de 500 m plutôt que de les approximer.
    dal.getActivePlanWithSessions.mockResolvedValue({
      ...ACTIVE,
      plan: { ...ACTIVE_PLAN, sessionsPerWeek: 6, weeklyTimeMinutes: null },
    });
    dal.getTrainingSnapshot.mockResolvedValue({
      ...SNAPSHOT,
      weeks: [{ startsOn: '2026-08-03', distanceKm: 1, movingTimeS: 400, sessions: 1 }],
    });
    coachAdjusts();

    const failure = await updatePlanFromInstruction('rien de spécial').catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InvalidPlanError);
    const error = failure as InstanceType<typeof InvalidPlanError>;
    expect(error.field).toBe('sessionsPerWeek');
    expect(error.message).toContain('6 séances par semaine ne tiennent pas');
    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    // Le diagnostic chiffré, que le formulaire ne peut pas montrer.
    expect(loggedText()).toContain('[plan] squelette infaisable : Semaine');
  });

  it('refuse de replanifier un plan dont la course a déjà eu lieu', async () => {
    // Course le mercredi, semaine pas finie : il ne reste aucun jour
    // d'entraînement à poser, et la cause n'a rien à voir avec le volume.
    dal.getActivePlanWithSessions.mockResolvedValue({
      plan: { ...ACTIVE_PLAN, startsOn: '2026-08-10', weeks: 1, raceDate: '2026-08-12' },
      sessions: [],
    });
    vi.setSystemTime(new Date('2026-08-13T09:00:00.000Z'));
    coachAdjusts();

    await expect(updatePlanFromInstruction('et maintenant ?')).rejects.toThrow(InvalidPlanError);
    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
  });

  it('réécrit tous les créneaux par l’appli avant d’abandonner', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    coachAdjusts();
    businessRuleViolations.mockReturnValueOnce(['Semaine 1 : quelque chose ne va pas.']);

    await expect(updatePlanFromInstruction('rien de spécial')).resolves.toBe(ACTIVE_PLAN);

    expect(updatedSessions().map((session) => session.title)).not.toContain(
      'Séance écrite par le coach',
    );
    expect(loggedText()).toContain('réécriture de tous les créneaux');
  });

  it('lève plutôt que d’écrire un plan invalide, et dit de quoi le rejouer', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    coachAdjusts();
    businessRuleViolations.mockReturnValue(['Semaine 1 : quelque chose ne va pas.']);

    await expect(updatePlanFromInstruction('rien de spécial')).rejects.toThrow(
      InvalidGeneratedPlanError,
    );

    expect(dal.applyPlanUpdate).not.toHaveBeenCalled();
    const logged = loggedText();
    expect(logged).toContain('plan tout-déterministe encore hors règles');
    // La configuration exacte de la fenêtre, pour rejouer le cas.
    expect(logged).toContain('6/16 semaines restantes à partir du 2026-08-10 (jour 3)');
  });
});

/**
 * Le budget temps est désormais une **entrée du calcul**, plus une règle vérifiée
 * après coup : les cibles de la fenêtre sont chiffrées sous lui
 * (`weeklyVolumeTargets`), et le squelette les répartit sans les défaire.
 */
describe('updatePlanFromInstruction — budget temps hebdomadaire', () => {
  beforeEach(() => {
    dal.getActivePlanWithSessions.mockResolvedValue({
      ...ACTIVE,
      plan: { ...ACTIVE_PLAN, weeklyTimeMinutes: 120 },
    });
  });

  it('tient le budget du plan dans les semaines qu’il recalcule', async () => {
    coachAdjusts();

    await updatePlanFromInstruction('rien de spécial');

    for (const [week, seconds] of secondsByWeek(updatedSessions())) {
      // 2 h déclarées, tolérance de 20 % comprise (cf. `VOLUME_RULES`).
      expect(seconds, week).toBeLessThanOrEqual(120 * 60 * 1.2);
    }
  });

  it('recalcule sous le budget élargi que l’instruction déclare', async () => {
    coachAdjusts({ weeklyTimeMinutes: 300 });

    await updatePlanFromInstruction('je peux courir 5 h par semaine maintenant');

    expect(updatedSettings()).toMatchObject({ weeklyTimeMinutes: 300 });
    const weekly = [...secondsByWeek(updatedSessions()).values()];
    // Le budget élargi se voit : au moins une semaine dépasse les 2 h d'avant.
    expect(Math.max(...weekly)).toBeGreaterThan(120 * 60);
  });

  it('lève toute contrainte quand l’instruction efface le budget', async () => {
    coachAdjusts({ weeklyTimeMinutes: null });

    await updatePlanFromInstruction("je n'ai plus de contrainte de temps");

    // Le budget effacé part en base : la fenêtre est calculée sur la contrainte
    // qu'elle fait enregistrer, jamais sur une autre.
    expect(updatedSettings()).toMatchObject({ weeklyTimeMinutes: null });
  });
});

/**
 * L'ancrage d'une **continuation**, et les trois trajectoires qui l'ont décidé.
 *
 * Ces tests éprouvent le chemin complet ({@link rewriteRemainingPlan} : cibles,
 * squelette, remplissage, validation), pas la seule arithmétique — c'est la
 * composition qui était fausse, pas une formule. Le raisonnement et les chiffres
 * mesurés sont en tête de `remainingVolumeTargets`.
 *
 * Le plan de ces tests n'a **ni course ni budget temps**, et c'est délibéré : un
 * affûtage ferait redescendre les volumes de la fin de fenêtre, et un budget les
 * plafonnerait — dans les deux cas, ce qu'on veut mesurer (d'où repart la
 * progression) serait masqué par autre chose.
 */
describe('rewriteRemainingPlan — l’ancrage d’une continuation', () => {
  /** Un bloc libre de douze semaines, sans plafond de temps : rien ne masque l'ancrage. */
  const OPEN_PLAN: PlanDto = {
    ...ACTIVE_PLAN,
    goalType: 'free',
    intent: 'faster',
    goalText: 'reprendre le volume',
    raceDate: null,
    weeks: 12,
    sessionsPerWeek: 5,
    weeklyTimeMinutes: null,
    level: 'intermediate',
  };

  /** Une date civile décalée de `days` jours — l'arithmétique des fixtures, sans dépendance. */
  function shiftDays(date: string, days: number): string {
    const day = new Date(`${date}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + days);
    return day.toISOString().slice(0, 10);
  }

  /**
   * Un snapshot dont les semaines valent `weeklyKm`, de la plus ancienne à celle
   * de `today` — l'ordre et le rôle exacts de `buildRecentWeeks`, la **dernière**
   * entrée étant la semaine en cours, celle qui est encore partielle.
   *
   * `today` est toujours un lundi ou un dimanche ici, et le lundi de sa semaine
   * se calcule donc sans ambiguïté.
   */
  function snapshotOf(today: string, weeklyKm: readonly number[]): TrainingSnapshotDto {
    const isoDay = (new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7;
    const currentWeekStart = shiftDays(today, -isoDay);

    return {
      ...SNAPSHOT,
      today,
      weeks: weeklyKm.map((distanceKm, index) => ({
        startsOn: shiftDays(currentWeekStart, (index - (weeklyKm.length - 1)) * 7),
        distanceKm,
        // Cohérent avec l'allure du snapshot (5:24/km), pour que rien ne détonne.
        movingTimeS: Math.round(distanceKm * 324),
        sessions: distanceKm > 0 ? 4 : 0,
      })),
    };
  }

  /**
   * Les cibles d'une fenêtre restante de douze semaines qui s'ouvre le `monday`.
   *
   * Fenêtre pleine (`firstWeekFromDay` à 1) → la révision s'est déclenchée le
   * **dimanche** d'avant, et la semaine en cours du snapshot est celle qui
   * précède la fenêtre. Fenêtre entamée → déclenchement le **lundi** même, la
   * reprise est au mardi, et la semaine en cours est la première de la fenêtre.
   */
  async function rewriteFrom(
    monday: string,
    weeklyKm: readonly number[],
    firstWeekFromDay = 1,
  ): Promise<number[]> {
    const today = firstWeekFromDay === 1 ? shiftDays(monday, -1) : monday;
    const rewrite = await rewriteRemainingPlan({
      plan: { ...OPEN_PLAN, startsOn: monday },
      window: { firstWeekStart: monday, weeks: 12, firstWeekFromDay },
      snapshot: snapshotOf(today, weeklyKm),
      plannedWeeklyKm: new Map(),
    });

    return rewrite.targets.map((target) => target.targetKm);
  }

  beforeEach(() => {
    // Seuls les créneaux de qualité passent par le modèle sur ce chemin.
    chatCompletionJson.mockImplementation(async (call: CoachCall) => {
      if (call.schemaName === 'quality_session') return qualityOutputFor(slotBudgetKm(call));
      throw new Error(`schéma inattendu sur le chemin de reconstruction : ${call.schemaName}`);
    });
  });

  /**
   * Le cliquet : c'est l'athlète **assidue** qui finançait la marche suivante.
   *
   * Chaque réadaptation repartait de `firstFullWeekMaxKm(meilleure semaine
   * récente)`, soit +20 %. Or ce qu'on prescrit devient ce qu'elle court, donc sa
   * meilleure semaine, donc le plafond du passage suivant. Mesuré avant
   * correction, une réadaptation par semaine, l'athlète courant exactement son
   * plan : 42 → 50,3 → 60,3 → 72,3 → 86,7 → 104,0 → 124,7 → 149,6 → 179,5 →
   * 215,3 km, soit **×5,13 en neuf réadaptations** — quand `maxWeeklyGrowth`
   * plafonne une hausse hebdomadaire à 12 %.
   *
   * La validation ne pouvait rien y voir : elle ne compare que des semaines *à
   * l'intérieur* d'une fenêtre, et chaque réadaptation en ouvre une neuve. Ce
   * test-ci compare donc **d'une fenêtre à l'autre**, ce que rien d'autre ne
   * fait.
   *
   * Le plan y repart avec la fenêtre (`startsOn` suit le lundi de chaque
   * passage), et c'est délibéré : la fenêtre rouvre toujours la même semaine de
   * plan, donc la cadence des semaines allégées reste neutre et seul l'ancrage
   * bouge. La cadence, elle, se mesure plus bas, sur un plan qui avance.
   */
  it('ne rejoue pas la marche de démarrage à chaque réadaptation', async () => {
    const START_KM = 42;
    let monday = '2026-06-01';
    // La semaine en cours est finie (déclenchement le dimanche) : elle porte bien
    // ce que le plan précédent lui avait prescrit.
    let history = [0, 0, 0, START_KM];
    const trajectory = [START_KM];

    for (let round = 0; round < 9; round += 1) {
      const [firstFullWeekKm] = await rewriteFrom(monday, history);
      trajectory.push(firstFullWeekKm);
      history = [...history.slice(1), firstFullWeekKm];
      monday = shiftDays(monday, 7);
    }

    // Aucune marche au-dessus de ce que la règle de progression autorise, d'une
    // reconstruction à la suivante — le raccord que la validation ne voit pas.
    for (let index = 1; index < trajectory.length; index += 1) {
      const growth = trajectory[index] / trajectory[index - 1];
      expect(growth, `semaine ${index}`).toBeLessThanOrEqual(VOLUME_RULES.maxWeeklyGrowth);
      // Et une vraie progression quand même : la fenêtre ne fait pas du surplace.
      expect(growth, `semaine ${index}`).toBeGreaterThan(1);
    }

    // La trajectoire mesurée après correction, au dixième :
    expect(trajectory).toEqual([42, 45.3, 48.9, 52.8, 57, 61.5, 66.4, 71.7, 77.4, 83.5]);
  });

  /*
   * Les quatre dernières semaines réelles, et la première semaine **pleine** que
   * la reconstruction en tire. La dernière valeur est la semaine en cours, encore
   * partielle : elle ne peut que relever l'ancrage, jamais l'abaisser.
   *
   * Deux corrections successives se lisent dans ces chiffres.
   *
   * **Il y a deux rondes** : les quatre premières lignes rendaient toutes le même
   * chiffre — 62,3 km, soit 1,2 × la meilleure des quatre semaines — parce qu'un
   * maximum sur quatre semaines rend un arrêt invisible. C'est pourtant
   * exactement la situation qui déclenche une révision `adjust`.
   *
   * **Cette ronde-ci**, et les deux mouvements sont indépendants :
   *
   * - le **régime nominal monte** (64,7 → 69,9 km) : la reprise est au mardi,
   *   donc la première semaine pleine est **deux** semaines calendaires après la
   *   dernière semaine complète, et elle reçoit donc deux marches de progression
   *   au lieu d'une. C'est la propriété 1, et son absence faisait décroître le
   *   plan d'une athlète assidue réadaptée en milieu de semaine (×0,66 sur 16
   *   semaines) ;
   * - les **reprises descendent** (45,3 → 41,9 ; 14 → 12,9) : le pont d'une
   *   semaine sautée et le plancher démontré sont des **niveaux de reprise**, pas
   *   des volumes à faire progresser. Leur appliquer la marche de la semaine —
   *   pire, la baisse d'une semaine allégée — revenait à prescrire une reprise
   *   qui n'en est pas une (propriété 3).
   */
  const RESUMPTIONS = [
    { label: 'deux semaines d’arrêt', weeks: [52, 50, 0, 0], firstFullWeekKm: 34.9 },
    { label: 'trois semaines d’arrêt', weeks: [52, 0, 0, 0], firstFullWeekKm: 12.9 },
    { label: 'reprise de blessure', weeks: [52, 10, 6, 4], firstFullWeekKm: 12.9 },
    { label: 'décrue installée', weeks: [30, 22, 14, 6], firstFullWeekKm: 16.3 },
    { label: 'une semaine de vacances', weeks: [60, 60, 0, 0], firstFullWeekKm: 41.9 },
    { label: 'régime nominal, lundi', weeks: [60, 60, 60, 0], firstFullWeekKm: 69.9 },
  ] as const;

  it.each(RESUMPTIONS)('suit le réel après $label', async ({ weeks, firstFullWeekKm }) => {
    // Reprise au mardi : l'index 0 est la semaine entamée, l'index 1 la première
    // semaine pleine — celle que l'ancrage décide.
    const targets = await rewriteFrom('2026-06-01', weeks, 2);

    expect(targets[1]).toBe(firstFullWeekKm);
  });

  it('ne ramène pas à rien une athlète qu’un arrêt long a fait disparaître', async () => {
    // Trois semaines sans courir après 52 km : la reconstruction repart bas, mais
    // elle repart — le plancher démontré garde un quart de ce que l'athlète a
    // montré (13 km, arrondi au dixième inférieur), largement au-dessus des 3 km
    // qu'une semaine de 5 séances doit financer.
    const rewrite = await rewriteRemainingPlan({
      plan: { ...OPEN_PLAN, startsOn: '2026-06-01' },
      window: { firstWeekStart: '2026-06-01', weeks: 12, firstWeekFromDay: 2 },
      snapshot: snapshotOf('2026-06-01', [52, 0, 0, 0]),
      plannedWeeklyKm: new Map(),
    });

    expect(rewrite.weeks).toHaveLength(12);
    expect(rewrite.targets[1].targetKm).toBe(12.9);
    // Chaque semaine porte bien ses séances : rien n'est tombé en route.
    expect(rewrite.weeks[1].sessions).toHaveLength(OPEN_PLAN.sessionsPerWeek);
  });

  it('ne pose pas de jour J sur une fenêtre où la course ne tombe pas', async () => {
    // Le jour J **ferme** la dernière semaine de la fenêtre et y déplace le plus
    // gros effort. Le lire sans vérifier que la date y tombe ferait amputer une
    // semaine ordinaire de ses derniers jours. La fenêtre restante se termine
    // toujours avec le plan, donc le cas n'est pas atteignable par l'appli — mais
    // c'est exactement lui qui rendait une fixture de test fausse sans que rien
    // ne le dise.
    const rewrite = await rewriteRemainingPlan({
      // Course le 20 septembre ; la fenêtre, elle, s'arrête douze semaines après
      // le 1er juin, soit le 23 août.
      plan: {
        ...OPEN_PLAN,
        goalType: 'race',
        intent: 'race',
        raceDate: '2026-09-20',
        startsOn: '2026-06-01',
      },
      window: { firstWeekStart: '2026-06-01', weeks: 12, firstWeekFromDay: 1 },
      snapshot: snapshotOf('2026-05-31', [42, 42, 42, 42]),
      plannedWeeklyKm: new Map(),
    });

    expect(loggedText()).toContain('hors de la dernière semaine de la fenêtre reconstruite');
    // La dernière semaine reste une semaine comme les autres : ses sept jours
    // sont utilisables, donc elle porte bien son compte de séances.
    expect(rewrite.weeks[11].sessions).toHaveLength(OPEN_PLAN.sessionsPerWeek);
  });

  it('repart du départ prudent du niveau quand rien n’ancre la reprise', async () => {
    // Quatre semaines à zéro ne disent pas « démarre à zéro », elles disent qu'il
    // n'y a rien à quoi s'ancrer — et surtout pas les +20 % d'un démarrage, qui
    // n'ont rien à quoi s'appliquer non plus.
    const targets = await rewriteFrom('2026-06-01', [0, 0, 0, 0], 2);

    expect(targets[1]).toBe(23.9);
  });

  /**
   * La **prescription en fréquence cardiaque sur le chemin de reconstruction**.
   *
   * Le risque que ces cas ferment est précis : la FC max voyage dans le contexte
   * de validation, que **deux** fonctions construisent — la création
   * (`writeGeneratedPlan`) et cette reconstruction. En oublier une donnerait un
   * plan dont les séances changent d'unité de cible à chaque révision, sans que
   * rien ne le signale. Les deux lisent le même champ du même instantané : à FC
   * max égale, même prescription.
   */
  describe('l’endurance prescrite en fréquence cardiaque', () => {
    /**
     * Le même plan libre, mais avec un chrono de référence : sans table
     * d'allures, l'appli ne prescrit rien du tout — ni allure, ni zone.
     */
    const PACED_PLAN: PlanDto = {
      ...OPEN_PLAN,
      referenceDistance: REFERENCE_RACE.distance,
      referenceTimeS: REFERENCE_RACE.timeS,
    };

    async function rewriteWith(maxHrBpm: number | undefined) {
      const base = snapshotOf('2026-05-31', [42, 42, 42, 42]);
      const profile = { ...base.profile };
      if (maxHrBpm === undefined) delete profile.maxHrBpm;
      else profile.maxHrBpm = maxHrBpm;

      const rewrite = await rewriteRemainingPlan({
        plan: { ...PACED_PLAN, startsOn: '2026-06-01' },
        window: { firstWeekStart: '2026-06-01', weeks: 12, firstWeekFromDay: 1 },
        snapshot: { ...base, profile },
        plannedWeeklyKm: new Map(),
      });

      return rewrite.weeks[1].sessions.filter((s) => s.kind === 'Endurance fondamentale');
    }

    it('pose la zone 2 sur les footings reconstruits quand le profil porte une FC max', async () => {
      const easy = await rewriteWith(184);

      expect(easy.length).toBeGreaterThan(0);
      for (const s of easy) {
        const runs = (s.steps ?? []).flatMap((b) => b.steps).filter((x) => x.role === 'run');
        // Les lignes droites d'un footing enrichi (90 m, ~20 s) restent en
        // allure : la FC n'y monte pas, et la cible contredirait la consigne.
        // Seul le corps de la séance change d'unité.
        const body = runs.filter((x) => (x.distanceM ?? 0) > 200);
        expect(body.length).toBeGreaterThan(0);
        for (const run of body) {
          expect(run).toMatchObject({ hrZone: 2, paceMinSecPerKm: null });
        }
        for (const stride of runs.filter((x) => (x.distanceM ?? 0) <= 200)) {
          expect(stride.hrZone).toBeNull();
        }
      }
    });

    it('les prescrit en allure sans FC max — le repli, sur ce chemin aussi', async () => {
      const easy = await rewriteWith(undefined);

      expect(easy.length).toBeGreaterThan(0);
      for (const s of easy) {
        for (const run of (s.steps ?? []).flatMap((b) => b.steps)) {
          expect(run.hrZone).toBeNull();
        }
      }
    });

    it('ne fait bouger ni distance ni durée d’une séance selon la FC max', async () => {
      // Le garde-fou, mesuré sur le chemin complet : changer l'unité de la cible
      // ne convertit rien en kilomètres.
      const [withHr, without] = await Promise.all([rewriteWith(184), rewriteWith(undefined)]);

      expect(withHr.map((s) => [s.day, s.distanceKm, s.durationMin])).toEqual(
        without.map((s) => [s.day, s.distanceKm, s.durationMin]),
      );
    });
  });

  /**
   * La **cadence des semaines allégées**, d'une reconstruction à la suivante — le
   * même défaut de famille que le cliquet, mesuré de la même façon : en simulant
   * la vie d'un plan plutôt qu'une exécution.
   *
   * ## Ce que la fenêtre neuve effaçait
   *
   * `weeklyVolumeTargets` pose une semaine allégée au quatrième rang de la
   * **fenêtre qu'elle reçoit**. À la création, cette fenêtre est le plan entier :
   * l'athlète souffle toutes les quatre semaines. Sur une reconstruction, la
   * fenêtre est neuve et le rang repart de zéro — or la révision se déclenche
   * toutes les quatre séances réalisées, soit environ chaque semaine à cinq
   * séances. Chaque reconstruction replaçait donc l'athlète au premier rang d'une
   * fenêtre neuve : **elle n'atteignait jamais le quatrième, donc ne recevait plus
   * jamais de semaine allégée**. De la surcharge progressive sans récupération,
   * indéfiniment — exactement ce qu'une périodisation existe pour éviter.
   *
   * Comme le cliquet, c'était invisible à tout test d'une exécution unique :
   * chaque plan reconstruit satisfait la règle « pas quatre semaines de suite sans
   * allégée » *dans sa fenêtre*. C'est la **suite** de plans qui ne la satisfait
   * pas, et rien ne regardait la suite.
   *
   * ## Ce que ce test mesure
   *
   * Un plan de 24 semaines rouvert à chacune de ses douze premières semaines, et
   * à deux jours de reprise. Le plan est long à dessein : toutes les fenêtres
   * reconstruites y restent assez longues pour porter leur respiration (cf.
   * `VOLUME_RULES.minWeeksForCutback`), donc ce qu'on mesure est bien la cadence
   * et jamais le bord du plan.
   */
  describe('la cadence des semaines allégées', () => {
    /** Le plan vécu : 24 semaines, ni course ni budget — rien ne masque la cadence. */
    const CADENCE_PLAN: PlanDto = { ...OPEN_PLAN, weeks: 24, startsOn: '2026-06-01' };

    /** Douze semaines de vie : trois cycles de quatre, la mesure demandée. */
    const LIVED_WEEKS = 12;

    /*
     * La **trajectoire** de cette vie-là — sa forme, sa dérive, son
     * indépendance à la fréquence et au jour de réadaptation — se mesure
     * désormais un cran plus bas, sur `remainingVolumeTargets` directement (cf.
     * « la vie d'un plan » en fin de fichier) : 84 vies simulées sur 16 semaines,
     * là où passer par `rewriteRemainingPlan` en aurait fait un test de plusieurs
     * secondes pour une couverture bien plus étroite.
     *
     * Ce qui reste ici est ce que seul le chemin complet peut dire : que la
     * cadence tient **à travers le squelette et la validation**, d'où qu'on
     * rouvre le plan.
     */

    it('retrouve les semaines allégées du plan quelle que soit la semaine de reprise', async () => {
      // Un plan démarré un **mercredi** : sa première semaine est entamée, donc
      // sa cadence ne commence qu'à sa semaine 2 et ses respirations tombent aux
      // semaines 5, 9, 13, 17 et 21. Une reconstruction doit les retrouver aux
      // mêmes dates, d'où qu'elle rouvre le plan — c'est là que se jouent les deux
      // semaines entamées, celle du plan et celle de la fenêtre, et une seule
      // oubliée décalerait toute la cadence d'un cran.
      const plan: PlanDto = { ...CADENCE_PLAN, startsOn: '2026-06-03' };
      const PLAN_CUTBACKS = [5, 9, 13, 17, 21];

      for (let week = 0; week < LIVED_WEEKS; week += 1) {
        // La semaine de départ d'un plan démarré un mercredi est entamée par
        // construction : `remainingPlanWindow` ne la rend jamais pleine — avant le
        // départ, elle rend la fenêtre du plan entier, jour de départ compris.
        for (const firstWeekFromDay of week === 0 ? [4] : [1, 4]) {
          const monday = shiftDays('2026-06-01', week * 7);
          const { targets } = await rewriteRemainingPlan({
            plan,
            window: { firstWeekStart: monday, weeks: plan.weeks - week, firstWeekFromDay },
            snapshot: snapshotOf(
              firstWeekFromDay === 1 ? shiftDays(monday, -1) : monday,
              [40, 42, 44, 46],
            ),
            plannedWeeklyKm: new Map(),
          });

          const label = `reprise semaine ${week + 1}, jour ${firstWeekFromDay}`;
          const lived = targets.flatMap((target, index) =>
            target.kind === 'cutback' ? [week + index + 1] : [],
          );
          // Une respiration qui tomberait sur la semaine **entamée** de la fenêtre
          // n'en est plus une : cette semaine-là est déjà à moitié courue et son
          // volume est proratisé (plus bas, de toute façon, qu'une allégée). La
          // cadence reprend à la première semaine pleine.
          const firstFullWeek = week + 1 + (firstWeekFromDay > 1 ? 1 : 0);
          expect(lived, label).toEqual(PLAN_CUTBACKS.filter((cutback) => cutback >= firstFullWeek));
        }
      }
    });
  });
});

describe('progression de la génération', () => {
  const PROGRESS_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

  /** Ce que \`chatCompletionJson\` reçoit, réduit à ce que ces tests consomment. */
  type JsonCall = CoachCall & { onProgress?: (receivedChars: number) => void };

  /**
   * Un plan assez gros pour que la barre ait des paliers : quatre semaines
   * pleines à cinq séances, soit sept créneaux de qualité.
   */
  const SEVEN_SLOTS: PlanRequest = { ...REQUEST, ...MONDAY, weeks: 4, sessionsPerWeek: 5 };

  it('avance créneau par créneau jusqu’à 100 %, puis efface son entrée', async () => {
    const seen: (PlanProgress | null)[] = [];
    chatCompletionJson.mockImplementation(async (call: JsonCall) => {
      if (call.schemaName === 'plan_summary') {
        // Le résumé part **après** le dernier créneau : la barre y est pleine.
        seen.push(getPlanProgress(PROGRESS_ID));
        return { summary: COACH_SUMMARY };
      }
      return qualityOutputFor(slotBudgetKm(call));
    });

    await generatePlan(SEVEN_SLOTS, PROGRESS_ID);

    // Sept créneaux : 1/7, 2/7, … arrondis, et 100 % au dernier.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ percent: 100, attempt: 1, maxAttempts: 1 });
    // Effacée en \`finally\` : plus rien à lire une fois le plan écrit.
    expect(getPlanProgress(PROGRESS_ID)).toBeNull();
  });

  it('mesure des créneaux écrits, pas des caractères devinés', async () => {
    const percents: number[] = [];
    chatCompletionJson.mockImplementation(async (call: JsonCall) => {
      if (call.schemaName === 'plan_summary') return { summary: COACH_SUMMARY };
      // Relevé **avant** de répondre : c'est l'avancement des créneaux déjà
      // écrits, celui-ci n'en étant pas encore un.
      percents.push(getPlanProgress(PROGRESS_ID)?.percent ?? -1);
      return qualityOutputFor(slotBudgetKm(call));
    });

    await generatePlan(SEVEN_SLOTS, PROGRESS_ID);

    // La barre est posée à zéro avant le premier appel — la modale ne reste
    // jamais muette —, puis chaque créneau la fait monter d'un cran, sans jamais
    // reculer.
    expect(percents).toEqual([0, 14, 29, 43, 57, 71, 86]);
    // Et rien n'est jamais demandé deux fois : le plan ne se rejoue plus.
    expect(percents).toHaveLength(new Set(percents).size);
  });

  it('n’affiche aucun compteur de tentative : ce chemin n’en rejoue aucune', async () => {
    let during: PlanProgress | null = null;
    chatCompletionJson.mockImplementation(async (call: JsonCall) => {
      if (call.schemaName === 'plan_summary') return { summary: COACH_SUMMARY };
      during = getPlanProgress(PROGRESS_ID) ?? during;
      return qualityOutputFor(slotBudgetKm(call));
    });

    await generatePlan(SEVEN_SLOTS, PROGRESS_ID);

    // \`maxAttempts\` à 1 : le formulaire tait alors le rang (cf.
    // \`GenerationProgressBar\`), qui ne décrirait rien.
    expect(during).toMatchObject({ attempt: 1, maxAttempts: 1 });
  });

  it("efface l'entrée même quand la génération échoue", async () => {
    coachAnswers();
    // Le seul échec possible après remplissage : un plan que l'appli refuse.
    businessRuleViolations.mockReturnValue(['Semaine 1 : quelque chose ne va pas.']);

    await expect(generatePlan(SEVEN_SLOTS, PROGRESS_ID)).rejects.toThrow(
      InvalidGeneratedPlanError,
    );

    expect(getPlanProgress(PROGRESS_ID)).toBeNull();
  });

  it('suit aussi un ajustement, créneau par créneau', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    const percents: number[] = [];
    chatCompletionJson.mockImplementation(async (call: JsonCall) => {
      if (call.schemaName === 'plan_instruction') return {};
      if (call.schemaName === 'plan_summary') return { summary: COACH_SUMMARY };
      // Relevé **avant** de répondre : c'est l'avancement des créneaux déjà
      // écrits, celui-ci n'en étant pas encore un.
      percents.push(getPlanProgress(PROGRESS_ID)?.percent ?? -1);
      return qualityOutputFor(slotBudgetKm(call));
    });

    await updatePlanFromInstruction('allège la semaine prochaine', PROGRESS_ID);

    // Quatre créneaux sur la fenêtre restante : la barre est posée à zéro avant
    // le premier appel, puis monte d'un cran par créneau écrit.
    expect(percents).toEqual([0, 25, 50, 75]);
    // Un seul passage, comme à la création : plus rien ne se rejoue.
    expect(getPlanProgress(PROGRESS_ID)).toBeNull();
  });

  /**
   * Le maillon le plus fragile de la chaîne « modale → action → service →
   * registre → route » est le premier : l'identifiant est tiré par le
   * navigateur et joint au `FormData`, et l'action l'écarte sans bruit s'il
   * n'est pas un UUID. Une attente muette ne disait pas lequel avait lâché.
   */
  it('journalise que la génération est suivie, avec le début de l’identifiant', async () => {
    coachAnswers();

    await generatePlan(REQUEST, PROGRESS_ID);

    expect(textOf(consoleInfo)).toContain('[plan] progression suivie (id a1b2c3d4)');
    // L'identifiant complet ne part pas au journal : huit caractères suffisent
    // à rapprocher la ligne des requêtes `/api/plan-progress`.
    expect(textOf(consoleInfo)).not.toContain(PROGRESS_ID);
  });

  it('journalise aussi une génération non suivie : le silence était le problème', async () => {
    coachAnswers();

    await generatePlan(REQUEST);

    expect(textOf(consoleInfo)).toContain('[plan] génération sans suivi de progression');
  });

  it('journalise de la même façon un ajustement', async () => {
    dal.getActivePlanWithSessions.mockResolvedValue(ACTIVE);
    coachAdjusts();

    await updatePlanFromInstruction('allège la semaine prochaine', PROGRESS_ID);

    expect(textOf(consoleInfo)).toContain('[plan] progression suivie (id a1b2c3d4)');
  });

  it('ne suit rien sans identifiant', async () => {
    coachAnswers();

    await generatePlan(REQUEST);

    // Rien n'est enregistré : le registre n'a pas de clé sous laquelle poser
    // quoi que ce soit, et un appel de créneau ne streame pas.
    expect(getPlanProgress(PROGRESS_ID)).toBeNull();
    for (const [call] of chatCompletionJson.mock.calls as [JsonCall][]) {
      expect(call.onProgress).toBeUndefined();
    }
  });
});

/**
 * **La vie d'un plan** — le balayage de trajectoires, et la preuve que ce
 * chantier existe pour produire.
 *
 * ## Pourquoi un test de trajectoire, et pas un test de plus
 *
 * Neuf défauts ont été trouvés en quatre revues successives sur la même
 * arithmétique, et ils ont tous la même signature : **invisibles sur une
 * exécution, visibles sur la trajectoire d'un plan qu'on réadapte**. La
 * validation métier ne compare que des semaines *à l'intérieur* d'une fenêtre,
 * et chaque réadaptation en ouvre une neuve — le raccord entre deux fenêtres
 * n'est regardé par rien. C'est là que vivaient les six.
 *
 * Ce balayage simule donc **la vie d'un plan** : l'athlète court ce qu'on lui
 * prescrit (à son taux de réalisation près), la reconstruction repart de ce
 * qu'elle a couru, et on lit la suite des volumes que l'athlète a réellement
 * vécus, semaine calendaire après semaine calendaire, à travers les
 * réadaptations. 168 vies, 16 semaines chacune :
 *
 * - **intervalle entre réadaptations** : 1, 2, 3, 4 semaines ;
 * - **jour de déclenchement** : les sept jours ISO (c'est là que se cachaient
 *   les défauts 1 et 4) ;
 * - **taux de réalisation** : 0,9 · 1,0 · 1,05 · 5,0 (les défauts 5 et 9) ;
 * - **deux plans** : un bloc libre de 24 semaines et une préparation de 16
 *   semaines menant à une course.
 *
 * Il porte sur {@link remainingVolumeTargets} directement plutôt que sur
 * {@link rewriteRemainingPlan} : la fonction est pure, et passer par la
 * reconstruction complète (squelette, remplissage des créneaux, validation) pour
 * 2 700 fenêtres ferait un test de plusieurs minutes. Ce que le chemin complet a
 * à dire est éprouvé ailleurs dans ce fichier, et la conformité des cibles aux
 * règles métier l'est par le balayage qui suit celui-ci.
 *
 * ## Le modèle d'athlète, et pourquoi il est fidèle
 *
 * Une semaine réadaptée en milieu de semaine n'est réécrite qu'à partir du
 * lendemain : ses premiers jours gardent ce que la reconstruction précédente
 * leur avait prescrit ({@link applyPlanUpdate} — le passé ne se réécrit pas). Le
 * volume **réel** d'une telle semaine est donc un mélange des deux
 * prescriptions, au prorata des jours, et c'est ce que la simulation compose.
 * Sans ce détail, la semaine entamée paraîtrait courue à 40 % de sa valeur et
 * l'ancrage du passage suivant s'effondrerait pour une raison qui n'existe pas.
 *
 * Et **la semaine en cours n'est courue qu'au prorata des jours écoulés**. C'est
 * la correction qui a rendu ce harnais honnête : il lisait auparavant le volume
 * *plein* de la semaine en cours, si bien qu'un lundi matin l'athlète simulée
 * avait déjà cinquante kilomètres au compteur. Ce n'était pas une approximation
 * bénigne — cela rendait dominante la branche
 * `max(…, project(currentWeekStart, openWeekKm, …))`, qui en production ne mord
 * presque jamais, et qui recalait la trajectoire à chaque tour. Le harnais
 * validait donc le code par un modèle qui le sauvait, et c'est ce qui a laissé
 * passer la dérive du dixième.
 *
 * La mémoire du plan (`plannedWeeklyKm`) est tenue de la même façon : c'est ce
 * que les séances en base porteraient, et {@link planWeeklyVolumeKm} le relit
 * exactement ainsi.
 */
describe('remainingVolumeTargets — la vie d’un plan', () => {
  /** Un bloc libre assez long pour que toutes ses fenêtres portent leur respiration. */
  const LONG_PLAN: PlanDto = {
    ...ACTIVE_PLAN,
    goalType: 'free',
    intent: 'faster',
    goalText: 'reprendre le volume',
    raceDate: null,
    startsOn: '2026-06-01',
    weeks: 24,
    sessionsPerWeek: 5,
    weeklyTimeMinutes: null,
    level: 'intermediate',
  };

  /** La même vie, mais avec une échéance : 16 semaines jusqu'au dimanche de la course. */
  const RACE_PLAN: PlanDto = {
    ...LONG_PLAN,
    goalType: 'race',
    intent: 'race',
    goalText: 'semi-marathon en 1 h 45',
    raceDate: '2026-09-20',
    weeks: 16,
  };

  /** Ce que l'athlète courait avant que le plan commence, en km par semaine. */
  const BEFORE_PLAN_KM = 42;

  /** Seize semaines de vie : quatre cycles de quatre, la mesure demandée. */
  const LIVED_WEEKS = 16;

  /** Le lundi de la semaine ISO d'une date civile. */
  function mondayOf(date: string): string {
    return shiftDays(date, -((new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7));
  }

  /** Ce qu'une vie de plan laisse derrière elle, semaine calendaire par semaine calendaire. */
  type Life = {
    /** Le volume **plein** prescrit pour chaque semaine ISO, en km. */
    planned: Map<string, number>;
    /** Ce que la dernière prescription disait de la nature de chaque semaine. */
    kinds: Map<string, WeeklyVolumeTarget['kind']>;
  };

  /**
   * La vie d'un plan : réadaptation tous les `everyWeeks`, déclenchée le jour ISO
   * `triggerDay`, l'athlète courant `realization` × ce qu'on lui prescrit.
   *
   * La boucle de rétroaction est complète et c'est tout l'intérêt : ce que le
   * passage suivant lira dans le snapshot est ce que le passage précédent a
   * écrit.
   */
  /**
   * Une vie plus accidentée que la réalisation constante du balayage : un creux,
   * puis une athlète qui **démontre** qu'elle est revenue.
   *
   * `capacityKm` est ce qu'elle court quoi que le plan dise, une fois le creux
   * passé — c'est la seule façon de poser la question de la sortie de
   * l'enfermement, puisque courir 100 % d'un plan effondré ne démontre rien.
   */
  type LifeShape = {
    /** Rangs de semaine du plan (0 = première) où la réalisation chute. */
    dipWeeks?: readonly [number, number];
    /** Taux de réalisation pendant le creux. */
    dipRealization?: number;
    /** Taux de réalisation après le creux (défaut : celui du reste de la vie). */
    afterRealization?: number;
    /** Ce que l'athlète court au minimum après le creux, en km. */
    capacityKm?: number;
    /** Nombre de semaines vécues (défaut : {@link LIVED_WEEKS}). */
    livedWeeks?: number;
  };

  function live(
    plan: PlanDto,
    everyWeeks: number,
    triggerDay: number,
    realization: number,
    shape: LifeShape = {},
  ): Life {
    const planned = new Map<string, number>();
    const kinds = new Map<string, WeeklyVolumeTarget['kind']>();
    const lived = new Map<string, number>();
    const planWeekStart = mondayOf(plan.startsOn);

    // Les trois semaines qui précèdent le plan : l'athlète courait déjà, et c'est
    // sur elles que la toute première reconstruction s'ancre.
    for (let back = 1; back <= 3; back += 1) {
      lived.set(shiftDays(plan.startsOn, -7 * back), BEFORE_PLAN_KM);
    }

    /** Ce que l'athlète court la semaine `weekStart`, pour un volume prescrit. */
    const run = (weekStart: string, prescribedKm: number): number => {
      const rank = Math.round(
        (Date.parse(`${weekStart}T00:00:00.000Z`) - Date.parse(`${planWeekStart}T00:00:00.000Z`)) /
          (7 * 24 * 3_600_000),
      );
      const [from, to] = shape.dipWeeks ?? [-1, -1];
      if (rank >= from && rank < to) return prescribedKm * (shape.dipRealization ?? realization);
      const after = rank >= to ? (shape.afterRealization ?? realization) : realization;
      const floorRun = rank >= to && shape.capacityKm !== undefined ? shape.capacityKm : 0;
      return Math.max(prescribedKm * after, floorRun);
    };

    // Le plan ne se réadapte pas au-delà de son terme : `remainingPlanWindow`
    // refuse une fenêtre vide, et un déclenchement le dimanche de l'avant-dernière
    // semaine ouvre déjà sur la dernière.
    const lastRebuildWeek = Math.min((shape.livedWeeks ?? LIVED_WEEKS) + 1, plan.weeks - 2);
    for (let week = 0; week <= lastRebuildWeek; week += everyWeeks) {
      const today = shiftDays(plan.startsOn, week * 7 + triggerDay - 1);
      const window = remainingPlanWindow(plan, shiftDays(today, 1));
      const currentWeekStart = mondayOf(today);

      // Les quatre dernières semaines ISO, exactement ce que `buildRecentWeeks`
      // remonte : la plus ancienne d'abord, la semaine en cours en dernier.
      const weeks = [3, 2, 1, 0].map((age) => {
        const full = lived.get(shiftDays(currentWeekStart, -7 * age)) ?? 0;
        const start = shiftDays(currentWeekStart, -7 * age);
        // **La semaine en cours n'est courue qu'au prorata des jours écoulés.**
        //
        // Le modèle précédent lui donnait son volume **plein** dès la
        // reconstruction qui l'avait prescrite : dans la simulation, un lundi
        // matin, l'athlète avait déjà 52 km au compteur. Ce n'était pas un détail
        // de fixture — cela rendait dominante la branche
        // `max(…, project(currentWeekStart, openWeekKm, …))`, qui en production ne
        // mord presque jamais, et qui recalait la trajectoire à chaque tour. Le
        // harnais sauvait donc le code qu'il était censé éprouver, et c'est ce qui
        // a laissé passer la dérive du dixième (cf. `promisedKm`).
        const distanceKm = age === 0 ? (full * triggerDay) / 7 : full;
        return {
          startsOn: start,
          distanceKm,
          movingTimeS: Math.round(distanceKm * 324),
          sessions: distanceKm > 0 ? 4 : 0,
        };
      });

      const targets = remainingVolumeTargets(
        plan,
        window,
        { ...SNAPSHOT, today, weeks },
        { sessionsPerWeek: 5, longRunDay: 7, weeklyTimeMinutes: plan.weeklyTimeMinutes },
        null,
        planned,
      );

      const elapsedDays = window.firstWeekFromDay - 1;
      targets.forEach((target, index) => {
        const start = shiftDays(window.firstWeekStart, index * 7);
        // La semaine entamée garde les jours déjà prescrits : son volume réel est
        // la somme des deux prescriptions, au prorata des jours.
        const kept = index === 0 ? ((planned.get(start) ?? 0) * elapsedDays) / 7 : 0;
        planned.set(start, kept + target.targetKm);
        // La nature d'une semaine se lit de la prescription qui la couvre
        // **entière** : l'étiquette `partial` d'une semaine déjà entamée ne dit
        // rien de sa place dans la périodisation, elle dit qu'on l'a rouverte en
        // cours de route. La laisser écraser la précédente effacerait toutes les
        // respirations dès que la réadaptation est hebdomadaire.
        if (index > 0 || elapsedDays === 0) kinds.set(start, target.kind);
        lived.set(start, run(start, kept + target.targetKm));
      });
    }

    return { planned, kinds };
  }

  /**
   * Les volumes prescrits, de la deuxième semaine à la dernière du plan
   * (au plus la 17ᵉ) — **affûtage compris**.
   *
   * Une seule exclusion, et c'est un artefact de mesure : la **semaine 1** est
   * celle du tout premier déclenchement, donc entamée et amputée d'autant de jours
   * que le déclenchement est tardif.
   *
   * Les semaines d'affûtage en faisaient partie jusqu'à la ronde précédente, au
   * motif que leurs deux chemins de calcul — base recalculée dans la fenêtre, ou
   * base relue dans la mémoire du plan — « s'accordent à 2 % près ». Mesuré, ils
   * s'accordaient à **7,2 %** sur cette préparation de 16 semaines, à **×1,295**
   * sur un marathon de 20 semaines, et le test qui les couvrait à part ne vérifie
   * que des inégalités (`affûtage < développement`, `course < affûtage`) — il
   * passait intégralement avec l'affûtage cassé. C'est cette exclusion qui a laissé
   * passer le défaut de la fenêtre ouverte en milieu de semaine sur la dernière
   * semaine de développement : **−25 % sur la semaine de course** selon le jour de
   * déclenchement. Les semaines d'affûtage rentrent donc dans la comparaison, où
   * elles s'accordent comme les autres.
   */
  function series(life: Life, plan: PlanDto): number[] {
    const last = Math.min(LIVED_WEEKS + 1, plan.weeks);
    return Array.from({ length: last - 1 }, (_, offset) => {
      const km = life.planned.get(shiftDays(plan.startsOn, (offset + 1) * 7)) ?? 0;
      return Math.round(km * 10) / 10;
    });
  }

  /** Les volumes prescrits des semaines de **développement** seules. */
  function buildSeries(life: Life, plan: PlanDto): number[] {
    const taper = plan.goalType === 'race' ? 2 : 0;
    return series(life, plan).slice(0, Math.min(LIVED_WEEKS + 1, plan.weeks - taper) - 1);
  }

  /** Les volumes prescrits des semaines d'affûtage, la semaine de course comprise. */
  function taperSeries(life: Life, plan: PlanDto): number[] {
    return Array.from({ length: 2 }, (_, offset) => {
      const week = plan.weeks - 2 + offset;
      const km = life.planned.get(shiftDays(plan.startsOn, week * 7)) ?? 0;
      return Math.round(km * 10) / 10;
    });
  }

  /** Les rangs (1 = première semaine du plan) des semaines allégées reçues. */
  function cutbackWeeks(life: Life, plan: PlanDto, weeks: number): number[] {
    return Array.from({ length: weeks }, (_, index) => index)
      .filter((index) => life.kinds.get(shiftDays(plan.startsOn, index * 7)) === 'cutback')
      .map((index) => index + 1);
  }

  /**
   * Toutes les vies du balayage, calculées une fois.
   *
   * La **semaine 1 est exclue** de toutes les mesures : elle est la semaine du
   * tout premier déclenchement, donc entamée et amputée d'autant de jours que le
   * déclenchement est tardif — un artefact du protocole de mesure, pas du plan.
   * Ce sont les semaines 2 à 17 qu'on lit.
   */
  const INTERVALS = [1, 2, 3, 4] as const;
  const TRIGGER_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

  describe.each([
    { label: 'bloc libre de 24 semaines', plan: LONG_PLAN },
    { label: 'préparation de 16 semaines vers une course', plan: RACE_PLAN },
  ])('$label', ({ plan }) => {
    /**
     * **Le raccord entre deux fenêtres ne fabrique jamais une marche que la règle
     * refuse.**
     *
     * C'est la propriété que rien ne regardait : chaque plan reconstruit satisfait
     * `maxWeeklyGrowth` *dans sa fenêtre*, et c'est la suite des fenêtres qui ne la
     * satisfaisait pas. Mesuré avant correction, à réalisation 1,05 : une hausse
     * hebdomadaire de **1,134**, au-dessus du plafond de 1,12, et un plan à ×2,50
     * sur 16 semaines.
     */
    it.each(INTERVALS)(
      'ne fait jamais monter le volume au-delà du plafond, réadaptation toutes les %i semaines',
      (everyWeeks) => {
        for (const triggerDay of TRIGGER_DAYS) {
          for (const realization of [0.9, 1, 1.05]) {
            const km = series(live(plan, everyWeeks, triggerDay, realization), plan);
            for (let index = 1; index < km.length; index += 1) {
              const growth = km[index] / km[index - 1];
              expect(
                growth,
                `${everyWeeks} sem · jour ${triggerDay} · réalisation ${realization} · semaine ${index + 2}`,
              ).toBeLessThanOrEqual(VOLUME_RULES.maxWeeklyGrowth);
            }
          }
        }
      },
    );

    /**
     * **Pour une athlète assidue, la trajectoire ne dépend ni de la fréquence ni
     * du jour de réadaptation.**
     *
     * C'est le critère qui a démasqué les défauts 1 et 2, et c'est le plus
     * exigeant du fichier : il dit que réadapter n'est pas un événement. Une
     * athlète qui court son plan doit vivre le même plan, qu'on le recalcule
     * chaque semaine ou une fois par mois, un mercredi ou un dimanche.
     *
     * Avant correction, réadaptation toutes les 2 semaines en milieu de semaine :
     * **45,3 → 29,4 km, ×0,66 sur 16 semaines** — un plan qui décroît pour
     * quelqu'un d'assidu, parce que la première semaine pleine était deux semaines
     * calendaires après l'ancre et ne recevait qu'une marche.
     *
     * L'égalité est à **3 pour mille** près et non au dixième : la semaine entamée
     * d'une réadaptation en milieu de semaine porte un mélange de deux
     * prescriptions, dont l'une est arrondie au dixième **inférieur**
     * ({@link floorKm}) sur une fraction de semaine. C'est un résidu d'arrondi et
     * non une dérive — il ne croît pas avec le nombre de reconstructions : sur 23
     * semaines vécues d'un bloc de 24, il vaut encore ×0,998 au pire, et les
     * dernières semaines retombent au dixième près sur la référence.
     *
     * La tolérance valait 1 % tant que `floorKm` rabotait un dixième à chaque
     * reconstruction : avec le modèle d'athlète honnête, la dérive mesurée était
     * de **×0,968 sur 16 semaines** et croissait. Elle est fermée (cf.
     * `promisedKm`), et la tolérance a été resserrée d'autant.
     */
    it('rend la même trajectoire quelle que soit la fréquence et le jour de réadaptation', () => {
      const reference = series(live(plan, 4, 7, 1), plan);

      for (const everyWeeks of INTERVALS) {
        for (const triggerDay of TRIGGER_DAYS) {
          const km = series(live(plan, everyWeeks, triggerDay, 1), plan);
          km.forEach((value, index) => {
            const label = `${everyWeeks} sem · jour ${triggerDay} · semaine ${index + 2}`;
            expect(value, label).toBeGreaterThan(reference[index] * 0.997);
            expect(value, label).toBeLessThan(reference[index] * 1.003);
          });
        }
      }
    });

    /**
     * **Courir plus que prescrit ne relève pas le plan d'un dixième.**
     *
     * La moitié haute de la propriété 5, et l'assertion la plus nette qu'on
     * puisse écrire : à réalisation 1,05 **comme à 5,0**, la trajectoire est
     * *exactement* celle d'une athlète à 1,0. Avant correction, une seule sortie
     * non planifiée dans une semaine allégée l'annulait et relevait tout l'avenir
     * de 18 % ; sur 16 semaines, 5 % d'excédent hebdomadaire faisaient ×2,50.
     *
     * Le facteur 5 est là depuis que le crédit peut dépasser 1 pour sortir de
     * l'enfermement : il éprouve que ce cran est **borné**, et pas proportionnel à
     * l'excédent. Un décapuchonnage naïf de `bestKm` rendait 205 km/semaine sur ce
     * même protocole.
     */
    it('ne relève rien quand l’athlète en fait plus que prescrit', () => {
      for (const everyWeeks of INTERVALS) {
        for (const triggerDay of TRIGGER_DAYS) {
          const label = `${everyWeeks} sem · jour ${triggerDay}`;
          const reference = series(live(plan, everyWeeks, triggerDay, 1), plan);
          expect(series(live(plan, everyWeeks, triggerDay, 1.05), plan), label).toEqual(reference);
          expect(series(live(plan, everyWeeks, triggerDay, 5), plan), label).toEqual(reference);
        }
      }
    });

    /**
     * **À 90 % de réalisation, le plan descend — et il ne s'effondre pas.**
     *
     * Les deux moitiés comptent. Avant correction, la boucle avait un gain égal au
     * taux de réalisation et le plan faisait **×0,24 sur 16 semaines** : une
     * athlète à 90 % se retrouvait avec un quart de son plan. Après, chaque
     * reconstruction ne retient que 5 points de l'écart
     * ({@link CONTINUATION_RULES.realizationRelief}), et la dérive est bornée par
     * le nombre de reconstructions : mesuré sur ce balayage, **×0,51 à
     * réadaptation hebdomadaire, ×1,04 à quatre semaines d'écart** — le nominal
     * étant lui-même de ×1,20 sur seize semaines.
     *
     * Les bornes retenues, et pourquoi celles-là :
     *
     * - **plancher 0,45** : la pire dérive possible du balayage est
     *   `0,95¹⁶ = 0,44` du nominal, et le nominal d'un bloc de 16 semaines vaut
     *   ×1,20. La borne laisse donc la dérive mesurée passer, et refuse tout ce
     *   qui irait plus vite — c'est-à-dire tout retour du gain non amorti ;
     * - **plafond 1,25** : à peine au-dessus du nominal. Une athlète qui ne court
     *   que 90 % de son plan ne doit surtout pas progresser plus qu'une assidue.
     *
     * La dérive résiduelle est assumée, et le modèle d'athlète qui la produit
     * suppose une coureuse dont la production est *proportionnelle* à la
     * prescription, donc sans capacité propre. Une athlète réelle, à capacité fixe,
     * voit le plan descendre jusqu'à elle — et là sa réalisation revient à 1, où le
     * cran de remontée la ramène vers la promesse du plan (cf. « la sortie de
     * l'enfermement » plus bas).
     */
    it('ne s’effondre pas et ne s’emballe pas à 90 % de réalisation', () => {
      for (const everyWeeks of INTERVALS) {
        for (const triggerDay of TRIGGER_DAYS) {
          // Sur les semaines de **développement** seules : un affûtage descend par
          // construction, et son rapport à la première semaine ne dit rien de la
          // dérive qu'on mesure ici.
          const km = buildSeries(live(plan, everyWeeks, triggerDay, 0.9), plan);
          const ratio = km[km.length - 1] / km[0];
          const label = `${everyWeeks} sem · jour ${triggerDay}`;
          expect(ratio, label).toBeGreaterThan(0.45);
          expect(ratio, label).toBeLessThan(1.25);
        }
      }
    });
  });

  /**
   * **L'affûtage descend, et la semaine de course reste sous les deux tiers du
   * pic** — quelle que soit la réadaptation qui l'a écrit.
   *
   * C'est la propriété qui compte d'un affûtage, et elle se juge à part de la
   * trajectoire : sa base est la dernière semaine de développement, relue dans la
   * mémoire du plan quand la fenêtre ne contient plus que de l'affûtage. Sans
   * cette lecture, la base était le point de départ de la fenêtre — une
   * projection de développement, une marche **au-dessus** du pic réel — et la
   * semaine de course valait 44,7 km ou 41,4 km selon que la dernière
   * réadaptation tombait en semaine 14 ou en semaine 12.
   */
  it('descend jusqu’à la course, d’où que la dernière réadaptation soit partie', () => {
    for (const everyWeeks of INTERVALS) {
      for (const triggerDay of TRIGGER_DAYS) {
        const life = live(RACE_PLAN, everyWeeks, triggerDay, 1);
        const build = buildSeries(life, RACE_PLAN);
        const [taperKm, raceKm] = taperSeries(life, RACE_PLAN);
        const label = `${everyWeeks} sem · jour ${triggerDay}`;

        const peak = Math.max(...build);
        expect(taperKm, label).toBeLessThan(build[build.length - 1]);
        expect(raceKm, label).toBeLessThan(taperKm);
        expect(raceKm, label).toBeLessThan(peak * VOLUME_RULES.raceWeekMaxRatio);
      }
    }
  });

  /**
   * **Les semaines allégées tombent aux semaines du plan d'origine, dans tous les
   * cas.**
   *
   * Mesuré sur le plan long, qui garde des fenêtres assez longues pour porter
   * leur respiration jusqu'au bout (`VOLUME_RULES.minBuildWeeksForCutback`). Le
   * plan démarre un lundi : sa première semaine pleine est sa semaine 1, et ses
   * respirations tombent donc aux semaines 4, 8, 12 et 16.
   *
   * Avant correction, la cadence se comptait depuis la **fenêtre** : la révision
   * se déclenchant toutes les quatre séances, l'athlète repartait indéfiniment du
   * premier rang d'un bloc neuf et n'atteignait jamais le quatrième —
   * `45,3 → 48,9 → 52,8 → 57,0 → 61,5 → 66,4 → 71,7 → 77,4 → 83,5 → 90,1 → 97,3 → 105,0`,
   * soit douze semaines de montée sans une seule récupération.
   */
  it('rend les semaines allégées du plan, à toutes les fréquences et tous les jours', () => {
    for (const everyWeeks of INTERVALS) {
      for (const triggerDay of TRIGGER_DAYS) {
        for (const realization of [0.9, 1, 1.05]) {
          const life = live(LONG_PLAN, everyWeeks, triggerDay, realization);
          expect(
            cutbackWeeks(life, LONG_PLAN, LIVED_WEEKS + 1).filter((week) => week > 1),
            `${everyWeeks} sem · jour ${triggerDay} · réalisation ${realization}`,
          ).toEqual([4, 8, 12, 16]);
        }
      }
    }
  });

  /**
   * La trajectoire elle-même, au dixième — pour qu'une régression se lise, et pas
   * seulement se constate.
   *
   * Semaines 2 à 17 d'un plan de 24 semaines, athlète assidue, réadaptation
   * toutes les quatre semaines déclenchée le dimanche. On y lit le bloc de
   * développement (+8 % par semaine), la respiration à 85 % toutes les quatre
   * semaines, et un rythme **net** de +1,7 % par semaine — le vrai rythme d'une
   * périodisation, quatre fois plus lent que la montée qu'elle enchaîne.
   */
  it('suit la progression que le plan a promise, respirations comprises', () => {
    const life = live(LONG_PLAN, 4, 7, 1);

    expect(series(life, LONG_PLAN)).toEqual([
      48.9, 52.8, 44.8, 48.3, 52.1, 56.2, 47.7, 51.5, 55.6, 60, 50.9, 54.9, 59.2, 63.9, 54.3, 58.6,
    ]);
  });

  /**
   * **Le plan sort de son creux quand l'athlète démontre qu'elle est revenue — et
   * il ne dépasse jamais ce qu'il avait promis.**
   *
   * ## Le piège produit que cela ferme
   *
   * `counted` plafonnait le réel par la prescription **courante**, y compris pour
   * les deux garde-fous de reprise. Le plancher ne mesurait donc plus ce que
   * l'athlète avait *démontré* mais ce que le plan lui avait *permis*, et la boucle
   * se refermait sur elle-même. Mesuré sur ce protocole exact, réadaptation
   * hebdomadaire : un creux de quatre semaines à 80 % coûtait **−39 %** du plan à
   * la semaine 24, à 50 % **−77 %**, et faire courir l'athlète **cinq fois le
   * prescrit pendant seize semaines** laissait la trajectoire identique au dixième.
   * Le seul remède était de créer un plan neuf, et ce n'était écrit nulle part.
   *
   * ## Ce que le test mesure
   *
   * Une athlète à **capacité fixe** : elle décroche quatre semaines, puis reprend
   * le volume qu'elle tenait juste avant. C'est le seul modèle qui pose la
   * question — courir 100 % d'un plan effondré ne démontre rien.
   *
   * Deux assertions, et elles vont ensemble : la trajectoire **rejoint** celle du
   * plan nominal, et elle ne la **dépasse jamais** — la promesse du plan est un
   * plafond, pas un objectif mobile.
   */
  describe('la sortie de l’enfermement', () => {
    /** Les volumes prescrits des semaines 2 à `weeks + 1` du plan. */
    function plannedKm(life: Life, plan: PlanDto, weeks: number): number[] {
      return Array.from({ length: weeks }, (_, offset) => {
        const km = life.planned.get(shiftDays(plan.startsOn, (offset + 1) * 7)) ?? 0;
        return Math.round(km * 10) / 10;
      });
    }

    /** Vingt-trois semaines vécues d'un plan de 24 : la place de se relever. */
    const LIVED = 22;
    const WEEKS = 23;
    /** Quatre semaines à moitié courues, de la 5ᵉ à la 8ᵉ. */
    const DIP = { dipWeeks: [4, 8] as const, dipRealization: 0.5, livedWeeks: LIVED };

    /**
     * Les réadaptations assez fréquentes pour que le creux **morde**.
     *
     * À trois ou quatre semaines d'écart, un creux de quatre semaines peut tomber
     * entièrement entre deux reconstructions : le plan ne le voit pas, il n'y a
     * rien à rattraper, et mesurer une remontée n'aurait aucun sens. Les
     * invariants, eux, se vérifient sur tout le balayage.
     */
    const BITING_INTERVALS = [1, 2] as const;

    /**
     * **Rien ne dépasse jamais ce que le plan avait promis.**
     *
     * C'est la borne, et c'est elle qui autorise la remontée sans rouvrir le
     * cliquet : la promesse est un point fixe, une prescription vaut au plus la
     * promesse, donc la reprojeter rend au plus la promesse. Un décapuchonnage
     * naïf de `bestKm`, lui, rendait 205 km/semaine à réalisation 5.
     */
    it.each(INTERVALS)(
      'ne dépasse jamais la promesse du plan, réadaptation toutes les %i semaines',
      (everyWeeks) => {
        for (const triggerDay of TRIGGER_DAYS) {
          const label = `${everyWeeks} sem · jour ${triggerDay}`;
          const nominal = plannedKm(
            live(LONG_PLAN, everyWeeks, triggerDay, 1, { livedWeeks: LIVED }),
            LONG_PLAN,
            WEEKS,
          );
          for (const afterRealization of [1, 1.05, 5]) {
            const km = plannedKm(
              live(LONG_PLAN, everyWeeks, triggerDay, 1, { ...DIP, afterRealization }),
              LONG_PLAN,
              WEEKS,
            );
            km.forEach((value, index) => {
              expect(
                value,
                `${label} · après ${afterRealization} · semaine ${index + 2}`,
              ).toBeLessThanOrEqual(nominal[index]);
            });
          }
        }
      },
    );

    /**
     * **Le plan revient sur sa trajectoire quand l'athlète démontre qu'elle est
     * revenue.**
     *
     * Le piège que cela ferme : `counted` plafonnait le réel par la prescription
     * **courante**, y compris pour les deux garde-fous de reprise. Le plancher ne
     * mesurait donc plus ce que l'athlète avait *démontré* mais ce que le plan lui
     * avait *permis*, et la boucle se refermait sur elle-même. Mesuré sur ce
     * protocole exact, réadaptation hebdomadaire : un creux de quatre semaines à
     * 50 % coûtait **−77 %** du plan à la semaine 24, et faire courir l'athlète
     * **cinq fois le prescrit** pendant les seize semaines suivantes laissait la
     * trajectoire *identique au dixième*. Le seul remède était de créer un plan
     * neuf, et ce n'était écrit nulle part.
     *
     * Mesuré après correction, semaine 24 : la vie qui démontre rend **61,7 km —
     * la trajectoire nominale exactement** à toutes les fréquences sauf un
     * déclenchement du lundi espacé (48,5 à 53,8 km, soit 79 à 87 % du nominal),
     * quand la vie qui se contente d'obéir reste entre 13,1 et 42,9 km.
     */
    it.each(BITING_INTERVALS)(
      'ramène le plan sur sa promesse quand l’athlète la démontre, réadaptation toutes les %i semaines',
      (everyWeeks) => {
        for (const triggerDay of TRIGGER_DAYS) {
          const label = `${everyWeeks} sem · jour ${triggerDay}`;
          const nominal = plannedKm(
            live(LONG_PLAN, everyWeeks, triggerDay, 1, { livedWeeks: LIVED }),
            LONG_PLAN,
            WEEKS,
          );
          const stuck = plannedKm(live(LONG_PLAN, everyWeeks, triggerDay, 1, DIP), LONG_PLAN, WEEKS);
          const back = plannedKm(
            live(LONG_PLAN, everyWeeks, triggerDay, 1, { ...DIP, afterRealization: 5 }),
            LONG_PLAN,
            WEEKS,
          );

          expect(back[WEEKS - 1], label).toBeGreaterThan(nominal[WEEKS - 1] * 0.75);
          // Avant correction, ces deux vies étaient identiques au dixième.
          expect(back[WEEKS - 1], label).toBeGreaterThan(stuck[WEEKS - 1] * 1.2);
        }
      },
    );

    /**
     * **Une athlète à capacité fixe remonte au rythme d'un entraîneur.**
     *
     * Le protocole précédent (cinq fois le prescrit) mesure la borne ; celui-ci
     * mesure la vie : l'athlète décroche quatre semaines, puis reprend le volume
     * qu'elle tenait juste avant — c'est le seul modèle qui pose la question,
     * puisque courir 100 % d'un plan effondré ne démontre rien.
     *
     * Le plan la rejoint sans jamais lui demander, d'une semaine sur l'autre, plus
     * que la hausse que la règle autorise au-dessus de ce qu'elle court réellement.
     * C'est ce qui distingue ce cran de remontée d'un décapuchonnage : le crédit
     * est borné par `maxWeeklyGrowth` divisé par la progression du niveau, si bien
     * qu'un raccord entre deux fenêtres vaut au plus `marche × crédit`, soit
     * `maxWeeklyGrowth` sur une semaine de développement et moins sur une semaine
     * allégée. Une
     * projection du réel depuis la semaine révolue rouvrait au contraire les deux
     * suites paire et impaire : **37,2 → 42,1 km, +13,2 %**, au-dessus du plafond
     * de 12 %.
     *
     * Mesuré, réadaptation hebdomadaire du dimanche : trou à **35 %** du nominal en
     * semaine 9, retour à **94 %** en semaine 10, **100 %** en semaine 12 — deux
     * reconstructions. Un déclenchement du lundi, où la semaine en cours ne
     * témoigne que d'un septième, remonte plus lentement : 47 % en semaine 11,
     * 100 % en semaine 24. Avant correction, la trajectoire restait à **23 %**.
     */
    it.each(INTERVALS)(
      'remonte sans jamais demander plus d’une marche au-dessus du réel, réadaptation toutes les %i semaines',
      (everyWeeks) => {
        for (const triggerDay of TRIGGER_DAYS) {
          const label = `${everyWeeks} sem · jour ${triggerDay}`;
          const nominal = plannedKm(
            live(LONG_PLAN, everyWeeks, triggerDay, 1, { livedWeeks: LIVED }),
            LONG_PLAN,
            WEEKS,
          );
          // La capacité retrouvée : ce que le plan lui demandait avant le creux.
          const capacityKm = nominal[3];
          const km = plannedKm(
            live(LONG_PLAN, everyWeeks, triggerDay, 1, { ...DIP, capacityKm }),
            LONG_PLAN,
            WEEKS,
          );

          km.forEach((value, index) => {
            expect(value, `${label} · semaine ${index + 2}`).toBeLessThanOrEqual(nominal[index]);
            if (index < 4) return;
            // Le `+ 0,1` est la granularité de `floorKm` : sur les volumes
            // effondrés du creux (9 km), un dixième vaut près d'un point.
            expect(value, `${label} · semaine ${index + 2}`).toBeLessThanOrEqual(
              Math.max(km[index - 1], capacityKm) * VOLUME_RULES.maxWeeklyGrowth + 0.1,
            );
          });

          if (!BITING_INTERVALS.includes(everyWeeks as 1 | 2)) continue;
          expect(km[WEEKS - 1], label).toBeGreaterThan(Math.min(...km.slice(4)) * 1.5);
        }
      },
    );
  });
});

/**
 * Le balayage de conformité : **une fenêtre restante chiffrée par l'appli n'est
 * jamais refusée par l'appli**.
 *
 * C'est la condition de non-régression de l'architecture « le modèle structure,
 * l'appli chiffre ». Une cible que la validation refuse est le pire des états :
 * l'appli se contredit elle-même, et la reconstruction sort en
 * `InvalidGeneratedPlanError` — une « incohérence interne » que l'athlète ne
 * peut rien faire pour corriger.
 *
 * La couture la plus dangereuse est celle de la semaine allégée d'ouverture :
 * quand la cadence du plan désigne la première semaine pleine de la fenêtre
 * comme la respiration du bloc, c'est la seule semaine dont la validation ne
 * peut pas constater la baisse — sa référence est le volume réellement couru
 * avant la fenêtre, que la règle ne connaît pas. Elle lit alors l'étiquette
 * (`kind: 'cutback'`), et ce balayage éprouve que l'étiquette et le chiffre
 * disent la même chose, dans les deux sens.
 *
 * Il remplace celui qui vivait dans `plan-schema.test.ts` du temps où une
 * continuation passait par `weeklyVolumeTargets`.
 */
describe('planWeeklyVolumeKm', () => {
  it('somme les séances par semaine ISO', () => {
    expect(
      planWeeklyVolumeKm([
        planSession({ scheduledOn: '2026-06-03', volumeM: 8_000 }),
        planSession({ scheduledOn: '2026-06-07', volumeM: 14_500 }),
        planSession({ scheduledOn: '2026-06-08', volumeM: 10_000 }),
      ]),
    ).toEqual(
      new Map([
        ['2026-06-01', 22.5],
        ['2026-06-08', 10],
      ]),
    );
  });

  it('écarte une semaine dont une séance ne déclare pas sa distance', () => {
    // La même prudence que `weekVolumeKm` : une somme partielle ferait croire que
    // l'athlète a dépassé sa prescription, et l'ancrage de la reconstruction s'y
    // fierait. Mieux vaut ne rien savoir de cette semaine que d'en savoir la
    // moitié.
    expect(
      planWeeklyVolumeKm([
        planSession({ scheduledOn: '2026-06-03', volumeM: 8_000 }),
        planSession({ scheduledOn: '2026-06-07', volumeM: null }),
      ]),
    ).toEqual(new Map());
  });
});

describe('remainingVolumeTargets × validatePlanBusinessRules', () => {
  /** L'allure d'endurance que le snapshot du balayage impose, en s/km. */
  const PACE_SEC_PER_KM = SNAPSHOT.recentAvgPaceSecPerKm ?? 0;

  /**
   * Une semaine qui **réalise exactement sa cible** : le volume et le temps
   * visés, répartis sur les jours encore ouverts, sortie longue comprise.
   *
   * C'est le plan qu'un modèle parfaitement obéissant écrirait — celui sur lequel
   * les règles métier doivent n'avoir rien à redire.
   */
  function weekForTarget(
    target: WeeklyVolumeTarget,
    sessionsPerWeek: number,
    longRunDay: number,
    fromDay: number,
  ): PlanWeekOutput {
    const days = [longRunDay, ...[1, 2, 3, 4, 5, 6, 7].filter((day) => day !== longRunDay)]
      .filter((day) => day >= fromDay)
      .slice(0, sessionsPerWeek)
      .sort((left, right) => left - right);

    const hasLongRun = days.includes(longRunDay);
    const shares = days.map((day) => {
      if (!hasLongRun || days.length === 1) return 1 / days.length;
      if (days.length === 2) return 0.5;
      return day === longRunDay ? 0.38 : 0.62 / (days.length - 1);
    });

    // La dernière séance absorbe les restes : la semaine doit totaliser sa cible
    // exactement, sans quoi un cheveu de flottant ferait constater une hausse que
    // la cible ne porte pas.
    let restKm = target.targetKm;
    let restMin = target.targetMinutes;

    return {
      sessions: days.map((day, index) => {
        const last = index === days.length - 1;
        const distanceKm = last ? restKm : target.targetKm * shares[index];
        const durationMin = last ? restMin : target.targetMinutes * shares[index];
        restKm -= distanceKm;
        restMin -= durationMin;

        return {
          day,
          kind: day === longRunDay ? 'Sortie longue' : 'Endurance fondamentale',
          title: 'Footing',
          distanceKm,
          durationMin,
        };
      }),
    };
  }

  /**
   * Ce que le plan porte en mémoire, à hauteur de `peakKm` sur la semaine qui
   * précède la fenêtre puis la cadence du niveau intermédiaire.
   *
   * **Le quadrant « mémoire du plan × budget temps » était le trou de ce
   * balayage** : il passait `new Map()`, si bien que les deux branches qui lisent
   * `plannedWeeklyKm` — la promesse et la base d'affûtage — n'étaient jamais
   * confrontées à la validation. Un affûtage relu de la mémoire et non replafonné
   * par le budget produisait **44,3 km annoncés en 114 min** et une fenêtre
   * refusée par l'appli elle-même.
   */
  function planMemory(firstWeekStart: string, weeks: number, peakKm: number): Map<string, number> {
    const memory = new Map<string, number>();
    let km = peakKm;
    for (let index = -2; index < weeks; index += 1) {
      memory.set(shiftDays(firstWeekStart, index * 7), Math.round(km * 10) / 10);
      km *= 1.08;
    }
    return memory;
  }

  it('produit des cibles qu’aucune règle ne refuse, d’où que la fenêtre s’ouvre', () => {
    const failures: string[] = [];

    // Le lundi 1ᵉʳ juin 2026 ouvre la fenêtre ; le plan, lui, démarre `planOffset`
    // semaines plus tôt, ce qui fait varier le rang de cadence de l'ouverture sur
    // les quatre valeurs possibles.
    for (const weeks of [1, 2, 4, 6, 8, 12, 16, 24]) {
      for (const goal of ['free', 'race', 'marathon'] as const) {
        for (const firstWeekFromDay of [1, 4, 7]) {
          for (const planOffset of [0, 1, 2, 3]) {
            for (const level of ['beginner', 'intermediate', 'advanced'] as const) {
              for (const weeklyTimeMinutes of [null, 300]) {
               for (const memory of [null, 42, 90]) {
                const firstWeekStart = '2026-06-01';
                const startsOn = shiftDays(firstWeekStart, -7 * planOffset);
                const window = { firstWeekStart, weeks, firstWeekFromDay };
                const plan: PlanDto = {
                  ...ACTIVE_PLAN,
                  level,
                  startsOn,
                  weeks: weeks + planOffset,
                  weeklyTimeMinutes,
                  goalType: goal === 'free' ? 'free' : 'race',
                  intent: goal === 'free' ? 'faster' : 'race',
                  goalText: goal === 'marathon' ? 'marathon de Paris' : '10 km sous 50 min',
                  raceDate:
                    goal === 'free' ? null : shiftDays(firstWeekStart, weeks * 7 - 1),
                };

                const targets = remainingVolumeTargets(
                  plan,
                  window,
                  {
                    ...SNAPSHOT,
                    today: '2026-05-31',
                    weeks: [
                      { startsOn: '2026-05-25', distanceKm: 42, movingTimeS: 13_608, sessions: 4 },
                    ],
                  },
                  { sessionsPerWeek: 5, longRunDay: 7, weeklyTimeMinutes },
                  null,
                  memory === null
                    ? new Map()
                    : planMemory(firstWeekStart, weeks + planOffset, memory),
                );

                // **La cible en km et la cible en minutes doivent dire la même
                // chose.** `targetMinutes` est systématiquement ramené au budget ;
                // si le volume, lui, ne l'a pas été, la fenêtre se contredit — elle
                // annonce 44,3 km en 114 min, soit 2:34/km — et le squelette, qui
                // ne lit que `targetKm` (`skeleton.ts`), écrit une semaine que la
                // validation refuse. Le modèle de semaine ci-dessous honore
                // `targetMinutes`, donc il ne peut pas voir cette contradiction :
                // elle se lit sur les cibles elles-mêmes.
                targets.forEach((target, index) => {
                  const minutesForKm = Math.round((target.targetKm * PACE_SEC_PER_KM) / 60);
                  // Une minute de battement : le budget d'une semaine entamée est
                  // proratisé au jour, et les deux arrondis ne tombent pas ensemble.
                  if (target.targetMinutes < minutesForKm - 1) {
                    failures.push(
                      `${weeks} sem · ${goal} · jour ${firstWeekFromDay} · décalage ${planOffset} · ` +
                        `${level} · budget ${weeklyTimeMinutes} · mémoire ${memory} · ` +
                        `semaine ${index + 1} : ${target.targetKm} km annoncés en ` +
                        `${target.targetMinutes} min, soit ${minutesForKm} min d'allure`,
                    );
                  }
                });

                const written = targets.map((target, index) =>
                  weekForTarget(target, 5, 7, index === 0 ? firstWeekFromDay : 1),
                );
                const violations = validatePlanBusinessRules(
                  written,
                  {
                    // Une fenêtre restante n'est pas un plan neuf : ni anti-plat,
                    // ni ancrage de départ (cf. `rewriteRemainingPlan`).
                    scope: 'adjustment',
                    weeks,
                    sessionsPerWeek: 5,
                    longRunDay: 7,
                    firstWeekFromDay,
                    race:
                      goal === 'free' ? null : { isMarathon: goal === 'marathon' },
                    weeklyTargets: targets,
                  },
                  { weeklyTimeMinutes },
                );

                if (violations.length > 0) {
                  failures.push(
                    `${weeks} sem · ${goal} · jour ${firstWeekFromDay} · décalage ${planOffset} · ` +
                      `${level} · budget ${weeklyTimeMinutes} · mémoire ${memory} → ` +
                      violations.join(' | '),
                  );
                }
               }
              }
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

/**
 * Les quatre défauts de la troisième ronde, un test chacun — et chacun **échoue
 * sur le code d'avant**, vérifié en rejouant l'arithmétique précédente. Ceux de la
 * quatrième ronde vivent plus bas (« l'affûtage d'une fenêtre ouverte en milieu de
 * semaine ») et dans « la sortie de l'enfermement ».
 *
 * Ils tiennent en une fenêtre, là où le balayage ci-dessus en simule des
 * milliers : ce sont des sondes, pas des propriétés. Elles disent *où* ça casse
 * quand le balayage dit *que* ça casse.
 */
describe('remainingVolumeTargets — les défauts mesurés', () => {
  const PLAN: PlanDto = {
    ...ACTIVE_PLAN,
    goalType: 'free',
    intent: 'faster',
    goalText: 'reprendre le volume',
    raceDate: null,
    startsOn: '2026-06-01',
    weeks: 12,
    sessionsPerWeek: 5,
    weeklyTimeMinutes: null,
    level: 'intermediate',
  };

  /** Les cibles d'une fenêtre, en km — l'appel réduit à ce que ces sondes lisent. */
  function targetsFor(
    plan: PlanDto,
    today: string,
    weeklyKm: readonly { startsOn: string; distanceKm: number }[],
    window: { firstWeekStart: string; weeks: number; firstWeekFromDay: number },
  ): WeeklyVolumeTarget[] {
    return remainingVolumeTargets(
      plan,
      window,
      {
        ...SNAPSHOT,
        today,
        weeks: weeklyKm.map((week) => ({
          ...week,
          movingTimeS: Math.round(week.distanceKm * 324),
          sessions: week.distanceKm > 0 ? 4 : 0,
        })),
      },
      { sessionsPerWeek: 5, longRunDay: 7, weeklyTimeMinutes: null },
      null,
      new Map(),
    );
  }

  it('défaut 1 — donne une marche par semaine calendaire franchie, pas une par fenêtre', () => {
    // Réadaptation le mercredi 10 juin : la fenêtre s'ouvre sur la semaine du
    // 8 juin, entamée, et sa première semaine **pleine** est celle du 15 juin —
    // soit **deux** semaines calendaires après la dernière semaine complète
    // (celle du 1ᵉʳ juin, courue à 60 km). Elle reçoit donc deux marches.
    //
    // Avant correction, elle n'en recevait qu'une (64,7 km) : la progression
    // marquait le pas à chaque réadaptation en milieu de semaine, et une athlète
    // assidue réadaptée toutes les deux semaines voyait son plan **décroître**
    // (45,3 → 29,4 km, ×0,66 sur 16 semaines).
    const targets = targetsFor(
      PLAN,
      '2026-06-10',
      [
        { startsOn: '2026-05-25', distanceKm: 55 },
        { startsOn: '2026-06-01', distanceKm: 60 },
        { startsOn: '2026-06-08', distanceKm: 25 },
      ],
      { firstWeekStart: '2026-06-08', weeks: 12, firstWeekFromDay: 4 },
    );

    expect(targets[1].targetKm).toBe(69.9);
    // Et la semaine entamée porte bien **une** marche, proratisée sur ses quatre
    // jours restants : 69,98 / 1,08 = 64,8, dont 4/7.
    //
    // Le calcul part du volume visé pour la première semaine pleine **avant**
    // arrondi (69,98) et non de sa cible arrondie (69,9) : diviser la cible
    // reviendrait à replancher une valeur déjà planchée, et cette troncature-là
    // se paie à chaque reconstruction (cf. `promisedKm`).
    expect(targets[0].targetKm).toBe(37);
    expect(targets[0].kind).toBe('partial');
  });

  it('défaut 3 — n’étiquette pas « allégée » une semaine qui monte', () => {
    // Semaines réelles 58, 60, 60 puis 20 : une interruption franche. Le pont
    // d'une semaine sautée rattrape la reprise à 70 % des 60 km d'avant.
    //
    // La fenêtre s'ouvre là où la cadence du plan pose sa respiration (semaine 4
    // d'un plan démarré le 1ᵉʳ juin). Avant correction, la marche 0,85
    // s'appliquait quand même au pont : cible de 35,6 km **étiquetée `cutback`**,
    // soit +78 % après une semaine à 20 km — et la validation, lisant
    // l'étiquette, considérait la respiration consommée et acceptait quatre
    // hausses derrière.
    const targets = targetsFor(
      // Plan démarré le lundi 15 juin : sa semaine 8 (celle du 3 août) est la
      // respiration du deuxième bloc, et c'est la première semaine pleine de la
      // fenêtre.
      { ...PLAN, startsOn: '2026-06-15', weeks: 16 },
      '2026-07-29',
      [
        { startsOn: '2026-06-29', distanceKm: 58 },
        { startsOn: '2026-07-06', distanceKm: 60 },
        { startsOn: '2026-07-13', distanceKm: 60 },
        { startsOn: '2026-07-20', distanceKm: 20 },
      ],
      { firstWeekStart: '2026-07-27', weeks: 10, firstWeekFromDay: 4 },
    );

    // Une reprise **est déjà** une décharge : elle ne descend pas d'un cran de
    // plus (70 % des 60 km d'avant l'interruption, et pas 85 % de ces 70 %), et
    // elle ne prétend pas être la respiration du bloc.
    expect(targets[1].kind).toBe('build');
    expect(targets[1].targetKm).toBe(41.9);

    // Et la respiration reste due : la reprise rouvre un bloc, dont la quatrième
    // semaine allège pour de bon.
    const cutbacks = targets.flatMap((target, index) => (target.kind === 'cutback' ? [index] : []));
    expect(cutbacks[0]).toBe(4);
    expect(targets[4].targetKm).toBeLessThan(targets[3].targetKm);
  });

  it('défaut 4 — lit la complétude d’une semaine du calendrier, pas de la fenêtre', () => {
    // Un plan **actif mais pas encore démarré** : il commence le lundi 8 juin,
    // on est le mardi 2 juin. C'est un état normal — `acceptDraftPlan` ne vérifie
    // pas `startsOn` — et `remainingPlanWindow` rend alors la fenêtre du plan
    // entier, sans passer par la branche qui découpe.
    //
    // La semaine en cours (celle du 1ᵉʳ juin) est **partielle** : deux jours,
    // 12 km. Avant correction, la complétude se déduisait de la géométrie de la
    // fenêtre (`firstWeekStart > isoWeekStart(today)`), vraie ici, et cette
    // semaine de deux jours était comptée comme la dernière semaine complète —
    // l'ancrage tombait de 42 à 12 km.
    const targets = targetsFor(
      { ...PLAN, startsOn: '2026-06-08' },
      '2026-06-02',
      [
        { startsOn: '2026-05-25', distanceKm: 42 },
        { startsOn: '2026-06-01', distanceKm: 12 },
      ],
      { firstWeekStart: '2026-06-08', weeks: 12, firstWeekFromDay: 1 },
    );

    // L'ancrage reste la semaine du 25 mai, la dernière **révolue** : 42 km, et
    // une seule marche — la semaine du 1ᵉʳ juin est antérieure au plan, elle ne
    // fait franchir aucune marche.
    expect(targets[0].targetKm).toBe(45.3);
  });

  it('ne laisse pas une grosse semaine partielle relever l’ancrage', () => {
    // Le symétrique du défaut 4, et la raison pour laquelle la semaine en cours ne
    // peut que relever *dans la limite de ce que le plan demandait* : sans
    // mémoire du plan, elle relève librement — ce qui reste le comportement voulu
    // quand rien ne dit ce qui était prescrit —, mais elle ne se substitue jamais
    // à la dernière semaine complète quand elle est plus basse.
    const targets = targetsFor(
      PLAN,
      '2026-06-09',
      [
        { startsOn: '2026-06-01', distanceKm: 50 },
        { startsOn: '2026-06-08', distanceKm: 8 },
      ],
      { firstWeekStart: '2026-06-08', weeks: 12, firstWeekFromDay: 3 },
    );

    // 8 km courus lundi et mardi ne disent pas que l'athlète est retombée à 8 km :
    // l'ancrage reste la semaine du 1ᵉʳ juin (50 km), deux marches plus loin.
    expect(targets[1].targetKm).toBe(58.3);
  });
});

/**
 * **L'affûtage part de la dernière semaine de développement du plan, quel que soit
 * le jour où la révision se déclenche.**
 *
 * Une sonde, et le défaut qu'elle ferme est un bloquant : `lastBuild < firstFull`
 * couvre **deux** géométries de fenêtre, et la première rédaction n'en traitait
 * qu'une.
 *
 * - `firstFull = 0`, `taperFrom ≤ 0` : la fenêtre entière est de l'affûtage ;
 * - `firstFull = 1`, `taperFrom = 1` : la fenêtre s'ouvre **en milieu de semaine
 *   sur la dernière semaine de développement**, et l'affûtage occupe le reste.
 *
 * La seconde retombait sur le point de départ de la fenêtre, qui est ici le volume
 * relu d'une semaine **d'affûtage** : les facteurs s'y appliquaient une seconde
 * fois. Sur cette préparation de 16 semaines (mémoire du plan S14 = 59,2 ·
 * S15 = 44,3 · S16 = 32,5), le dimanche rendait 44,3 / 32,5 et le lundi au jeudi
 * 33,1 / 24,3 — **−25 %, soit un facteur 1,44 sur la semaine de course** pour le
 * même plan et la même athlète. En silence : `peakBuildVolume` étant nul sur cette
 * fenêtre, `raceWeekMaxRatio` et la décroissance de l'affûtage étaient toutes deux
 * court-circuitées.
 *
 * Le cas n'a rien d'exotique : la révision partant toutes les quatre séances, elle
 * tombe un autre jour que le dimanche six fois sur sept.
 */
describe('remainingVolumeTargets — l’affûtage d’une fenêtre ouverte en milieu de semaine', () => {
  /** Une préparation de 16 semaines démarrée le lundi 1ᵉʳ juin, course le 20 septembre. */
  const RACE_PLAN: PlanDto = {
    ...ACTIVE_PLAN,
    goalType: 'race',
    intent: 'race',
    goalText: 'semi-marathon en 1 h 45',
    raceDate: '2026-09-20',
    startsOn: '2026-06-01',
    weeks: 16,
    sessionsPerWeek: 5,
    weeklyTimeMinutes: null,
    level: 'intermediate',
  };

  /** La semaine 14 du plan — sa dernière semaine de développement. */
  const LAST_BUILD_WEEK = '2026-08-31';

  /**
   * Ce que le plan porte en mémoire : les quatre dernières semaines chiffrées,
   * dont l'affûtage déjà écrit par la reconstruction précédente.
   */
  const PLANNED = new Map([
    ['2026-08-17', 54.3],
    ['2026-08-24', 58.6],
    [LAST_BUILD_WEEK, 59.2],
    ['2026-09-07', 44.3],
    ['2026-09-14', 32.5],
  ]);

  /** Les cibles d'une révision déclenchée le jour ISO `triggerDay` de la semaine 14. */
  function targetsOn(triggerDay: number): WeeklyVolumeTarget[] {
    const today = shiftDays(LAST_BUILD_WEEK, triggerDay - 1);
    const window = remainingPlanWindow(RACE_PLAN, shiftDays(today, 1));
    // L'athlète a couru son plan ; la semaine en cours l'est au prorata des jours.
    const weeks = [3, 2, 1, 0].map((age) => {
      const startsOn = shiftDays(LAST_BUILD_WEEK, -7 * age);
      const full = PLANNED.get(startsOn) ?? 0;
      const distanceKm = age === 0 ? (full * triggerDay) / 7 : full;
      return { startsOn, distanceKm, movingTimeS: Math.round(distanceKm * 324), sessions: 4 };
    });

    return remainingVolumeTargets(
      RACE_PLAN,
      window,
      { ...SNAPSHOT, today, weeks },
      { sessionsPerWeek: 5, longRunDay: 7, weeklyTimeMinutes: null },
      null,
      PLANNED,
    );
  }

  it.each([1, 2, 3, 4, 5, 6])(
    'rend l’affûtage du plan quand la révision part le jour %i',
    (triggerDay) => {
      const targets = targetsOn(triggerDay);

      // Trois semaines : la 14 entamée, puis l'affûtage et la course.
      expect(targets.map((target) => target.kind)).toEqual(['partial', 'taper', 'race']);
      expect(targets[1].targetKm).toBe(44.3);
      expect(targets[2].targetKm).toBe(32.5);
    },
  );

  it('rend le même affûtage qu’un déclenchement du dimanche', () => {
    // Le dimanche, la fenêtre s'ouvre sur la semaine d'affûtage : `firstFull = 0`
    // et `taperFrom = 0`, la géométrie que le code traitait déjà.
    const sunday = targetsOn(7);

    expect(sunday.map((target) => target.targetKm)).toEqual([44.3, 32.5]);
  });

  it('sans course, laisse l’ancrage réel décider de la dernière semaine', () => {
    // La borne de la branche : `lastBuild < firstFull` est aussi vrai d'un plan
    // **sans course** dont on révise la dernière semaine en milieu de semaine
    // (`planTaperWeeks = 0`, donc `lastBuild = weeks - 1 = 0` quand la fenêtre ne
    // fait qu'une semaine). La mémoire du plan n'a là aucun titre à se substituer
    // à ce que l'athlète a réellement couru : sans le garde-fou, une athlète à
    // l'arrêt depuis un mois recevait **34,2 km sur quatre jours** — les 60 km que
    // le plan avait prescrits, proratisés — au lieu du repli prudent du niveau.
    const plan: PlanDto = {
      ...ACTIVE_PLAN,
      goalType: 'free',
      intent: 'faster',
      goalText: 'reprendre le volume',
      raceDate: null,
      startsOn: '2026-06-01',
      weeks: 12,
      weeklyTimeMinutes: null,
      level: 'intermediate',
    };

    const targets = remainingVolumeTargets(
      plan,
      { firstWeekStart: '2026-08-17', weeks: 1, firstWeekFromDay: 4 },
      {
        ...SNAPSHOT,
        today: '2026-08-19',
        weeks: ['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17'].map((startsOn) => ({
          startsOn,
          distanceKm: 0,
          movingTimeS: 0,
          sessions: 0,
        })),
      },
      { sessionsPerWeek: 5, longRunDay: 7, weeklyTimeMinutes: null },
      null,
      new Map([['2026-08-17', 60]]),
    );

    // Le départ prudent du niveau (24 km), une marche en dessous parce que la
    // semaine entamée précède la première semaine pleine, sur quatre jours.
    expect(targets).toEqual([{ targetKm: 12.6, targetMinutes: 68, kind: 'partial' }]);
  });

  it('proratise la semaine 14 sur son propre volume, pas sur celui de l’affûtage', () => {
    // Elle **est** la dernière semaine de développement du plan : sa valeur pleine
    // est 59,2 km, dont les six jours qui restent au lendemain d'un lundi —
    // 50,7 km. Avant correction, elle partait de 44,3 (le volume d'affûtage relu)
    // divisé par la marche de la cadence, soit 41,0 km.
    expect(targetsOn(1)[0].targetKm).toBe(50.7);
  });
});
