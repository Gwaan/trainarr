import 'server-only';

import { and, asc, eq, gte, inArray, isNull } from 'drizzle-orm';

import { isoWeekStart, shiftCivilDate } from '@/lib/dates/civil';
import {
  planSessionStepsSchema,
  sessionStepsTotals,
  type PlanSessionSteps,
} from '@/lib/plan-steps/schema';

import { AthleteNotFoundError, getAthleteId, isCivilDate, todayCivilDate } from './athlete';
import { db } from './db/client';
import {
  PLAN_GOAL_TYPES,
  PLAN_LEVELS,
  plannedSessions,
  plans,
  type NewPlan,
  type NewPlannedSession,
  type Plan,
  type PlanGoalType,
  type PlanLevel,
  type PlanStatus,
  type PlannedSession,
} from './db/schema';

/**
 * Plans d'entraînement : création par le coach, lecture par l'UI, régénération
 * partielle quand l'athlète change ses contraintes en cours de route.
 *
 * Deux règles structurent tout ce module :
 *
 * 1. **Un seul plan actif par athlète.** La base le garantit (index partiel
 *    `plans_active_per_athlete`) ; ici, créer un plan archive le précédent dans
 *    la même transaction, et emporte avec lui ses séances encore à venir — sans
 *    quoi elles continueraient d'apparaître au calendrier et au tableau de bord.
 * 2. **Le passé ne se réécrit pas.** Une régénération ne touche qu'aux séances
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
   * Niveau déclaré à la création, `null` sur les plans antérieurs à ce champ —
   * l'UI et le coach s'en passent alors plutôt que d'en supposer un.
   */
  level: PlanLevel | null;
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
  summary: string | null;
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
  /** Requis : un plan créé aujourd'hui se cale toujours sur un niveau déclaré. */
  level: PlanLevel;
  goalText: string;
  raceDate?: string | null;
  startsOn: string;
  weeks: number;
  sessionsPerWeek: number;
  weeklyTimeMinutes?: number | null;
  longRunDay: number;
  summary?: string | null;
  sessions: NewPlanSessionInput[];
};

/** Même chose, une fois les facultatifs normalisés en `null`. */
export type ValidatedPlanInput = {
  goalType: PlanGoalType;
  level: PlanLevel;
  goalText: string;
  raceDate: string | null;
  startsOn: string;
  weeks: number;
  sessionsPerWeek: number;
  weeklyTimeMinutes: number | null;
  longRunDay: number;
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
} as const;

/** Champ d'un plan mis en cause par {@link InvalidPlanError}. */
export type PlanInputField =
  | 'goalType'
  | 'level'
  | 'goalText'
  | 'raceDate'
  | 'startsOn'
  | 'weeks'
  | 'sessionsPerWeek'
  | 'weeklyTimeMinutes'
  | 'longRunDay'
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
 * Le plan visé n'existe pas, n'appartient pas à l'athlète, ou n'est plus actif.
 *
 * Les trois cas partagent volontairement la même erreur : distinguer « il existe
 * mais il n'est pas à toi » de « il n'existe pas » révélerait l'existence de la
 * ligne (anti-IDOR).
 */
export class PlanNotFoundError extends Error {
  constructor() {
    super("Aucun plan actif ne correspond : il n'existe pas, ou il a été archivé.");
    this.name = 'PlanNotFoundError';
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
    level: row.level,
    goalText: row.goalText,
    raceDate: row.raceDate,
    startsOn: row.startsOn,
    weeks: row.weeks,
    sessionsPerWeek: row.sessionsPerWeek,
    weeklyTimeMinutes: row.weeklyTimeMinutes,
    longRunDay: row.longRunDay,
    summary: row.summary,
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

  // Le niveau n'a pas de valeur de repli : un plan calé sur un niveau supposé
  // serait faux sans le dire.
  if (!PLAN_LEVELS.includes(input.level)) {
    throw new InvalidPlanError('level', 'Niveau inattendu : choisis ton niveau en course.');
  }

  const goalText = input.goalText.trim();
  if (goalText.length === 0) {
    throw new InvalidPlanError('goalText', "L'objectif est requis : c'est lui qui date le plan.");
  }

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

  if (input.sessions.length === 0) {
    throw new InvalidPlanError('sessions', 'Un plan sans aucune séance ne planifie rien.');
  }
  validatePlanSessions(input.sessions, { startsOn: input.startsOn, weeks: input.weeks });

  return {
    goalType: input.goalType,
    level: input.level,
    goalText,
    raceDate,
    startsOn: input.startsOn,
    weeks: input.weeks,
    sessionsPerWeek: input.sessionsPerWeek,
    weeklyTimeMinutes,
    longRunDay: input.longRunDay,
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

/**
 * Le plan actif et ses séances (ordonnées dans le temps), `null` s'il n'y en a
 * pas — ou si l'onboarding n'a pas encore eu lieu.
 */
export async function getActivePlanWithSessions(): Promise<{
  plan: PlanDto;
  sessions: PlanSessionDto[];
} | null> {
  const athleteId = await getAthleteId();
  if (athleteId === null) return null;

  const planRows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
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
 * Crée un plan et ses séances, en archivant le plan actif précédent.
 *
 * Le tout dans une transaction : sans elle, un échec d'insertion des séances
 * laisserait l'athlète avec un plan vide et son ancien plan archivé — c'est-à-
 * dire sans plan du tout.
 *
 * @throws {AthleteNotFoundError} si l'onboarding n'a pas eu lieu.
 * @throws {InvalidPlanError} si un invariant du plan n'est pas tenu.
 */
export async function createPlanWithSessions(input: CreatePlanInput): Promise<PlanDto> {
  const values = validatePlanInput(input);

  const athleteId = await getAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  const created = await db.transaction(async (tx) => {
    // L'index partiel `plans_active_per_athlete` refuserait deux lignes actives :
    // l'archivage précède donc l'insertion, dans la même transaction.
    const archived = await tx
      .update(plans)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
      .returning({ id: plans.id });

    // Sans cette purge, les séances à venir de l'ancien plan cohabiteraient avec
    // celles du nouveau : deux séances le même jour, dont une que plus rien ne
    // pilote.
    await deleteUpcomingSessions(
      tx,
      archived.map((row) => row.id),
      todayCivilDate(),
    );

    const inserted = await tx
      .insert(plans)
      .values({
        athleteId,
        status: 'active',
        goalType: values.goalType,
        level: values.level,
        goalText: values.goalText,
        raceDate: values.raceDate,
        startsOn: values.startsOn,
        weeks: values.weeks,
        sessionsPerWeek: values.sessionsPerWeek,
        weeklyTimeMinutes: values.weeklyTimeMinutes,
        longRunDay: values.longRunDay,
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

  return toPlanDto(created);
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
