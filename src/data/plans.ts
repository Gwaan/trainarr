import 'server-only';

import { and, asc, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';

import { isoWeekStart, shiftCivilDate } from '@/lib/dates/civil';
import {
  InvalidRacePerformanceError,
  REFERENCE_DISTANCES,
  vdotFromRace,
} from '@/lib/metrics/vdot';
import type { PlanIntent } from '@/lib/plan-skeleton/intent';
import {
  planSessionStepsSchema,
  sessionStepsTotals,
  type PlanSessionSteps,
} from '@/lib/plan-steps/schema';

import { AthleteNotFoundError, getAthleteId, isCivilDate, todayCivilDate } from './athlete';
import { db } from './db/client';
import { isUniqueViolation } from './db/errors';
import {
  PLAN_GOAL_TYPES,
  PLAN_INTENTS,
  PLAN_LEVELS,
  PLAN_REFERENCE_DISTANCES,
  plannedSessions,
  plans,
  type NewPlan,
  type NewPlannedSession,
  type Plan,
  type PlanGoalType,
  type PlanLevel,
  type PlanReferenceDistance,
  type PlanStatus,
  type PlannedSession,
} from './db/schema';

/**
 * Plans d'entraînement : proposition par le coach, validation par l'athlète,
 * lecture par l'UI, régénération partielle quand l'athlète change ses
 * contraintes en cours de route.
 *
 * Trois règles structurent tout ce module :
 *
 * 1. **Le coach propose, l'athlète dispose.** Une génération écrit un plan
 *    `draft` et ne touche à rien d'autre : le plan en cours reste le plan en
 *    cours tant que la proposition n'est pas adoptée ({@link acceptDraftPlan}),
 *    et la refuser ({@link discardDraftPlan}) ne laisse aucune trace. Au plus un
 *    brouillon par athlète : en écrire un efface le précédent, et la base le
 *    garantit aussi (index partiel `plans_draft_per_athlete`).
 * 2. **Un seul plan actif par athlète.** La base le garantit (index partiel
 *    `plans_active_per_athlete`) ; ici, **adopter** une proposition archive le
 *    plan actif dans la même transaction, et emporte avec lui ses séances encore
 *    à venir — sans quoi elles continueraient d'apparaître au calendrier et au
 *    tableau de bord.
 * 3. **Le passé ne se réécrit pas.** Une régénération ne touche qu'aux séances
 *    futures encore non réalisées : une séance rapprochée d'une activité
 *    (`completedActivityId`) survit à toute instruction du coach.
 */

/**
 * DTO d'un plan.
 *
 * Déclaré explicitement (pas de `typeof row`) : ajouter une colonne au schéma ne
 * doit jamais l'élargir en silence. `athleteId` n'en fait pas partie — mono-
 * utilisateur ou non, un identifiant d'athlète ne franchit pas la frontière
 * client. `id`, lui, y est : c'est la poignée que l'UI renvoie aux actions de
 * modification (chaque appel revérifie l'appartenance, cf. `PlanNotFoundError`).
 */
export type PlanDto = {
  id: number;
  status: PlanStatus;
  goalType: PlanGoalType;
  /**
   * Ce que l'athlète est venue chercher : c'est ce qui décide de la forme du
   * plan, et ce que la page affiche en titre. Solidaire de `goalType`
   * (`intent === 'race'` ⇔ `goalType === 'race'`).
   */
  intent: PlanIntent;
  /** Antécédent de blessure déclaré — ne joue qu'en reprise, `false` ailleurs. */
  returnInjuryHistory: boolean;
  /**
   * Niveau déclaré à la création, `null` sur les plans antérieurs à ce champ —
   * l'UI et le coach s'en passent alors plutôt que d'en supposer un.
   */
  level: PlanLevel | null;
  /**
   * Note libre de l'athlète, telle qu'elle l'a écrite — **facultative** depuis
   * que le sélecteur d'intention a remplacé l'objectif en texte libre. Chaîne
   * vide quand elle n'a rien noté.
   */
  goalText: string;
  /** Date civile `YYYY-MM-DD`, renseignée pour un objectif `race` uniquement. */
  raceDate: string | null;
  /** Date civile `YYYY-MM-DD` du premier jour couvert. */
  startsOn: string;
  weeks: number;
  sessionsPerWeek: number;
  weeklyTimeMinutes: number | null;
  /** Jour de la sortie longue au format ISO : 1 = lundi … 7 = dimanche. */
  longRunDay: number;
  /**
   * Chrono de course déclaré à la création : distance et temps (en secondes),
   * les deux ensemble ou les deux `null`. C'est l'ancre des allures du plan —
   * l'UI l'affiche pour que l'athlète sache sur quoi son plan est calé.
   */
  referenceDistance: PlanReferenceDistance | null;
  referenceTimeS: number | null;
  /**
   * Date civile `YYYY-MM-DD` de la dernière mise à jour du chrono de référence
   * par un test chronométré, `null` quand aucun test ne l'a fait bouger.
   */
  referenceUpdatedOn: string | null;
  /**
   * Ce que le dernier test a donné, en une phrase — `null` tant qu'il n'y en a
   * pas eu. Affichée telle quelle sur la page du plan, quel que soit le verdict.
   */
  lastTestNote: string | null;
  summary: string | null;
  /**
   * Dernière révision automatique du plan par le coach, sérialisée en ISO-8601,
   * `null` tant qu'il n'y en a pas eu.
   *
   * Le compte de séances qui va avec (`reviewed_session_count`) reste en base :
   * c'est l'état d'un service, il n'a rien à faire côté client. Cet instant-là,
   * si — c'est ce qui permet à la page du plan de dire quand le coach l'a relu.
   */
  reviewedAt: string | null;
  /** Instant de création, sérialisé en ISO-8601 (le DTO traverse la frontière client). */
  createdAt: string;
};

/** DTO d'une séance planifiée, telle que le calendrier du plan l'affiche. */
export type PlanSessionDto = {
  id: number;
  /** Date civile `YYYY-MM-DD`. */
  scheduledOn: string;
  /** Ex. « VMA courte · piste ». */
  kind: string;
  /** Ex. « 6 × 800 m ». */
  title: string;
  warmup: string | null;
  recovery: string | null;
  cooldown: string | null;
  targetPaceSecPerKm: number | null;
  volumeM: number | null;
  durationS: number | null;
  /**
   * Déroulé structuré de la séance, `null` quand elle n'en a pas.
   *
   * Sa place dans le DTO est légitime : c'est de l'affichage (le détail de la
   * séance), pas de l'interne — et `lib/plan-steps/schema` est un module pur,
   * donc importable par un composant client.
   */
  steps: PlanSessionSteps | null;
  /** Activité qui a réalisé la séance, `null` tant qu'elle ne l'est pas. */
  completedActivityId: number | null;
};

/**
 * Une séance telle que le coach la propose.
 *
 * Ni `id`, ni `planId`, ni `athleteId` : ces trois-là sont portés par le DAL, et
 * c'est ce qui rend impossible d'écrire une séance dans le plan d'un autre.
 */
export type NewPlanSessionInput = {
  /** Date civile `YYYY-MM-DD`, dans la fenêtre du plan. */
  scheduledOn: string;
  kind: string;
  title: string;
  warmup?: string | null;
  recovery?: string | null;
  cooldown?: string | null;
  targetPaceSecPerKm?: number | null;
  volumeM?: number | null;
  durationS?: number | null;
  /**
   * Déroulé structuré, si le coach en propose un. Validé par
   * {@link planSessionStepsSchema} avant toute écriture.
   */
  steps?: PlanSessionSteps | null;
};

/** Le plan tel que le coach le soumet à la création. */
export type CreatePlanInput = {
  goalType: PlanGoalType;
  /** Requis : c'est l'intention qui décide de la structure du plan. */
  intent: PlanIntent;
  /** Facultatif, et sans effet hors reprise (cf. {@link validatePlanInput}). */
  returnInjuryHistory?: boolean;
  /** Requis : un plan créé aujourd'hui se cale toujours sur un niveau déclaré. */
  level: PlanLevel;
  /** Note libre, facultative : chaîne vide acceptée. */
  goalText: string;
  raceDate?: string | null;
  startsOn: string;
  weeks: number;
  sessionsPerWeek: number;
  weeklyTimeMinutes?: number | null;
  longRunDay: number;
  /** Chrono de référence : les deux champs ensemble, ou aucun des deux. */
  referenceDistance?: PlanReferenceDistance | null;
  referenceTimeS?: number | null;
  summary?: string | null;
  sessions: NewPlanSessionInput[];
};

/** Même chose, une fois les facultatifs normalisés en `null`. */
export type ValidatedPlanInput = {
  goalType: PlanGoalType;
  intent: PlanIntent;
  returnInjuryHistory: boolean;
  level: PlanLevel;
  goalText: string;
  raceDate: string | null;
  startsOn: string;
  weeks: number;
  sessionsPerWeek: number;
  weeklyTimeMinutes: number | null;
  longRunDay: number;
  referenceDistance: PlanReferenceDistance | null;
  referenceTimeS: number | null;
  summary: string | null;
  sessions: NewPlanSessionInput[];
};

/**
 * Les réglages qu'une instruction (« plutôt 3 séances ») peut faire bouger.
 *
 * Le niveau n'en fait volontairement pas partie : il fonde la méthodologie de
 * tout le plan, pas seulement de sa suite. En changer, c'est régénérer un plan.
 */
export type PlanSettingsPatch = {
  sessionsPerWeek?: number;
  /** `null` efface la contrainte de temps hebdomadaire. */
  weeklyTimeMinutes?: number | null;
  longRunDay?: number;
  /** `null` efface l'approche rédigée. */
  summary?: string | null;
  /**
   * Le **chrono de référence** mis à jour par un test chronométré, avec la date
   * de cette mise à jour — les trois vont ensemble ou aucun ne bouge.
   *
   * Sa place ici n'est pas cosmétique : un chrono de référence qui changerait
   * hors de la transaction qui réécrit les séances laisserait, entre les deux
   * écritures, un plan dont les allures ne viennent pas du chrono qu'il affiche.
   * C'est exactement l'invariant que {@link applyPlanUpdate} existe pour tenir.
   */
  referenceDistance?: PlanReferenceDistance;
  referenceTimeS?: number;
  /** Date civile de la mise à jour, qui porte la cadence de Daniels. */
  referenceUpdatedOn?: string;
  /** Ce que le dernier test a donné, en une phrase pour l'athlète. */
  lastTestNote?: string;
};

/**
 * Bornes d'un plan.
 *
 * Source unique : la Server Action construira son schéma Zod dessus, et le DAL
 * les re-vérifie (défense en profondeur — une action n'est pas la seule porte
 * d'entrée possible, le coach IA écrit ici lui aussi).
 */
export const PLAN_LIMITS = {
  weeks: { min: 1, max: 104 },
  sessionsPerWeek: { min: 1, max: 7 },
  /** Jour ISO de la sortie longue : 1 = lundi … 7 = dimanche. */
  longRunDay: { min: 1, max: 7 },
  /** Une semaine ne contient que 10 080 minutes — au-delà, c'est une saisie erronée. */
  weeklyTimeMinutes: { min: 1, max: 10_080 },
  /**
   * Chrono de référence, en secondes : de 4 min (un 1 500 m rapide, sous la
   * borne du modèle VDOT de toute façon) à 10 h (un marathon marché). C'est un
   * garde-fou de saisie ; la plausibilité, elle, est tranchée par `vdotFromRace`.
   */
  referenceTimeS: { min: 240, max: 36_000 },
} as const;

/** Champ d'un plan mis en cause par {@link InvalidPlanError}. */
export type PlanInputField =
  | 'goalType'
  | 'intent'
  | 'level'
  | 'goalText'
  | 'raceDate'
  | 'startsOn'
  | 'weeks'
  | 'sessionsPerWeek'
  | 'weeklyTimeMinutes'
  | 'longRunDay'
  | 'referenceDistance'
  | 'referenceTimeS'
  | 'sessions';

/*
 * Erreurs métier — nommées, pour que l'appelant (Server Action, outil du coach)
 * distingue le cas attendu de la panne, sans jamais inspecter un message.
 */

/** Une valeur du plan est hors bornes ou incohérente. `field` désigne le fautif. */
export class InvalidPlanError extends Error {
  constructor(
    readonly field: PlanInputField,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidPlanError';
  }
}

/**
 * Le plan visé n'existe pas, n'appartient pas à l'athlète, ou n'est pas dans
 * l'état qu'exigeait l'opération (actif pour un ajustement, brouillon pour une
 * décision).
 *
 * Les trois cas partagent volontairement la même erreur : distinguer « il existe
 * mais il n'est pas à toi » de « il n'existe pas » révélerait l'existence de la
 * ligne (anti-IDOR).
 */
export class PlanNotFoundError extends Error {
  constructor() {
    super("Aucun plan ne correspond : il n'existe pas, ou il a changé d'état.");
    this.name = 'PlanNotFoundError';
  }
}

/**
 * Deux générations ont voulu écrire une proposition en même temps, et l'index
 * partiel `plans_draft_per_athlete` a tranché.
 *
 * C'est le comportement voulu : en `READ COMMITTED`, la transaction perdante ne
 * voit pas le brouillon que l'autre vient d'insérer, donc son `DELETE`
 * préalable ne l'emporte pas — sans contrainte, elle laisserait un second
 * brouillon que plus rien ne distingue. Mieux vaut une génération qui échoue en
 * le disant qu'un doublon silencieux dont la lecture montrerait l'un ou l'autre.
 */
export class ConcurrentDraftError extends Error {
  constructor() {
    super(
      "Une autre génération vient d'écrire une proposition : recharge la page pour la voir avant d'en relancer une.",
    );
    this.name = 'ConcurrentDraftError';
  }
}

/*
 * Mapping vers les DTOs.
 */

export function toPlanDto(row: Plan): PlanDto {
  return {
    id: row.id,
    status: row.status,
    goalType: row.goalType,
    intent: row.intent,
    returnInjuryHistory: row.returnInjuryHistory,
    level: row.level,
    goalText: row.goalText,
    raceDate: row.raceDate,
    startsOn: row.startsOn,
    weeks: row.weeks,
    sessionsPerWeek: row.sessionsPerWeek,
    weeklyTimeMinutes: row.weeklyTimeMinutes,
    longRunDay: row.longRunDay,
    referenceDistance: row.referenceDistance,
    referenceTimeS: row.referenceTimeS,
    referenceUpdatedOn: row.referenceUpdatedOn,
    lastTestNote: row.lastTestNote,
    summary: row.summary,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPlanSessionDto(row: PlannedSession): PlanSessionDto {
  return {
    id: row.id,
    scheduledOn: row.scheduledOn,
    kind: row.kind,
    title: row.title,
    warmup: row.warmup,
    recovery: row.recovery,
    cooldown: row.cooldown,
    targetPaceSecPerKm: row.targetPaceSecPerKm,
    volumeM: row.volumeM,
    durationS: row.durationS,
    steps: row.steps,
    completedActivityId: row.completedActivityId,
  };
}

/*
 * Validation (défense en profondeur), fonctions pures exportées pour les tests.
 */

function requireIntegerInRange(
  value: number,
  field: PlanInputField,
  bounds: { min: number; max: number },
  label: string,
): void {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new InvalidPlanError(
      field,
      `${label} : entier attendu entre ${bounds.min} et ${bounds.max}.`,
    );
  }
}

/**
 * Premier jour **non** couvert par le plan.
 *
 * Compté depuis l'**ancre** — le lundi de la semaine de `startsOn` — et non
 * depuis `startsOn` lui-même : les `weeks` d'un plan sont des semaines ISO, et un
 * programme démarré un jeudi n'ouvre qu'une première semaine entamée. Compter
 * `weeks × 7` jours à partir du jeudi étirerait la fenêtre de trois jours au-delà
 * du dernier dimanche du plan.
 *
 * La fenêtre des séances reste `[startsOn, planEndExclusive)` : rien avant le
 * jour du départ, rien après le dimanche de la dernière semaine.
 */
export function planEndExclusive(startsOn: string, weeks: number): string {
  return shiftCivilDate(isoWeekStart(startsOn), weeks * 7);
}

/**
 * Étapes de la séance, validées et normalisées, `null` si elle n'en porte pas.
 *
 * Le retour du parse est ce qui part en base, jamais l'objet d'entrée : Zod en
 * retire les clés inconnues, et ce JSON vient du modèle — une clé inventée n'a
 * rien à faire dans la colonne.
 *
 * @throws {InvalidPlanError}
 */
function parseSessionSteps(session: NewPlanSessionInput): PlanSessionSteps | null {
  const steps = session.steps ?? null;
  if (steps === null) return null;

  const parsed = planSessionStepsSchema.safeParse(steps);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? '' : issue.path.join('.');
    throw new InvalidPlanError(
      'sessions',
      `Séance du ${session.scheduledOn} : déroulé invalide${path.length > 0 ? ` (${path})` : ''} — ${issue?.message ?? 'structure inattendue'}`,
    );
  }

  return parsed.data;
}

/**
 * Vérifie que chaque séance tombe dans la fenêtre du plan et porte ses textes
 * obligatoires.
 *
 * Le plancher est le jour de départ **réel** : sur un plan démarré en milieu de
 * semaine, les jours du lundi de l'ancre à la veille du départ appartiennent à la
 * grille des semaines mais pas au plan, et aucune séance ne peut s'y poser.
 *
 * @param notBefore date civile plancher supplémentaire — le `fromDate` d'une
 * régénération, qui interdit de réécrire une journée déjà passée.
 * @throws {InvalidPlanError}
 */
export function validatePlanSessions(
  sessions: readonly NewPlanSessionInput[],
  window: { startsOn: string; weeks: number },
  notBefore?: string,
): void {
  const endExclusive = planEndExclusive(window.startsOn, window.weeks);
  const floor = notBefore !== undefined && notBefore > window.startsOn ? notBefore : window.startsOn;

  for (const session of sessions) {
    if (!isCivilDate(session.scheduledOn)) {
      throw new InvalidPlanError('sessions', 'Séance : date au format AAAA-MM-JJ attendue.');
    }
    // Comparaison lexicographique : sur des dates civiles `YYYY-MM-DD` bien
    // formées, elle coïncide avec l'ordre chronologique.
    if (session.scheduledOn < floor || session.scheduledOn >= endExclusive) {
      throw new InvalidPlanError(
        'sessions',
        `Séance du ${session.scheduledOn} : hors de la fenêtre du plan (${floor} → ${endExclusive} exclu).`,
      );
    }
    if (session.kind.trim().length === 0 || session.title.trim().length === 0) {
      throw new InvalidPlanError('sessions', 'Séance : type et intitulé sont requis.');
    }
    // Le déroulé structuré est éprouvé ici, avant la moindre écriture — la
    // valeur retenue, elle, est reparsée au moment de construire la ligne.
    parseSessionSteps(session);
  }
}

/** Le chrono de référence, normalisé — les deux champs, ou aucun des deux. */
type ValidatedReferenceRace = {
  referenceDistance: PlanReferenceDistance | null;
  referenceTimeS: number | null;
};

/**
 * Vérifie le chrono de référence : la paire est complète ou absente, le temps
 * tient dans des bornes de saisie, et le couple décrit **une course**.
 *
 * Cette dernière vérification est déléguée à `vdotFromRace` plutôt que réécrite :
 * c'est la même fonction qui calculera la table d'allures, donc un chrono accepté
 * ici produira toujours une table. Un `InvalidRacePerformanceError` devient une
 * erreur de champ lisible — la formulation est celle du formulaire, puisque c'est
 * là qu'elle s'affiche.
 *
 * @throws {InvalidPlanError}
 */
export function validateReferenceRace(input: {
  referenceDistance?: PlanReferenceDistance | null;
  referenceTimeS?: number | null;
}): ValidatedReferenceRace {
  const referenceDistance = input.referenceDistance ?? null;
  const referenceTimeS = input.referenceTimeS ?? null;

  if (referenceDistance === null && referenceTimeS === null) {
    return { referenceDistance: null, referenceTimeS: null };
  }
  if (referenceDistance === null) {
    throw new InvalidPlanError(
      'referenceDistance',
      'Chrono de référence : indique aussi la distance courue.',
    );
  }
  if (!PLAN_REFERENCE_DISTANCES.includes(referenceDistance)) {
    throw new InvalidPlanError('referenceDistance', 'Distance de référence inattendue.');
  }
  if (referenceTimeS === null) {
    throw new InvalidPlanError(
      'referenceTimeS',
      'Chrono de référence : indique aussi le temps réalisé.',
    );
  }
  requireIntegerInRange(
    referenceTimeS,
    'referenceTimeS',
    PLAN_LIMITS.referenceTimeS,
    'Chrono de référence (secondes)',
  );

  try {
    vdotFromRace(REFERENCE_DISTANCES[referenceDistance], referenceTimeS);
  } catch (error) {
    if (error instanceof InvalidRacePerformanceError) {
      throw new InvalidPlanError(
        'referenceTimeS',
        'Ce chrono ne ressemble pas à une course — vérifie la saisie.',
      );
    }
    throw error;
  }

  return { referenceDistance, referenceTimeS };
}

/**
 * Vérifie les invariants du plan et retourne l'entrée normalisée (facultatifs en
 * `null`, textes détourés).
 *
 * @throws {InvalidPlanError} au premier champ fautif.
 */
export function validatePlanInput(input: CreatePlanInput): ValidatedPlanInput {
  if (!PLAN_GOAL_TYPES.includes(input.goalType)) {
    throw new InvalidPlanError('goalType', "Type d'objectif inattendu.");
  }

  if (!PLAN_INTENTS.includes(input.intent)) {
    throw new InvalidPlanError('intent', 'Intention inattendue : choisis ce que tu veux préparer.');
  }

  // Les deux colonnes disent la même chose, l'une pour la structure du plan,
  // l'autre pour ce qui le date : les laisser diverger ferait un plan daté sans
  // affûtage, ou un affûtage sans jour J.
  if ((input.intent === 'race') !== (input.goalType === 'race')) {
    throw new InvalidPlanError(
      'intent',
      "Incohérence : seule l'intention « course » porte un objectif daté.",
    );
  }

  // Le niveau n'a pas de valeur de repli : un plan calé sur un niveau supposé
  // serait faux sans le dire.
  if (!PLAN_LEVELS.includes(input.level)) {
    throw new InvalidPlanError('level', 'Niveau inattendu : choisis ton niveau en course.');
  }

  // Facultative depuis le sélecteur d'intention : c'est lui qui dit ce que
  // l'athlète prépare, la note n'ajoute qu'un détail quand elle en a un.
  const goalText = input.goalText.trim();

  const raceDate = input.raceDate ?? null;
  if (input.goalType === 'race') {
    if (raceDate === null) {
      throw new InvalidPlanError('raceDate', 'Un objectif « course » exige la date de la course.');
    }
    if (!isCivilDate(raceDate)) {
      throw new InvalidPlanError('raceDate', 'Date de course : format AAAA-MM-JJ attendu.');
    }
  } else if (raceDate !== null) {
    // Un objectif libre n'a pas d'échéance : accepter la date la ferait passer
    // pour une course dans toutes les lectures ultérieures.
    throw new InvalidPlanError('raceDate', 'Un objectif libre ne porte pas de date de course.');
  }

  if (!isCivilDate(input.startsOn)) {
    throw new InvalidPlanError('startsOn', 'Début du plan : format AAAA-MM-JJ attendu.');
  }

  requireIntegerInRange(input.weeks, 'weeks', PLAN_LIMITS.weeks, 'Durée du plan (semaines)');
  requireIntegerInRange(
    input.sessionsPerWeek,
    'sessionsPerWeek',
    PLAN_LIMITS.sessionsPerWeek,
    'Séances par semaine',
  );
  requireIntegerInRange(
    input.longRunDay,
    'longRunDay',
    PLAN_LIMITS.longRunDay,
    'Jour de la sortie longue',
  );

  const weeklyTimeMinutes = input.weeklyTimeMinutes ?? null;
  if (weeklyTimeMinutes !== null) {
    requireIntegerInRange(
      weeklyTimeMinutes,
      'weeklyTimeMinutes',
      PLAN_LIMITS.weeklyTimeMinutes,
      'Temps hebdomadaire (minutes)',
    );
  }

  const referenceRace = validateReferenceRace(input);

  if (input.sessions.length === 0) {
    throw new InvalidPlanError('sessions', 'Un plan sans aucune séance ne planifie rien.');
  }
  validatePlanSessions(input.sessions, { startsOn: input.startsOn, weeks: input.weeks });

  return {
    goalType: input.goalType,
    intent: input.intent,
    // Hors reprise, l'antécédent ne joue sur rien (cf. `intent.ts`) : le
    // stocker à `true` écrirait une donnée qui ne veut rien dire, et qu'une
    // lecture ultérieure prendrait pour un fait.
    returnInjuryHistory: input.intent === 'return' && (input.returnInjuryHistory ?? false),
    level: input.level,
    goalText,
    raceDate,
    startsOn: input.startsOn,
    weeks: input.weeks,
    sessionsPerWeek: input.sessionsPerWeek,
    weeklyTimeMinutes,
    longRunDay: input.longRunDay,
    referenceDistance: referenceRace.referenceDistance,
    referenceTimeS: referenceRace.referenceTimeS,
    summary: input.summary ?? null,
    sessions: input.sessions,
  };
}

/** Valeurs d'insertion d'une séance : le DAL seul décide de `planId` et `athleteId`. */
function toPlannedSessionValues(
  session: NewPlanSessionInput,
  athleteId: number,
  planId: number,
): NewPlannedSession {
  const steps = parseSessionSteps(session);
  // Volume et durée déclarés priment, même s'ils s'écartent des totaux du
  // déroulé : « ~12 km » pour 12,4 km est un arrondi de coach, pas une erreur, et
  // le corriger reviendrait à réécrire ce qui est affiché à l'athlète. En
  // revanche, quand ils manquent, on les dérive des étapes plutôt que de laisser
  // la séance sans volume : une somme d'étapes déclarées est une donnée
  // *dérivée*, pas une métrique inventée (`sessionStepsTotals` rend `null` dès
  // qu'il faudrait supposer une allure).
  const totals = steps === null ? null : sessionStepsTotals(steps);

  return {
    athleteId,
    planId,
    scheduledOn: session.scheduledOn,
    kind: session.kind,
    title: session.title,
    warmup: session.warmup ?? null,
    recovery: session.recovery ?? null,
    cooldown: session.cooldown ?? null,
    targetPaceSecPerKm: session.targetPaceSecPerKm ?? null,
    volumeM: session.volumeM ?? totals?.distanceM ?? null,
    durationS: session.durationS ?? totals?.durationS ?? null,
    steps,
  };
}

/*
 * Lectures.
 */

/** Un plan et ses séances, tel que l'UI l'affiche. */
export type PlanWithSessions = { plan: PlanDto; sessions: PlanSessionDto[] };

/**
 * Le plan de l'athlète dans l'état demandé, avec ses séances ordonnées dans le
 * temps. `null` s'il n'y en a pas — ou si l'onboarding n'a pas encore eu lieu.
 *
 * Le statut est toujours dans le `WHERE` : c'est lui qui garantit qu'un
 * brouillon ne sorte jamais par la porte du plan actif (et réciproquement).
 */
async function getPlanWithSessions(status: PlanStatus): Promise<PlanWithSessions | null> {
  const athleteId = await getAthleteId();
  if (athleteId === null) return null;

  const planRows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.athleteId, athleteId), eq(plans.status, status)))
    // Ceinture et bretelles : les deux index partiels rendent la ligne unique
    // pour `active` comme pour `draft`, mais un `LIMIT 1` sans ordre choisirait
    // au hasard si l'un d'eux venait à manquer. Le plus récent fait foi.
    .orderBy(desc(plans.createdAt), desc(plans.id))
    .limit(1);

  const plan = planRows[0];
  if (!plan) return null;

  const sessionRows = await db
    .select()
    .from(plannedSessions)
    .where(eq(plannedSessions.planId, plan.id))
    // `id` en second : deux séances peuvent tomber le même jour, l'ordre
    // d'affichage doit rester stable d'un rendu à l'autre.
    .orderBy(asc(plannedSessions.scheduledOn), asc(plannedSessions.id));

  return { plan: toPlanDto(plan), sessions: sessionRows.map(toPlanSessionDto) };
}

/**
 * Le plan **actif** et ses séances, `null` s'il n'y en a pas.
 *
 * C'est la seule lecture que le reste de l'appli utilise (page du plan,
 * ajustement, synchronisation intervals.icu) : une proposition en attente n'en
 * sort jamais.
 */
export function getActivePlanWithSessions(): Promise<PlanWithSessions | null> {
  return getPlanWithSessions('active');
}

/**
 * La **proposition** du coach en attente de décision, `null` s'il n'y en a pas.
 *
 * Lecture réservée à l'écran qui la soumet à l'athlète : tant qu'elle n'est pas
 * adoptée, ce plan ne pilote rien.
 */
export function getDraftPlanWithSessions(): Promise<PlanWithSessions | null> {
  return getPlanWithSessions('draft');
}

/**
 * La séance planifiée qu'une activité a réalisée, `null` si l'activité n'a pas
 * été rapprochée d'une séance.
 *
 * Le filtre porte aussi sur `athleteId` : un id d'activité venu du client ne
 * doit pas pouvoir révéler la séance d'un autre athlète.
 */
export async function getPlannedSessionForActivity(
  activityId: number,
): Promise<PlanSessionDto | null> {
  const athleteId = await getAthleteId();
  if (athleteId === null) return null;

  const rows = await db
    .select()
    .from(plannedSessions)
    .where(
      and(
        eq(plannedSessions.completedActivityId, activityId),
        eq(plannedSessions.athleteId, athleteId),
      ),
    )
    .limit(1);

  const row = rows[0];
  return row ? toPlanSessionDto(row) : null;
}

/*
 * Écritures.
 *
 * Les helpers ci-dessous portent les invariants une seule fois : chaque écriture
 * publique les compose, seule ou au sein d'une transaction plus large.
 */

/**
 * Poignée d'écriture : le client, ou la transaction en cours.
 *
 * Dérivée du client plutôt qu'importée des types internes de Drizzle — ses
 * génériques (schéma, driver) suivent alors `db` sans être recopiés ici.
 */
type PlanWriter = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lit le plan en exigeant qu'il soit celui, actif, de l'athlète.
 *
 * @throws {PlanNotFoundError} sinon — les trois causes possibles (inexistant,
 * pas à lui, archivé) partagent la même erreur (anti-IDOR).
 */
async function requireActivePlan(
  tx: PlanWriter,
  planId: number,
  athleteId: number,
): Promise<Plan> {
  const rows = await tx
    .select()
    .from(plans)
    .where(
      and(eq(plans.id, planId), eq(plans.athleteId, athleteId), eq(plans.status, 'active')),
    )
    .limit(1);

  const plan = rows[0];
  if (!plan) throw new PlanNotFoundError();
  return plan;
}

/**
 * Supprime les séances des plans donnés à partir de `fromDate`, **sauf celles
 * déjà rapprochées d'une activité**.
 *
 * C'est la forme unique de la règle « le passé ne se réécrit pas » : elle sert la
 * régénération d'un plan comme le nettoyage d'un plan qu'on archive.
 */
async function deleteUpcomingSessions(
  tx: PlanWriter,
  planIds: readonly number[],
  fromDate: string,
): Promise<void> {
  if (planIds.length === 0) return;

  await tx
    .delete(plannedSessions)
    .where(
      and(
        inArray(plannedSessions.planId, planIds),
        gte(plannedSessions.scheduledOn, fromDate),
        isNull(plannedSessions.completedActivityId),
      ),
    );
}

/**
 * Supprime les séances du plan **antérieures** à `beforeDate`.
 *
 * Symétrique de {@link deleteUpcomingSessions}, mais sans sa garde sur le
 * rapprochement : l'appelant est l'adoption d'une proposition, et un brouillon
 * n'a jamais de séance rapprochée (le rapprochement ignore les plans non
 * actifs). Il n'y a donc rien à préserver dans ce passé-là.
 */
async function deletePastSessions(
  tx: PlanWriter,
  planId: number,
  beforeDate: string,
): Promise<void> {
  await tx
    .delete(plannedSessions)
    .where(and(eq(plannedSessions.planId, planId), lt(plannedSessions.scheduledOn, beforeDate)));
}

/** Remplace la suite du plan : validation de la fenêtre, purge, réinsertion. */
async function replacePlanSessions(
  tx: PlanWriter,
  plan: Plan,
  fromDate: string,
  sessions: readonly NewPlanSessionInput[],
): Promise<void> {
  validatePlanSessions(sessions, { startsOn: plan.startsOn, weeks: plan.weeks }, fromDate);

  await deleteUpcomingSessions(tx, [plan.id], fromDate);

  if (sessions.length > 0) {
    await tx
      .insert(plannedSessions)
      .values(sessions.map((session) => toPlannedSessionValues(session, plan.athleteId, plan.id)));
  }
}

/**
 * Traduit un patch de réglages en valeurs de colonnes, bornes vérifiées.
 *
 * Fonction pure : elle échoue avant toute écriture.
 *
 * @throws {InvalidPlanError} si une valeur du patch est hors bornes.
 */
function toPlanSettingsValues(patch: PlanSettingsPatch): Partial<NewPlan> {
  const values: Partial<NewPlan> = {};

  if (patch.sessionsPerWeek !== undefined) {
    requireIntegerInRange(
      patch.sessionsPerWeek,
      'sessionsPerWeek',
      PLAN_LIMITS.sessionsPerWeek,
      'Séances par semaine',
    );
    values.sessionsPerWeek = patch.sessionsPerWeek;
  }

  if (patch.weeklyTimeMinutes !== undefined) {
    if (patch.weeklyTimeMinutes !== null) {
      requireIntegerInRange(
        patch.weeklyTimeMinutes,
        'weeklyTimeMinutes',
        PLAN_LIMITS.weeklyTimeMinutes,
        'Temps hebdomadaire (minutes)',
      );
    }
    values.weeklyTimeMinutes = patch.weeklyTimeMinutes;
  }

  if (patch.longRunDay !== undefined) {
    requireIntegerInRange(
      patch.longRunDay,
      'longRunDay',
      PLAN_LIMITS.longRunDay,
      'Jour de la sortie longue',
    );
    values.longRunDay = patch.longRunDay;
  }

  if (patch.summary !== undefined) values.summary = patch.summary;

  // Le chrono de référence passe par la même validation qu'à la création : le
  // couple est complet, le temps est dans ses bornes, et le résultat décrit bien
  // une course. Un chrono issu d'un test n'a aucun privilège sur un chrono saisi.
  if (patch.referenceDistance !== undefined || patch.referenceTimeS !== undefined) {
    const reference = validateReferenceRace(patch);
    values.referenceDistance = reference.referenceDistance;
    values.referenceTimeS = reference.referenceTimeS;
  }
  if (patch.referenceUpdatedOn !== undefined) {
    if (!isCivilDate(patch.referenceUpdatedOn)) {
      throw new InvalidPlanError(
        'referenceTimeS',
        'Date de mise à jour du chrono : format AAAA-MM-JJ attendu.',
      );
    }
    values.referenceUpdatedOn = patch.referenceUpdatedOn;
  }
  if (patch.lastTestNote !== undefined) values.lastTestNote = patch.lastTestNote;

  return values;
}

/**
 * Écrit les réglages du plan et touche sa date de mise à jour.
 *
 * L'appartenance et l'état actif sont dans le `WHERE` de l'`UPDATE` lui-même :
 * une lecture préalable laisserait une fenêtre entre le contrôle et l'écriture.
 *
 * @throws {PlanNotFoundError} si aucune ligne n'a été touchée.
 */
async function writePlanSettings(
  tx: PlanWriter,
  planId: number,
  athleteId: number,
  values: Partial<NewPlan>,
): Promise<void> {
  const updated = await tx
    .update(plans)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(eq(plans.id, planId), eq(plans.athleteId, athleteId), eq(plans.status, 'active')),
    )
    .returning({ id: plans.id });

  if (updated.length === 0) throw new PlanNotFoundError();
}

/**
 * Écrit la **proposition** du coach : un plan `draft` et ses séances.
 *
 * Rien d'autre ne bouge — le plan actif reste actif, ses séances restent en
 * place, et aucun effet de bord (rapprochement, synchronisation) n'a lieu : tant
 * que l'athlète n'a pas tranché, cette proposition ne pilote rien. C'est
 * {@link acceptDraftPlan} qui bascule.
 *
 * **Au plus un brouillon par athlète** : le précédent est supprimé d'abord, dans
 * la même transaction. Ses séances partent avec lui (`plan_id … ON DELETE
 * CASCADE`) — aucune ne peut être « réalisée », le rapprochement ignorant les
 * plans non actifs, donc rien de l'histoire de l'athlète n'y est attaché.
 *
 * L'ordre `DELETE` puis `INSERT` ne heurte pas l'index partiel
 * `plans_draft_per_athlete` **au sein d'une transaction** : au moment de
 * l'insertion, la ligne précédente est déjà supprimée. Entre transactions
 * concurrentes, en revanche, c'est l'index qui tranche — et c'est voulu, cf.
 * {@link ConcurrentDraftError}.
 *
 * La transaction couvre tout : sans elle, un échec d'insertion des séances
 * laisserait un brouillon vide, et aurait déjà effacé le précédent.
 *
 * @throws {AthleteNotFoundError} si l'onboarding n'a pas eu lieu.
 * @throws {InvalidPlanError} si un invariant du plan n'est pas tenu.
 * @throws {ConcurrentDraftError} si une autre génération a écrit sa proposition
 * entre-temps.
 */
export async function createDraftPlanWithSessions(input: CreatePlanInput): Promise<PlanDto> {
  const values = validatePlanInput(input);

  const athleteId = await getAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  const created = await writeDraftPlan(athleteId, values);

  return toPlanDto(created);
}

/**
 * Écrit la proposition et traduit la collision d'unicité en erreur métier.
 *
 * La violation est reconnue sur le **code** Postgres (`23505`) et non sur un
 * nom de contrainte : le pilote ne le transmet pas toujours, et l'insertion ne
 * peut de toute façon heurter que `plans_draft_per_athlete` — l'autre index
 * partiel ne couvre que les lignes `active`, et celle-ci naît `draft`. Tout
 * autre échec remonte tel quel : un `catch` qui avale l'inattendu ferait passer
 * une panne pour une course.
 */
async function writeDraftPlan(athleteId: number, values: ValidatedPlanInput): Promise<Plan> {
  try {
    return await draftPlanTransaction(athleteId, values);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConcurrentDraftError();
    throw error;
  }
}

/** La transaction proprement dite : purge du brouillon précédent, plan, séances. */
function draftPlanTransaction(athleteId: number, values: ValidatedPlanInput): Promise<Plan> {
  return db.transaction(async (tx) => {
    await tx
      .delete(plans)
      .where(and(eq(plans.athleteId, athleteId), eq(plans.status, 'draft')));

    const inserted = await tx
      .insert(plans)
      .values({
        athleteId,
        status: 'draft',
        goalType: values.goalType,
        intent: values.intent,
        returnInjuryHistory: values.returnInjuryHistory,
        level: values.level,
        goalText: values.goalText,
        raceDate: values.raceDate,
        startsOn: values.startsOn,
        weeks: values.weeks,
        sessionsPerWeek: values.sessionsPerWeek,
        weeklyTimeMinutes: values.weeklyTimeMinutes,
        longRunDay: values.longRunDay,
        referenceDistance: values.referenceDistance,
        referenceTimeS: values.referenceTimeS,
        summary: values.summary,
      })
      .returning();

    const plan = inserted[0];
    if (!plan) throw new Error("L'insertion du plan n'a retourné aucune ligne.");

    await tx
      .insert(plannedSessions)
      .values(values.sessions.map((session) => toPlannedSessionValues(session, athleteId, plan.id)));

    return plan;
  });
}

/**
 * Adopte la proposition : le plan actif est archivé, le brouillon devient le
 * plan de l'athlète.
 *
 * Tout tient dans une transaction, et l'ordre n'est pas négociable : l'index
 * partiel `plans_active_per_athlete` refuserait deux lignes actives, l'archivage
 * précède donc l'activation. La purge des séances à venir de l'ancien plan est
 * la même que partout ailleurs ({@link deleteUpcomingSessions}) — sans elle, ses
 * séances futures cohabiteraient avec celles du nouveau plan, deux séances le
 * même jour dont une que plus rien ne pilote.
 *
 * **Le passé du brouillon est purgé au passage.** Une proposition générée lundi
 * et adoptée mercredi porte des séances de lundi et mardi : l'athlète a couru
 * ces jours-là, mais ses activités ont été rapprochées des séances du plan
 * *alors* actif, et une activité ne réalise qu'une séance — celles du nouveau
 * plan resteraient donc « manquées » à tort dès l'ouverture de la page. Le plan
 * adopté prend la main à partir du jour de l'adoption ; son passé théorique n'a
 * jamais piloté personne, il n'a rien à afficher.
 *
 * L'appartenance et l'état sont dans le `WHERE` de l'`UPDATE` : aucune fenêtre
 * entre le contrôle et l'écriture, et un id venu du client ne peut pas activer
 * le brouillon d'un autre. C'est aussi pourquoi la purge du brouillon vient
 * **après** cette activation : à ce moment-là seulement, le plan est prouvé
 * sien.
 *
 * @throws {PlanNotFoundError} si l'id ne désigne pas un brouillon de l'athlète.
 */
export async function acceptDraftPlan(draftId: number): Promise<PlanDto> {
  const athleteId = await getAthleteId();
  if (athleteId === null) throw new PlanNotFoundError();

  const today = todayCivilDate();

  const activated = await db.transaction(async (tx) => {
    const archived = await tx
      .update(plans)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
      .returning({ id: plans.id });

    await deleteUpcomingSessions(
      tx,
      archived.map((row) => row.id),
      today,
    );

    const rows = await tx
      .update(plans)
      .set({ status: 'active', updatedAt: new Date() })
      .where(
        and(eq(plans.id, draftId), eq(plans.athleteId, athleteId), eq(plans.status, 'draft')),
      )
      .returning();

    // Le brouillon n'existe pas (ou plus) : la transaction est annulée, et le
    // plan actif reste actif. Refuser après avoir archivé laisserait l'athlète
    // sans aucun plan.
    const plan = rows[0];
    if (!plan) throw new PlanNotFoundError();

    // Les jours déjà écoulés de la proposition ne deviennent pas rétroactivement
    // le programme de l'athlète (cf. l'en-tête de cette fonction).
    await deletePastSessions(tx, plan.id, today);

    return plan;
  });

  return toPlanDto(activated);
}

/**
 * Refuse la proposition : le brouillon disparaît, et rien d'autre ne bouge.
 *
 * Ses séances partent avec lui par cascade (`planned_sessions.plan_id … ON
 * DELETE CASCADE`) : un brouillon n'ayant jamais pu être rapproché d'une
 * activité, il n'emporte aucune trace du réel.
 *
 * @throws {PlanNotFoundError} si l'id ne désigne pas un brouillon de l'athlète.
 */
export async function discardDraftPlan(draftId: number): Promise<void> {
  const athleteId = await getAthleteId();
  if (athleteId === null) throw new PlanNotFoundError();

  const deleted = await db
    .delete(plans)
    .where(and(eq(plans.id, draftId), eq(plans.athleteId, athleteId), eq(plans.status, 'draft')))
    .returning({ id: plans.id });

  if (deleted.length === 0) throw new PlanNotFoundError();
}

/** Ce qu'une instruction du coach fait bouger d'un coup sur le plan actif. */
export type PlanUpdate = {
  /** Date civile de reprise : la planification est réécrite à partir de ce jour. */
  fromDate: string;
  /** La suite du plan telle que le coach vient de la régénérer. */
  sessions: NewPlanSessionInput[];
  /** Les contraintes déclarées que l'instruction change, s'il y en a. */
  settings: PlanSettingsPatch;
};

/**
 * Applique en une seule transaction les deux moitiés d'une instruction du coach :
 * la suite du plan **et** les contraintes qu'elle change.
 *
 * Deux transactions séparées (réécrire les séances, puis les réglages)
 * donneraient le même résultat au succès ; mais si la seconde échouait, le plan
 * annoncerait encore 4 séances par semaine avec un calendrier déjà réécrit sur
 * 3. Seules les séances **non réalisées** à partir de `fromDate` sont
 * remplacées : une séance rapprochée d'une activité est de l'histoire, pas de
 * la planification, et le coach n'a pas à la réécrire.
 *
 * @throws {PlanNotFoundError} si le plan n'est pas celui, actif, de l'athlète.
 * @throws {InvalidPlanError} si une séance sort de la fenêtre du plan ou de
 * `fromDate`, ou si une valeur des réglages est hors bornes.
 */
export async function applyPlanUpdate(planId: number, update: PlanUpdate): Promise<void> {
  if (!isCivilDate(update.fromDate)) {
    throw new InvalidPlanError('sessions', 'Date de reprise : format AAAA-MM-JJ attendu.');
  }

  // Les bornes des réglages se vérifient avant d'ouvrir la transaction : un patch
  // aberrant ne doit pas commencer par supprimer des séances.
  const values = toPlanSettingsValues(update.settings);

  const athleteId = await getAthleteId();
  if (athleteId === null) throw new PlanNotFoundError();

  await db.transaction(async (tx) => {
    const plan = await requireActivePlan(tx, planId, athleteId);
    await replacePlanSessions(tx, plan, update.fromDate, update.sessions);
    // Pas de « touch » séparé de `updatedAt` : l'écriture des réglages le fait.
    await writePlanSettings(tx, planId, athleteId, values);
  });
}

/**
 * Archive le plan actif. `false` s'il n'y en avait pas — l'appelant distingue
 * ainsi l'archivage effectif du clic sans effet.
 *
 * En transaction : l'archivage emporte les séances à venir non réalisées du plan,
 * sinon elles resteraient au calendrier et au tableau de bord alors que plus
 * aucun plan ne les porte.
 */
export async function archiveActivePlan(): Promise<boolean> {
  const athleteId = await getAthleteId();
  if (athleteId === null) return false;

  return db.transaction(async (tx) => {
    const archived = await tx
      .update(plans)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
      .returning({ id: plans.id });

    if (archived.length === 0) return false;

    await deleteUpcomingSessions(
      tx,
      archived.map((row) => row.id),
      todayCivilDate(),
    );

    return true;
  });
}
