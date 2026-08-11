import 'server-only';

/**
 * Génération et modification d'un plan d'entraînement par le coach IA.
 *
 * Le service orchestre, il ne décide pas : la fenêtre du plan est arithmétique
 * ({@link planWindow}), le contrat de sortie appartient à `plan-schema.ts`, et
 * l'écriture appartient au DAL. Ce qui vit ici, ce sont les prompts et la boucle
 * de correction.
 *
 * ## La boucle de correction, et pourquoi elle est bornée à un seul retry
 *
 * La grammaire garantit la forme, pas le sens : le modèle peut rendre un JSON
 * impeccable qui compte onze semaines au lieu de douze. On lui renvoie alors la
 * liste des violations, en français, et on regénère **une fois**. Si la seconde
 * passe échoue aussi, on s'arrête : sur un modèle de 6 Go, une troisième
 * tentative coûte des minutes pour la même erreur, et une génération de plan est
 * déclenchée par un clic — l'utilisatrice attend devant.
 *
 * ## Budget de contexte
 *
 * 32 k de contexte, partagés entre le prompt et la **sortie** — et un plan de
 * douze semaines fait déjà plusieurs milliers de tokens à écrire. Le prompt de
 * génération vise donc ~600 tokens (rôle + contraintes + snapshot), celui de
 * modification ~1 500 (il porte en plus les séances à venir). Le retry n'ajoute
 * que les violations, jamais la sortie fautive : la renvoyer doublerait la
 * facture pour rien.
 */

import { after } from 'next/server';
import type { z } from 'zod';

import { isCivilDate, todayCivilDate } from '@/data/athlete';
import { getTrainingSnapshot, type TrainingSnapshotDto } from '@/data/coach-context';
import { reconcilePlanSessions } from '@/data/plan-reconciliation';
import {
  InvalidPlanError,
  PLAN_LIMITS,
  PlanNotFoundError,
  applyPlanUpdate,
  createPlanWithSessions,
  getActivePlanWithSessions,
  type PlanDto,
  type PlanSessionDto,
  type PlanSettingsPatch,
} from '@/data/plans';
import { civilDaysBetween, isoDayIndex, shiftCivilDate } from '@/lib/dates/civil';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';

import { requireAi } from './availability';
import { chatCompletionJson, type ChatMessage } from './client';
import { AiInvalidOutputError } from './errors';
import {
  formatCivilDate,
  formatDistanceKm,
  formatDuration,
  formatIsoDay,
  formatPace,
  formatTrainingSnapshot,
} from './format';
import {
  PLAN_OUTPUT_BOUNDS,
  mapPlanWeeksToSessions,
  planJsonSchema,
  planOutputSchema,
  planUpdateJsonSchema,
  planUpdateOutputSchema,
  validatePlanBusinessRules,
  type PlanExpectations,
  type PlanUpdateOutput,
  type PlanWeekOutput,
} from './plan-schema';

/** Ce que le formulaire de création soumet au coach. */
export type PlanRequest = {
  goalType: 'race' | 'free';
  goalText: string;
  /** Date civile de la course, exigée par `goalType: 'race'`. */
  raceDate?: string;
  /** Durée voulue, exigée par `goalType: 'free'` (une course la déduit de sa date). */
  weeks?: number;
  sessionsPerWeek: number;
  weeklyTimeMinutes?: number;
  /** Jour ISO de la sortie longue : 1 = lundi … 7 = dimanche. */
  longRunDay: number;
};

/** La fenêtre calendaire que le plan couvrira. */
export type PlanWindow = { startsOn: string; weeks: number };

/**
 * Sous ce nombre de semaines, un plan de course ne se périodise pas : il ne
 * reste plus de place pour un développement suivi d'un affûtage.
 */
export const MIN_RACE_PLAN_WEEKS = 3;

/**
 * Au-delà, le modèle ne produit plus un plan d'un seul tenant (cf.
 * {@link PLAN_OUTPUT_BOUNDS}). Repris ici sous un nom que le formulaire peut
 * importer pour borner son champ date sans connaître le contrat de sortie.
 */
export const MAX_PLAN_WEEKS = PLAN_OUTPUT_BOUNDS.weeksPerPlan.max;

/** Température basse : on veut un plan reproductible, pas de la créativité. */
const PLAN_TEMPERATURE = 0.3;

/** Une seule reprise après violation des règles métier (cf. l'en-tête). */
const MAX_ATTEMPTS = 2;

/**
 * Premier jour du plan : le **prochain lundi**, ou aujourd'hui si l'on est déjà
 * lundi.
 *
 * Deux raisons de partir un lundi plutôt que demain : le volume hebdomadaire ne
 * se compare qu'entre semaines pleines, et l'alignement sur la semaine ISO fait
 * coïncider les semaines du plan avec celles des statistiques déjà affichées.
 * Un plan demandé un mardi commence donc dans six jours — la semaine en cours
 * est déjà entamée, la remplir a posteriori n'aurait pas de sens.
 */
export function nextPlanStart(today: string): string {
  const index = isoDayIndex(today);
  return index === 0 ? today : shiftCivilDate(today, 7 - index);
}

/**
 * Fenêtre du plan, à partir de l'objectif.
 *
 * Pour une course, la durée se **déduit** de la date : le nombre de semaines
 * entamées entre le départ du plan et le jour de la course, celui-ci compris —
 * sans le `+ 1`, une course tombant un lundi sortirait de la fenêtre du plan
 * censé y mener.
 *
 * @throws {InvalidPlanError} date de course absente/invalide, course trop
 * proche ({@link MIN_RACE_PLAN_WEEKS}) ou trop lointaine
 * ({@link MAX_PLAN_WEEKS}), ou durée manquante pour un objectif libre.
 */
export function planWindow(request: PlanRequest, today: string): PlanWindow {
  const startsOn = nextPlanStart(today);

  if (request.goalType === 'race') {
    const { raceDate } = request;
    if (raceDate === undefined || !isCivilDate(raceDate)) {
      throw new InvalidPlanError('raceDate', 'Un objectif « course » exige la date de la course.');
    }

    const weeks = Math.ceil((civilDaysBetween(startsOn, raceDate) + 1) / 7);
    if (weeks < MIN_RACE_PLAN_WEEKS) {
      throw new InvalidPlanError(
        'raceDate',
        `La course est dans moins de ${MIN_RACE_PLAN_WEEKS} semaines : c'est trop court pour périodiser un plan.`,
      );
    }
    // Rabattre silencieusement sur le maximum rendrait un plan qui s'arrête des
    // semaines avant la course qu'il prépare — un plan faux, et muet sur son
    // défaut. La date est refusée, avec la raison.
    if (weeks > MAX_PLAN_WEEKS) {
      throw new InvalidPlanError(
        'raceDate',
        `Course trop lointaine : elle est dans ${weeks} semaines, un plan en couvre ${MAX_PLAN_WEEKS} au plus.`,
      );
    }
    return { startsOn, weeks };
  }

  const { weeks } = request;
  if (weeks === undefined || !Number.isInteger(weeks) || weeks < PLAN_LIMITS.weeks.min) {
    throw new InvalidPlanError('weeks', 'Un objectif libre exige une durée en semaines.');
  }
  // Plafonnée à ce que le modèle peut réellement produire d'un seul tenant.
  return { startsOn, weeks: Math.min(weeks, MAX_PLAN_WEEKS) };
}

/*
 * Prompts. Exportés pour que les tests vérifient ce qui part réellement au
 * modèle — les données chiffrées attendues, et rien d'autre.
 */

/** Les principes d'entraînement, communs à la création et à la modification. */
const COACH_RULES = [
  "Tu es un coach de course à pied francophone. Tu écris des plans prudents et progressifs, calés sur le niveau réel de l'athlète.",
  'Principes que tu ne transgresses pas :',
  "- le volume hebdomadaire n'augmente jamais de plus de 10 % d'une semaine à l'autre ;",
  '- une semaine de décharge (environ −30 % de volume) toutes les 3 à 4 semaines ;',
  "- avant une course, 1 à 2 semaines d'affûtage : volume réduit, intensité maintenue ;",
  '- une seule sortie longue par semaine, le jour imposé par l\'athlète, et c\'est la plus longue séance de sa semaine ;',
  '- au plus deux séances de qualité (seuil, VMA, côtes) par semaine, jamais deux jours de suite ;',
  '- un seul entraînement par jour, `day` valant 1 pour lundi jusqu\'à 7 pour dimanche.',
  "Tu ne t'appuies que sur les données fournies : tu n'inventes aucune valeur. Si la charge d'entraînement n'est pas calculable, tu pars d'un volume délibérément conservateur et tu l'écris dans le résumé.",
  'Les allures cibles (`targetPaceSecPerKm`) sont en secondes par kilomètre, les distances en kilomètres, les durées en minutes.',
  "Le résumé (`summary`) fait 3 à 5 phrases : la logique du bloc, la progression prévue, les points de vigilance. Tout en français.",
].join('\n');

/** Les contraintes déclarées par l'athlète, en une ligne lisible. */
function formatConstraints(request: {
  sessionsPerWeek: number;
  weeklyTimeMinutes?: number | null;
  longRunDay: number;
}): string {
  const parts = [
    `${request.sessionsPerWeek} séances par semaine`,
    `sortie longue le ${formatIsoDay(request.longRunDay)}`,
  ];
  if (request.weeklyTimeMinutes !== undefined && request.weeklyTimeMinutes !== null) {
    parts.push(`${formatDuration(request.weeklyTimeMinutes * 60)} d'entraînement par semaine au plus`);
  }
  return parts.join(' · ');
}

/** Les messages d'une génération de plan. */
export function buildPlanMessages(
  request: PlanRequest,
  window: PlanWindow,
  snapshot: TrainingSnapshotDto,
): ChatMessage[] {
  const endsOn = shiftCivilDate(window.startsOn, window.weeks * 7 - 1);

  const lines = [
    request.goalType === 'race' && request.raceDate !== undefined
      ? `Objectif : la course « ${request.goalText} », le ${formatCivilDate(request.raceDate)}.`
      : `Objectif : ${request.goalText}.`,
    `Plan à produire : ${window.weeks} semaines, du ${formatCivilDate(window.startsOn)} au ${formatCivilDate(endsOn)}.`,
    `Contraintes : ${formatConstraints(request)}.`,
    '',
    `État de l'athlète au ${snapshot.today} :`,
    formatTrainingSnapshot(snapshot),
    '',
    `Rends les ${window.weeks} semaines dans l'ordre chronologique : weeks[0] est la semaine du ${formatCivilDate(window.startsOn)}. Chaque semaine compte exactement ${request.sessionsPerWeek} séances.`,
  ];

  return [
    { role: 'system', content: COACH_RULES },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** Une séance à venir, en une ligne compacte (~25 tokens). */
function formatUpcomingSession(session: PlanSessionDto, weekStart: string): string {
  const day = formatIsoDay(civilDaysBetween(weekStart, session.scheduledOn) + 1);
  const details: string[] = [];
  if (session.volumeM !== null) details.push(formatDistanceKm(session.volumeM));
  if (session.durationS !== null) details.push(formatDuration(session.durationS));
  if (session.targetPaceSecPerKm !== null) details.push(formatPace(session.targetPaceSecPerKm));

  const suffix = details.length > 0 ? ` (${details.join(' · ')})` : '';
  return `- ${day} : ${session.kind} — ${session.title}${suffix}`;
}

/**
 * Le plan en cours, condensé : ses réglages et ses seules séances à venir,
 * groupées par semaine.
 *
 * Ni les séances passées ni les séances réalisées : elles ne sont pas
 * replanifiables, et les envoyer coûterait la moitié du budget de contexte pour
 * une information que le modèle n'a pas le droit d'utiliser.
 */
export function formatUpcomingPlan(
  plan: PlanDto,
  upcoming: readonly PlanSessionDto[],
  window: RemainingPlanWindow,
): string {
  const lines: string[] = [];

  for (let index = 0; index < window.weeks; index += 1) {
    const weekStart = shiftCivilDate(window.firstWeekStart, index * 7);
    const weekEnd = shiftCivilDate(weekStart, 6);
    const sessions = upcoming.filter(
      (session) => session.scheduledOn >= weekStart && session.scheduledOn <= weekEnd,
    );

    const partial = index === 0 && window.firstWeekFromDay > 1;
    lines.push(
      `Semaine ${index + 1} (du ${formatCivilDate(weekStart)}${partial ? `, déjà entamée : à replanifier à partir du ${formatIsoDay(window.firstWeekFromDay)}` : ''}) :`,
    );
    if (sessions.length === 0) {
      lines.push('- aucune séance planifiée');
      continue;
    }
    for (const session of sessions) lines.push(formatUpcomingSession(session, weekStart));
  }

  const header = [
    `Plan en cours : « ${plan.goalText} »${plan.raceDate === null ? '' : `, course le ${formatCivilDate(plan.raceDate)}`}.`,
    `Réglages actuels : ${formatConstraints(plan)}.`,
    `Séances restantes (${window.weeks} semaines) :`,
  ];

  return [...header, ...lines].join('\n');
}

/** Les messages d'une modification par instruction. */
export function buildPlanUpdateMessages(
  plan: PlanDto,
  upcoming: readonly PlanSessionDto[],
  window: RemainingPlanWindow,
  instruction: string,
): ChatMessage[] {
  const system = [
    COACH_RULES,
    '',
    "Tu modifies un plan existant : tu ne régénères que les semaines restantes, weeks[0] étant la première semaine restante. Le passé de l'athlète ne se réécrit pas.",
    "Si l'instruction change une contrainte durable (nombre de séances, jour de la sortie longue, temps hebdomadaire), reporte-la dans `settings` ; sinon, omets `settings`.",
    "Le résumé décrit le plan modifié dans son ensemble, pas la modification.",
  ].join('\n');

  const user = [
    formatUpcomingPlan(plan, upcoming, window),
    '',
    `Instruction de l'athlète : « ${instruction.trim()} »`,
    '',
    `Rends les ${window.weeks} semaines restantes dans l'ordre chronologique, en appliquant l'instruction.`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Le message de reprise : les violations, telles que le modèle doit les corriger. */
export function buildViolationsMessage(violations: readonly string[]): string {
  return [
    'Ce plan ne respecte pas les contraintes demandées :',
    ...violations.map((violation) => `- ${violation}`),
    'Régénère le plan complet en corrigeant ces points, dans le même format.',
  ].join('\n');
}

/*
 * Génération.
 */

type GenerationOptions<T> = {
  messages: ChatMessage[];
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  /** Les semaines produites, quelle que soit la forme de l'enveloppe. */
  weeksOf: (output: T) => PlanWeekOutput[];
  /**
   * Ce que la sortie doit respecter. Calculé **depuis la sortie** : une
   * modification peut changer les réglages du plan, et c'est alors sur les
   * réglages patchés qu'il faut la juger.
   */
  expectationsOf: (output: T) => PlanExpectations;
};

/**
 * Génère, vérifie les règles métier, et reprend une fois en cas de violation.
 *
 * @throws {AiInvalidOutputError} si la seconde tentative viole encore les
 * règles — le message porte la liste, pour que l'UI dise ce qui n'a pas pu être
 * respecté plutôt qu'« erreur ».
 */
async function generateWithBusinessRules<T>(options: GenerationOptions<T>): Promise<T> {
  const messages = [...options.messages];
  let violations: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const output = await chatCompletionJson<T>({
      messages,
      schemaName: options.schemaName,
      jsonSchema: options.jsonSchema,
      schema: options.schema,
      temperature: PLAN_TEMPERATURE,
    });

    violations = validatePlanBusinessRules(options.weeksOf(output), options.expectationsOf(output));
    if (violations.length === 0) return output;

    if (attempt < MAX_ATTEMPTS) {
      messages.push({ role: 'user', content: buildViolationsMessage(violations) });
    }
  }

  throw new AiInvalidOutputError(
    `Le coach n'est pas parvenu à respecter les contraintes du plan : ${violations.join(' ')}`,
  );
}

/**
 * Les deux effets de bord qui suivent toute écriture de plan : rapprocher les
 * séances des activités déjà en base, et republier le calendrier intervals.icu.
 *
 * Pourquoi le rapprochement : une séance (re)générée sur un jour déjà couru doit
 * s'afficher « réalisée », pas « manquée ». Les sorties du passé, elles, sont en
 * base depuis longtemps — personne ne les réimportera, donc rien d'autre ne
 * posera ce lien.
 *
 * Aucun des deux ne remonte : le plan est écrit et valide. Un rapprochement raté
 * se rattrape au prochain import ou au prochain ajustement, une synchronisation
 * ratée à la prochaine écriture. Les deux sont journalisés — faire échouer une
 * génération de plusieurs minutes pour cela serait pire.
 *
 * Les deux ne sont pas attendus de la même façon, et c'est délibéré :
 *
 * - le **rapprochement** reste dans le fil de la requête, parce que son résultat
 *   conditionne ce que la page re-rendue affiche (« réalisée » plutôt que
 *   « manquée ») ;
 * - la **synchronisation** part en {@link after} : elle n'a aucune influence sur
 *   la réponse, et intervals.icu injoignable au niveau TCP coûte jusqu'à trois
 *   fois trente secondes de délai de garde — autant de spinner pour un plan déjà
 *   écrit en base.
 */
async function afterPlanWritten(planId: number): Promise<void> {
  try {
    await reconcilePlanSessions(planId);
  } catch (error) {
    console.error(`[plan] rapprochement des séances du plan ${planId} impossible :`, error);
  }

  // Le catch vit dans le module de synchronisation : les trois points de
  // branchement (création, ajustement, archivage) partagent la même garde.
  after(() => syncPlanToIntervalsSafely(`plan ${planId}`));
}

/**
 * Écrit un plan d'entraînement complet et l'active (le précédent est archivé).
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable.
 * @throws {InvalidPlanError} si la demande ne définit pas une fenêtre valide.
 * @throws {AiInvalidOutputError} si le plan produit reste hors des contraintes
 * après une reprise.
 */
export async function generatePlan(request: PlanRequest): Promise<PlanDto> {
  await requireAi();

  const window = planWindow(request, todayCivilDate());
  const snapshot = await getTrainingSnapshot();

  const output = await generateWithBusinessRules({
    messages: buildPlanMessages(request, window, snapshot),
    schemaName: 'training_plan',
    jsonSchema: planJsonSchema,
    schema: planOutputSchema,
    weeksOf: (plan) => plan.weeks,
    expectationsOf: () => ({
      weeks: window.weeks,
      sessionsPerWeek: request.sessionsPerWeek,
      longRunDay: request.longRunDay,
    }),
  });

  const plan = await createPlanWithSessions({
    goalType: request.goalType,
    goalText: request.goalText,
    raceDate: request.goalType === 'race' ? (request.raceDate ?? null) : null,
    startsOn: window.startsOn,
    weeks: window.weeks,
    sessionsPerWeek: request.sessionsPerWeek,
    weeklyTimeMinutes: request.weeklyTimeMinutes ?? null,
    longRunDay: request.longRunDay,
    summary: output.summary,
    sessions: mapPlanWeeksToSessions(output.weeks, window.startsOn),
  });

  await afterPlanWritten(plan.id);
  return plan;
}

/*
 * Modification.
 */

/** La part du plan qui reste à écrire, à partir d'une date de reprise. */
export type RemainingPlanWindow = {
  /** Premier jour de la première semaine restante — la base du mapping des jours. */
  firstWeekStart: string;
  /** Nombre de semaines restantes, celle en cours comprise. */
  weeks: number;
  /** Jour ISO à partir duquel la première semaine est encore replanifiable. */
  firstWeekFromDay: number;
};

/**
 * Découpe la partie du plan postérieure à `fromDate`, sur **la grille de semaines
 * du plan** (des blocs de 7 jours à partir de `startsOn`, qui est un lundi pour
 * tout plan généré par le coach — les semaines coïncident donc avec les semaines
 * ISO).
 *
 * @throws {InvalidPlanError} si le plan est terminé : il n'y a plus rien à
 * régénérer, et une instruction ne ressuscite pas un plan échu.
 */
export function remainingPlanWindow(
  plan: { startsOn: string; weeks: number },
  fromDate: string,
): RemainingPlanWindow {
  const offset = civilDaysBetween(plan.startsOn, fromDate);
  // Plan qui n'a pas encore commencé : tout est à venir, rien n'est entamé.
  if (offset <= 0) {
    return { firstWeekStart: plan.startsOn, weeks: plan.weeks, firstWeekFromDay: 1 };
  }

  const weekIndex = Math.floor(offset / 7);
  const weeks = plan.weeks - weekIndex;
  if (weeks <= 0) {
    throw new InvalidPlanError(
      'weeks',
      "Ce plan est arrivé à son terme : il n'y a plus de semaine à régénérer.",
    );
  }

  return {
    firstWeekStart: shiftCivilDate(plan.startsOn, weekIndex * 7),
    weeks,
    firstWeekFromDay: offset - weekIndex * 7 + 1,
  };
}

/** Les réglages que la sortie du modèle fait réellement bouger, et rien d'autre. */
function settingsPatch(plan: PlanDto, output: PlanUpdateOutput): PlanSettingsPatch {
  const patch: PlanSettingsPatch = { summary: output.summary };
  const { settings } = output;
  if (settings === undefined) return patch;

  if (settings.sessionsPerWeek !== undefined && settings.sessionsPerWeek !== plan.sessionsPerWeek) {
    patch.sessionsPerWeek = settings.sessionsPerWeek;
  }
  if (settings.longRunDay !== undefined && settings.longRunDay !== plan.longRunDay) {
    patch.longRunDay = settings.longRunDay;
  }
  if (
    settings.weeklyTimeMinutes !== undefined &&
    settings.weeklyTimeMinutes !== plan.weeklyTimeMinutes
  ) {
    patch.weeklyTimeMinutes = settings.weeklyTimeMinutes;
  }
  return patch;
}

/**
 * Applique une instruction en langage naturel au plan actif (« je pars en
 * déplacement la semaine prochaine », « plutôt 3 séances »).
 *
 * La reprise part de **demain** : la séance du jour est en cours ou déjà faite,
 * la déplacer serait au mieux inutile. Les séances déjà réalisées, elles, sont
 * protégées par le DAL ({@link applyPlanUpdate}) — quoi que dise le modèle, il
 * ne réécrit pas le passé.
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable.
 * @throws {PlanNotFoundError} s'il n'y a pas de plan actif.
 * @throws {InvalidPlanError} si le plan est terminé, ou si les séances produites
 * sortent de sa fenêtre.
 * @throws {AiInvalidOutputError} si la sortie reste hors contraintes après reprise.
 */
export async function updatePlanFromInstruction(instruction: string): Promise<PlanDto> {
  await requireAi();

  const active = await getActivePlanWithSessions();
  if (active === null) throw new PlanNotFoundError();

  const fromDate = shiftCivilDate(todayCivilDate(), 1);
  const window = remainingPlanWindow(active.plan, fromDate);
  const upcoming = active.sessions.filter(
    (session) => session.scheduledOn >= fromDate && session.completedActivityId === null,
  );

  const output = await generateWithBusinessRules({
    messages: buildPlanUpdateMessages(active.plan, upcoming, window, instruction),
    schemaName: 'training_plan_update',
    jsonSchema: planUpdateJsonSchema,
    schema: planUpdateOutputSchema,
    weeksOf: (plan) => plan.weeks,
    expectationsOf: (plan) => ({
      weeks: window.weeks,
      sessionsPerWeek: plan.settings?.sessionsPerWeek ?? active.plan.sessionsPerWeek,
      longRunDay: plan.settings?.longRunDay ?? active.plan.longRunDay,
      firstWeekFromDay: window.firstWeekFromDay,
    }),
  });

  // Séances et réglages en une seule transaction : un plan ne doit jamais
  // annoncer des contraintes que son calendrier ne suit pas.
  await applyPlanUpdate(active.plan.id, {
    fromDate,
    sessions: mapPlanWeeksToSessions(output.weeks, window.firstWeekStart),
    settings: settingsPatch(active.plan, output),
  });
  await afterPlanWritten(active.plan.id);

  const refreshed = await getActivePlanWithSessions();
  if (refreshed === null) throw new PlanNotFoundError();
  return refreshed.plan;
}
