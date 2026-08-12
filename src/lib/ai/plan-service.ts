import 'server-only';

/**
 * Écriture d'un plan d'entraînement : création, ajustement, et la capacité que
 * la révision automatique partage avec l'ajustement.
 *
 * Le service orchestre, il ne décide pas : la fenêtre du plan est arithmétique
 * ({@link planWindow}), les volumes et le calendrier appartiennent à
 * `lib/plan-skeleton`, les règles à `plan-schema.ts`, et l'écriture au DAL.
 *
 * ## Le modèle n'écrit plus de plans, et c'est la clé de lecture du fichier
 *
 * L'appli écrit tout ce qui se **calcule** — périodisation, volumes
 * hebdomadaires, jours, footings, sortie longue, séance du jour J — et ne
 * demande au coach que ce qui se **juge** : le déroulé des séances dures, une
 * par une (`quality-fill.ts`), la lecture d'une instruction en langage naturel
 * ({@link instructionSettings}), le verdict d'une révision
 * (`review-service.ts`) et les textes qui accompagnent tout cela.
 *
 * Le constat chiffré qui a imposé ce renversement est en tête de
 * `plan-skeleton/skeleton.ts` : répartir un volume sur sept séances et seize
 * semaines est de l'arithmétique, et un modèle de 6 Go n'en fait pas.
 *
 * Ce qui a disparu avec lui, et qu'on ne cherchera donc pas ici : la boucle de
 * correction (« voici tes violations, régénère »), la génération par tranches,
 * les prompts de méthodologie. Il n'y a plus de plan à faire réécrire, donc plus
 * rien à corriger — et personne en face pour corriger l'appli. Ce qui les
 * remplace est une **dégradation en escalier** ({@link validatedPlanWeeks}) :
 * réécrire tous les créneaux en déterministe, revalider, et lever plutôt que de
 * rendre un plan invalide.
 *
 * ## Les trois chemins, et ce qu'ils partagent
 *
 * - **Création** ({@link generatePlan}) : plan neuf, écrit en proposition.
 * - **Ajustement** ({@link updatePlanFromInstruction}) : une instruction de
 *   l'athlète, traduite en réglages durables, puis la fin du plan reconstruite.
 * - **Révision** (`review-service.ts`) : un verdict automatique sur les séances
 *   réalisées, puis la même reconstruction.
 *
 * Les deux derniers passent par {@link rewriteRemainingPlan}, écrite une fois :
 * une fenêtre partielle, des volumes recalculés sur le réel, une périodisation
 * conservée. Le détail de ces trois points est en tête de sa section.
 *
 * ## Budget de contexte
 *
 * 32 k de contexte sur le modèle cible, partagés entre le prompt et la sortie.
 * Ce n'est plus une contrainte serrée depuis la bascule : le plus gros appel du
 * fichier est devenu un résumé de cinq phrases, et le remplissage d'un créneau
 * tient dans quelques centaines de tokens de part et d'autre. Aucun appel ne
 * dépasse plus le millier de tokens de sortie.
 */

import { after } from 'next/server';
import { z } from 'zod';

import { isCivilDate, todayCivilDate } from '@/data/athlete';
import { getTrainingSnapshot, type TrainingSnapshotDto } from '@/data/coach-context';
import type { PlanGoalType, PlanLevel } from '@/data/db/schema';
import { reconcilePlanSessions } from '@/data/plan-reconciliation';
import {
  InvalidPlanError,
  PLAN_LIMITS,
  PlanNotFoundError,
  applyPlanUpdate,
  createDraftPlanWithSessions,
  getActivePlanWithSessions,
  type PlanDto,
  type PlanSessionDto,
  type PlanSettingsPatch,
} from '@/data/plans';
import { civilDaysBetween, isoDayIndex, isoWeekStart, shiftCivilDate } from '@/lib/dates/civil';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';
import {
  InvalidRacePerformanceError,
  REFERENCE_DISTANCES,
  trainingPacesFromRace,
  type ReferenceDistance,
  type TrainingPaces,
} from '@/lib/metrics/vdot';
import {
  PlanSkeletonInfeasibleError,
  buildPlanSkeleton,
  planPhases,
  type PlanPhase,
  type PlanSkeletonParams,
  type SkeletonWeek,
} from '@/lib/plan-skeleton';

import { requireAi } from './availability';
import { chatCompletionJson, type ChatMessage } from './client';
import {
  formatCivilDate,
  formatDistanceKm,
  formatDuration,
  formatIsoDay,
  formatNumber,
  formatPace,
  formatPlanSteps,
} from './format';
import {
  MIN_FIRST_WEEK_DAYS,
  PLAN_OUTPUT_BOUNDS,
  VOLUME_RULES,
  VOLUME_TARGET_RULES,
  floorKm,
  goalDistanceKm,
  goalPaceSecPerKm,
  isCutbackCadenceRank,
  isMarathonGoal,
  mapPlanWeeksToSessions,
  planInstructionJsonSchema,
  planInstructionOutputSchema,
  planWeeksPostProcessing,
  remainingWeekDays,
  resolveWeeklyTimeBudget,
  taperFactors,
  taperWeekCount,
  validatePlanBusinessRules,
  weeklyVolumeTargets,
  type PlanExpectations,
  type PlanInstructionOutput,
  type PlanRaceGoal,
  type PlanSessionOutput,
  type PlanSettingsOutput,
  type PlanValidationContext,
  type PlanWeekOutput,
  type PlanWeeksPostProcessing,
  type WeeklyVolumeTarget,
  type WeeklyVolumeTargetKind,
} from './plan-schema';
import { clearPlanProgress, setPlanProgress, type PlanProgressInput } from './progress';
import { deterministicQualitySession, fillQualitySlots } from './quality-fill';

/** Ce que le formulaire de création soumet au coach. */
export type PlanRequest = {
  goalType: 'race' | 'free';
  /** Niveau en course déclaré par l'athlète : il choisit la méthodologie appliquée. */
  level: PlanLevel;
  goalText: string;
  /** Date civile de la course, exigée par `goalType: 'race'`. */
  raceDate?: string;
  /** Durée voulue, exigée par `goalType: 'free'` (une course la déduit de sa date). */
  weeks?: number;
  sessionsPerWeek: number;
  weeklyTimeMinutes?: number;
  /** Jour ISO de la sortie longue : 1 = lundi … 7 = dimanche. */
  longRunDay: number;
  /**
   * Premier jour du programme, choisi par l'athlète — n'importe quel jour à
   * partir d'aujourd'hui. Absent : aujourd'hui (cf. {@link planStart}).
   */
  startsOn?: string;
  /**
   * Chrono de course récent, s'il y en a un : c'est la donnée qui **calcule** la
   * table d'allures du plan (méthode VDOT), au lieu de la laisser deviner au
   * modèle depuis une allure d'entraînement moyenne.
   */
  referenceRace?: ReferenceRace;
};

/** Un chrono de course : une distance de référence, un temps. */
export type ReferenceRace = { distance: ReferenceDistance; timeS: number };

/**
 * La fenêtre calendaire que le plan couvrira.
 *
 * Deux dates, et elles ne coïncident que sur un départ un lundi : `startsOn` est
 * le jour réel du départ (celui que le DAL stocke, avant lequel aucune séance
 * n'existe), `anchor` est le lundi de sa semaine — la grille sur laquelle les
 * jours ISO produits par le modèle se posent, et celle qui compte les semaines.
 */
export type PlanWindow = {
  /** Premier jour du programme, tel que l'athlète l'a choisi. */
  startsOn: string;
  /** Lundi de la semaine de `startsOn`, base du mapping des jours ISO. */
  anchor: string;
  /** Semaines ISO couvertes depuis l'ancre, la première (parfois entamée) comprise. */
  weeks: number;
  /** Jour ISO à partir duquel la première semaine porte des séances : 1 = lundi. */
  firstWeekFromDay: number;
};

/**
 * Sous ce nombre de semaines, un plan de course ne se périodise pas : il ne
 * reste plus de place pour un développement suivi d'un affûtage.
 *
 * Ce sont des semaines d'entraînement, pas des cases du calendrier : une semaine
 * du départ trop entamée n'en est pas une (cf. {@link firstWeekCountsAsPlanWeek}).
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

/**
 * L'avancement d'une écriture de plan, compté en créneaux de qualité remplis —
 * une création comme une reconstruction de fenêtre restante.
 *
 * Ce que la bascule change, et c'est un gain : le pourcentage cesse d'être une
 * estimation. Une génération d'un seul tenant ne pouvait mesurer que des
 * caractères reçus contre une taille *supposée* ; ici, l'unité de travail est le
 * créneau, l'appli sait combien il y en a avant le premier appel, et chacun est
 * fini ou ne l'est pas. La barre décrit donc exactement ce qui se passe.
 *
 * Et elle va jusqu'à **100**, là où l'ancienne plafonnait à 99 : ce plafond
 * disait « la validation n'a pas encore parlé, et elle peut tout faire
 * recommencer ». Plus rien ne recommence — le squelette est écrit avant le
 * premier créneau, et les règles ne peuvent plus renvoyer le plan au modèle.
 * Ce qui suit le dernier créneau (post-traitement, résumé, écriture en base) se
 * compte en secondes, pas en minutes.
 *
 * Un plan **sans créneau** (deux séances par semaine : la décomposition garde
 * toujours un footing à côté de la sortie longue, il ne reste aucune place pour
 * de la qualité) n'attend rien du modèle : il est déjà écrit, donc à 100 %.
 */
function slotProgress(filled: number, total: number): PlanProgressInput {
  return {
    percent: total <= 0 ? 100 : Math.round((100 * filled) / total),
    // Une seule « tentative » : le plan ne se rejoue plus en entier, et les
    // reprises qui subsistent (deux par créneau) sont trop fines pour être
    // affichées — l'athlète verrait un compteur reculer sans rien comprendre.
    attempt: 1,
    maxAttempts: 1,
  };
}

/**
 * Premier jour du programme : celui que l'athlète a choisi, sinon **aujourd'hui**.
 *
 * N'importe quel jour convient, et c'est le point de la première semaine
 * partielle : le `day` d'une séance produite par le modèle reste un jour ISO
 * (1 = lundi) posé sur `PlanWindow.anchor`, le lundi de la semaine du départ.
 * Un départ un jeudi ne décale donc rien — il retire simplement du lundi au
 * mercredi de la première semaine, que le prompt et
 * {@link validatePlanBusinessRules} traitent comme une semaine entamée.
 *
 * @throws {InvalidPlanError} date inexploitable ou passée.
 */
function planStart(request: PlanRequest, today: string): string {
  const { startsOn } = request;
  if (startsOn === undefined) return today;

  if (!isCivilDate(startsOn)) {
    throw new InvalidPlanError('startsOn', 'Début du programme : format AAAA-MM-JJ attendu.');
  }
  if (startsOn < today) {
    throw new InvalidPlanError('startsOn', "Le programme ne peut pas démarrer dans le passé.");
  }
  return startsOn;
}

/**
 * La semaine du départ vaut-elle une semaine d'entraînement ?
 *
 * Le seuil vit dans `plan-schema.ts` ({@link MIN_FIRST_WEEK_DAYS}), qui l'applique
 * aussi au budget temps d'une semaine entamée : une semaine trop courte pour
 * compter dans le plan l'est aussi pour porter un plafond horaire.
 *
 * Arbitrage : un plan de 8 semaines démarré un samedi laisse deux jours dans la
 * semaine en cours. Les compter pour une semaine d'entraînement en volerait une
 * vraie — l'athlète recevrait 7 semaines pleines là où elle en a demandé 8. Pour
 * une course, la durée reste déduite des dates — mais le même seuil décide si
 * cette semaine-là compte dans le minimum ({@link MIN_RACE_PLAN_WEEKS}) : sans
 * lui, un départ un dimanche ferait passer huit jours de préparation pour trois
 * semaines de plan.
 *
 * Vrai dès qu'il y reste au moins {@link MIN_FIRST_WEEK_DAYS} jours, jour du
 * départ compris — soit un départ du lundi au jeudi. Exporté parce que le
 * formulaire en dépend : `_lib/plan-window.ts` borne son champ « date de
 * course » sur cette même réponse, et deux arithmétiques divergentes
 * proposeraient une date que ce service refuserait ensuite.
 */
export function firstWeekCountsAsPlanWeek(startsOn: string): boolean {
  return 7 - isoDayIndex(startsOn) >= MIN_FIRST_WEEK_DAYS;
}

/**
 * Fenêtre du plan, à partir de l'objectif.
 *
 * Tout se compte depuis l'**ancre** — le lundi de la semaine du départ — pour que
 * les semaines du plan coïncident avec les semaines ISO des statistiques déjà
 * affichées. Un départ en milieu de semaine produit donc une première semaine
 * entamée, qui ne porte des séances qu'à partir du jour du départ.
 *
 * Pour une course, la durée se **déduit** des dates : le nombre de semaines ISO
 * de l'ancre au jour de la course, celui-ci compris — sans le `+ 1`, une course
 * tombant un lundi sortirait de la fenêtre du plan censé y mener.
 *
 * @throws {InvalidPlanError} date de démarrage inexploitable ({@link planStart}),
 * date de course absente/invalide, course trop proche
 * ({@link MIN_RACE_PLAN_WEEKS}) ou trop lointaine ({@link MAX_PLAN_WEEKS}), ou
 * durée manquante pour un objectif libre.
 */
export function planWindow(request: PlanRequest, today: string): PlanWindow {
  const startsOn = planStart(request, today);
  const anchor = isoWeekStart(startsOn);
  const firstWeekFromDay = isoDayIndex(startsOn) + 1;
  const base = { startsOn, anchor, firstWeekFromDay };

  if (request.goalType === 'race') {
    const { raceDate } = request;
    if (raceDate === undefined || !isCivilDate(raceDate)) {
      throw new InvalidPlanError('raceDate', 'Un objectif « course » exige la date de la course.');
    }

    const weeks = Math.ceil((civilDaysBetween(anchor, raceDate) + 1) / 7);
    // La fenêtre garde la semaine entamée (les séances s'y posent), mais le
    // minimum ne la compte que si elle porte de l'entraînement : sinon un départ
    // le dimanche pour une course le lundi suivant ferait un « plan de trois
    // semaines » de huit jours.
    const effectiveWeeks = weeks - (firstWeekCountsAsPlanWeek(startsOn) ? 0 : 1);
    if (effectiveWeeks < MIN_RACE_PLAN_WEEKS) {
      const days = Math.max(civilDaysBetween(startsOn, raceDate), 0);
      throw new InvalidPlanError(
        'raceDate',
        `Le programme ne laisse que ${days} jour${days > 1 ? 's' : ''} avant la course : c'est trop court pour la périodiser (${MIN_RACE_PLAN_WEEKS} semaines au minimum).`,
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
    return { ...base, weeks };
  }

  const { weeks } = request;
  if (weeks === undefined || !Number.isInteger(weeks) || weeks < PLAN_LIMITS.weeks.min) {
    throw new InvalidPlanError('weeks', 'Un objectif libre exige une durée en semaines.');
  }

  // Une semaine entamée trop courte s'ajoute aux semaines demandées plutôt que
  // d'en consommer une (cf. MIN_FIRST_WEEK_DAYS).
  const total = firstWeekCountsAsPlanWeek(startsOn) ? weeks : weeks + 1;
  // Plafonnée à ce que le modèle peut réellement produire d'un seul tenant.
  return { ...base, weeks: Math.min(total, MAX_PLAN_WEEKS) };
}


/** Le niveau, tel que les prompts le nomment. */
const LEVEL_LABELS: Record<PlanLevel, string> = {
  beginner: 'débutant',
  intermediate: 'intermédiaire',
  advanced: 'confirmé',
};


/*
 * Allures imposées.
 */

/**
 * La table d'allures d'un chrono de référence, ou `null` s'il n'y en a pas.
 *
 * Le calcul appartient à `lib/metrics/vdot` ; ici on ne fait que le brancher, et
 * traduire son refus en erreur de champ — le formulaire et le DAL ont déjà écarté
 * un chrono implausible, mais le service n'est pas leur seule porte d'entrée.
 *
 * @throws {InvalidPlanError} si le chrono ne décrit pas une course.
 */
function referenceRacePaces(race: ReferenceRace | undefined): TrainingPaces | null {
  if (race === undefined) return null;

  try {
    return trainingPacesFromRace(REFERENCE_DISTANCES[race.distance], race.timeS);
  } catch (error) {
    if (error instanceof InvalidRacePerformanceError) {
      throw new InvalidPlanError(
        'referenceTimeS',
        'Ce chrono ne ressemble pas à une course — vérifie la saisie.',
      );
    }
    throw error;
  }
}

/**
 * L'objectif du plan tel que les règles de volume le lisent : une course (donc
 * un affûtage à respecter), ou rien.
 *
 * La seule chose que la distance de la course y change est la longueur de
 * l'affûtage, d'où la reconnaissance du seul marathon dans le texte libre de
 * l'objectif ({@link isMarathonGoal}).
 */
function raceGoalOf(goalType: PlanGoalType, goalText: string): PlanRaceGoal | null {
  return goalType === 'race' ? { isMarathon: isMarathonGoal(goalText) } : null;
}

/**
 * Le chrono d'un plan déjà écrit, `undefined` s'il n'en porte pas.
 *
 * Les deux colonnes sont solidaires en base (invariant du DAL) ; le `undefined`
 * ne couvre donc que les plans antérieurs au champ, et non un demi-chrono.
 */
function planReferenceRace(plan: PlanDto): ReferenceRace | undefined {
  if (plan.referenceDistance === null || plan.referenceTimeS === null) return undefined;
  return { distance: plan.referenceDistance, timeS: plan.referenceTimeS };
}

/**
 * La table d'allures d'un plan déjà écrit, `null` s'il n'a pas de chrono.
 *
 * Le raccourci des deux appels ci-dessus, exporté pour la révision automatique :
 * elle reconstruit la fin du même plan, donc sous les mêmes allures imposées.
 *
 * @throws {InvalidPlanError} si le chrono stocké ne décrit pas une course.
 */
export function planTrainingPaces(plan: PlanDto): TrainingPaces | null {
  return referenceRacePaces(planReferenceRace(plan));
}

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


/**
 * Le **meilleur** volume hebdomadaire réellement couru sur la fenêtre du
 * snapshot, en km — `null` sans historique exploitable.
 *
 * Le maximum, et pas la moyenne : c'est ce que l'athlète a démontré pouvoir
 * faire, et une moyenne tirée vers le bas par une semaine de vacances ferait
 * démarrer le plan sous son niveau. Sert de deux façons, avec le même chiffre
 * des deux côtés : le prompt l'annonce comme plafond de départ, la validation le
 * vérifie ({@link PlanValidationContext.recentWeeklyKm}).
 *
 * **Limite connue** : ce chiffre ne vaut que ce que vaut l'historique importé. Un
 * import FIT partiel — canal de synchronisation cassé, reprise de compte, backfill
 * en cours — fait passer pour « le meilleur volume récent » ce qui n'est que la
 * partie visible, et plafonne le plan sans que rien ne le dise. Le remède est du
 * côté de l'import, pas ici : fabriquer une correction reviendrait à inventer un
 * volume que les données ne portent pas.
 */
function bestRecentWeeklyKm(snapshot: TrainingSnapshotDto): number | null {
  if (snapshot.weeks.length === 0) return null;
  const best = Math.max(...snapshot.weeks.map((week) => week.distanceKm));
  // Quatre semaines à zéro ne disent pas « démarre à zéro », elles disent qu'il
  // n'y a rien à quoi ancrer le départ.
  return best > 0 ? best : null;
}

/**
 * L'allure qui convertit les kilomètres cibles en minutes.
 *
 * La table calculée d'abord (le milieu de son créneau d'endurance), l'allure
 * d'entraînement récente ensuite : c'est la même hiérarchie que partout ailleurs
 * dans ce module, et la même raison — un chrono de course dit mieux ce que
 * l'athlète tient qu'une moyenne de footings. `null` quand ni l'une ni l'autre
 * n'existe, le planificateur applique alors son repli prudent.
 */
function easyPaceSecPerKm(
  snapshot: TrainingSnapshotDto,
  paces: TrainingPaces | null,
): number | null {
  if (paces === null) return snapshot.recentAvgPaceSecPerKm;
  return Math.round((paces.easy.minSecPerKm + paces.easy.maxSecPerKm) / 2);
}

/**
 * Les volumes hebdomadaires cibles d'une **création**, tels que le prompt les
 * annonce et que la validation les vérifie.
 *
 * Fonction pure et déterministe, appelée des deux côtés plutôt que passée de
 * l'un à l'autre : deux chiffrages divergents feraient refuser un plan qui
 * applique la consigne à la lettre — le défaut que ce module passe son temps à
 * éviter.
 */
export function planVolumeTargets(
  request: PlanRequest,
  window: PlanWindow,
  snapshot: TrainingSnapshotDto,
  paces: TrainingPaces | null = null,
): WeeklyVolumeTarget[] {
  return weeklyVolumeTargets({
    weeks: window.weeks,
    firstWeekFromDay: window.firstWeekFromDay,
    recentWeeklyKm: bestRecentWeeklyKm(snapshot),
    weeklyTimeMinutes: request.weeklyTimeMinutes ?? null,
    easyPaceSecPerKm: easyPaceSecPerKm(snapshot, paces),
    race: raceGoalOf(request.goalType, request.goalText),
    level: request.level,
  });
}


/**
 * Une séance à venir, en une ligne compacte (~25 tokens), plus une seconde
 * ligne pour son déroulé quand elle en porte un.
 *
 * Le déroulé n'est pas un détail d'affichage ici : sans lui, le modèle réécrit
 * « Seuil — 3 × 8 min » à l'aveugle et perd l'échauffement, les récupérations et
 * les allures déjà calées. Avec lui, il ajuste ce qui existe.
 */
function formatUpcomingSession(session: PlanSessionDto, weekStart: string): string {
  const day = formatIsoDay(civilDaysBetween(weekStart, session.scheduledOn) + 1);
  const details: string[] = [];
  if (session.volumeM !== null) details.push(formatDistanceKm(session.volumeM));
  if (session.durationS !== null) details.push(formatDuration(session.durationS));
  if (session.targetPaceSecPerKm !== null) details.push(formatPace(session.targetPaceSecPerKm));

  const suffix = details.length > 0 ? ` (${details.join(' · ')})` : '';
  const line = `- ${day} : ${session.kind} — ${session.title}${suffix}`;
  return session.steps === null ? line : `${line}\n  déroulé : ${formatPlanSteps(session.steps)}`;
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
  firstWeekNumber = 1,
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
      `Semaine ${firstWeekNumber + index} (du ${formatCivilDate(weekStart)}${partial ? `, déjà entamée : à replanifier à partir du ${formatIsoDay(window.firstWeekFromDay)}` : ''}) :`,
    );
    if (sessions.length === 0) {
      lines.push('- aucune séance planifiée');
      continue;
    }
    for (const session of sessions) lines.push(formatUpcomingSession(session, weekStart));
  }

  const header = [
    `Plan en cours : « ${plan.goalText} »${plan.raceDate === null ? '' : `, course le ${formatCivilDate(plan.raceDate)}`}.`,
    // Les plans antérieurs au champ n'en portent pas : rien n'est dit plutôt
    // qu'un niveau supposé, qui orienterait tout l'ajustement.
    ...(plan.level === null ? [] : [`Niveau déclaré : ${LEVEL_LABELS[plan.level]}.`]),
    `Réglages actuels : ${formatConstraints(plan)}.`,
    `Séances restantes (${window.weeks} semaines) :`,
  ];

  return [...header, ...lines].join('\n');
}



/**
 * Journalise si la génération qui démarre est **suivie** ou non.
 *
 * Le pourcentage n'existe que si le formulaire a joint son identifiant de suivi
 * au `FormData` (cf. `useGenerationProgress`), et une modale muette ne dit pas
 * lequel des maillons a lâché : l'identifiant n'est pas parti, l'action l'a
 * écarté (UUID mal formé), ou c'est l'interrogation de la route qui échoue. Les
 * deux premiers cas se lisent maintenant dans les logs du serveur.
 *
 * Huit caractères de l'UUID : de quoi rapprocher la ligne de la requête
 * `/api/plan-progress` correspondante, sans recopier un identifiant entier dans
 * le journal.
 */
function logProgressTracking(progressId: string | undefined): void {
  console.info(
    progressId === undefined
      ? '[plan] génération sans suivi de progression'
      : `[plan] progression suivie (id ${progressId.slice(0, 8)})`,
  );
}


/*
 * Le résumé d'un plan déjà écrit.
 *
 * C'est le seul endroit de la création où le modèle garde la main, et c'est
 * cohérent : un résumé est du texte libre destiné à être lu, exactement ce qu'un
 * générateur de phrases fait mieux qu'un gabarit. Il ne décide de rien — le plan
 * est écrit, validé, et le résumé le décrit après coup.
 *
 * Deux conséquences sur la forme de l'appel :
 *
 * - il est **court et séparé** : quelques centaines de tokens de prompt, autant
 *   de sortie. Rien à voir avec le plan entier qu'on demandait avant, et c'est
 *   pour cela qu'il tient dans le contexte d'un modèle local sans effort ;
 * - il a un **repli déterministe**. Un plan de seize semaines écrit, validé et
 *   payé de plusieurs minutes d'attente ne doit pas échouer pour un paragraphe.
 */

/** Nom du schéma transmis au serveur — identifiant libre, exigé par le format. */
const SUMMARY_SCHEMA_NAME = 'plan_summary';

/**
 * Le plafond de génération du résumé, en tokens.
 *
 * Cinq phrases françaises pèsent ~200 tokens ; 512 laisse le double sans
 * autoriser une dissertation. Explicite comme partout ailleurs : un `max_tokens`
 * absent laisse le serveur trancher, et un JSON coupé ne rend pas un JSON
 * incomplet — il ne rend pas de JSON du tout.
 */
const SUMMARY_MAX_OUTPUT_TOKENS = 512;

/**
 * Délai de garde du résumé : 60 secondes.
 *
 * Le défaut du socle (5 min) est taillé pour un plan entier. Ici, l'athlète
 * attend déjà depuis plusieurs minutes devant un plan **écrit et valide** :
 * lui coûter cinq minutes de plus pour un paragraphe serait absurde, et le
 * dépassement ne coûte rien de plus que le repli déterministe.
 */
const SUMMARY_REQUEST_TIMEOUT_MS = 60_000;

/** Le contrat de sortie : un paragraphe, et rien d'autre. */
const planSummaryOutputSchema = z.object({
  summary: z.string().min(1).max(PLAN_OUTPUT_BOUNDS.summaryChars),
});

const planSummaryJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: PLAN_OUTPUT_BOUNDS.summaryChars },
  },
};

/**
 * Le système du résumé, avec ses consignes supplémentaires s'il y en a.
 *
 * `extra` sert à l'ajustement, qui a une chose de plus à dire au modèle : que le
 * plan qu'il résume vient d'être **recalculé** à la demande de l'athlète, et que
 * son résumé doit le rattacher à ce qu'elle a demandé. Le reste — un plan écrit
 * qui n'est pas à discuter, aucune allure — vaut dans les deux cas.
 */
function summarySystemPrompt(extra: readonly string[] = []): string {
  return [
    "Tu es coach de course à pied francophone. On te décrit un plan d'entraînement DÉJÀ ÉCRIT, et tu en rédiges le résumé pour l'athlète qui va le suivre.",
    '',
    '3 à 5 phrases, en français : la logique de la préparation, la progression prévue, les points de vigilance.',
    '',
    "Tu ne proposes rien et tu ne corriges rien — le plan est écrit, il n'est pas à discuter.",
    "Tu n'écris aucune allure : l'application les calcule et les affiche elle-même, et un chiffre de plus contredirait le sien.",
    ...extra,
  ].join('\n');
}

/** Ce qu'une phase pèse dans le résumé : son nom en français. */
const PHASE_LABELS: Record<PlanPhase, string> = {
  partial: 'reprise',
  base: 'base',
  build: 'développement',
  specific: 'spécificité',
  taper: 'affûtage',
  race: 'semaine de course',
};

/** La périodisation en toutes lettres : `4 semaines de base, 5 de développement, …`. */
function phaseBreakdown(skeleton: readonly SkeletonWeek[]): string {
  const counts = new Map<PlanPhase, number>();
  for (const week of skeleton) counts.set(week.phase, (counts.get(week.phase) ?? 0) + 1);
  return [...counts]
    .map(([phase, count]) => `${count} × ${PHASE_LABELS[phase]}`)
    .join(', ');
}

/**
 * Les chiffres d'un plan **déjà écrit**, tels que le résumé les reçoit : la
 * périodisation, l'amplitude des volumes, le nombre de créneaux de qualité.
 *
 * Trois lignes, et rien d'autre : ce sont les seuls faits que le modèle ne peut
 * pas contredire, puisqu'ils sont calculés. Lui donner les séances lui ferait
 * recopier des chiffres que l'affichage porte déjà — le défaut que tout ce
 * module passe son temps à éviter.
 */
function writtenPlanFacts(
  targets: readonly WeeklyVolumeTarget[],
  skeleton: readonly SkeletonWeek[],
): string[] {
  const volumes = targets.map((target) => target.targetKm);
  return [
    `Périodisation : ${phaseBreakdown(skeleton)}.`,
    `Volume hebdomadaire : de ${formatNumber(Math.min(...volumes), 1)} à ${formatNumber(Math.max(...volumes), 1)} km, ${formatNumber(volumes[volumes.length - 1], 1)} km la dernière semaine.`,
    `Séances de qualité : ${qualitySlotCount(skeleton)} au total, le reste en endurance.`,
  ];
}

/** Le nombre de créneaux de qualité d'un squelette, toutes semaines confondues. */
function qualitySlotCount(skeleton: readonly SkeletonWeek[]): number {
  return skeleton.reduce((total, week) => total + week.qualitySlots.length, 0);
}

/**
 * Le paragraphe du coach : celui du modèle, ou celui de l'appli.
 *
 * Ne lève jamais — c'est tout l'objet de la fonction. Le repli est **journalisé**
 * avec sa cause : sans cette trace, un coach en panne depuis des semaines est
 * indiscernable d'un coach qui écrit bien, les deux rendant un plan complet.
 *
 * @param fallback le texte que l'appli écrit à sa place. Évalué paresseusement :
 * il n'a pas de raison d'être composé quand le modèle répond.
 */
async function coachParagraph(
  messages: ChatMessage[],
  fallback: () => string,
): Promise<string> {
  try {
    const output = await chatCompletionJson<z.infer<typeof planSummaryOutputSchema>>({
      messages,
      schemaName: SUMMARY_SCHEMA_NAME,
      jsonSchema: planSummaryJsonSchema,
      schema: planSummaryOutputSchema,
      temperature: PLAN_TEMPERATURE,
      maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      timeoutMs: SUMMARY_REQUEST_TIMEOUT_MS,
    });
    return output.summary;
  } catch (error) {
    console.error(
      `[plan] résumé écrit par l'appli — ${error instanceof Error ? `${error.name} : ${error.message}` : String(error)}`,
    );
    return fallback();
  }
}

/*
 * Le résumé d'une création.
 */

/**
 * Ce que le modèle reçoit du plan créé : ce qu'il doit résumer, et **rien qu'il
 * puisse contredire** (cf. {@link writtenPlanFacts}).
 */
function buildPlanSummaryMessages(
  request: PlanRequest,
  window: PlanWindow,
  targets: readonly WeeklyVolumeTarget[],
  skeleton: readonly SkeletonWeek[],
): ChatMessage[] {
  const endsOn = shiftCivilDate(window.anchor, window.weeks * 7 - 1);

  return [
    { role: 'system', content: summarySystemPrompt() },
    {
      role: 'user',
      content: [
        request.goalType === 'race' && request.raceDate !== undefined
          ? `Objectif : la course « ${request.goalText} », le ${formatCivilDate(request.raceDate)}.`
          : `Objectif : ${request.goalText}.`,
        `Niveau déclaré : ${LEVEL_LABELS[request.level]}.`,
        `Plan écrit : ${window.weeks} semaines, du ${formatCivilDate(window.startsOn)} au ${formatCivilDate(endsOn)}.`,
        `Contraintes : ${formatConstraints(request)}.`,
        ...writtenPlanFacts(targets, skeleton),
      ].join('\n'),
    },
  ];
}

/**
 * Le résumé écrit par l'appli — factuel, et suffisant.
 *
 * Ce n'est pas un pis-aller honteux : il dit ce que le plan contient, dans la
 * langue du reste de l'appli. Ce qu'il n'a pas, c'est le ton d'un entraîneur et
 * le point de vigilance qu'un modèle sait formuler. Une proposition de plan
 * complète et validée vaut infiniment mieux qu'une erreur pour un paragraphe.
 */
function fallbackPlanSummary(
  request: PlanRequest,
  window: PlanWindow,
  targets: readonly WeeklyVolumeTarget[],
  skeleton: readonly SkeletonWeek[],
): string {
  const volumes = targets.map((target) => target.targetKm);
  const slots = qualitySlotCount(skeleton);

  return [
    `Plan de ${window.weeks} semaines à partir du ${formatCivilDate(window.startsOn)}, ` +
      `pour l'objectif « ${request.goalText} », niveau ${LEVEL_LABELS[request.level]}.`,
    `Périodisation : ${phaseBreakdown(skeleton)}.`,
    `Le volume hebdomadaire va de ${formatNumber(Math.min(...volumes), 1)} à ` +
      `${formatNumber(Math.max(...volumes), 1)} km, pour ${request.sessionsPerWeek} séances par semaine ` +
      `et une sortie longue le ${formatIsoDay(request.longRunDay)}.`,
    slots === 0
      ? "Aucune séance de qualité : tout le volume est couru en endurance, le temps d'installer le socle."
      : `${slots} séances de qualité sont réparties sur le plan, le reste du volume est couru en endurance.`,
  ].join(' ');
}

/** Le résumé d'une création : celui du modèle, ou celui de l'appli. */
async function planSummary(
  request: PlanRequest,
  window: PlanWindow,
  targets: readonly WeeklyVolumeTarget[],
  skeleton: readonly SkeletonWeek[],
): Promise<string> {
  return coachParagraph(buildPlanSummaryMessages(request, window, targets, skeleton), () =>
    fallbackPlanSummary(request, window, targets, skeleton),
  );
}

/**
 * Les deux effets de bord d'un plan **que l'athlète suit** : rapprocher les
 * séances des activités déjà en base, et republier le calendrier intervals.icu.
 *
 * Deux points d'appel, une seule politique — d'où l'export : l'ajustement du
 * plan actif (ici même) et l'adoption d'une proposition (Server Action de la
 * page « Plan »). Une génération, elle, n'y passe pas : elle n'écrit qu'une
 * proposition, que rien ne pilote tant qu'elle n'est pas adoptée.
 *
 * Pourquoi le rapprochement : une séance (re)générée — ou adoptée quelques jours
 * après avoir été proposée — sur un jour déjà couru doit s'afficher
 * « réalisée », pas « manquée ». Les sorties du passé, elles, sont en base
 * depuis longtemps — personne ne les réimportera, donc rien d'autre ne posera ce
 * lien.
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
export async function afterActivePlanChanged(planId: number): Promise<void> {
  try {
    await reconcilePlanSessions(planId);
  } catch (error) {
    console.error(`[plan] rapprochement des séances du plan ${planId} impossible :`, error);
  }

  // Le catch vit dans le module de synchronisation : les trois points de
  // branchement (adoption, ajustement, archivage) partagent la même garde.
  after(() => syncPlanToIntervalsSafely(`plan ${planId}`));
}

/**
 * Écrit un plan d'entraînement complet **en proposition** (`draft`).
 *
 * Le coach propose, il n'impose pas : rien du plan en cours ne bouge ici, et
 * aucun effet de bord n'est déclenché. C'est l'athlète qui tranche depuis la
 * page du plan — adopter la proposition l'active et archive le plan précédent
 * ({@link acceptDraftPlan}), la refuser l'efface sans laisser de trace.
 *
 * @param progressId identifiant de suivi (UUID) généré par le formulaire, ou
 * `undefined`. Fourni, il alimente le registre de progression que lit
 * `GET /api/plan-progress`, créneau par créneau ({@link slotProgress}) ; il est
 * effacé quoi qu'il arrive, une entrée oubliée décrirait indéfiniment une
 * génération finie.
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable — la seule chose
 * qu'un coach en panne coûte encore, et c'est `requireAi` qui la dit : le
 * remplissage, lui, se replierait sans broncher.
 * @throws {InvalidPlanError} si la demande ne définit pas une fenêtre valide, ou
 * si le volume visé ne finance pas les séances demandées.
 * @throws {InvalidGeneratedPlanError} si le plan que l'appli a écrit viole ses
 * propres règles — une incohérence interne, jamais une faute du modèle.
 */
export async function generatePlan(request: PlanRequest, progressId?: string): Promise<PlanDto> {
  logProgressTracking(progressId);
  await requireAi();

  const window = planWindow(request, todayCivilDate());
  const snapshot = await getTrainingSnapshot();

  try {
    return await writeGeneratedPlan(request, window, snapshot, progressId);
  } finally {
    // L'écriture en base est incluse dans le suivi : sans cela, la dernière
    // interrogation du formulaire tomberait sur `null` alors que l'attente dure
    // encore, et la barre disparaîtrait juste avant la fin.
    if (progressId !== undefined) clearPlanProgress(progressId);
  }
}

/**
 * Le jour ISO du **jour J**, `null` hors objectif daté.
 *
 * Recalculé depuis la date plutôt que porté par la fenêtre : `planWindow` a déjà
 * refusé une date de course inexploitable ({@link InvalidPlanError}), donc le
 * `isCivilDate` ci-dessous ne couvre qu'un appelant qui court-circuiterait la
 * fenêtre — pas un cas nominal.
 */
function raceIsoDay(request: PlanRequest): number | null {
  const { raceDate } = request;
  if (request.goalType !== 'race' || raceDate === undefined || !isCivilDate(raceDate)) return null;
  return isoDayIndex(raceDate) + 1;
}

/**
 * Le squelette du plan, ou un refus **traduit en erreur de formulaire**.
 *
 * {@link PlanSkeletonInfeasibleError} est un diagnostic technique : elle nomme
 * les semaines fautives, leur cible et le minimum finançable. Ce que l'athlète
 * peut faire de cette information tient en une phrase — courir moins souvent, ou
 * repartir sur un volume qu'elle tient déjà —, et c'est le champ « séances par
 * semaine » qui la porte : c'est le seul des deux qu'un formulaire de plan
 * expose, et celui que l'erreur sait chiffrer ({@link
 * PlanSkeletonInfeasibleError.fundableSessionsPerWeek}).
 *
 * @throws {InvalidPlanError} quand le volume visé ne finance pas les séances
 * demandées.
 */
function planSkeletonOrInvalid(params: PlanSkeletonParams): SkeletonWeek[] {
  try {
    return buildPlanSkeleton(params);
  } catch (error) {
    if (!(error instanceof PlanSkeletonInfeasibleError)) throw error;

    // Le détail chiffré part au journal : il désigne des semaines par leur
    // numéro, ce qui ne veut rien dire dans un formulaire de création.
    console.error(`[plan] squelette infaisable : ${error.message}`);

    const worst = error.weeks.reduce((low, week) => (week.targetKm < low.targetKm ? week : low));
    const fallback =
      error.fundableSessionsPerWeek === 0
        ? "Ton volume actuel ne permet aucun plan à ce rythme : commence par courir davantage, ou repousse l'échéance."
        : `À ce volume, vise ${error.fundableSessionsPerWeek} séance${error.fundableSessionsPerWeek > 1 ? 's' : ''} par semaine au plus.`;

    throw new InvalidPlanError(
      'sessionsPerWeek',
      `${error.requestedSessionsPerWeek} séances par semaine ne tiennent pas dans le volume que ce plan vise ` +
        `(${formatNumber(worst.targetKm, 1)} km sur sa semaine la plus légère, soit moins de ` +
        `${formatNumber(PLAN_OUTPUT_BOUNDS.distanceKm.min, 1)} km par séance). ${fallback}`,
    );
  }
}

/**
 * Le plan assemblé : les séances **écrites** du squelette et les créneaux
 * remplis, remis dans l'ordre des jours.
 *
 * Un seul entraînement par jour est une règle vérifiée
 * ({@link validatePlanBusinessRules}) et le squelette la tient par construction
 * — les jours des créneaux sont pris hors de ceux des séances écrites. Le tri
 * n'est donc pas une précaution contre les doublons, c'est ce qui fait qu'une
 * semaine se lit du lundi au dimanche.
 *
 * @param filled les séances remplies, **dans l'ordre des créneaux du squelette
 * aplati** — c'est le contrat de {@link fillQualitySlots}.
 */
function assemblePlanWeeks(
  skeleton: readonly SkeletonWeek[],
  filled: readonly PlanSessionOutput[],
): PlanWeekOutput[] {
  let cursor = 0;
  return skeleton.map((week) => {
    const own = filled.slice(cursor, cursor + week.qualitySlots.length);
    cursor += week.qualitySlots.length;
    return {
      sessions: [...week.sessions, ...own].sort((left, right) => left.day - right.day),
    };
  });
}

/**
 * Le plan qu'aucune règle ne refuse — **par construction**, et par dégradation
 * s'il le faut.
 *
 * ## Pourquoi une dégradation, et pourquoi celle-là
 *
 * Le squelette est écrit pour satisfaire {@link validatePlanBusinessRules} :
 * c'est sa raison d'être, et son test de propriété le mesure à **zéro
 * violation** sur des dizaines de milliers de combinaisons. Une violation ici
 * n'est donc pas un modèle qui a mal lu une consigne — c'est l'appli qui s'est
 * contredite, et **il n'y a personne à qui redemander quoi que ce soit**.
 *
 * Reste une variable : le déroulé des créneaux, seule partie que le modèle
 * écrit. Le premier barreau consiste donc à la lui retirer entièrement —
 * réécrire **tous** les créneaux avec {@link deterministicQualitySession}, qui
 * est exactement la configuration mesurée à zéro violation — puis à revalider.
 * Réécrire les seuls créneaux des semaines fautives serait plus fin et moins
 * sûr : une règle de volume se lit sur le plan entier, et deux régimes mélangés
 * dans un même plan ne correspondent à aucun cas mesuré.
 *
 * S'il reste des violations après cela, le défaut est dans le squelette ou dans
 * les cibles, pas dans le remplissage. Il n'y a plus rien à tenter, et rendre un
 * plan invalide est le seul geste interdit : on lève, en journalisant assez pour
 * que le cas soit rejouable (les violations, la configuration qui les produit).
 *
 * @throws {InvalidGeneratedPlanError} quand même le plan tout-déterministe viole
 * une règle.
 */
function validatedPlanWeeks(params: {
  skeleton: readonly SkeletonWeek[];
  filled: readonly PlanSessionOutput[];
  postProcess: PlanWeeksPostProcessing;
  expectations: PlanExpectations;
  context: PlanValidationContext;
  /**
   * La configuration en une ligne, telle qu'elle part au journal si même le
   * plan tout-déterministe échoue — de quoi rejouer le cas à l'identique.
   *
   * Une chaîne, et pas la demande d'origine : cet escalier sert désormais deux
   * chemins qui n'ont pas la même entrée (une création part d'un
   * {@link PlanRequest}, une reconstruction part d'un plan en base), et seule
   * la trace les distingue.
   */
  describe: string;
}): PlanWeekOutput[] {
  const { skeleton, postProcess, expectations, context } = params;

  /** Assemble, post-traite, puis juge — les trois gestes du pipeline, dans l'ordre. */
  const judge = (
    filled: readonly PlanSessionOutput[],
  ): { weeks: PlanWeekOutput[]; violations: string[] } => {
    const weeks = postProcess(assemblePlanWeeks(skeleton, filled));
    return { weeks, violations: validatePlanBusinessRules(weeks, expectations, context) };
  };

  const written = judge(params.filled);
  if (written.violations.length === 0) return written.weeks;

  console.error(
    `[plan] plan assemblé hors règles malgré un squelette calculé — réécriture de tous les créneaux par l'appli :\n${written.violations.join('\n')}`,
  );

  const slots = skeleton.flatMap((week) => week.qualitySlots);
  const deterministic = judge(slots.map(deterministicQualitySession));
  if (deterministic.violations.length === 0) return deterministic.weeks;

  console.error(
    `[plan] plan tout-déterministe encore hors règles — ${params.describe} :\n${deterministic.violations.join('\n')}`,
  );
  throw new InvalidGeneratedPlanError(deterministic.violations);
}

/** La demande, en une ligne : de quoi rejouer un plan fautif à l'identique. */
function describePlanRequest(request: PlanRequest): string {
  return [
    `objectif ${request.goalType} « ${request.goalText} »`,
    request.raceDate === undefined ? null : `course le ${request.raceDate}`,
    request.weeks === undefined ? null : `${request.weeks} semaines`,
    `niveau ${request.level}`,
    `${request.sessionsPerWeek} séances/semaine`,
    `sortie longue jour ${request.longRunDay}`,
    request.weeklyTimeMinutes === undefined ? null : `${request.weeklyTimeMinutes} min/semaine`,
    request.startsOn === undefined ? null : `départ ${request.startsOn}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/**
 * Le plan écrit par l'appli ne satisfait pas ses propres règles.
 *
 * Erreur d'**incohérence interne**, et c'est ce qui la distingue d'une
 * {@link AiInvalidOutputError} : aucun modèle n'est en cause, et redemander ne
 * mène nulle part. L'UI la traite comme un imprévu (message générique), le
 * journal porte le diagnostic.
 */
export class InvalidGeneratedPlanError extends Error {
  override readonly name = 'InvalidGeneratedPlanError';

  constructor(readonly violations: readonly string[]) {
    super(`Le plan écrit par l'application viole ses propres règles : ${violations.join(' ')}`);
  }
}

/** Le corps de {@link generatePlan}, isolé pour que l'effacement du suivi tienne en un `finally`. */
async function writeGeneratedPlan(
  request: PlanRequest,
  window: PlanWindow,
  snapshot: TrainingSnapshotDto,
  progressId: string | undefined,
): Promise<PlanDto> {
  const paces = referenceRacePaces(request.referenceRace);
  // Les volumes que l'appli a chiffrés : c'est d'eux que le squelette tire les
  // budgets de chaque séance, et c'est eux que la validation vérifiera.
  const volumeTargets = planVolumeTargets(request, window, snapshot, paces);
  const race = raceGoalOf(request.goalType, request.goalText);
  const raceDay = raceIsoDay(request);

  const expectations: PlanExpectations = {
    scope: 'creation',
    weeks: window.weeks,
    sessionsPerWeek: request.sessionsPerWeek,
    longRunDay: request.longRunDay,
    // > 1 sur un départ en milieu de semaine : la première semaine est jugée
    // comme une semaine entamée, exactement comme à l'ajustement.
    firstWeekFromDay: window.firstWeekFromDay,
    race,
    // La semaine de course se juge sur son jour J : c'est lui qui porte le plus
    // gros effort de la semaine, pas le jour de sortie longue habituel.
    raceDay,
    weeklyTargets: volumeTargets,
  };
  const context: PlanValidationContext = {
    referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm,
    paces,
    // Une création, et elle seule, se juge sur l'historique d'avant-plan.
    recentWeeklyKm: bestRecentWeeklyKm(snapshot),
    // Une création ne porte pas de réglages : le budget est celui de la requête.
    weeklyTimeMinutes: request.weeklyTimeMinutes ?? null,
  };

  // 1. Le squelette : périodisation, volumes, jours, footings, sortie longue et
  //    séance du jour J. Tout ce qui se calcule est écrit ici, par l'appli.
  const skeleton = planSkeletonOrInvalid({
    weeks: window.weeks,
    firstWeekFromDay: window.firstWeekFromDay,
    sessionsPerWeek: request.sessionsPerWeek,
    longRunDay: request.longRunDay,
    level: request.level,
    race,
    raceDay,
    // **Seul un objectif « course » a une distance à préparer.** `goalDistanceKm`
    // ne fait que chercher un motif de distance dans du texte libre, et sans ce
    // filtre le squelette lisait « semi » ou « marathon » dans n'importe quelle
    // phrase. Mesuré : l'objectif libre « me remettre après mon semi » recevait
    // 3 sorties longues découpées en « Mise en route / Bloc à allure objectif /
    // Retour au calme », et « préparer un marathon un jour » 8 séances
    // « Spécifique allure course » — pour des objectifs qui n'ont ni date ni
    // chrono. C'est la règle que le prompt énonce déjà de son côté
    // (cf. `coachRuleTailLines`) : sur un objectif libre il n'y a pas d'allure
    // objectif à travailler, et en prescrire une fabriquerait une échéance.
    goalDistanceKm: request.goalType === 'race' ? goalDistanceKm(request.goalText) : null,
    targets: volumeTargets,
  });

  // 2. Le seul travail qui reste au modèle : le déroulé des séances dures. Un
  //    créneau qui échoue se replie sur un déroulé déterministe, donc cet appel
  //    ne lève jamais et un coach injoignable ne coûte que du sur-mesure.
  const slots = skeleton.flatMap((week) => week.qualitySlots);
  // Posée **avant** le premier créneau : la barre apparaît sans attendre qu'un
  // appel au modèle ait abouti, et un plan sans créneau (deux séances par
  // semaine) n'est pas suivi d'une modale muette.
  if (progressId !== undefined) setPlanProgress(progressId, slotProgress(0, slots.length));
  const filled = await fillQualitySlots(
    slots,
    progressId === undefined
      ? undefined
      : (done, total) => setPlanProgress(progressId, slotProgress(done, total)),
  );

  // 3. Assemblage, post-traitement des allures (la seule porte, inchangée), et
  //    validation — avec sa dégradation en escalier.
  const weeks = validatedPlanWeeks({
    skeleton,
    filled,
    postProcess: planWeeksPostProcessing(context, goalPaceSecPerKm(request.goalText)),
    expectations,
    context,
    describe: describePlanRequest(request),
  });

  // 4. Le résumé, seul texte libre du plan — et le seul endroit où l'écriture du
  //    modèle vaut mieux qu'un gabarit.
  const summary = await planSummary(request, window, volumeTargets, skeleton);

  return createDraftPlanWithSessions({
    goalType: request.goalType,
    level: request.level,
    goalText: request.goalText,
    raceDate: request.goalType === 'race' ? (request.raceDate ?? null) : null,
    referenceDistance: request.referenceRace?.distance ?? null,
    referenceTimeS: request.referenceRace?.timeS ?? null,
    // Le jour **réel** du départ est ce que le plan stocke ; la grille des jours
    // ISO, elle, se pose sur l'ancre.
    startsOn: window.startsOn,
    weeks: window.weeks,
    sessionsPerWeek: request.sessionsPerWeek,
    weeklyTimeMinutes: request.weeklyTimeMinutes ?? null,
    longRunDay: request.longRunDay,
    summary,
    sessions: mapPlanWeeksToSessions(weeks, window.anchor),
  });
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
 * du plan** : des blocs de 7 jours à partir de l'ancre, le lundi de la semaine de
 * `startsOn` — les semaines du plan sont des semaines ISO, y compris quand le
 * plan démarre en milieu de semaine.
 *
 * @throws {InvalidPlanError} si le plan est terminé : il n'y a plus rien à
 * régénérer, et une instruction ne ressuscite pas un plan échu.
 */
export function remainingPlanWindow(
  plan: { startsOn: string; weeks: number },
  fromDate: string,
): RemainingPlanWindow {
  const anchor = isoWeekStart(plan.startsOn);
  // Plan qui n'a pas encore commencé : tout est à venir. Sa première semaine
  // reste celle du départ, entamée si le départ n'est pas un lundi.
  if (fromDate <= plan.startsOn) {
    return {
      firstWeekStart: anchor,
      weeks: plan.weeks,
      firstWeekFromDay: isoDayIndex(plan.startsOn) + 1,
    };
  }

  const offset = civilDaysBetween(anchor, fromDate);
  const weekIndex = Math.floor(offset / 7);
  const weeks = plan.weeks - weekIndex;
  if (weeks <= 0) {
    throw new InvalidPlanError(
      'weeks',
      "Ce plan est arrivé à son terme : il n'y a plus de semaine à régénérer.",
    );
  }

  return {
    firstWeekStart: shiftCivilDate(anchor, weekIndex * 7),
    weeks,
    firstWeekFromDay: offset - weekIndex * 7 + 1,
  };
}

/**
 * Les réglages que la sortie du modèle fait réellement bouger, et rien d'autre.
 *
 * Le résumé est passé à part : une modification le tient du modèle, une révision
 * automatique le compose depuis celui du plan (cf. `review-service.ts`).
 * Exporté pour ce second appelant.
 */
export function planSettingsPatch(
  plan: PlanDto,
  settings: PlanSettingsOutput | undefined,
  summary: string | null,
): PlanSettingsPatch {
  const patch: PlanSettingsPatch = { summary };
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

/*
 * ------------------------------------------------------------------------
 * Reconstruction de la fenêtre restante — la capacité commune à l'ajustement
 * et à la révision.
 * ------------------------------------------------------------------------
 *
 * ## Ce qu'elle fait, et pourquoi elle existe une seule fois
 *
 * Exactement ce que fait une création ({@link writeGeneratedPlan}) — chiffrer
 * les volumes, écrire le squelette, ne faire remplir que les créneaux de
 * qualité, assembler, poser les allures, valider avec dégradation — mais sur la
 * **fin** d'un plan en cours au lieu d'un plan neuf.
 *
 * Les deux chemins qui en ont besoin (l'ajustement par instruction et la
 * révision automatique) ne diffèrent que par ce qui les déclenche et par le
 * texte qu'ils écrivent ; ce qu'ils font au calendrier est identique au geste
 * près. Les écrire deux fois, c'était garantir qu'ils divergeraient — et c'est
 * exactement ce qui s'était passé : la création est passée au squelette pendant
 * qu'ils continuaient à faire réécrire des semaines entières par le modèle.
 *
 * ## Les trois choses qu'une fenêtre partielle change
 *
 * **1. Le passé ne se réécrit pas.** La fenêtre commence demain
 * ({@link remainingPlanWindow}) : sa première semaine est entamée, et le
 * squelette n'y pose de séances qu'à partir du jour de reprise. Le DAL, lui,
 * protège de toute façon les séances déjà réalisées ({@link applyPlanUpdate}).
 *
 * **2. D'où repart la progression : du réel, pas du plan.** C'est la décision
 * de conception de ce chantier, et elle mérite d'être écrite (cf.
 * {@link remainingVolumeTargets}).
 *
 * **3. La périodisation ne redémarre pas.** Une fenêtre restante n'est pas un
 * plan neuf : les phases sont calculées sur le plan **entier** puis tranchées
 * (cf. {@link remainingPhases}).
 */

/** Ce qu'il faut pour reconstruire la fin d'un plan en cours. */
export type RemainingPlanRewriteParams = {
  /** Le plan en cours, tel que le DAL le rend. */
  plan: PlanDto;
  /** La fenêtre restante ({@link remainingPlanWindow}). */
  window: RemainingPlanWindow;
  /** L'état d'entraînement réel de l'athlète — l'ancrage des volumes. */
  snapshot: TrainingSnapshotDto;
  /**
   * Ce que le plan **prescrit** par semaine ISO, en km ({@link planWeeklyVolumeKm})
   * — la mémoire de ce qu'il visait.
   *
   * Sans elle, la reconstruction repart du seul réel, et la boucle « je prescris
   * → elle court → je m'ancre sur ce qu'elle a couru » a un gain égal au taux de
   * réalisation : ×2,50 sur 16 semaines à réalisation 1,05, ×0,24 à 0,9 (cf.
   * {@link CONTINUATION_RULES.realizationRelief}). Une carte vide reste
   * acceptable — la reconstruction retombe alors sur le réel nu — et c'est ce qui
   * arrive sur un plan dont aucune séance ne porte de volume.
   */
  plannedWeeklyKm: ReadonlyMap<string, number>;
  /**
   * Les réglages durables que l'appelant fait bouger — `undefined` quand il n'en
   * change aucun. C'est la seule chose que le modèle décide encore du
   * calendrier : le nombre de séances, le jour de sortie longue, le budget temps.
   */
  settings?: PlanSettingsOutput;
  /**
   * Appelé après chaque créneau rempli, pour la barre de progression — absent
   * quand personne ne regarde (la révision tourne à l'import).
   */
  onSlotFilled?: (filled: number, total: number) => void;
};

/** Ce que la reconstruction rend : les semaines, et de quoi en parler. */
export type RemainingPlanRewrite = {
  /** Les semaines de la fenêtre, validées — prêtes pour {@link mapPlanWeeksToSessions}. */
  weeks: PlanWeekOutput[];
  /** Les cibles chiffrées de la fenêtre, dans l'ordre. */
  targets: WeeklyVolumeTarget[];
  /** Le squelette, pour ce que le résumé en dit (périodisation, créneaux). */
  skeleton: SkeletonWeek[];
  /** Les réglages effectifs de la fenêtre, patch appliqué. */
  effectiveSettings: EffectivePlanSettings;
};

/** Les réglages d'un plan une fois le patch de l'appelant appliqué. */
export type EffectivePlanSettings = {
  sessionsPerWeek: number;
  longRunDay: number;
  weeklyTimeMinutes: number | null;
};

/**
 * Les réglages du plan, patchés par ce que l'appelant a décidé.
 *
 * `resolveWeeklyTimeBudget` porte les trois états du budget temps (absent,
 * `null`, valeur) : c'est la même fonction qui décide ici de ce que le
 * planificateur vise et là de ce que la validation vérifie, donc les deux ne
 * peuvent pas diverger.
 */
function effectiveSettingsOf(
  plan: PlanDto,
  settings: PlanSettingsOutput | undefined,
): EffectivePlanSettings {
  return {
    sessionsPerWeek: settings?.sessionsPerWeek ?? plan.sessionsPerWeek,
    longRunDay: settings?.longRunDay ?? plan.longRunDay,
    weeklyTimeMinutes: resolveWeeklyTimeBudget(settings, plan.weeklyTimeMinutes),
  };
}

/**
 * Le jour ISO du jour J d'un plan en cours, `null` quand il n'y en a pas.
 *
 * Il compte ici pour les mêmes raisons qu'à la création, et il comptait déjà
 * avant qu'on sache s'en servir : sans lui, la dernière semaine reçoit une
 * « Sortie longue » posée le jour de sortie longue habituel — y compris quand ce
 * jour-là *est* celui de la course — et des séances **après** l'épreuve. La
 * différence est qu'une reconstruction réécrit désormais cette semaine-là, donc
 * qu'elle doit la traiter comme la création la traite.
 *
 * ## Pourquoi la date est vérifiée, et pas seulement lue
 *
 * Ce jour ISO est **posé sur la dernière semaine de la fenêtre** par
 * {@link PlanExpectations.raceDay} et par le squelette : dire « jour J = mardi »
 * ferme cette semaine-là au mardi et y déplace le plus gros effort. Se contenter
 * de lire le jour de la semaine de `raceDate`, sans vérifier que cette date
 * tombe bien dans la dernière semaine, c'est faire ce ravage sur une semaine qui
 * n'est pas celle de la course — et amputer une semaine ordinaire de ses cinq
 * derniers jours.
 *
 * La fenêtre restante se termine avec le plan, donc l'incohérence n'est pas
 * atteignable aujourd'hui. Elle a pourtant déjà coûté : c'est exactement elle
 * qui rendait une fixture de test fausse sans que rien ne le dise. Le repli est
 * de **ne pas déclarer de jour J** — la dernière semaine redevient une semaine
 * comme les autres, ce qui est faux mais inoffensif — et de le journaliser, sans
 * quoi une fenêtre mal découpée resterait indiscernable d'un plan sans course.
 */
function planRaceIsoDay(plan: PlanDto, window: RemainingPlanWindow): number | null {
  if (plan.goalType !== 'race' || plan.raceDate === null || !isCivilDate(plan.raceDate)) return null;

  const lastWeekStart = shiftCivilDate(window.firstWeekStart, (window.weeks - 1) * 7);
  const offset = civilDaysBetween(lastWeekStart, plan.raceDate);
  if (offset < 0 || offset >= 7) {
    console.error(
      `[plan] plan ${plan.id} : course le ${plan.raceDate}, hors de la dernière semaine de la ` +
        `fenêtre reconstruite (${lastWeekStart} + 7 jours) — jour J non déclaré.`,
    );
    return null;
  }

  return isoDayIndex(plan.raceDate) + 1;
}

/**
 * La périodisation de la fenêtre restante : celle du **plan entier**, tranchée.
 *
 * ## Pourquoi elle ne se recalcule pas sur la fenêtre
 *
 * Parce que {@link planPhases} déduit les phases d'une **durée** : quelques
 * semaines de base, du développement, de la spécificité, l'affûtage. Appliquée
 * aux dix semaines restantes d'un plan de seize, elle rendrait « quelques
 * semaines de base » — et renverrait en phase de base une athlète qui entre dans
 * son bloc spécifique. Pire : la périodisation redémarrerait à **chaque**
 * ajustement, et comme la révision se déclenche toutes les quatre séances, le
 * plan ne quitterait jamais sa base.
 *
 * On calcule donc les phases sur le plan entier — la seule fenêtre où
 * « 30 % de base, 40 % de développement, 30 % de spécificité » veut dire quelque
 * chose — et on n'en garde que la queue. La position dans la préparation est
 * ainsi **conservée par construction**, sans qu'on ait à l'inventer.
 *
 * ## L'exception de la semaine entamée
 *
 * La première semaine restante est entamée : des séances y ont déjà eu lieu,
 * dont peut-être une séance de qualité, et rien de ce qui remonte ici ne le dit.
 * Elle est donc ramenée à `partial`, exactement comme la semaine de départ d'une
 * création, et pour la même raison — poser une séance dure derrière des jours
 * inconnus est un pari qu'aucun entraîneur ne prend. La semaine de **course**,
 * elle, garde sa phase : elle ne porte de toute façon aucune qualité, et lui
 * retirer son étiquette lui retirerait sa course.
 */
function remainingPhases(plan: PlanDto, window: RemainingPlanWindow): PlanPhase[] {
  const race = raceGoalOf(plan.goalType, plan.goalText);
  const full = planPhases({
    weeks: plan.weeks,
    // La périodisation d'origine : celle qu'a connue le plan quand il a été
    // écrit, jour de départ compris.
    firstWeekFromDay: isoDayIndex(plan.startsOn) + 1,
    race,
  });

  // La fenêtre se termine avec le plan : ses semaines sont donc les dernières.
  const phases = full.slice(Math.max(0, full.length - window.weeks));
  if (window.firstWeekFromDay > 1 && phases.length > 0 && phases[0] !== 'race') {
    phases[0] = 'partial';
  }
  return phases;
}

/**
 * Ce que le plan **prescrit** par semaine ISO, en kilomètres — la mémoire de ce
 * qu'il visait, dont la reconstruction a besoin pour ne pas repartir du seul
 * réel (cf. {@link CONTINUATION_RULES.realizationRelief}).
 *
 * Les séances du plan sont la seule trace de ses volumes : rien ne stocke les
 * cibles hebdomadaires, et une reconstruction en réécrit une partie à chaque
 * passage. Ce qui reste vrai, et c'est ce qui compte ici, c'est que les semaines
 * **révolues** portent ce que la dernière reconstruction leur avait prescrit —
 * le passé ne se réécrit pas (`applyPlanUpdate`).
 *
 * Une semaine dont **une seule** séance ne déclare pas sa distance est écartée
 * plutôt que sous-estimée : la même prudence que `weekVolumeKm` dans
 * `plan-schema.ts`, et pour la même raison — une somme partielle ferait constater
 * un manquement qui n'existe pas, ici en faisant croire que l'athlète a dépassé
 * sa prescription.
 *
 * Fonction pure, exportée pour être éprouvée et appelée par les deux chemins de
 * reconstruction (l'ajustement par instruction et la révision automatique).
 */
export function planWeeklyVolumeKm(
  sessions: readonly PlanSessionDto[],
): ReadonlyMap<string, number> {
  const byWeek = new Map<string, number>();
  const incomplete = new Set<string>();

  for (const session of sessions) {
    const week = isoWeekStart(session.scheduledOn);
    if (session.volumeM === null) {
      incomplete.add(week);
      continue;
    }
    byWeek.set(week, (byWeek.get(week) ?? 0) + session.volumeM / 1_000);
  }

  for (const week of incomplete) byWeek.delete(week);
  return byWeek;
}

/*
 * ------------------------------------------------------------------------
 * L'arithmétique d'une **continuation** — explicite, autonome, et séparée de
 * celle d'un démarrage.
 * ------------------------------------------------------------------------
 *
 * ## Le constat qui a fait écrire cette section
 *
 * Quatre revues successives ont trouvé neuf défauts, tous ici, tous de la même
 * famille : **invisibles sur une exécution, visibles sur la trajectoire d'un
 * plan qu'on réadapte**. À chaque ronde, la correction ajoutait un paramètre
 * optionnel à `weeklyVolumeTargets` (`firstFullWeekCapKm`, puis
 * `firstFullWeekCadenceRank`) et créait une couture, qui produisait le défaut
 * suivant.
 *
 * La cause racine était là : `weeklyVolumeTargets` est une fonction de
 * **création** — elle sait démarrer : choisir un point de départ à partir du
 * réel récent, monter, alléger, affûter — et on lui faisait faire de la
 * **continuation** — reprendre un plan en cours à sa semaine N — par surcharges
 * successives. Démarrer et continuer n'obéissent pas aux mêmes règles, et les
 * mélanger dans une fonction paramétrée produit des cas limites sans fin.
 *
 * D'où cette section : la continuation calcule ses cibles avec sa propre
 * logique, lisible d'un bout à l'autre. Elle réutilise de `plan-schema.ts` les
 * briques partagées — `taperWeekCount`, `taperFactors`, `floorKm`, `VOLUME_RULES.maxWeeklyGrowth`,
 * `remainingWeekDays`, `isCutbackCadenceRank`, les constantes de
 * {@link VOLUME_RULES} et {@link VOLUME_TARGET_RULES} — parce que deux arrondis
 * ou deux cadences divergents produiraient des cibles que la validation refuse.
 * Elle n'emprunte plus **jamais** le chemin de démarrage. Les deux paramètres
 * optionnels ont été retirés de `weeklyVolumeTargets`, et c'est le signe que la
 * séparation est propre : la création ne connaît plus la continuation.
 *
 * ## Le principe, en une phrase
 *
 * **Une marche par semaine calendaire franchie depuis la dernière semaine
 * complète, jamais plus, jamais moins** — la marche étant celle que la cadence
 * du plan d'origine assigne à cette semaine-là (la progression du niveau, ou la
 * baisse d'une semaine allégée).
 *
 * Tout le reste en découle : c'est ce qui rend la trajectoire **indépendante de
 * la fréquence et du jour de réadaptation** pour une athlète qui court son plan.
 * Réadapter un mercredi ou un dimanche, chaque semaine ou toutes les quatre, ne
 * change rien : les mêmes semaines calendaires sont franchies, donc les mêmes
 * marches sont appliquées.
 *
 * ## Les neuf propriétés, et les trajectoires qui les ont fait écrire
 *
 * Chacune est un défaut mesuré, retourné en spécification. Elles sont éprouvées
 * dans `plan-service.test.ts`, section « la vie d'un plan » — un balayage
 * complet (1 à 4 semaines entre réadaptations × 7 jours de déclenchement ×
 * réalisation 0,9 / 1,0 / 1,05 / 5,0, sur 16 semaines de vie), et le modèle
 * d'athlète y est **honnête** : la semaine en cours n'est courue qu'au prorata
 * des jours écoulés. Ce détail-là n'en est pas un — tant que la simulation lui
 * donnait son volume plein dès le premier jour, une branche que la production
 * n'emprunte presque jamais recalait la trajectoire à chaque tour, et le harnais
 * sauvait le code qu'il devait éprouver (défauts 7 et 8 ci-dessous).
 *
 * **1. Une marche par semaine calendaire franchie.** Avant : quand la fenêtre
 * s'ouvrait en milieu de semaine, la première semaine *pleine* était deux
 * semaines calendaires après l'ancre mais ne recevait qu'une marche — la
 * progression marquait le pas, et chaque réadaptation en perdait une. Mesuré,
 * athlète courant **exactement** son plan, réadaptée toutes les 2 semaines en
 * milieu de semaine : `45,3 → 29,4 km, ×0,66 sur 16 semaines`. Un plan qui
 * **décroît** pour quelqu'un d'assidu.
 *
 * **2. La cadence des semaines allégées est celle du plan d'origine**, en
 * semaines calendaires, quelle que soit la fréquence des reconstructions. Elle
 * se lit de la position de chaque semaine dans le plan
 * ({@link planCadenceRank}), jamais de sa position dans la fenêtre : la révision
 * se déclenchant toutes les quatre séances, une cadence comptée depuis la
 * fenêtre remettait l'athlète au premier rang d'un bloc neuf à chaque passage,
 * et elle n'atteignait donc **jamais** le quatrième — plus une seule semaine de
 * récupération, jamais. Mesuré sur le code d'il y a deux rondes, plan de 24
 * semaines, réadaptation hebdomadaire :
 * `45,3 → 48,9 → 52,8 → 57,0 → 61,5 → 66,4 → 71,7 → 77,4 → 83,5 → 90,1 → 97,3 → 105,0`,
 * soit +8 % par semaine pendant douze semaines quand un bloc de développement
 * ne progresse que de 1,08³ × 0,85 = +1,7 % par semaine.
 *
 * **3. Une semaine n'est étiquetée `cutback` que si son volume baisse
 * réellement** par rapport à ce que l'athlète a couru. Avant : la marche 0,85
 * s'appliquait à l'ancre, y compris quand l'ancre venait du pont
 * ({@link CONTINUATION_RULES.pauseBridgeShare}) ou du plancher
 * ({@link CONTINUATION_RULES.demonstratedFloorShare}) — la cible étiquetée
 * « allégée » était alors **au-dessus** du réel. Mesuré, semaines réelles
 * `58, 60, 60, 20` : cible de **35,6 km étiquetée `cutback`, soit +78 % après
 * une semaine à 20 km**, suivie de quatre hausses parce que la validation lisait
 * l'étiquette et considérait la respiration consommée. Une reprise après
 * interruption **est déjà** une décharge : lui appliquer 0,85 et déclarer la
 * respiration consommée est faux des deux côtés. D'où le mode *reprise*
 * ci-dessous, qui ne descend pas et rouvre un bloc.
 *
 * **4. La complétude d'une semaine se lit du calendrier**, pas de la géométrie
 * de la fenêtre. Avant, la complétude se déduisait de
 * `window.firstWeekStart > isoWeekStart(today)`, ce qui n'est vrai que sur une
 * des deux branches de {@link remainingPlanWindow} : sur un plan **actif mais
 * pas encore démarré** — l'état normal, `acceptDraftPlan` ne vérifie pas
 * `startsOn` —, la semaine en cours, partielle, était comptée comme complète.
 * Mesuré : **−30 %** sur la première semaine prescrite, et symétriquement une
 * grosse semaine partielle relevait l'ancrage à tort. Ici, la semaine de `today`
 * est **toujours** ouverte, et elle ne peut donc que **relever** l'ancrage.
 *
 * **5. Pas de cliquet montant, et une descente amortie.** Avant, l'ancre n'était bornée par
 * rien vers le haut : à réalisation 1,05 la hausse hebdomadaire atteignait
 * **1,134 > `maxWeeklyGrowth`** et le plan faisait **×2,50 sur 16 semaines** ;
 * une seule sortie non planifiée dans une semaine allégée l'annulait et relevait
 * **tout l'avenir de 18 %**. Symétriquement, à réalisation 0,9 le plan
 * s'effondrait (**×0,24**). La boucle avait un gain `réalisation` par
 * reconstruction, sans amortissement ni mémoire de ce que le plan visait. Elle
 * en a une désormais : la reconstruction connaît **ce que le plan prescrivait**
 * pour la semaine d'ancrage (`plannedWeeklyKm`), et le réel ne fait que la
 * corriger, dans une bande ({@link CONTINUATION_RULES.realizationRelief}).
 *
 * **6. Aucune `InvalidGeneratedPlanError` là où un refus lisible est possible.**
 * Corrigé à la source, dans `weeklySessionBudgets` (`plan-schema.ts`) : le
 * budget de sortie longue est borné par le plus gros footing de la semaine.
 *
 * **7. L'affûtage se lit du plan, et sur toutes les géométries de fenêtre.**
 * `lastBuild < firstFull` en couvre deux, pas une : la fenêtre entièrement
 * d'affûtage, et celle qui s'ouvre **en milieu de semaine sur la dernière semaine
 * de développement** — c'est-à-dire toute révision déclenchée un autre jour que
 * le dimanche pendant cette semaine-là. La seconde repliait sur le point de
 * départ de la fenêtre, un volume d'affûtage relu, et lui réappliquait les
 * facteurs : **44,3 / 32,5 km le dimanche, 33,1 / 24,3 du lundi au jeudi, −25 %**,
 * soit un facteur 1,44 sur la semaine de course pour le même plan et la même
 * athlète (cf. le plafond de l'affûtage dans {@link remainingVolumeTargets}). Le
 * **compte** des semaines d'affûtage se lit lui aussi du plan et non de la
 * fenêtre, du même mouvement que la cadence de la propriété 2 : une fenêtre de 4
 * à 7 semaines n'affûtait que deux semaines là où un marathon en affûte trois.
 *
 * **8. Aucun dixième ne se perd d'une reconstruction à l'autre.** {@link floorKm}
 * est un plancher *strictement* inférieur : il retire un dixième à toute valeur
 * déjà posée sur la grille. Appliqué à une cible relue — et une reconstruction
 * relit toujours ce que la précédente a écrit —, il rabotait le plan de 0,1 km par
 * passage : **56,7 km en semaine 17 au lieu de 58,6, ×0,968** sur seize
 * réadaptations hebdomadaires. La chaîne de promesses garde donc la valeur brute
 * à côté de la valeur planchée (cf. `promisedKm`).
 *
 * **9. Le plan peut remonter, et il ne peut pas s'emballer.** Le plafond du réel
 * était la prescription *courante* : le plancher ne mesurait plus ce que l'athlète
 * avait démontré mais ce que le plan lui avait permis, et la boucle se refermait
 * sur elle-même — un creux de quatre semaines à 50 % coûtait **−77 %** du plan à
 * la semaine 24, et courir cinq fois le prescrit pendant seize semaines n'y
 * changeait *rien*. Le plafond est désormais ce que le plan **promettait**, et le
 * crédit peut dépasser 1 d'un cran borné par la règle de hausse.
 */

/**
 * Ce qu'une **continuation** retient du passé récent, là où un démarrage
 * n'aurait retenu qu'un plafond ({@link firstFullWeekMaxKm}).
 *
 * Quatre chiffres, quatre dimensions distinctes, et aucun n'est une règle de
 * progression — celle-là reste {@link VOLUME_TARGET_RULES.weeklyGrowth}, sous le
 * plafond {@link VOLUME_RULES.maxWeeklyGrowth}. Ces chiffres-ci ne disent pas
 * *de combien on monte*, ils disent *depuis quoi*.
 */
const CONTINUATION_RULES = {
  /**
   * Le **pont d'une semaine sautée** : ce qu'il reste de l'avant-dernière
   * semaine complète quand la dernière est vide ou effondrée.
   *
   * Une semaine à zéro dans un bloc — vacances, grippe, déplacement — ne remet
   * pas une athlète au niveau de sa semaine à zéro : elle lui coûte une marche,
   * pas sa condition. 70 %, soit une reprise à un peu moins des trois quarts du
   * volume d'avant l'interruption, ce qui est la fourchette d'usage après une
   * semaine d'arrêt.
   *
   * Le pont ne franchit **qu'une** semaine, et c'est ce qui le distingue d'un
   * lissage : deux semaines consécutives en baisse ne sont plus un accident,
   * c'est une tendance, et une tendance se suit.
   */
  pauseBridgeShare: 0.7,
  /**
   * Le **plancher démontré** : la reconstruction ne descend jamais sous ce quart
   * du meilleur volume vu dans la fenêtre du snapshot.
   *
   * Sans lui, trois semaines à zéro rendent un ancrage nul, et une athlète à
   * 52 km/semaine repart soit au départ par défaut de son niveau, soit — pire —
   * sur un volume que le squelette refuse de financer
   * (`PlanSkeletonInfeasibleError` : 5 km minimum à 6 séances). Un quart, c'est
   * la reprise très prudente qu'on propose après un arrêt long, et c'est surtout
   * un chiffre qui garde la fenêtre **écrivable** : 13 km pour une athlète de
   * 52 km, largement au-dessus du minimum finançable.
   */
  demonstratedFloorShare: 0.25,
  /**
   * Ce que le plan **pardonne** d'écart à sa propre prescription, en part de
   * cette prescription — l'amortisseur de la boucle de rétroaction.
   *
   * ## Le défaut qu'il ferme : le gain de boucle
   *
   * Chaque reconstruction s'ancre sur ce que l'athlète a couru ; ce qu'elle
   * prescrit devient ce que l'athlète courra. C'est une boucle fermée, et son
   * gain valait exactement le taux de réalisation. Mesuré sur 16 semaines de vie
   * à réadaptation hebdomadaire : **×2,50 à réalisation 1,05** (avec une hausse
   * hebdomadaire à 1,134, au-dessus du plafond de 1,12 que la validation
   * applique *à l'intérieur* d'une fenêtre et ne peut donc pas voir), et
   * **×0,24 à réalisation 0,9**. Un plan qui s'emballe et un plan qui s'effondre,
   * pour ±5 à 10 % d'écart à sa propre prescription.
   *
   * ## Ce que la mémoire du plan change
   *
   * La reconstruction sait ce que le plan prescrivait pour la semaine
   * d'ancrage : le réel n'est plus la source, il est la **correction**. Deux
   * bornes, asymétriques à dessein :
   *
   * - **vers le haut, un cran, et un seul** : `min(recoveryCap, …)`, où le cran
   *   vaut tout ce que `maxWeeklyGrowth` laisse au-dessus de la progression du
   *   niveau, `VOLUME_TARGET_RULES.weeklyGrowth` (cf. la sortie de l'enfermement
   *   dans {@link remainingVolumeTargets}).
   *   Il ne dépend pas de *combien* l'athlète a dépassé sa prescription : le
   *   cliquet montant entrait par là — une sortie non planifiée dans une semaine
   *   allégée annulait la respiration et relevait tout l'avenir de 18 % —, et la
   *   doctrine reste que le plan est un projet, pas un enregistreur. Ce cran-ci ne
   *   sert qu'à laisser un plan **rejoindre sa propre promesse** quand il en a
   *   décroché, et la promesse le plafonne ;
   * - **vers le bas, ces 5 points** : `réel + 5 % du prescrit`, plafonné au
   *   prescrit. Un écart de 5 % à la prescription est du bruit — une séance
   *   écourtée, un GPS qui coupe — et le plan l'absorbe. Au-delà, c'est un
   *   signal, et un signal se suit : l'écart au-delà des 5 points passe
   *   intégralement dans l'ancrage.
   *
   * ## Ce que cela borne, et ce que cela ne borne pas
   *
   * À réalisation ≥ 0,95, la trajectoire est celle que le plan avait promise : le
   * crédit sature son cran, et la promesse plafonne. Elle ne dépend alors de la
   * fréquence de réadaptation qu'à **3 pour mille** près — le résidu d'arrondi des
   * semaines entamées, éprouvé et borné dans « la vie d'un plan » ; le mot
   * « exactement » qui figurait ici promettait plus que l'arithmétique ne tient.
   * À réalisation 0,9, chaque reconstruction retient 0,95 —
   * la trajectoire descend donc, ce qui est le comportement voulu, mais d'au plus
   * 0,95 par reconstruction au lieu de 0,9. Sur 16 semaines à réadaptation
   * hebdomadaire, `0,95¹⁶ = 0,44` du nominal au lieu de `0,9¹⁶ = 0,19`.
   *
   * Une dérive résiduelle vers le bas subsiste donc, et c'est **assumé** : une
   * athlète qui ne court durablement que 90 % de ce qu'on lui prescrit doit voir
   * son plan descendre. Le modèle de test qui la simule suppose une athlète dont
   * la production est *proportionnelle* à la prescription, donc sans capacité
   * propre ; une vraie athlète à capacité fixe voit le plan descendre jusqu'à sa
   * capacité, où la réalisation revient à 1 — et le cran de remontée la ramène
   * alors vers la promesse du plan, ce qui n'était pas le cas avant cette ronde.
   */
  realizationRelief: 0.05,
} as const;

/**
 * Le lundi de la première semaine **pleine** du plan — le rang 0 de sa cadence.
 *
 * Une semaine entamée porte quelques jours et un volume proratisé : elle n'ouvre
 * pas un bloc d'entraînement, et la création ne la compte pas non plus (cf.
 * `firstFull` dans `weeklyVolumeTargets`). C'est la conserver ici qui fait qu'un
 * plan démarré un mercredi retrouve ses respirations aux mêmes semaines, d'où
 * qu'on le rouvre.
 */
function planFirstFullWeekStart(plan: { startsOn: string }): string {
  const anchor = isoWeekStart(plan.startsOn);
  return isoDayIndex(plan.startsOn) > 0 ? shiftCivilDate(anchor, 7) : anchor;
}

/**
 * Le rang d'une semaine **calendaire** dans la cadence des semaines allégées du
 * plan : 0 pour sa première semaine pleine, 3 pour la respiration qui referme le
 * premier bloc, et ainsi de suite.
 *
 * Négatif pour une semaine antérieure au plan — la cadence n'a pas d'objet
 * avant lui, et l'appelant le vérifie.
 *
 * C'est **la** correction de la propriété 2 : le rang se déduit des dates, donc
 * de la position dans la préparation, et jamais de la position dans la fenêtre
 * reconstruite. Une fenêtre neuve à chaque réadaptation ne déplace plus rien.
 */
function planCadenceRank(plan: { startsOn: string }, weekStart: string): number {
  return Math.round(civilDaysBetween(planFirstFullWeekStart(plan), weekStart) / 7);
}

/**
 * D'où la fenêtre repart, et dans quel régime.
 *
 * Le volume est celui de la **première semaine pleine** de la fenêtre, déjà
 * projeté : toutes les marches calendaires qui séparent l'ancrage réel de cette
 * semaine-là y sont appliquées.
 */
type ContinuationSeed = {
  /** Volume plein visé pour la première semaine **pleine** de la fenêtre, en km. */
  firstFullWeekKm: number;
  /**
   * Vrai quand ce volume ne prolonge pas un bloc en cours mais **rouvre** un
   * bloc : le pont d'une semaine sautée, le plancher démontré, ou le repli du
   * niveau quand rien n'ancre la reprise.
   *
   * Deux conséquences, et elles vont ensemble (propriété 3) : la cadence repart
   * du rang 0 — une reprise n'hérite pas de la respiration du bloc qu'elle
   * interrompt —, et la première semaine pleine n'est donc jamais étiquetée
   * `cutback`, ce qui serait mentir à la validation sur une cible qui monte.
   */
  resumption: boolean;
};

/**
 * Les volumes cibles d'une fenêtre restante, semaine par semaine.
 *
 * L'algorithme, dans l'ordre — et il se lit d'un bout à l'autre, c'est le point
 * de ce chantier :
 *
 * 1. **La cadence.** Chaque semaine calendaire de la fenêtre reçoit son rang
 *    dans le plan d'origine ({@link planCadenceRank}), et donc sa marche : la
 *    progression du niveau, ou la baisse d'une semaine allégée.
 * 2. **L'ancrage.** La dernière semaine ISO **révolue** du snapshot, corrigée
 *    par ce que le plan prescrivait pour elle
 *    ({@link CONTINUATION_RULES.realizationRelief}), puis projetée jusqu'à la
 *    première semaine pleine de la fenêtre — une marche par semaine franchie.
 *    La semaine en cours, elle, ne peut que **relever** cet ancrage : elle est
 *    partielle par construction. Et deux garde-fous rouvrent un bloc plutôt que
 *    de prolonger un effondrement : le pont d'une semaine sautée et le plancher
 *    démontré.
 * 3. **La montée**, marche après marche, plafonnée au budget temps.
 * 4. **L'affûtage** ({@link taperFactors}), quand le plan mène à une course.
 * 5. **La semaine entamée**, au prorata de ses jours restants — une marche en
 *    dessous de la première semaine pleine parce qu'elle est une semaine
 *    calendaire plus tôt, sauf quand l'affûtage la couvre déjà ou qu'elle **est**
 *    la dernière semaine de développement du plan : la marche ne s'applique alors
 *    à rien, le volume de cette semaine-là étant lu directement.
 *
 * Ce que cette fonction ne fait **pas**, et c'est délibéré : elle ne garde pas
 * de réserve de montée sous le budget temps ({@link VOLUME_TARGET_RULES.peakHeadroom}).
 * Cette réserve existe à la création pour rendre l'anti-plat satisfaisable ; une
 * fenêtre restante est jugée en `scope: 'adjustment'`, où l'anti-plat ne
 * s'applique pas (cf. `volumeViolations`). La garder amputerait le volume de
 * 13 % pour une contrainte qui n'existe pas ici.
 *
 * Fonction **pure**, exportée pour être éprouvée directement : c'est cette
 * arithmétique-là qui a coûté neuf défauts, et les éprouver à travers
 * {@link rewriteRemainingPlan} — qui remplit des créneaux de qualité — rendrait
 * le balayage de trajectoires trop lent pour être écrit.
 */
export function remainingVolumeTargets(
  plan: PlanDto,
  window: RemainingPlanWindow,
  snapshot: TrainingSnapshotDto,
  settings: EffectivePlanSettings,
  paces: TrainingPaces | null,
  plannedWeeklyKm: ReadonlyMap<string, number>,
): WeeklyVolumeTarget[] {
  const weeks = window.weeks;
  if (weeks <= 0) return [];

  // Les plans antérieurs au champ n'en portent pas : `intermediate` est le
  // régime médian, celui qui ne durcit ni n'allège la progression.
  const level = plan.level ?? 'intermediate';
  const race = raceGoalOf(plan.goalType, plan.goalText);
  const growth = VOLUME_TARGET_RULES.weeklyGrowth[level];
  const paceMinPerKm =
    (easyPaceSecPerKm(snapshot, paces) ?? VOLUME_TARGET_RULES.fallbackEasyPaceSecPerKm) / 60;

  const firstFull = window.firstWeekFromDay > 1 ? 1 : 0;

  // Le plan s'offre-t-il des semaines allégées ? **La question se pose du plan,
  // pas de la fenêtre**, et c'est la propriété 2 jusqu'au bout.
  //
  // La création pose cette condition sur le plan qu'elle écrit, ce qui est la
  // même chose. La poser sur la fenêtre reconstruite ferait dépendre la cadence
  // de la fréquence des réadaptations : mesuré sur une préparation de 16 semaines
  // menant à une course, la respiration de la semaine 12 tombait bien quand on
  // réadaptait toutes les 4 semaines (la fenêtre ouverte en semaine 9 est encore
  // longue) et disparaissait en réadaptation hebdomadaire (la fenêtre ouverte en
  // semaine 12 ne compte plus que deux semaines de développement avant
  // l'affûtage). Deux athlètes, le même plan, deux périodisations.
  //
  // Rien ne s'y oppose côté validation : la règle des quatre semaines n'exige une
  // respiration que sur une fenêtre assez longue, elle n'en interdit jamais une.
  const planTaperWeeks = taperWeekCount(plan.weeks, race);
  const planFirstFull = isoDayIndex(plan.startsOn) > 0 ? 1 : 0;
  const planBuildWeeks = plan.weeks - planTaperWeeks - planFirstFull;
  const eases =
    plan.weeks >= VOLUME_RULES.minWeeksForCutback &&
    planBuildWeeks >= VOLUME_RULES.minBuildWeeksForCutback;

  // **L'affûtage se compte lui aussi du plan, pas de la fenêtre.** Une fenêtre
  // restante finit toujours avec le plan : ses semaines d'affûtage sont donc les
  // `planTaperWeeks` dernières du plan, tronquées par la longueur de la fenêtre.
  //
  // Le compter sur la fenêtre (`taperWeekCount(weeks, race)`) faisait dépendre
  // l'affûtage de la date de la dernière réadaptation, du même mouvement que la
  // cadence juste au-dessus : `taperWeekCount` n'ouvre la troisième semaine
  // d'affûtage d'un marathon qu'à partir de huit semaines, si bien qu'une fenêtre
  // de 4 à 7 semaines n'affûtait que deux semaines là où le plan en affûte trois.
  // Mesuré sur un marathon de 20 semaines : la semaine 18 valait 46,6 km ou
  // 63,2 km selon la réadaptation qui l'avait écrite.
  const taper = Math.min(weeks, planTaperWeeks);
  const taperFrom = weeks - taper;
  const lastBuild = taperFrom - 1;

  const budgetKm =
    settings.weeklyTimeMinutes === null || settings.weeklyTimeMinutes <= 0
      ? null
      : (settings.weeklyTimeMinutes * VOLUME_TARGET_RULES.timeBudgetShare) / paceMinPerKm;

  const planWeekStart = isoWeekStart(plan.startsOn);
  const firstFullWeekStart = shiftCivilDate(window.firstWeekStart, firstFull * 7);

  /**
   * La marche que fait franchir la semaine calendaire `weekStart` — la seule
   * définition de « une marche », et elle ne dépend que du calendrier.
   *
   * `1` (aucune marche) pour une semaine **antérieure au plan** : rien n'y était
   * prescrit, et composer une progression sur des semaines que l'athlète n'a pas
   * courues au titre du plan reviendrait à lui facturer un entraînement qui n'a
   * pas eu lieu. Le cas se présente sur un plan actif dont la date de départ est
   * encore devant (`acceptDraftPlan` ne vérifie pas `startsOn`).
   */
  const stepInto = (weekStart: string): number => {
    if (weekStart < planWeekStart) return 1;
    const rank = planCadenceRank(plan, weekStart);
    return eases && rank >= 0 && isCutbackCadenceRank(rank) ? VOLUME_RULES.cutbackRatio : growth;
  };

  /**
   * Un volume attribué à la semaine `fromWeek`, projeté jusqu'à `toWeek` : une
   * marche par semaine calendaire franchie, jamais plus, jamais moins.
   *
   * C'est la propriété 1, et elle tient ici en trois lignes.
   */
  const project = (fromWeek: string, km: number, toWeek: string): number => {
    let value = km;
    for (let week = shiftCivilDate(fromWeek, 7); week <= toWeek; week = shiftCivilDate(week, 7)) {
      value *= stepInto(week);
    }
    return value;
  };

  // La complétude d'une semaine se lit du **calendrier** (propriété 4) : la
  // semaine de `today` est toujours en cours, donc toujours partielle, et les
  // deux qui la précèdent sont toujours révolues. Aucune géométrie de fenêtre
  // n'entre là-dedans.
  const currentWeekStart = isoWeekStart(snapshot.today);
  const lastCompleteWeekStart = shiftCivilDate(currentWeekStart, -7);
  const previousCompleteWeekStart = shiftCivilDate(currentWeekStart, -14);

  /**
   * Ce que le plan **promettait** pour chaque semaine calendaire, en km : sa
   * trajectoire d'origine, reconstruite de sa propre mémoire.
   *
   * ## Le défaut que cela ferme : le plan s'enfermait, et rien ne l'en sortait
   *
   * Le plafond de {@link counted} était la prescription **courante** de la
   * semaine. Or cette prescription descend quand l'athlète décroche : le plancher
   * ne mesurait donc plus ce qu'elle a *démontré*, mais ce que le plan lui avait
   * *permis*, et la boucle se refermait sur elle-même. Mesuré sur un bloc libre
   * de 24 semaines, réadaptation hebdomadaire, l'athlète revenant à 100 % après le
   * creux : un creux de quatre semaines à 80 % coûtait **−39 %** du plan à la
   * semaine 24 ; à 50 %, **−77 %**. Et après le creux à 50 %, la faire courir
   * **cinq fois le prescrit pendant seize semaines** laissait la trajectoire
   * identique au dixième — aucun chemin de sortie, sinon créer un plan neuf.
   *
   * ## La borne, et pourquoi elle tient les deux bouts
   *
   * La promesse d'une semaine, c'est le plus haut volume que le plan ait chiffré
   * *avant* elle, mené jusqu'à elle par sa propre cadence — exactement la chaîne
   * qu'une fenêtre écrit, `floorKm` compris, pour que les deux se recouvrent au
   * dixième. Les semaines révolues ne sont jamais réécrites : leur prescription
   * d'avant le décrochage est encore là, et c'est elle qui porte la promesse.
   *
   * - **elle autorise la remontée** : ce que l'athlète a démontré compte jusqu'à
   *   cette promesse, même quand le plan courant est tombé bien plus bas ;
   * - **elle ne rouvre pas le cliquet** : rien ne peut la franchir, et elle ne
   *   peut pas monter d'elle-même. Une prescription vaut au plus la promesse, donc
   *   la reprojeter rend au plus la promesse — c'est un point fixe, pas une
   *   spirale. Un simple décapuchonnage de `bestKm`, lui, rouvrait le cliquet :
   *   à réalisation 5, le plan atteignait 205 km/semaine.
   *
   * ## La promesse est **brute**, et c'est ce qui ferme la dérive du dixième
   *
   * {@link floorKm} est un plancher *strictement* inférieur : il retire un
   * dixième à toute valeur déjà posée sur la grille — `floorKm(52,8)` vaut `52,7`,
   * et c'est vrai des 900 dixièmes de 10 à 100 km. C'est exactement ce qu'on veut
   * d'un produit qu'on vient de calculer, parce qu'une cible ne doit jamais se
   * poser pile sur le plafond qu'elle respecte ; c'est un poison sur une valeur
   * relue, parce qu'une reconstruction relit toujours ce que la précédente a
   * écrit. Mesuré sur un bloc libre de 24 semaines, athlète assidue, réadaptation
   * hebdomadaire du lundi, avec un modèle d'athlète honnête — la semaine en cours
   * n'est courue qu'au prorata des jours écoulés : **56,7 km en semaine 17 au lieu
   * de 58,6, ×0,968**, et la dérive croissait avec le nombre de reconstructions.
   * Elle restait invisible tant que la simulation faisait courir la semaine en
   * cours *entière* : la branche `project(currentWeekStart, …)` reprenait alors la
   * main à chaque tour et recalait la trajectoire.
   *
   * La chaîne garde donc **deux lectures** de chaque promesse : le produit
   * `raw`, que `floorKm` posera sur la grille une seule fois, en aval, et qui
   * plafonne la *cible* ; et `written`, ce même produit tel qu'une fenêtre
   * l'écrirait, qui plafonne ce qu'on porte au *crédit de l'athlète*. Les
   * confondre coûte un dixième dans un sens ou dans l'autre : plafonner le réel
   * par `raw` rend une athlète à réalisation 1,05 très légèrement au-dessus d'une
   * athlète à 1,0 (mesuré : 59,9 contre 59,7 km en semaine 11), alors qu'elles
   * doivent être identiques au dixième. Une prescription relue, elle, est déjà sur
   * la grille : elle passe telle quelle dans les deux lectures.
   *
   * La carte est construite en une passe, de la première semaine chiffrée du plan
   * jusqu'à la dernière dont on a besoin.
   */
  const promisedKm = new Map<string, { raw: number; written: number }>();
  {
    let firstPlannedWeek: string | null = null;
    for (const [week, km] of plannedWeeklyKm) {
      if (km > 0 && (firstPlannedWeek === null || week < firstPlannedWeek)) firstPlannedWeek = week;
    }
    if (firstPlannedWeek !== null) {
      const last = firstFullWeekStart > currentWeekStart ? firstFullWeekStart : currentWeekStart;
      let written = 0;
      for (let week = firstPlannedWeek; week <= last; week = shiftCivilDate(week, 7)) {
        const raised = written * stepInto(week);
        const planned = plannedWeeklyKm.get(week) ?? 0;
        written = planned >= raised ? planned : floorKm(raised);
        promisedKm.set(week, { raw: Math.max(raised, planned), written });
      }
    }
  }

  /**
   * Ce qu'une semaine réelle **compte** : ce que l'athlète y a couru, à la
   * tolérance de {@link CONTINUATION_RULES.realizationRelief} près, et jamais plus
   * que ce que le plan lui **promettait** ({@link promisedKm}).
   *
   * Le plafond est la moitié haute de la propriété 5 : courir plus que ce que le
   * plan visait ne relève jamais le plan. C'est la **promesse** qui borne, et non
   * la prescription courante : sans quoi les garde-fous de reprise ne mesurent
   * plus ce que l'athlète a démontré mais ce que le plan lui a permis, et la
   * boucle se referme sur elle-même.
   *
   * Sans promesse pour cette semaine-là — un plan sans séance chiffrée, une semaine
   * d'avant le plan —, le réel nu fait foi, et c'est le seul régime que l'appli
   * connaissait jusqu'ici.
   */
  const counted = (realizedKm: number, weekStart: string): number => {
    const promised = promisedKm.get(weekStart);
    return promised === undefined || promised.written <= 0
      ? realizedKm
      : Math.min(realizedKm, promised.written);
  };

  let openWeekKm = 0;
  let lastCompleteKm = 0;
  let previousCompleteKm = 0;
  let bestKm = 0;

  for (const week of snapshot.weeks) {
    // Une semaine à venir n'a rien démontré. Le snapshot n'en produit pas, mais
    // rien dans son type ne l'interdit, et une semaine future ferait ici un
    // ancrage sur des kilomètres qui n'ont pas été courus.
    if (week.startsOn > currentWeekStart) continue;

    const km = counted(week.distanceKm, week.startsOn);
    bestKm = Math.max(bestKm, km);
    if (week.startsOn === currentWeekStart) openWeekKm = Math.max(openWeekKm, km);
    if (week.startsOn === lastCompleteWeekStart) lastCompleteKm = Math.max(lastCompleteKm, km);
    if (week.startsOn === previousCompleteWeekStart) {
      previousCompleteKm = Math.max(previousCompleteKm, km);
    }
  }

  /*
   * Ce qui **prolonge** le bloc, en deux régimes et un garde-fou.
   *
   * ## Le régime nominal : le plan corrigé par le réel
   *
   * `credit` est ce que le réel vaut comme **correction** de la prescription :
   * 1 quand l'athlète a couru son plan (à {@link CONTINUATION_RULES.realizationRelief}
   * près), son taux de réalisation en dessous. La cible de la première semaine
   * pleine est alors **ce que le plan visait déjà pour elle**, multiplié par ce
   * crédit.
   *
   * C'est la forme qui ferme la propriété 5, et le détour par la prescription
   * compte autant que le crédit. La version qui projetait le réel de semaine en
   * semaine (le régime de repli ci-dessous) a un défaut que seule la trajectoire
   * révèle : sur un déclenchement du dimanche, l'ancre est la semaine **révolue**
   * et la cible porte sur la semaine d'après la semaine en cours — deux semaines
   * plus loin. Chaque cible se calcule donc depuis celle d'il y a deux semaines,
   * et les semaines paires et impaires forment deux suites indépendantes. Tant
   * que la réalisation vaut 1, elles coïncident ; dès qu'elle s'en écarte, elles
   * divergent autour des semaines allégées, et le vécu de l'athlète y prend des
   * marches que rien n'autorise. Mesuré à réalisation 0,9, réadaptation
   * hebdomadaire le dimanche : `41,4 → 47,2 km, +14 %`, au-dessus du plafond de
   * 12 %. S'ancrer sur ce que le plan prescrivait pour **la semaine visée**
   * rétablit une suite à un terme : chaque cible vaut la précédente × la marche
   * de la semaine × le crédit, soit au plus `1,08 × recoveryCap = maxWeeklyGrowth`
   * — le plafond lui-même, jamais au-dessus.
   *
   * ## Le régime de repli : le réel projeté
   *
   * Quand le plan ne prescrit rien pour la semaine d'ancrage ou pour la première
   * semaine pleine — aucune séance chiffrée, ou une fenêtre qui déborde de ce que
   * le plan couvre —, le réel est tout ce qu'il y a, et il se projette : une
   * marche par semaine calendaire franchie.
   *
   * ## La sortie de l'enfermement : le crédit peut dépasser 1, d'un cran borné
   *
   * Le crédit ne remontait jamais au-dessus de 1. C'est ce qui tuait le cliquet —
   * et c'est aussi ce qui enfermait le plan : une fois descendu, il ne pouvait plus
   * que suivre sa propre descente, et l'athlète avait beau courir cinq fois le
   * prescrit, rien ne bougeait (cf. {@link promisedKm}).
   *
   * Il monte désormais jusqu'à `recoveryCap` — `maxWeeklyGrowth` divisé par la
   * progression du niveau, soit `1,12 / 1,08 = 1,037` pour un niveau
   * intermédiaire —, et la cible
   * reste plafonnée par la **promesse** du plan. Trois choses en découlent, et les
   * trois comptent :
   *
   * - **le cliquet reste mort** : au-delà de la réalisation qui sature ce cran,
   *   tout se vaut. À réalisation 1,0 comme à 1,05 comme à 5, le crédit vaut le
   *   cran, la cible vaut la promesse, et la trajectoire est la même au dixième ;
   * - **la remontée existe et ne peut pas s'emballer** : elle ne dépasse jamais la
   *   promesse, qui est un point fixe (cf. {@link promisedKm}) ;
   * - **la suite reste à un terme** : la cible vaut la précédente × la marche de la
   *   semaine × le crédit, donc la hausse d'un raccord reste bornée par
   *   `maxWeeklyGrowth` — ce qu'une projection du réel depuis la semaine révolue ne
   *   garantit pas, puisqu'elle rouvre les deux suites paire et impaire décrites
   *   plus haut. Mesuré avec une projection du réel : 37,2 → 42,1 km, **+13,2 %**,
   *   au-dessus du plafond de 12 %.
   *
   * ## Le garde-fou : la semaine en cours ne peut que **relever**
   *
   * Elle est partielle par construction (propriété 4), donc elle sous-estime
   * toujours : la compter comme une semaine complète ferait reculer le plan d'une
   * athlète simplement parce qu'on est mardi. Un maximum lui laisse le seul rôle
   * qu'elle peut tenir honnêtement — témoigner d'un volume déjà atteint —, et
   * `counted` l'empêche de dépasser ce que le plan lui promettait, sans quoi une
   * sortie non planifiée relèverait tout l'avenir.
   */
  const plannedAnchorKm = plannedWeeklyKm.get(lastCompleteWeekStart);
  const plannedFirstFullKm = plannedWeeklyKm.get(firstFullWeekStart);
  // Le cran de remontée se déduit de la règle de hausse, il ne se choisit pas :
  // c'est tout ce que `maxWeeklyGrowth` laisse au-dessus de la **progression du
  // niveau**, de sorte qu'un raccord `marche × crédit` reste sous le plafond que
  // la validation applique à l'intérieur d'une fenêtre. La marche d'une semaine
  // allégée est plus basse encore (0,85) : le cran y est donc, a fortiori, sans
  // effet sur le plafond.
  const recoveryCap = VOLUME_RULES.maxWeeklyGrowth / growth;
  const credit =
    plannedAnchorKm === undefined || plannedAnchorKm <= 0
      ? null
      : Math.min(
          recoveryCap,
          lastCompleteKm / plannedAnchorKm + CONTINUATION_RULES.realizationRelief,
        );

  // Le plafond de la promesse s'applique **sur la cible**, et pas seulement sur ce
  // qui l'alimente : c'est lui qui borne la remontée, et c'est aussi lui qui fait
  // que l'ancrage d'une athlète assidue vaut **exactement** la promesse — quelle
  // que soit la fréquence des réadaptations, et sans qu'aucun dixième se perde en
  // route.
  const promisedFirstFullKm = promisedKm.get(firstFullWeekStart)?.raw ?? Number.POSITIVE_INFINITY;
  const continuityKm = Math.min(
    promisedFirstFullKm,
    Math.max(
      credit !== null && plannedFirstFullKm !== undefined && plannedFirstFullKm > 0
        ? plannedFirstFullKm * credit
        : project(lastCompleteWeekStart, lastCompleteKm, firstFullWeekStart),
      project(currentWeekStart, openWeekKm, firstFullWeekStart),
    ),
  );

  // Deux garde-fous qui **rouvrent** un bloc. Ce sont des niveaux de reprise, pas
  // des volumes à faire progresser : ils s'appliquent tels quels à la première
  // semaine pleine, sans marche et sans baisse (propriété 3).
  const resumptionKm = Math.max(
    previousCompleteKm * CONTINUATION_RULES.pauseBridgeShare,
    bestKm * CONTINUATION_RULES.demonstratedFloorShare,
  );

  const seed: ContinuationSeed =
    continuityKm > 0 && continuityKm >= resumptionKm
      ? { firstFullWeekKm: continuityKm, resumption: false }
      : resumptionKm > 0
        ? { firstFullWeekKm: resumptionKm, resumption: true }
        : // Rien n'ancre la reprise : pas un kilomètre dans le snapshot. Le repli
          // est le départ prudent du niveau — et surtout **pas** les +20 % de
          // `firstFullWeekMaxKm`, qui n'ont de toute façon rien à quoi
          // s'appliquer. C'est un début de bloc, donc une reprise.
          { firstFullWeekKm: VOLUME_TARGET_RULES.defaultStartKm[level], resumption: true };

  // La cadence de la fenêtre : celle du plan quand on prolonge son bloc, un bloc
  // neuf quand on reprend. Le `max(0, …)` couvre une fenêtre qui s'ouvrirait
  // avant la première semaine pleine du plan — un rang négatif se lirait comme un
  // rang 3 (la cadence est périodique) et poserait une respiration avant le
  // premier effort.
  const baseRank = seed.resumption ? 0 : Math.max(0, planCadenceRank(plan, firstFullWeekStart));

  const start = floorKm(
    budgetKm === null ? seed.firstFullWeekKm : Math.min(seed.firstFullWeekKm, budgetKm),
  );
  const kilometers = new Array<number>(weeks).fill(start);
  const kinds = new Array<WeeklyVolumeTargetKind>(weeks).fill('build');

  // La fenêtre s'ouvre-t-elle **sur** la respiration du bloc ? Alors la marche
  // qui l'a chiffrée était la baisse, et son volume descend bien par rapport à ce
  // que l'athlète a couru. Il ne reste qu'à l'étiqueter : c'est ce que la
  // validation relit pour accepter que les trois semaines suivantes montent (cf.
  // `volumeViolations`).
  //
  // En mode reprise, `baseRank` vaut 0 et cette étiquette ne peut pas tomber :
  // c'est exactement la propriété 3.
  const opensOnCutback = eases && isCutbackCadenceRank(baseRank);
  if (opensOnCutback && firstFull < weeks) kinds[firstFull] = 'cutback';

  // La marche que franchit la première semaine pleine, telle que **cette
  // fenêtre-ci** la compte — la cadence du plan quand elle prolonge son bloc,
  // celle d'un bloc neuf quand elle reprend. C'est la même valeur que celle qui
  // vient de décider l'étiquette, et ce n'est pas un hasard : c'est elle qui
  // relie la semaine entamée à la première semaine pleine, plus bas.
  const stepIntoFirstFull = opensOnCutback ? VOLUME_RULES.cutbackRatio : growth;

  for (let index = firstFull + 1; index <= lastBuild; index += 1) {
    const previous = kilometers[index - 1];
    if (eases && isCutbackCadenceRank(baseRank + index - firstFull)) {
      kilometers[index] = floorKm(previous * VOLUME_RULES.cutbackRatio);
      kinds[index] = 'cutback';
      continue;
    }
    const raised = previous * growth;
    kilometers[index] = floorKm(budgetKm === null ? raised : Math.min(raised, budgetKm));
  }

  // L'affûtage se cale sur la dernière semaine de développement de la fenêtre.
  //
  // Quand la fenêtre n'en compte aucune — cas rare à la création, courant ici —,
  // ses semaines sont la *queue* de l'affûtage du plan : sa base est la dernière
  // semaine de développement du **plan**, que la mémoire de celui-ci porte encore.
  //
  // Sans cette lecture, la base était le point de départ de la fenêtre — une
  // projection de développement, une marche **au-dessus** du pic réel — et
  // l'affûtage dépendait de la date de la dernière réadaptation. Mesuré sur une
  // préparation de 16 semaines, semaine de course : **44,7 km quand la dernière
  // réadaptation tombe en semaine 14, 41,4 km quand elle tombe en semaine 12**,
  // pour le même plan et la même athlète.
  //
  // **`lastBuild < firstFull` couvre deux géométries, pas une**, et c'est le
  // défaut que la première rédaction laissait ouvert :
  //
  // - `firstFull = 0` et `taperFrom ≤ 0` : la fenêtre entière, semaine d'ouverture
  //   comprise, est de l'affûtage ;
  // - `firstFull = 1` et `taperFrom = 1` : la fenêtre s'ouvre **en milieu de
  //   semaine sur la dernière semaine de développement du plan**, et l'affûtage
  //   occupe tout le reste. C'est le cas de toute révision déclenchée un autre
  //   jour que le dimanche pendant cette semaine-là — la révision partant toutes
  //   les quatre séances, il est courant.
  //
  // La seconde géométrie retombait sur `start`, qui est ici le volume relu d'une
  // semaine **d'affûtage** : les facteurs s'y appliquaient une seconde fois.
  // Mesuré sur une préparation de 16 semaines (mémoire du plan S14 = 59,2 ·
  // S15 = 44,3 · S16 = 32,5), athlète assidue, révision en semaine 14 :
  // **44,3 / 32,5 le dimanche, 33,1 / 24,3 du lundi au jeudi — −25 %**, soit un
  // facteur 1,44 sur la semaine de course pour le même plan et la même athlète.
  // Écrit en silence : `peakBuildVolume` étant nul sur cette fenêtre,
  // `raceWeekMaxRatio` et la décroissance de l'affûtage étaient toutes deux
  // court-circuitées.
  const planLastBuildWeekStart = shiftCivilDate(
    window.firstWeekStart,
    (weeks - 1 - planTaperWeeks) * 7,
  );
  const plannedLastBuildKm = plannedWeeklyKm.get(planLastBuildWeekStart);
  // **Le budget temps s'applique à la mémoire du plan comme au reste.** Une base
  // relue n'a pas été chiffrée sous le budget d'aujourd'hui : celui-ci a pu être
  // abaissé depuis, et l'ajustement ne transporte justement que trois réglages,
  // dont celui-là. Sans ce plafond, la fenêtre se contredit elle-même —
  // `targetMinutes` est ramené au budget quelques lignes plus bas, mais pas
  // `targetKm`. Mesuré sur le balayage de conformité, fenêtre d'une semaine menant
  // à une course, budget de 300 min : **53,4 km annoncés en 285 min**, quand ces
  // 53,4 km en demandent 288. Le squelette ne lit que `targetKm` : il écrivait donc
  // une semaine que `validatePlanBusinessRules` refuse, soit une
  // `InvalidGeneratedPlanError` que l'athlète ne peut rien faire pour corriger — et
  // que la révision automatique classe non transitoire, marqueur avancé compris.
  const budgeted = (km: number): number => (budgetKm === null ? km : Math.min(km, budgetKm));
  const taperBase =
    lastBuild >= firstFull
      ? kilometers[lastBuild]
      : plannedLastBuildKm !== undefined && plannedLastBuildKm > 0
        ? budgeted(plannedLastBuildKm)
        : start;
  // Les semaines d'affûtage de la fenêtre sont les **dernières** de celles du
  // plan : leurs facteurs sont donc la queue de la série du plan.
  const factors = taperFactors(planTaperWeeks).slice(planTaperWeeks - taper);
  for (let index = taperFrom; index < weeks; index += 1) {
    kilometers[index] = floorKm(taperBase * factors[index - taperFrom]);
    kinds[index] = index === weeks - 1 ? 'race' : 'taper';
  }

  const remainingDays = remainingWeekDays(window.firstWeekFromDay);
  if (firstFull === 1) {
    // La semaine entamée vaut **une marche de moins** que la première semaine
    // pleine : elle est une semaine calendaire plus tôt, et la propriété 1 ne
    // souffre pas d'exception. C'est ce qui empêche la réadaptation en milieu de
    // semaine de dériver — la semaine entamée devient, au passage suivant, la
    // dernière semaine révolue, donc l'ancrage.
    //
    // Sa valeur **pleine** se prend avant tout arrondi, et jamais en divisant la
    // cible de la première semaine pleine par la marche qui l'a produite. Deux
    // raisons, mesurées toutes les deux :
    //
    // - `kilometers[firstFull]` est déjà passé par {@link floorKm} ; le rediviser
    //   puis re-plancher retire un second dixième, et la semaine entamée devient
    //   au tour suivant l'ancrage — la troncature ne se compense jamais ;
    // - sous plafond de budget temps, cette cible **est** le plafond : la division
    //   inverse rend alors une semaine entamée systématiquement trop basse
    //   (49,2 km au lieu de 52,0 pour un budget de 300 min à 8:00/km), alors que
    //   la semaine précédente était, elle aussi, au plafond.
    //
    // Trois cas, et ils suivent la géométrie de l'affûtage ci-dessus : la semaine
    // entamée est déjà chiffrée par l'affûtage (`taperFrom` vaut alors 0, puisque
    // l'affûtage de la fenêtre est celui du plan tronqué par sa longueur), ou elle
    // **est** la dernière semaine de développement d'un plan qui mène à une
    // course, ou elle précède d'une marche la première semaine pleine.
    //
    // Le `taper > 0` du deuxième cas n'est pas décoratif : sans course,
    // `lastBuild < firstFull` se réduit à « dernière semaine du plan, révisée en
    // milieu de semaine », et la mémoire du plan n'y a aucun titre à se substituer
    // à l'ancrage réel. Mesuré sur un plan libre de 12 semaines, athlète à l'arrêt
    // depuis un mois, mémoire du plan à 60 km : **34,2 km sur quatre jours** au
    // lieu des 13,6 km que le repli du niveau prescrit.
    const openWeekFullKm =
      taperFrom === 0
        ? taperBase * factors[0]
        : lastBuild < firstFull && taper > 0
          ? taperBase
          : budgeted(seed.firstFullWeekKm / stepIntoFirstFull);
    kilometers[0] = floorKm((openWeekFullKm * remainingDays) / 7);
    // Le `kinds[0]` que la boucle d'affûtage vient peut-être de poser est écrasé,
    // et c'est voulu : une semaine entamée est d'abord une semaine entamée.
    kinds[0] = 'partial';
  }

  return kilometers.map((targetKm, index) => {
    // Le budget d'une semaine entamée est celui de ses jours restants — la même
    // arithmétique que la règle qui le vérifiera (`partialWeekTimeBudget`).
    const share = index === 0 && firstFull === 1 ? remainingDays / 7 : 1;
    const budgetMinutes =
      settings.weeklyTimeMinutes === null
        ? null
        : Math.floor(settings.weeklyTimeMinutes * VOLUME_TARGET_RULES.timeBudgetShare * share);
    const minutes = Math.round(targetKm * paceMinPerKm);

    return {
      targetKm,
      targetMinutes: budgetMinutes === null ? minutes : Math.min(minutes, budgetMinutes),
      kind: kinds[index],
    };
  });
}

/** Le plan en cours, en une ligne — la trace d'une reconstruction fautive. */
function describeRemainingPlan(
  plan: PlanDto,
  window: RemainingPlanWindow,
  settings: EffectivePlanSettings,
): string {
  return [
    `plan ${plan.id} « ${plan.goalText} »`,
    plan.raceDate === null ? null : `course le ${plan.raceDate}`,
    `${window.weeks}/${plan.weeks} semaines restantes à partir du ${window.firstWeekStart} (jour ${window.firstWeekFromDay})`,
    `niveau ${plan.level ?? 'inconnu'}`,
    `${settings.sessionsPerWeek} séances/semaine`,
    `sortie longue jour ${settings.longRunDay}`,
    settings.weeklyTimeMinutes === null ? null : `${settings.weeklyTimeMinutes} min/semaine`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/**
 * Reconstruit les semaines restantes d'un plan en cours : squelette
 * déterministe, créneaux de qualité remplis par le coach, validation avec
 * dégradation en escalier.
 *
 * Le pipeline est celui de {@link writeGeneratedPlan}, aux trois différences
 * décrites en tête de section — et cette fonction n'écrit **rien** en base :
 * l'appelant décide de ce qu'il fait des semaines (les proposer, les écrire, les
 * accompagner d'un texte).
 *
 * @throws {InvalidPlanError} quand le volume que la fenêtre vise ne finance pas
 * les séances demandées ({@link planSkeletonOrInvalid}), ou quand il ne reste
 * plus un seul jour à planifier.
 * @throws {InvalidGeneratedPlanError} quand même la fenêtre tout-déterministe
 * viole une règle métier — jamais une faute du modèle, une incohérence interne.
 */
export async function rewriteRemainingPlan(
  params: RemainingPlanRewriteParams,
): Promise<RemainingPlanRewrite> {
  const { plan, window, snapshot } = params;
  const effectiveSettings = effectiveSettingsOf(plan, params.settings);
  const paces = planTrainingPaces(plan);
  const race = raceGoalOf(plan.goalType, plan.goalText);
  const raceDay = planRaceIsoDay(plan, window);

  // La course est déjà courue mais sa semaine n'est pas finie : il ne reste
  // aucun jour d'entraînement à poser. Le dire ici, plutôt que de laisser le
  // squelette refuser une semaine de zéro séance avec un message qui parlerait
  // de volume — la cause n'a rien à voir.
  if (raceDay !== null && window.weeks === 1 && raceDay < window.firstWeekFromDay) {
    throw new InvalidPlanError(
      'weeks',
      "Ce plan est arrivé à son terme : la course a eu lieu, il n'y a plus rien à replanifier.",
    );
  }

  const targets = remainingVolumeTargets(
    plan,
    window,
    snapshot,
    effectiveSettings,
    paces,
    params.plannedWeeklyKm,
  );

  const expectations: PlanExpectations = {
    // Fenêtre restante, pas plan complet : la règle anti-plat n'y a pas d'objet —
    // exiger un pic supérieur à la première semaine restante réclamerait de
    // monter le volume à quelques semaines de la course.
    scope: 'adjustment',
    weeks: window.weeks,
    sessionsPerWeek: effectiveSettings.sessionsPerWeek,
    longRunDay: effectiveSettings.longRunDay,
    firstWeekFromDay: window.firstWeekFromDay,
    // La fenêtre restante se termine avec le plan, donc avec la course : ses
    // dernières semaines sont bien celles de l'affûtage.
    race,
    // Et sa dernière semaine est bien celle de la course — désormais réécrite
    // ici, donc jugée comme telle (cf. {@link planRaceIsoDay}).
    raceDay,
    weeklyTargets: targets,
  };
  const context: PlanValidationContext = {
    referencePaceSecPerKm: snapshot.recentAvgPaceSecPerKm,
    paces,
    // Pas de `recentWeeklyKm` : cette règle-là plafonne la **première semaine
    // pleine d'une création**, et la fenêtre reconstruite n'en est pas une. Son
    // ancrage sur le réel est déjà fait, une fois, par les cibles ci-dessus.
    weeklyTimeMinutes: effectiveSettings.weeklyTimeMinutes,
  };

  // 1. Le squelette de la fenêtre — périodisation conservée, volumes recalculés.
  const skeleton = planSkeletonOrInvalid({
    weeks: window.weeks,
    firstWeekFromDay: window.firstWeekFromDay,
    sessionsPerWeek: effectiveSettings.sessionsPerWeek,
    longRunDay: effectiveSettings.longRunDay,
    level: plan.level ?? 'intermediate',
    race,
    raceDay,
    // Même filtre qu'à la création : `goalDistanceKm` cherche un motif de
    // distance dans du texte libre, et sans ce garde-fou un objectif libre
    // « me remettre après mon semi » recevrait des sorties longues spécifiques
    // pour une échéance qui n'existe pas.
    goalDistanceKm: plan.goalType === 'race' ? goalDistanceKm(plan.goalText) : null,
    targets,
    phases: remainingPhases(plan, window),
  });

  // 2. Le seul travail du modèle : le déroulé des séances dures. Ne lève jamais
  //    — un créneau qui échoue se replie sur un déroulé déterministe.
  const slots = skeleton.flatMap((week) => week.qualitySlots);
  params.onSlotFilled?.(0, slots.length);
  const filled = await fillQualitySlots(slots, params.onSlotFilled);

  // 3. Assemblage, allures, validation — avec la dégradation en escalier.
  const weeks = validatedPlanWeeks({
    skeleton,
    filled,
    postProcess: planWeeksPostProcessing(context, goalPaceSecPerKm(plan.goalText)),
    expectations,
    context,
    describe: describeRemainingPlan(plan, window, effectiveSettings),
  });

  return { weeks, targets, skeleton, effectiveSettings };
}

/*
 * ------------------------------------------------------------------------
 * Ajustement par instruction.
 * ------------------------------------------------------------------------
 */

/** Nom du schéma transmis au serveur — identifiant libre, exigé par le format. */
const INSTRUCTION_SCHEMA_NAME = 'plan_instruction';

/**
 * Le plafond de génération d'une lecture d'instruction, en tokens.
 *
 * Trois entiers en sortie : 256 est déjà dix fois trop. Explicite quand même,
 * comme partout ailleurs — un `max_tokens` absent laisse le serveur trancher, et
 * un JSON coupé ne rend pas un JSON incomplet, il ne rend pas de JSON du tout.
 */
const INSTRUCTION_MAX_OUTPUT_TOKENS = 256;

/**
 * Délai de garde de la lecture d'instruction : 60 secondes.
 *
 * Le même que le résumé, et pour la même raison : la sortie est minuscule, et le
 * dépassement ne coûte rien de plus qu'un repli — ici, un plan recalculé sans
 * changement de réglage.
 */
const INSTRUCTION_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Ce qu'on demande au modèle d'une instruction : la traduire en réglages
 * durables, et rien d'autre.
 *
 * ## Ce que ce prompt ne demande plus, et ce que ça coûte
 *
 * Il ne demande plus de réécrire des semaines — c'est tout l'objet de
 * l'inversion. La conséquence se dit franchement : une instruction **ponctuelle**
 * (« je pars en déplacement la semaine prochaine ») n'a plus de champ où
 * atterrir, puisque le calendrier est recalculé par l'appli à partir de réglages
 * *durables*. Elle ne fait donc plus déplacer trois séances ; elle fait
 * recalculer la fin du plan sur le volume réellement couru, ce qui est déjà
 * quelque chose, et le résumé le dit à l'athlète plutôt que de le taire.
 *
 * Ce qu'on y gagne est ce que le modèle ne peut plus casser : la progression des
 * volumes, le compte de séances, l'affûtage, la position dans la périodisation.
 */
const INSTRUCTION_SYSTEM_PROMPT = [
  "Tu es coach de course à pied francophone. L'athlète te donne une consigne sur son plan en cours, et ton seul travail est de la traduire en RÉGLAGES DURABLES.",
  '',
  'Trois réglages existent, et rien d\'autre :',
  '- `sessionsPerWeek` : le nombre de séances par semaine ;',
  '- `longRunDay` : le jour de la sortie longue (1 = lundi … 7 = dimanche) ;',
  '- `weeklyTimeMinutes` : le temps d\'entraînement hebdomadaire disponible, en minutes.',
  '',
  "Tu ne renseignes QUE ce que la consigne change explicitement, et tu omets le reste : un réglage absent est un réglage inchangé. Si la consigne ne change aucun de ces trois réglages (une gêne passagère, un déplacement, une remarque sur la forme), tu omets `settings` entièrement.",
  "Tu n'écris aucune séance, aucune allure, aucun volume : l'application recalcule elle-même le calendrier à partir de ces réglages et de ce que l'athlète a réellement couru.",
].join('\n');

/** Ce que le modèle reçoit pour lire une instruction : le plan en une poignée de lignes. */
export function buildPlanInstructionMessages(
  plan: PlanDto,
  window: RemainingPlanWindow,
  instruction: string,
): ChatMessage[] {
  return [
    { role: 'system', content: INSTRUCTION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Plan en cours : « ${plan.goalText} »${plan.raceDate === null ? '' : `, course le ${formatCivilDate(plan.raceDate)}`}.`,
        ...(plan.level === null ? [] : [`Niveau déclaré : ${LEVEL_LABELS[plan.level]}.`]),
        `Réglages actuels : ${formatConstraints(plan)}.`,
        `Semaines restantes : ${window.weeks}.`,
        '',
        `Consigne de l'athlète : « ${instruction.trim()} »`,
      ].join('\n'),
    },
  ];
}

/**
 * Les réglages que l'instruction change, `undefined` si elle n'en change aucun.
 *
 * **Ne lève jamais.** Un coach injoignable ou une sortie hors schéma ne doivent
 * pas coûter l'ajustement entier : la fenêtre restante est de toute façon
 * recalculée sur le réel, et c'est déjà l'essentiel de ce que l'athlète a
 * demandé. Le repli est journalisé — sans cette trace, un modèle qui aurait
 * cessé de lire les instructions serait indiscernable d'une instruction qui ne
 * change effectivement rien.
 */
async function instructionSettings(
  plan: PlanDto,
  window: RemainingPlanWindow,
  instruction: string,
): Promise<PlanSettingsOutput | undefined> {
  try {
    const output = await chatCompletionJson<PlanInstructionOutput>({
      messages: buildPlanInstructionMessages(plan, window, instruction),
      schemaName: INSTRUCTION_SCHEMA_NAME,
      jsonSchema: planInstructionJsonSchema,
      schema: planInstructionOutputSchema,
      temperature: PLAN_TEMPERATURE,
      maxTokens: INSTRUCTION_MAX_OUTPUT_TOKENS,
      timeoutMs: INSTRUCTION_REQUEST_TIMEOUT_MS,
    });
    return output.settings;
  } catch (error) {
    console.error(
      `[plan] instruction non interprétée, réglages inchangés — ${error instanceof Error ? `${error.name} : ${error.message}` : String(error)}`,
    );
    return undefined;
  }
}

/** Ce qui, dans les réglages, a réellement changé — en français, pour le résumé. */
function settingsChangeLines(
  plan: PlanDto,
  settings: EffectivePlanSettings,
): string[] {
  const changes: string[] = [];
  if (settings.sessionsPerWeek !== plan.sessionsPerWeek) {
    changes.push(`${plan.sessionsPerWeek} → ${settings.sessionsPerWeek} séances par semaine`);
  }
  if (settings.longRunDay !== plan.longRunDay) {
    changes.push(
      `sortie longue déplacée du ${formatIsoDay(plan.longRunDay)} au ${formatIsoDay(settings.longRunDay)}`,
    );
  }
  if (settings.weeklyTimeMinutes !== plan.weeklyTimeMinutes) {
    changes.push(
      settings.weeklyTimeMinutes === null
        ? 'plus de limite de temps hebdomadaire'
        : `${formatDuration(settings.weeklyTimeMinutes * 60)} d'entraînement par semaine au plus`,
    );
  }
  return changes;
}

/** Les messages du résumé d'un plan ajusté : les faits, plus ce qui a été demandé. */
function buildAdjustedSummaryMessages(
  plan: PlanDto,
  window: RemainingPlanWindow,
  instruction: string,
  rewrite: RemainingPlanRewrite,
): ChatMessage[] {
  const changes = settingsChangeLines(plan, rewrite.effectiveSettings);
  const endsOn = shiftCivilDate(window.firstWeekStart, window.weeks * 7 - 1);

  return [
    {
      role: 'system',
      content: summarySystemPrompt([
        '',
        "Ce plan vient d'être RECALCULÉ à la demande de l'athlète : ton résumé décrit la suite du plan telle qu'elle est maintenant, et dit en une phrase ce que sa demande y a changé.",
        "Si sa demande ne se traduit par aucun changement de réglage — un déplacement, une gêne passagère —, dis-le honnêtement : la suite du plan a été recalée sur ce qu'elle court réellement, mais son cas particulier n'est pas inscrit au calendrier.",
      ]),
    },
    {
      role: 'user',
      content: [
        `Plan en cours : « ${plan.goalText} »${plan.raceDate === null ? '' : `, course le ${formatCivilDate(plan.raceDate)}`}.`,
        ...(plan.level === null ? [] : [`Niveau déclaré : ${LEVEL_LABELS[plan.level]}.`]),
        `Semaines recalculées : ${window.weeks}, du ${formatCivilDate(window.firstWeekStart)} au ${formatCivilDate(endsOn)}.`,
        `Contraintes : ${formatConstraints(rewrite.effectiveSettings)}.`,
        ...writtenPlanFacts(rewrite.targets, rewrite.skeleton),
        changes.length === 0
          ? 'Réglages durables : inchangés.'
          : `Réglages modifiés : ${changes.join(', ')}.`,
        '',
        `Demande de l'athlète : « ${instruction.trim()} »`,
      ].join('\n'),
    },
  ];
}

/** Le résumé d'un plan ajusté, écrit par l'appli — factuel, et suffisant. */
function fallbackAdjustedSummary(
  plan: PlanDto,
  window: RemainingPlanWindow,
  rewrite: RemainingPlanRewrite,
): string {
  const changes = settingsChangeLines(plan, rewrite.effectiveSettings);
  const volumes = rewrite.targets.map((target) => target.targetKm);

  return [
    `Les ${window.weeks} semaines restantes ont été recalculées à partir du ${formatCivilDate(window.firstWeekStart)}, ` +
      `sur le volume réellement couru ces dernières semaines.`,
    `Périodisation : ${phaseBreakdown(rewrite.skeleton)}.`,
    `Le volume hebdomadaire va de ${formatNumber(Math.min(...volumes), 1)} à ` +
      `${formatNumber(Math.max(...volumes), 1)} km, pour ${rewrite.effectiveSettings.sessionsPerWeek} séances par semaine ` +
      `et une sortie longue le ${formatIsoDay(rewrite.effectiveSettings.longRunDay)}.`,
    changes.length === 0
      ? "Aucun réglage durable n'a changé."
      : `Réglages modifiés : ${changes.join(', ')}.`,
  ].join(' ');
}

/**
 * Applique une instruction en langage naturel au plan actif (« plutôt 3
 * séances », « ma sortie longue passe au samedi »).
 *
 * La reprise part de **demain** : la séance du jour est en cours ou déjà faite,
 * la déplacer serait au mieux inutile. Les séances déjà réalisées, elles, sont
 * protégées par le DAL ({@link applyPlanUpdate}).
 *
 * Ce que le modèle décide ici tient en trois entiers ({@link instructionSettings})
 * et un paragraphe ; tout le reste — volumes, périodisation, jours, séances — est
 * calculé par l'appli ({@link rewriteRemainingPlan}).
 *
 * @param progressId identifiant de suivi (UUID) généré par le formulaire — même
 * rôle et même cycle de vie qu'à la génération (cf. {@link generatePlan}).
 *
 * @throws {AiUnavailableError} si le coach n'est pas joignable.
 * @throws {PlanNotFoundError} s'il n'y a pas de plan actif.
 * @throws {InvalidPlanError} si le plan est terminé, ou si les réglages demandés
 * ne tiennent pas dans le volume que la fenêtre vise.
 * @throws {InvalidGeneratedPlanError} si le plan que l'appli a écrit viole ses
 * propres règles.
 */
export async function updatePlanFromInstruction(
  instruction: string,
  progressId?: string,
): Promise<PlanDto> {
  logProgressTracking(progressId);
  try {
    return await writeUpdatedPlan(instruction, progressId);
  } finally {
    if (progressId !== undefined) clearPlanProgress(progressId);
  }
}

/** Le corps de {@link updatePlanFromInstruction} — cf. {@link writeGeneratedPlan}. */
async function writeUpdatedPlan(
  instruction: string,
  progressId: string | undefined,
): Promise<PlanDto> {
  await requireAi();

  const active = await getActivePlanWithSessions();
  if (active === null) throw new PlanNotFoundError();

  const fromDate = shiftCivilDate(todayCivilDate(), 1);
  const window = remainingPlanWindow(active.plan, fromDate);
  const snapshot = await getTrainingSnapshot();

  // 1. La seule chose que le modèle décide du calendrier : les réglages durables.
  const settings = await instructionSettings(active.plan, window, instruction);

  // 2. La fenêtre restante, recalculée par l'appli sous ces réglages.
  const rewrite = await rewriteRemainingPlan({
    plan: active.plan,
    window,
    snapshot,
    plannedWeeklyKm: planWeeklyVolumeKm(active.sessions),
    settings,
    onSlotFilled:
      progressId === undefined
        ? undefined
        : (done, total) => setPlanProgress(progressId, slotProgress(done, total)),
  });

  // 3. Le résumé, seul texte libre de l'ajustement.
  const summary = await coachParagraph(
    buildAdjustedSummaryMessages(active.plan, window, instruction, rewrite),
    () => fallbackAdjustedSummary(active.plan, window, rewrite),
  );

  // Séances et réglages en une seule transaction : un plan ne doit jamais
  // annoncer des contraintes que son calendrier ne suit pas.
  await applyPlanUpdate(active.plan.id, {
    fromDate,
    sessions: mapPlanWeeksToSessions(rewrite.weeks, window.firstWeekStart),
    settings: planSettingsPatch(active.plan, settings, summary),
  });
  await afterActivePlanChanged(active.plan.id);

  const refreshed = await getActivePlanWithSessions();
  if (refreshed === null) throw new PlanNotFoundError();
  return refreshed.plan;
}
