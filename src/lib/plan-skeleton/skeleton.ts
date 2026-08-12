/**
 * Le **squelette d'un plan**, écrit par l'appli et non par le modèle.
 *
 * ## Le constat qui a renversé l'architecture
 *
 * Jusqu'ici, le modèle local écrivait le plan entier : périodisation, volumes,
 * jours, séances. Il ne tenait aucune des contraintes numériques — 44,9 km écrits
 * pour 26,8 km demandés, malgré des cibles annoncées, une grammaire GBNF qui
 * imposait le compte de séances et trois messages de reprise. Ce n'est pas un
 * défaut de consigne : répartir un volume sur sept séances, sous une part de
 * sortie longue, sur seize semaines, est de l'arithmétique — un modèle de 6 Go ne
 * fait pas d'arithmétique sur seize lignes.
 *
 * L'appli écrit donc tout ce qui se calcule, et n'appelle plus le modèle que sur
 * ce qui se juge. Ce module produit :
 *
 * - la périodisation ({@link planPhases}) ;
 * - les jours de chaque séance ({@link placeSessionDays}) ;
 * - les footings et la sortie longue, **entièrement écrits**, kilométrage compris ;
 * - et, pour les séances de qualité, des **créneaux** — jour, zone, `kind`,
 *   budget kilométrique — dont il ne reste au modèle qu'à écrire le déroulé.
 *
 * Le kilométrage ne vient jamais d'ici : il vient de {@link weeklyVolumeTargets}
 * (le volume de la semaine, calculé par l'appelant) puis de
 * {@link weeklySessionBudgets} (sa répartition entre les séances). Ces deux-là
 * satisfont les règles de volume par construction, et ce module se contente de ne
 * pas les défaire — c'est pour cela qu'un test de propriété repasse chaque
 * squelette produit, rempli puis post-traité comme le pipeline le post-traite,
 * devant {@link validatePlanBusinessRules} et exige zéro violation.
 *
 * ## Ce qu'il refuse d'écrire
 *
 * « Ne pas défaire » a une limite : quand la cible d'une semaine est trop basse
 * pour financer les séances demandées au-dessus du plancher de 0,5 km par
 * séance, {@link weeklySessionBudgets} rend une décomposition dont la somme
 * dépasse la cible, et il n'existe aucune façon d'écrire cette semaine-là qui
 * satisfasse les règles. Le squelette lève alors
 * {@link PlanSkeletonInfeasibleError} plutôt que d'écrire une semaine invalide —
 * le raisonnement complet, chiffres à l'appui, est dans `feasibility.ts`.
 *
 * ## Ce que ce module n'écrit surtout pas
 *
 * **Ni allure, ni durée.** Les séances sortent d'ici avec un jour, un `kind`, un
 * titre et une distance, rien d'autre. `applyImposedPaces` (avec table VDOT) et
 * `applyDerivedMeasures` (sans) les posent en aval, exactement comme sur la
 * sortie du modèle — un seul endroit décide des allures, et ce n'est pas ici.
 * Écrire une allure ici la ferait diverger de celle que le reste du plan reçoit.
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`, ni horloge, ni aléa.
 */

import {
  weeklySessionBudgets,
  type PlanRaceGoal,
  type PlanSessionOutput,
  type WeeklyVolumeTarget,
} from '@/lib/ai/plan-schema';
import type { PlanLevel } from '@/data/db/schema';
import type { PlanSessionSteps, PlanStep } from '@/lib/plan-steps/schema';

import { placeSessionDays } from './days';
import {
  minFundableWeeklyKm,
  PlanSkeletonInfeasibleError,
  type PlanSkeletonUnderfundedWeek,
} from './feasibility';
import { planPhases, type PlanPhase } from './phases';
import { goalFamily, qualityZones, QUALITY_ZONE_KINDS, type QualityZone } from './quality';

const DAYS_PER_WEEK = 7;

/**
 * Les `kind` que l'appli écrit — le vocabulaire que `sessionPaceZone` reclasse.
 *
 * Trois libellés seulement, parce que l'appli n'écrit que des séances d'endurance :
 * tout ce qui est intensité passe par un créneau ({@link QualitySlot}) et reçoit
 * son `kind` de la grille de qualité.
 *
 * « Récupération » n'est pas un synonyme d'« Endurance fondamentale » : il coupe
 * toute cible d'allure en aval (`RECOVERY_KIND_PATTERN`), ce qui est exactement ce
 * qu'on veut d'un footing d'affûtage ou de semaine de course — le seul contrat qui
 * vaille y est « plus lent que l'endurance ».
 */
const SESSION_KINDS = {
  easy: 'Endurance fondamentale',
  recovery: 'Récupération',
  longRun: 'Sortie longue',
  race: 'Course',
} as const;

/** Les titres lus dans la timeline : du français court, pas des étiquettes techniques. */
const SESSION_TITLES = {
  easy: 'Footing en endurance',
  recovery: 'Footing de récupération',
  longRun: 'Sortie longue en endurance',
  specificLongRun: 'Sortie longue avec bloc à allure objectif',
  race: 'Jour J : la course',
} as const;

/**
 * Part de la sortie longue courue à l'allure de l'objectif, en phase spécifique.
 *
 * Un tiers : c'est le bloc qui apprend à tenir l'allure de course sur des jambes
 * déjà fatiguées, et c'est là tout son intérêt. Plus court, il n'apprend rien de
 * plus qu'une séance de seuil ; plus long, la sortie longue devient une course et
 * réclame une récupération que le plan n'a pas prévue.
 */
const SPECIFIC_BLOCK_SHARE = 1 / 3;

/**
 * Part de ce qui reste consacrée à la mise en route, le solde allant au retour au
 * calme.
 *
 * Un peu plus de la moitié : on arrive au bloc spécifique déjà en rythme, et on
 * rentre ensuite en levant le pied. L'inverse ferait attaquer l'allure objectif à
 * froid.
 */
const SPECIFIC_WARMUP_SHARE = 0.55;

/**
 * En deçà de cette distance, une sortie longue ne se découpe pas en trois.
 *
 * Un tiers de 5 km fait 1,7 km à l'allure objectif, encadré de deux fragments de
 * 2 km : ce n'est pas une sortie longue spécifique, c'est un footing découpé pour
 * la forme. Sous ce seuil, la séance reste une sortie longue nue — et c'est le
 * cas d'un plan à très petit volume, où le travail spécifique se fera dans les
 * créneaux de qualité.
 */
const SPECIFIC_LONG_RUN_MIN_KM = 6;

/**
 * Un créneau de qualité : tout ce qu'il faut au modèle pour écrire **une** séance,
 * et rien de ce qu'il n'a pas à décider.
 *
 * Le jour, la zone et le budget kilométrique sont arrêtés — ce sont les chiffres
 * qui font tenir le plan. Il ne reste à remplir que le déroulé : combien de
 * répétitions, de quelle longueur, avec quelle récupération. C'est le seul endroit
 * où le jugement d'un entraîneur vaut mieux qu'une formule.
 *
 * ## Le déroulé qui remplira ce créneau mesure ses étapes en DISTANCE
 *
 * Ce n'est pas une préférence de style, c'est une condition pour que le volume
 * de la semaine tienne. Le post-traitement (`applyImposedPaces`,
 * `applyDerivedMeasures`) recalcule la distance d'une séance depuis la couverture
 * de son déroulé et **remplace la distance déclarée dès que le déroulé couvre
 * plus** (`imposedDistanceKm`). Un créneau budgété 4,5 km rempli par « 15 min +
 * 4 × (3 min + 2 min) + 10 min » couvre environ 11 km à l'allure seuil : la
 * séance déclare alors 11 km, et la semaine passe de 42 à 51 km.
 *
 * Mesuré sur les 3 024 combinaisons du test de propriété : un remplissage en
 * durée fait sortir **2 973 semaines sur 3 024 (98,3 %)** de leur cible une fois
 * `applyImposedPaces` passé ; le même remplissage en distance en fait sortir
 * zéro, dans les deux régimes de post-traitement. Le budget d'un créneau ne vaut
 * donc que si son déroulé se mesure dans la même unité que lui.
 */
export type QualitySlot = {
  /** Jour ISO : 1 = lundi … 7 = dimanche. */
  day: number;
  /** La phase de la semaine — ce qui a décidé de la zone. */
  phase: PlanPhase;
  /**
   * Le niveau de l'athlète — ce qui décide de la **forme** de l'effort.
   *
   * Il voyage avec le créneau parce que c'est là qu'il sert, et des deux côtés :
   * le prompt du modèle (`buildQualitySessionMessages`) et le déroulé
   * déterministe (`qualitySessionTemplate`) le lisent tous les deux, sans quoi
   * ils divergeraient dès le premier repli.
   *
   * Ce qu'il répare est une régression mesurée de la bascule sur squelette : le
   * niveau ne décidait plus que du **nombre** de créneaux
   * ({@link qualitySlotCount}), jamais de leur contenu. Sur un semi en 1 h 45 à
   * 4 séances, une débutante recevait 9 séances de seuil à la structure exacte
   * d'une confirmée, et `advanced` rendait un plan strictement identique à
   * `intermediate`.
   */
  level: PlanLevel;
  zone: QualityZone;
  /** Le `kind` français de la séance, tel qu'il sera écrit ({@link QUALITY_ZONE_KINDS}). */
  kind: string;
  /**
   * La distance totale attendue, **enveloppe comprise** : échauffement,
   * répétitions, récupérations et retour au calme. C'est ce chiffre que la séance
   * écrite devra déclarer, sans quoi le volume de la semaine ne tombe plus juste.
   */
  budgetKm: number;
};

/** Une semaine du squelette : ce qui est écrit, et ce qui reste à écrire. */
export type SkeletonWeek = {
  /** Numéro 1-based dans la numérotation du **plan entier**. */
  weekNumber: number;
  phase: PlanPhase;
  target: WeeklyVolumeTarget;
  /** Footings et sortie longue, entièrement écrits. */
  sessions: PlanSessionOutput[];
  /** Les créneaux que le modèle remplira, un par séance de qualité. */
  qualitySlots: QualitySlot[];
};

export type PlanSkeletonParams = {
  /** Nombre de semaines du plan, la première (parfois entamée) comprise. */
  weeks: number;
  /** Jour ISO à partir duquel la première semaine porte des séances : 1 = lundi. */
  firstWeekFromDay: number;
  sessionsPerWeek: number;
  /** Jour ISO de la sortie longue, tel que l'athlète l'a réglé. */
  longRunDay: number;
  level: PlanLevel;
  /** L'objectif, quand c'est une course : elle impose un affûtage et une semaine de course. */
  race: PlanRaceGoal | null;
  /**
   * Le **jour ISO du jour J** dans la dernière semaine du plan — `null` hors
   * objectif daté.
   *
   * Sans lui, la semaine de course recevait une « Sortie longue » posée le jour
   * de sortie longue habituel de l'athlète, y compris quand ce jour-là *était*
   * celui de sa course : vérifié en production, l'athlète lisait « 8,5 km à
   * 5:54/km » sur la case de son marathon. Le squelette ne pouvait pas le
   * corriger seul — il ne connaissait que `race.isMarathon`, jamais la date.
   *
   * Ce jour-là porte donc {@link SESSION_KINDS.race}, un libellé que
   * `sessionPaceZone` range en zone `marathon` (cf. `RACE_DAY_PATTERN`) : la
   * séance du jour J s'affiche à l'allure de l'objectif, pas en endurance.
   */
  raceDay: number | null;
  /** La distance de l'objectif, en km — `null` quand il n'est pas chiffré. */
  goalDistanceKm: number | null;
  /**
   * Les volumes cibles, **déjà calculés** par l'appelant
   * ({@link weeklyVolumeTargets}), un par semaine et dans l'ordre.
   *
   * Passés plutôt que recalculés : ce sont les mêmes chiffres que le prompt
   * annonce et que la validation vérifiera, et deux appels aux mêmes paramètres
   * seraient deux occasions de diverger.
   */
  targets: readonly WeeklyVolumeTarget[];
};

/** Une étape mesurée en distance, sans aucune cible : toutes les clés, `null` pour le reste. */
function distanceStep(role: PlanStep['role'], distanceM: number, note: string): PlanStep {
  return {
    role,
    distanceM,
    durationS: null,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note,
  };
}

/**
 * Le déroulé d'une sortie longue spécifique : mise en route, bloc à allure
 * objectif, retour au calme — `undefined` quand la séance est trop courte pour
 * qu'un découpage ait du sens ({@link SPECIFIC_LONG_RUN_MIN_KM}).
 *
 * Aucune allure sur les étapes, une **note** sur celle du milieu : c'est elle que
 * le post-traitement lit (`STEP_NOTE_ZONES`) pour poser l'allure de l'objectif sur
 * ce bloc-là et l'endurance sur le reste. Écrire l'allure ici court-circuiterait
 * ce mécanisme et donnerait une séance dont les allures ne viennent pas de la même
 * source que celles du reste du plan.
 *
 * Le découpage retombe **exactement** sur la distance de la séance : le déroulé
 * couvre toute la sortie, donc rien en aval n'a à arbitrer entre la distance
 * déclarée et celle du déroulé (`imposedDistanceKm`).
 */
function specificLongRunSteps(distanceKm: number): PlanSessionSteps | undefined {
  if (distanceKm < SPECIFIC_LONG_RUN_MIN_KM) return undefined;

  const totalM = Math.round(distanceKm * 1_000);
  const goalM = Math.round(totalM * SPECIFIC_BLOCK_SHARE);
  const warmupM = Math.round((totalM - goalM) * SPECIFIC_WARMUP_SHARE);
  const cooldownM = totalM - goalM - warmupM;

  return [
    { repeat: 1, steps: [distanceStep('warmup', warmupM, 'Mise en route en endurance')] },
    { repeat: 1, steps: [distanceStep('run', goalM, 'Bloc à allure objectif, souple et régulier')] },
    { repeat: 1, steps: [distanceStep('cooldown', cooldownM, 'Retour au calme en endurance')] },
  ];
}

/**
 * Une sortie longue spécifique n'a de sens que si la course est assez longue pour
 * qu'on ait à en répéter l'allure sur la fatigue.
 *
 * Sur 5 ou 10 km, l'allure de course est au-dessus du seuil : la tenir en fin de
 * sortie longue ne prépare rien, elle fabrique une séance de seuil mal placée. Ce
 * travail-là appartient aux créneaux de qualité, pas au week-end.
 */
function wantsSpecificLongRun(phase: PlanPhase, goalDistanceKm: number | null): boolean {
  if (phase !== 'specific') return false;
  const family = goalFamily(goalDistanceKm);
  return family === 'half' || family === 'marathon';
}

/**
 * Le nombre de créneaux de qualité d'une semaine, sous trois plafonds.
 *
 * 1 pour une débutante, 2 sinon : c'est le dosage classique (une séance dure par
 * semaine tant que le corps apprend encore à encaisser, deux ensuite), et la
 * sortie longue compte déjà comme une troisième sollicitation.
 *
 * Puis deux plafonds qui n'ont rien d'esthétique :
 *
 * - **le nombre de zones que la phase propose** — une semaine d'affûtage n'a
 *   qu'une zone à travailler, et lui en poser deux reviendrait à doubler la même
 *   séance dure la semaine d'avant la course ;
 * - **`sessionsPerWeek − 2`**, la borne de {@link weeklySessionBudgets} : une
 *   semaine garde toujours au moins un footing à côté de sa sortie longue. Sans
 *   quoi la distribution cesse d'être polarisée et tout devient moyennement dur.
 */
function qualitySlotCount(
  level: PlanLevel,
  zoneCount: number,
  sessionCount: number,
): number {
  const wanted = level === 'beginner' ? 1 : 2;
  return Math.max(0, Math.min(wanted, zoneCount, sessionCount - 2));
}

/**
 * Ce qu'une semaine porte, **avant** d'écrire quoi que ce soit : de quoi juger
 * si sa cible la finance, puis de quoi l'écrire.
 *
 * Ce découpage en deux temps n'est pas cosmétique : le refus d'un plan
 * infaisable ({@link PlanSkeletonInfeasibleError}) doit tomber avant la première
 * séance écrite, sans quoi l'appelant recevrait une exception après coup, sur un
 * plan à moitié construit.
 */
type WeekPlan = {
  weekNumber: number;
  phase: PlanPhase;
  target: WeeklyVolumeTarget;
  /** Premier jour ISO disponible : 1 partout, sauf sur une première semaine entamée. */
  fromDay: number;
  /** Dernier jour ISO disponible : 7 partout, sauf sur la semaine de la course. */
  lastDay: number;
  /**
   * Les séances réellement plaçables — une semaine entamée en porte moins, une
   * semaine de course aussi.
   */
  sessionCount: number;
  /** Les zones que la phase propose, dans l'ordre où les créneaux les prendront. */
  zones: QualityZone[];
  slotCount: number;
};

/**
 * Le nombre de séances plaçables dans la fenêtre `[fromDay, lastDay]`.
 *
 * Les deux bornes existent pour la même raison — il y a des jours sur lesquels
 * cette semaine-là ne peut rien poser : ceux déjà passés d'une première semaine
 * entamée, et ceux qui suivent le jour J d'une semaine de course.
 */
function sessionsFitting(sessionsPerWeek: number, fromDay: number, lastDay: number): number {
  return Math.min(sessionsPerWeek, Math.max(0, lastDay - fromDay + 1));
}

/**
 * Le plus grand nombre de séances par semaine que **toutes** les semaines du
 * plan financeraient — `0` quand aucune ne tient, c'est-à-dire quand c'est le
 * volume lui-même qui ne fait pas un plan.
 *
 * Recalculé semaine par semaine plutôt qu'estimé sur la plus pauvre : le nombre
 * de créneaux de qualité dépend du nombre de séances (cf.
 * {@link qualitySlotCount}), donc le minimum finançable en dépend aussi, et
 * chaque semaine a ses propres zones.
 */
function fundableSessionsPerWeek(
  plans: readonly WeekPlan[],
  level: PlanLevel,
  requested: number,
): number {
  for (let candidate = requested - 1; candidate >= 1; candidate -= 1) {
    const fits = plans.every((plan) => {
      const sessionCount = sessionsFitting(candidate, plan.fromDay, plan.lastDay);
      const slotCount = qualitySlotCount(level, plan.zones.length, sessionCount);
      return plan.target.targetKm >= minFundableWeeklyKm(sessionCount, slotCount);
    });
    if (fits) return candidate;
  }
  return 0;
}

/**
 * Refuse le plan dès qu'une de ses semaines vise un volume que ses séances ne
 * peuvent pas financer — cible nulle ou négative comprise, qui n'est que le cas
 * dégénéré du même refus.
 *
 * Le pourquoi de ce refus est dans {@link minFundableWeeklyKm} : la
 * décomposition remonterait les séances au-dessus de la cible, la semaine
 * sortirait de sa bande de ±10 % ou cesserait d'être allégée, et personne en
 * aval ne pourrait la rattraper puisque c'est l'appli qui l'écrit.
 */
function assertFundable(
  plans: readonly WeekPlan[],
  level: PlanLevel,
  sessionsPerWeek: number,
): void {
  const underfunded: PlanSkeletonUnderfundedWeek[] = [];

  for (const plan of plans) {
    const minimumKm = minFundableWeeklyKm(plan.sessionCount, plan.slotCount);
    if (plan.target.targetKm >= minimumKm) continue;
    underfunded.push({
      weekNumber: plan.weekNumber,
      targetKm: plan.target.targetKm,
      minimumKm,
      sessionCount: plan.sessionCount,
      qualitySlotCount: plan.slotCount,
    });
  }

  if (underfunded.length === 0) return;

  throw new PlanSkeletonInfeasibleError({
    weeks: underfunded,
    requestedSessionsPerWeek: sessionsPerWeek,
    fundableSessionsPerWeek: fundableSessionsPerWeek(plans, level, sessionsPerWeek),
  });
}

/**
 * Le squelette complet d'un plan : une entrée par semaine, dans l'ordre.
 *
 * Une semaine se construit dans cet ordre, et il n'est pas interchangeable :
 *
 * 1. les **jours disponibles** (une première semaine entamée en a moins), d'où le
 *    nombre de séances réellement plaçables ;
 * 2. la **phase**, qui décide des zones de qualité, donc du nombre de créneaux ;
 * 3. la **répartition du volume** entre ces séances-là — elle a besoin du compte
 *    de séances et du compte de créneaux, pas l'inverse ;
 * 4. les **jours**, la sortie longue d'abord ;
 * 5. l'écriture, chaque budget rejoignant le jour de son rôle.
 *
 * Le budget de rôle `long` reste attribué même quand la sortie longue n'a pas
 * lieu (première semaine entamée dont le jour de sortie longue est passé) : il
 * devient alors le plus long footing de la semaine. Le volume de la semaine doit
 * tomber sur sa cible, et un budget abandonné le ferait passer sous la barre.
 *
 * **La semaine de course fait exception aux points 1 et 4.** Au point 4, c'est
 * le jour J ({@link PlanSkeletonParams.raceDay}) qui prend le rôle `long`, et la
 * séance écrite est la course elle-même : le jour de sortie longue de l'athlète
 * n'a plus cours cette semaine-là — deux gros efforts à quelques jours d'écart,
 * dont l'un est une compétition, ne sont pas une semaine d'affûtage. Au point 1,
 * ses jours disponibles s'arrêtent **au jour J** : mesuré avant cette borne, un
 * marathon un lundi à 6 séances donnait 5 séances et 23,3 km *après* la course,
 * dont une le lendemain de l'épreuve.
 *
 * Cette semaine-là porte donc moins de séances que le réglage, exactement comme
 * une première semaine entamée — et pour la même raison. `PlanExpectations`
 * l'apprend par le même champ (`raceDay`), et `validatePlanBusinessRules` y
 * plafonne le compte de séances au lieu de l'exiger exact.
 *
 * @throws {PlanSkeletonInfeasibleError} quand au moins une semaine vise un
 * volume que son nombre de séances ne peut pas financer — un athlète à 3 km par
 * semaine qui demande 6 séances demande 500 m par séance. Le squelette le dit au
 * lieu d'écrire une semaine que la validation refusera.
 */
export function buildPlanSkeleton(params: PlanSkeletonParams): SkeletonWeek[] {
  const {
    weeks,
    firstWeekFromDay,
    sessionsPerWeek,
    longRunDay,
    level,
    raceDay,
    goalDistanceKm,
    targets,
  } = params;
  if (weeks <= 0) return [];

  const phases = planPhases({ weeks, firstWeekFromDay, race: params.race });

  const plans: WeekPlan[] = [];
  for (let index = 0; index < weeks; index += 1) {
    const phase = phases[index];
    // Seule la première semaine peut être amputée ; les suivantes sont pleines,
    // quel que soit le jour où le plan a commencé.
    const fromDay = index === 0 && firstWeekFromDay > 1 ? firstWeekFromDay : 1;
    // La semaine de la course s'arrête au jour J. Les jours qui le suivent ne
    // sont pas des jours d'entraînement : mesuré avant cette borne, un marathon
    // un lundi à 6 séances donnait **5 séances et 23,3 km après la course**,
    // dont une le lendemain de l'épreuve.
    const lastDay = phase === 'race' && raceDay !== null ? raceDay : DAYS_PER_WEEK;
    const sessionCount = sessionsFitting(sessionsPerWeek, fromDay, lastDay);
    const zones = qualityZones(phase, goalDistanceKm);

    plans.push({
      weekNumber: index + 1,
      phase,
      target: targets[index],
      fromDay,
      lastDay,
      sessionCount,
      zones,
      slotCount: qualitySlotCount(level, zones.length, sessionCount),
    });
  }

  // Avant la première séance écrite : ce plan est-il seulement finançable ?
  assertFundable(plans, level, sessionsPerWeek);

  const skeleton: SkeletonWeek[] = [];

  for (const {
    weekNumber,
    phase,
    target,
    fromDay,
    lastDay,
    sessionCount,
    zones,
    slotCount,
  } of plans) {
    // La décomposition part du nombre de séances **réellement plaçables** : les
    // kilomètres des séances qu'une borne a supprimées sont ainsi répartis sur
    // celles qui restent, et la semaine retombe sur sa cible. Les abandonner la
    // ferait passer sous sa bande de ±10 %.
    const budgets = weeklySessionBudgets(target.targetKm, sessionCount, slotCount);
    const longBudget = budgets.find((budget) => budget.role === 'long');
    const qualityBudgets = budgets.filter((budget) => budget.role === 'quality');
    const easyBudgets = budgets.filter((budget) => budget.role === 'easy');

    // La semaine de course n'a pas de sortie longue : elle a une course, et
    // c'est le jour J qui porte le rôle `long` — son plus gros effort. Le jour
    // de sortie longue de l'athlète n'y a plus cours, sans quoi le plan lui
    // proposerait un long run la veille ou le lendemain de son épreuve.
    const isRaceWeek = phase === 'race' && raceDay !== null;
    const hardDay = isRaceWeek ? raceDay : longRunDay;

    const days = placeSessionDays({
      sessionsPerWeek: sessionCount,
      longRunDay: hardDay,
      qualityCount: slotCount,
      fromDay,
      toDay: lastDay,
    });

    // Un footing d'affûtage ou de semaine de course n'est pas un footing
    // ordinaire : il ne doit porter aucune cible, et c'est son `kind` qui le dit.
    const isRecoveryWeek = phase === 'taper' || phase === 'race';
    const easyKind = isRecoveryWeek ? SESSION_KINDS.recovery : SESSION_KINDS.easy;
    const easyTitle = isRecoveryWeek ? SESSION_TITLES.recovery : SESSION_TITLES.easy;

    const sessions: PlanSessionOutput[] = [];

    if (days.longRunDay !== null && longBudget !== undefined) {
      // Aucun déroulé le jour J : `wantsSpecificLongRun` n'accepte que la phase
      // `specific`, et la semaine de course n'en est pas une.
      const steps = wantsSpecificLongRun(phase, goalDistanceKm)
        ? specificLongRunSteps(longBudget.km)
        : undefined;

      sessions.push({
        day: days.longRunDay,
        kind: isRaceWeek ? SESSION_KINDS.race : SESSION_KINDS.longRun,
        title: isRaceWeek
          ? SESSION_TITLES.race
          : steps === undefined
            ? SESSION_TITLES.longRun
            : SESSION_TITLES.specificLongRun,
        // **Le budget de la décomposition, jamais la distance réelle de la
        // course.** C'est une décision assumée, et elle mérite d'être écrite :
        // un plan d'entraînement porte des volumes d'**entraînement**, et
        // injecter les 42,195 km d'un marathon dans la semaine qui le porte
        // ferait exploser tout ce qui l'encadre — l'affûtage descend strictement
        // chaque semaine, et la semaine de course reste sous 65 % du pic
        // (`VOLUME_RULES.raceWeekMaxRatio`). Aucun plan ne survivrait à ces deux
        // règles avec un marathon compté dedans.
        //
        // La séance du jour J est donc un **repère** : le bon libellé, le bon
        // jour, la bonne allure — pas une comptabilisation de l'épreuve. La
        // question de compter réellement la course dans le volume reste ouverte,
        // et elle se réglera ailleurs (côté volumes cibles, pas ici).
        distanceKm: longBudget.km,
        ...(steps === undefined ? {} : { steps }),
      });
    }

    // Sortie longue non plaçable : son budget rejoint les footings plutôt que
    // d'être abandonné, sans quoi la semaine passerait sous sa cible.
    const withLongRun =
      days.longRunDay === null && longBudget !== undefined
        ? [longBudget, ...easyBudgets]
        : easyBudgets;
    const easyKms = withLongRun.map((budget) => budget.km);

    days.easyDays.forEach((day, easyIndex) => {
      const km = easyKms[easyIndex];
      // Plus de budget que de jours ne se produit plus depuis le refus des
      // semaines infaisables ({@link assertFundable}) ; la garde reste parce
      // qu'une séance sans distance rendrait tout le plan invérifiable.
      if (km === undefined) return;
      sessions.push({ day, kind: easyKind, title: easyTitle, distanceKm: km });
    });

    const qualitySlots = days.qualityDays.map((day, slotIndex) => {
      const zone = zones[slotIndex];
      return {
        day,
        phase,
        level,
        zone,
        kind: QUALITY_ZONE_KINDS[zone],
        budgetKm: qualityBudgets[slotIndex].km,
      };
    });

    skeleton.push({
      weekNumber,
      phase,
      target,
      sessions: sessions.sort((left, right) => left.day - right.day),
      qualitySlots,
    });
  }

  return skeleton;
}
