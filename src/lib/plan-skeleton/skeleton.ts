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
 * - les footings et la sortie longue, **entièrement écrits**, kilométrage compris,
 *   déroulé compris quand la séance en porte un ({@link weeklyEasyVariation},
 *   {@link longRunFinishSteps}, {@link specificLongRunSteps}) ;
 * - les **tests chronométrés** de la périodisation, eux aussi entièrement
 *   écrits — un 5 km à fond qui reste la **seule séance dure de sa semaine** et
 *   remet à jour le chrono de référence du plan (`fitness-test.ts`) ;
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
 * titre, une distance et parfois un déroulé — mais aucune cible chiffrée.
 * `applyImposedPaces` (avec table VDOT) et `applyDerivedMeasures` (sans) les
 * posent en aval, exactement comme sur la sortie du modèle — un seul endroit
 * décide des allures, et ce n'est pas ici. Écrire une allure ici la ferait
 * diverger de celle que le reste du plan reçoit ; ce que les déroulés d'ici
 * portent, ce sont des **notes** en français, dont aucune ne déplace la zone
 * d'une étape (cf. `variations.ts`).
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`, ni horloge, ni aléa.
 */

import type { SessionBudget } from '@/lib/ai/format';
import {
  weeklySessionBudgets,
  type PlanRaceGoal,
  type PlanSessionOutput,
  type WeeklyVolumeTarget,
} from '@/lib/ai/plan-schema';
import type { PlanLevel } from '@/data/db/schema';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import { weeklyQualityShares, type CompositionAnchor } from './composition';
import { placeSessionDays } from './days';
import {
  minFundableWeeklyKm,
  PlanSkeletonInfeasibleError,
  type PlanSkeletonUnderfundedWeek,
} from './feasibility';
import {
  fitnessTestBudgets,
  fitnessTestSteps,
  fitnessTestWeekNumbers,
  FITNESS_TEST_KIND,
  FITNESS_TEST_TITLE,
  pickFitnessTestDay,
} from './fitness-test';
import {
  intentLongRunShareCap,
  intentQualitySlots,
  intentWalkRunBaseWeeks,
  type PlanIntent,
} from './intent';
import { cappedLongRunBudgets, longRunCapCandidatesKm } from './long-run-cap';
import { planPhases, type PlanPhase } from './phases';
import { goalFamily, qualityZones, QUALITY_ZONE_KINDS, type QualityZone } from './quality';
import {
  distanceStep,
  easySessionSteps,
  longRunFinishSteps,
  spreadEasyDistances,
  weeklyEasyVariation,
  type EasyVariation,
} from './variations';
import { walkRunShape } from './walk-run';

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
  longRunFinish: 'Sortie longue, fin de parcours appuyée',
  race: 'Jour J : la course',
} as const;

/**
 * Le titre de chaque variation de footing ({@link EasyVariation}).
 *
 * Ces titres sont ce que l'utilisatrice lit sur sa timeline, et c'est par eux
 * que deux footings d'une même semaine cessent d'être deux jumeaux. Ils ne sont
 * lus par aucun classement d'allure — seul le `kind` l'est
 * (`sessionPaceZone`, `isIntensitySession`), et il reste « Endurance
 * fondamentale » : un footing à lignes droites n'est pas une séance de qualité.
 */
const EASY_VARIATION_TITLES = {
  plain: SESSION_TITLES.easy,
  strides: 'Footing avec lignes droites',
  hillStrides: 'Footing avec côtes courtes',
  progressive: 'Footing progressif',
} as const satisfies Record<EasyVariation, string>;

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
  /**
   * La **cible hebdomadaire de la semaine où tombe ce créneau**, en km — ce qui
   * plafonne le volume d'effort de la séance ({@link qualityEffortCapKm}).
   *
   * Elle voyage avec le créneau pour la même raison que le niveau : c'est là
   * qu'elle sert, et des deux côtés. Le plafond de Daniels s'exprime en part du
   * volume **hebdomadaire** — 10 % au seuil, 8 % en VMA, 5 % en répétitions —, or
   * ni la validation d'une séance remplie (`quality-fill.ts`) ni le déroulé
   * déterministe ({@link qualitySessionTemplate}) ne voient la semaine : ils ne
   * voient qu'un créneau. Sans ce champ, la seule dimension de la séance dont
   * l'excès mène au surentraînement resterait la seule que rien ne borne.
   *
   * C'est bien la cible de la semaine, pas le budget du créneau : un plafond
   * calculé sur la séance elle-même ne dirait rien de la charge que l'athlète
   * absorbe cette semaine-là.
   */
  weeklyTargetKm: number;
};

/** Une semaine du squelette : ce qui est écrit, et ce qui reste à écrire. */
export type SkeletonWeek = {
  /**
   * Numéro 1-based dans la **fenêtre construite** — donc dans le plan entier
   * lors d'une création, et dans la fenêtre seule lors d'une reconstruction.
   *
   * C'est un repère de diagnostic (le refus d'une semaine infaisable la nomme
   * par ce numéro), jamais une entrée de décision : tout ce qui doit rendre la
   * même chose d'une fenêtre à l'autre se compte du plan
   * ({@link PlanSkeletonParams.planWeekOffset}).
   */
  weekNumber: number;
  phase: PlanPhase;
  target: WeeklyVolumeTarget;
  /** Footings et sortie longue, entièrement écrits. */
  sessions: PlanSessionOutput[];
  /** Les créneaux que le modèle remplira, un par séance de qualité. */
  qualitySlots: QualitySlot[];
};

export type PlanSkeletonParams = {
  /**
   * Ce que l'athlète vient chercher — le paramètre qui décide de la **forme** du
   * plan : longueur de la base, existence d'une spécificité, nombre de créneaux
   * de qualité, zones travaillées, plafond de la sortie longue et marche/course
   * des premières semaines.
   *
   * Il ne décide en revanche d'**aucun kilomètre** : les cibles hebdomadaires
   * arrivent toutes faites ({@link PlanSkeletonParams.targets}), et une intention
   * qui les corrigerait ici les ferait diverger de celles que le prompt annonce et
   * que la validation vérifie. Le détail de chaque structure, et la recherche qui
   * la fonde, sont dans `intent.ts`.
   */
  intent: PlanIntent;
  /**
   * L'athlète déclare un **antécédent de blessure** — ne joue qu'en `return`.
   *
   * C'est le prédicteur le plus fort du dossier (OR 7,56, Relph 2023), et le seul
   * qui déplace franchement un paramètre : il rallonge la base de 50 à 60 % du
   * plan et double la fenêtre de marche/course.
   */
  returnInjuryHistory?: boolean;
  /**
   * Le plafond de la **première** sortie longue, en km — `null` ou absent quand
   * rien ne la plafonne, ce qui est le comportement historique.
   *
   * L'appelant le calcule depuis les données réelles de l'athlète : la plus longue
   * séance des trente derniers jours, majorée de 10 %. Le squelette ne saurait pas
   * le faire — il ne voit ni activités ni historique —, et c'est aussi la raison
   * pour laquelle il ne le devine pas : sans donnée, pas de plafond.
   *
   * Le plafond est **conservateur** : il cède devant les invariants de la semaine
   * plutôt que de les casser (cf. `long-run-cap.ts`).
   */
  longRunCapKm?: number | null;
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
  /**
   * La périodisation, **imposée par l'appelant** — une phase par semaine, dans
   * l'ordre. Absente, elle est calculée depuis la fenêtre ({@link planPhases}),
   * ce qui est le cas nominal d'une création.
   *
   * ## Pourquoi ce paramètre existe
   *
   * {@link planPhases} déduit les phases de la **durée totale** du plan : quatre
   * semaines de base, puis du développement, puis de la spécificité, puis
   * l'affûtage. C'est juste tant que la fenêtre construite *est* le plan entier.
   *
   * Elle ne l'est plus quand on reconstruit la fin d'un plan en cours
   * (`rewriteRemainingPlan`) : dix semaines restantes d'un plan de seize ne sont
   * pas un plan de dix semaines, elles en sont le dernier tiers. Les recalculer
   * ici renverrait un athlète entré dans son bloc spécifique en phase de base —
   * la périodisation redémarrerait à chaque ajustement, et l'entraînement
   * n'irait jamais nulle part.
   *
   * L'appelant calcule donc les phases sur le plan **entier** et n'en passe que
   * la tranche restante. Ce module ne fait rien d'autre que les prendre pour
   * argent comptant : il n'a pas les moyens de vérifier une position dans une
   * durée qu'il ne connaît pas.
   */
  phases?: readonly PlanPhase[];
  /**
   * Où cette fenêtre se situe dans la séquence de développement du **plan
   * entier** — ce qui décide de la composition de chaque semaine
   * ({@link weeklyQualityShares}).
   *
   * Absent, la fenêtre **est** le plan : c'est le cas nominal d'une création,
   * et la rampe se mesure alors sur la fenêtre elle-même. Le contrat que les
   * deux chemins partagent est celui-ci : *une même semaine calendaire reçoit
   * la même composition, qu'elle soit écrite à la création ou par n'importe
   * quelle fenêtre de reconstruction*.
   *
   * Le paramètre suit exactement l'esprit de {@link phases} — l'appelant sait
   * ce que le module ne peut pas déduire —, et il existe pour la même raison :
   * une rampe calée sur la position dans la fenêtre se recalerait à chaque
   * réadaptation.
   */
  compositionAnchor?: CompositionAnchor;
  /**
   * Le nombre de semaines du **plan** qui précèdent cette fenêtre — `0` ou
   * absent quand la fenêtre *est* le plan, ce qui est le cas d'une création.
   *
   * ## Le défaut qu'il ferme
   *
   * {@link weeklyEasyVariation} et {@link longRunFinishSteps} se décident du
   * **numéro de semaine**, et ce numéro était celui de la fenêtre : une
   * reconstruction renumérote depuis 1, donc une même semaine calendaire
   * changeait de parité d'un ajustement à l'autre. Mesuré sur une préparation
   * de 16 semaines à 6 séances, fenêtre de 15 : la semaine calendaire 5 sortait
   * en `6,1 · 6,8 · 6,8 · 7,4` km à la création et en `7,5 · 6,8 · 6,8 · 6,0` à
   * la reconstruction — mêmes kilomètres au total, autres séances. La sortie
   * longue à fin appuyée, une semaine sur trois, se déplaçait de la même façon.
   *
   * Le paramètre suit l'esprit de {@link compositionAnchor} : l'appelant sait où
   * sa fenêtre commence, le module ne peut pas le deviner.
   */
  planWeekOffset?: number;
  /**
   * Le nombre de semaines de **base du plan** que cette fenêtre ne porte pas —
   * `0` ou absent quand la fenêtre est le plan.
   *
   * Même chaînon manquant que {@link planWeekOffset}, pour la fenêtre de
   * marche/course : elle couvre les premières semaines de base **du plan**, et
   * un compteur qui ne voit que la fenêtre la rouvrirait à chaque
   * reconstruction ouverte en pleine base — une reprise de quatrième semaine
   * retomberait au ratio 1:2 du premier jour.
   *
   * Compté par **soustraction** chez l'appelant (semaines de base du plan moins
   * celles que la fenêtre porte), comme
   * {@link CompositionAnchor.completedDevelopmentWeeks} : la première semaine
   * d'une fenêtre entamée est ramenée à `partial` et perd son rang de base, et
   * la soustraction la range du bon côté là où un décompte de préfixe
   * décalerait toutes les suivantes.
   */
  completedBaseWeeks?: number;
  /**
   * Les semaines du **plan entier** qui portent un test chronométré, par leur
   * numéro 1-based ({@link fitnessTestWeekNumbers}) — absent quand la fenêtre
   * *est* le plan, ce qui est le cas nominal d'une création.
   *
   * Même esprit que {@link phases} et {@link compositionAnchor}, et même piège
   * fermé : le placement des tests se déduit de la périodisation du **plan**
   * (la fin de la phase de base, puis tous les cinq semaines), et une fenêtre
   * reconstruite ne voit qu'une tranche de cette périodisation — elle y
   * replacerait un premier test « en fin de base » qui n'a plus lieu d'être, ou
   * en perdrait un que la création avait posé. L'appelant calcule donc les
   * semaines de test sur le plan entier et passe la liste telle quelle ; ce
   * module se contente de retenir celles qui tombent dans sa fenêtre.
   */
  testWeeks?: readonly number[];
};

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

/** Le titre et le déroulé d'une sortie longue — les deux se décident ensemble. */
type LongRunShape = { title: string; steps?: PlanSessionSteps };

/**
 * Ce que porte la sortie longue d'une semaine, dans l'ordre de priorité :
 *
 * 1. le **bloc à allure objectif** de la phase spécifique, quand la course visée
 *    est assez longue pour qu'on ait à en répéter l'allure sur la fatigue ;
 * 2. sinon, une **fin de parcours appuyée**, une semaine sur trois en
 *    développement et en spécificité ({@link longRunFinishSteps}) ;
 * 3. sinon la sortie longue nue, qui reste le cas majoritaire — une sortie
 *    longue est d'abord du temps passé en endurance.
 *
 * Le repli sur le titre nu quand le déroulé n'a pas pu s'écrire (séance trop
 * courte pour être découpée) n'est pas cosmétique : un titre qui annonce un
 * découpage absent est un mensonge sur la timeline.
 *
 * @param planWeekNumber le rang de la semaine dans le **plan**, jamais dans la
 * fenêtre : c'est lui qui décide de la cadence « une sortie longue sur trois »,
 * et une numérotation de fenêtre la déplacerait à chaque reconstruction.
 */
function longRunShape(
  phase: PlanPhase,
  planWeekNumber: number,
  goalDistanceKm: number | null,
  distanceKm: number,
): LongRunShape {
  if (wantsSpecificLongRun(phase, goalDistanceKm)) {
    const steps = specificLongRunSteps(distanceKm);
    return steps === undefined
      ? { title: SESSION_TITLES.longRun }
      : { title: SESSION_TITLES.specificLongRun, steps };
  }

  const finish = longRunFinishSteps(phase, planWeekNumber, distanceKm);
  return finish === undefined
    ? { title: SESSION_TITLES.longRun }
    : { title: SESSION_TITLES.longRunFinish, steps: finish };
}

/**
 * Le nombre de créneaux de qualité d'une semaine, sous trois plafonds.
 *
 * Ce que l'**intention** veut d'abord ({@link intentQualitySlots}) : 1 pour une
 * débutante et 2 sinon quand il y a une course à préparer ou de la vitesse à
 * gagner, 1 quel que soit le niveau pour une perte de poids, 0 pour une reprise —
 * chacun avec ses sources, dans `intent.ts`.
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
  intent: PlanIntent,
  level: PlanLevel,
  zoneCount: number,
  sessionCount: number,
): number {
  const wanted = intentQualitySlots(intent, level);
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
  /**
   * Le numéro de la semaine dans le **plan entier** — `weekNumber` décalé de
   * {@link PlanSkeletonParams.planWeekOffset}.
   *
   * C'est lui, et jamais `weekNumber`, que lisent les décisions de **forme**
   * (variation d'endurance, fin de sortie longue appuyée) : elles doivent rendre
   * la même chose pour une semaine calendaire donnée, quelle que soit la fenêtre
   * qui l'écrit.
   */
  planWeekNumber: number;
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
  /**
   * La part du volume que prend **chaque** créneau de qualité de cette
   * semaine-là ({@link weeklyQualityShares}).
   *
   * Portée par la semaine et pas recalculée à l'usage : elle sert à trois
   * endroits — le minimum finançable, le repli sur un nombre de séances tenable
   * et la décomposition elle-même —, et trois calculs séparés seraient trois
   * occasions de diverger.
   */
  qualityShare: number;
  /**
   * Le rang (0-based) de la semaine dans la fenêtre de marche/course, `null`
   * quand elle n'en est pas — c'est ce rang qui décide du ratio course/marche
   * ({@link walkRunShape}).
   */
  walkRunRank: number | null;
};

/**
 * Le rang de chaque semaine dans la fenêtre de **marche/course** — `null`
 * partout dès que l'intention n'en ouvre aucune.
 *
 * La fenêtre est celle des `count` **premières semaines de base**, et pas des
 * `count` premières semaines du plan : une première semaine entamée n'est pas une
 * semaine de base, et la faire compter reviendrait à ne prescrire la marche/course
 * qu'une seule fois sur un plan qui démarre un jeudi.
 *
 * Les phases étant ordonnées, un simple compteur suffit — les semaines de base
 * sont contiguës et en tête. Il démarre à `completed`, les semaines de base que
 * la fenêtre ne porte pas (cf. {@link PlanSkeletonParams.completedBaseWeeks}) :
 * c'est ce qui fait qu'une reconstruction ouverte en pleine base reprend la rampe
 * où elle en était au lieu de la rouvrir.
 */
function walkRunBaseRanks(
  phases: readonly PlanPhase[],
  count: number,
  completed: number,
): (number | null)[] {
  let seen = completed;
  return phases.map((phase) => {
    if (phase !== 'base' || seen >= count) return null;
    const rank = seen;
    seen += 1;
    return rank;
  });
}

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
  intent: PlanIntent,
  level: PlanLevel,
  requested: number,
): number {
  for (let candidate = requested - 1; candidate >= 1; candidate -= 1) {
    const fits = plans.every((plan) => {
      const sessionCount = sessionsFitting(candidate, plan.fromDay, plan.lastDay);
      const slotCount = qualitySlotCount(intent, level, plan.zones.length, sessionCount);
      // La part de qualité ne dépend que de la phase et du rang, jamais du
      // nombre de séances : celle de la semaine reste la bonne à tout candidat.
      return plan.target.targetKm >= minFundableWeeklyKm(sessionCount, slotCount, plan.qualityShare);
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
  intent: PlanIntent,
  level: PlanLevel,
  sessionsPerWeek: number,
): void {
  const underfunded: PlanSkeletonUnderfundedWeek[] = [];

  for (const plan of plans) {
    const minimumKm = minFundableWeeklyKm(plan.sessionCount, plan.slotCount, plan.qualityShare);
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
    fundableSessionsPerWeek: fundableSessionsPerWeek(plans, intent, level, sessionsPerWeek),
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
    intent,
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

  const returnInjuryHistory = params.returnInjuryHistory ?? false;

  // La périodisation de l'appelant quand il en a une (cf.
  // {@link PlanSkeletonParams.phases}) ; celle de la fenêtre sinon.
  const phases =
    params.phases ??
    planPhases({ weeks, firstWeekFromDay, race: params.race, intent, returnInjuryHistory });
  // La composition de chaque semaine, décidée par sa position dans le PLAN et
  // non dans la fenêtre (cf. {@link PlanSkeletonParams.compositionAnchor}).
  const qualityShares = weeklyQualityShares(intent, phases, params.compositionAnchor);
  // Les semaines de marche/course : les premières de la base **du plan**, et
  // elles seules — d'où l'ancrage, sans lequel une reconstruction rouvrirait la
  // rampe à son premier barreau.
  const walkRunWeeks = intentWalkRunBaseWeeks(intent, returnInjuryHistory);
  const walkRunRanks = walkRunBaseRanks(phases, walkRunWeeks, params.completedBaseWeeks ?? 0);
  // Où la fenêtre commence dans le plan : tout ce qui se décide de la **forme**
  // d'une semaine se compte à partir de là (cf. `planWeekOffset`).
  const planWeekOffset = params.planWeekOffset ?? 0;
  // Les semaines de test, en numérotation du **plan** : celles de l'appelant
  // quand il en a (reconstruction), celles de la fenêtre sinon — auquel cas la
  // fenêtre est le plan (cf. `testWeeks`).
  // `params.firstWeekFromDay` est ici celui du plan : la branche sans
  // `testWeeks` est exactement celle où la fenêtre *est* le plan (cf. le champ).
  const testWeeks = new Set(
    params.testWeeks ?? fitnessTestWeekNumbers(intent, phases, params.firstWeekFromDay),
  );

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
    const zones = qualityZones(intent, phase, goalDistanceKm);

    plans.push({
      weekNumber: index + 1,
      planWeekNumber: planWeekOffset + index + 1,
      phase,
      target: targets[index],
      fromDay,
      lastDay,
      sessionCount,
      zones,
      slotCount: qualitySlotCount(intent, level, zones.length, sessionCount),
      qualityShare: qualityShares[index],
      walkRunRank: walkRunRanks[index],
    });
  }

  // Avant la première séance écrite : ce plan est-il seulement finançable ?
  assertFundable(plans, intent, level, sessionsPerWeek);

  const shareCapKm = intentLongRunShareCap(intent);
  // Le **pic** de sortie longue déjà écrit : c'est lui qui borne les suivantes,
  // et non le budget brut ni la semaine précédente (cf. `long-run-cap.ts`).
  let peakLongRunKm: number | null = null;

  const skeleton: SkeletonWeek[] = [];

  for (const {
    weekNumber,
    planWeekNumber,
    phase,
    target,
    fromDay,
    lastDay,
    sessionCount,
    zones,
    slotCount,
    qualityShare,
    walkRunRank,
  } of plans) {
    // La décomposition part du nombre de séances **réellement plaçables** : les
    // kilomètres des séances qu'une borne a supprimées sont ainsi répartis sur
    // celles qui restent, et la semaine retombe sur sa cible. Les abandonner la
    // ferait passer sous sa bande de ±10 %.
    //
    // `undefined` sur la part de sortie longue : elle reste celle que la
    // décomposition décide seule. Mesurée sur le plan de l'utilisatrice, elle
    // est déjà collée à son plafond réglementaire en développement (39,1 à
    // 39,9 % pour un maximum de 40 %) — une rampe n'y aurait rien à relever,
    // et le raisonnement complet est dans `composition.ts`. Le **plafond** de la
    // sortie longue, lui, ne peut pas passer par ce paramètre : c'est un plancher
    // déguisé, et la démonstration est dans `long-run-cap.ts`.
    const rawBudgets = weeklySessionBudgets(
      target.targetKm,
      sessionCount,
      slotCount,
      undefined,
      qualityShare,
    );

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

    // Le plafond ne s'applique qu'à une **sortie longue réellement écrite** : ni
    // à la course du jour J (un repère, pas un entraînement), ni au budget d'une
    // sortie longue que la semaine entamée ne peut plus placer.
    //
    // Annoté plutôt qu'inféré : la valeur dépend du pic de sortie longue déjà
    // écrit, qui dépend lui-même de ce plafond — une boucle que l'inférence ne
    // sait pas dérouler, et qui n'existe pas à l'exécution.
    const capCandidates: number[] =
      isRaceWeek || days.longRunDay === null
        ? []
        : longRunCapCandidatesKm(
            params.longRunCapKm ?? null,
            peakLongRunKm,
            shareCapKm === null ? null : shareCapKm * target.targetKm,
          );
    // Du plus serré au plus large : le premier plafond que la semaine peut tenir
    // l'emporte, et aucun ne peut en relever un autre (cf. `long-run-cap.ts`).
    let budgets: SessionBudget[] = rawBudgets;
    for (const allowedKm of capCandidates) {
      const capped = cappedLongRunBudgets(rawBudgets, allowedKm, target.targetKm);
      if (capped !== null) {
        budgets = capped;
        break;
      }
    }

    // Le **test chronométré**, quand la périodisation en pose un cette
    // semaine-là. Il ne s'ajoute pas aux créneaux de qualité et ne se contente
    // pas d'en remplacer un : cette semaine-là ne porte **que lui** comme séance
    // dure, les autres créneaux redevenant des footings — le raisonnement et la
    // mesure qui l'imposent sont dans l'en-tête de `fitness-test.ts`. Les
    // kilomètres, eux, restent dans la semaine : ils repartent au pot des
    // footings, et la somme ne bouge pas. Il cède devant les invariants comme le
    // plafond de sortie longue : une semaine qui ne peut pas le financer garde
    // simplement sa qualité ordinaire.
    const testDay =
      testWeeks.has(planWeekNumber) && days.qualityDays.length > 0
        ? pickFitnessTestDay(days.qualityDays, days.longRunDay)
        : null;
    const testedBudgets = testDay === null ? null : fitnessTestBudgets(budgets);
    let test: { day: number; km: number } | null = null;
    if (testDay !== null && testedBudgets !== null) {
      budgets = testedBudgets;
      // Le test consomme le **premier** créneau de qualité — celui dont
      // `fitnessTestBudgets` vient de relever le budget, et le seul qui reste.
      const testBudget = testedBudgets.find((budget) => budget.role === 'quality');
      if (testBudget !== undefined) test = { day: testDay, km: testBudget.km };
    }

    const longBudget = budgets.find((budget) => budget.role === 'long');
    // Une semaine de test n'ouvre **aucun** créneau à faire remplir : le test
    // est écrit ici de bout en bout, et les créneaux qu'il a effacés sont
    // devenus des footings — budget compris (`fitnessTestBudgets`), jour compris
    // (ci-dessous).
    const slotBudgets = test === null ? budgets.filter((budget) => budget.role === 'quality') : [];
    const slotDays = test === null ? days.qualityDays : [];
    const easyBudgets = budgets.filter((budget) => budget.role === 'easy');
    const easyDays =
      test === null
        ? days.easyDays
        : [...days.easyDays, ...days.qualityDays.filter((day) => day !== test.day)].sort(
            (left, right) => left - right,
          );
    if (days.longRunDay !== null && !isRaceWeek && longBudget !== undefined) {
      peakLongRunKm = Math.max(peakLongRunKm ?? 0, longBudget.km);
    }

    // Un footing d'affûtage ou de semaine de course n'est pas un footing
    // ordinaire : il ne doit porter aucune cible, et c'est son `kind` qui le dit.
    const isRecoveryWeek = phase === 'taper' || phase === 'race';
    const easyKind = isRecoveryWeek ? SESSION_KINDS.recovery : SESSION_KINDS.easy;
    const easyTitle = isRecoveryWeek ? SESSION_TITLES.recovery : SESSION_TITLES.easy;

    const sessions: PlanSessionOutput[] = [];

    if (days.longRunDay !== null && longBudget !== undefined) {
      // Aucun déroulé le jour J : ni `wantsSpecificLongRun` ni
      // `longRunFinishSteps` n'acceptent la phase `race`, et une course ne se
      // découpe pas.
      //
      // Pendant la fenêtre de marche/course, la sortie longue se court comme le
      // reste de la semaine : mêmes blocs, même ratio, budget kilométrique
      // inchangé. Mesuré sur une semaine 1 de reprise : des footings en
      // marche/course et, à côté, une sortie longue continue de 10,6 km — la
      // séance la plus coûteuse de la semaine était la seule à ne pas suivre la
      // consigne de la semaine.
      const walkRunLong =
        walkRunRank === null ? undefined : walkRunShape(longBudget.km, walkRunRank, walkRunWeeks);
      const shape =
        walkRunLong ?? longRunShape(phase, planWeekNumber, goalDistanceKm, longBudget.km);
      const steps = isRaceWeek ? undefined : shape.steps;

      sessions.push({
        day: days.longRunDay,
        kind: isRaceWeek ? SESSION_KINDS.race : SESSION_KINDS.longRun,
        title: isRaceWeek ? SESSION_TITLES.race : shape.title,
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

    // La variation de la semaine se décide sur le nombre de footings **budgétés**
    // : c'est le rang dans cette liste-là que `spreadEasyDistances` et l'écriture
    // ci-dessous partagent.
    const variation = weeklyEasyVariation(phase, planWeekNumber, easyBudgets.length);
    // La sortie longue reste la séance la plus longue de sa semaine : c'est elle
    // qui plafonne le footing qui s'allonge. Quand elle n'a pas lieu, son budget
    // est devenu le plus gros footing et joue le même rôle de plafond.
    const ceilingKm = longBudget?.km ?? Number.POSITIVE_INFINITY;
    const spreadKms = spreadEasyDistances(
      easyBudgets.map((budget) => budget.km),
      variation.index,
      ceilingKm,
    );

    // Sortie longue non plaçable : son budget rejoint les footings plutôt que
    // d'être abandonné, sans quoi la semaine passerait sous sa cible. Il reste en
    // tête et hors du rééquilibrage — c'est le plus gros de la semaine, il n'a
    // rien à céder.
    const reversedLongKm =
      days.longRunDay === null && longBudget !== undefined ? [longBudget.km] : [];
    const easyKms = [...reversedLongKm, ...spreadKms];
    const enrichedIndex = reversedLongKm.length + variation.index;

    easyDays.forEach((day, easyIndex) => {
      const km = easyKms[easyIndex];
      // Plus de budget que de jours ne se produit plus depuis le refus des
      // semaines infaisables ({@link assertFundable}) ; la garde reste parce
      // qu'une séance sans distance rendrait tout le plan invérifiable.
      if (km === undefined) return;

      // Les premières semaines d'une reprise : **tous** les footings se courent
      // en marche/course, et pas un seul « enrichi » comme le reste du temps. Ce
      // n'est pas une variation qu'on saupoudre, c'est la forme de la séance —
      // la seule qui ait un essai contrôlé derrière elle (cf. `walk-run.ts`).
      const walkRun = walkRunRank === null ? undefined : walkRunShape(km, walkRunRank, walkRunWeeks);
      if (walkRun !== undefined) {
        sessions.push({
          day,
          kind: easyKind,
          title: walkRun.title,
          distanceKm: km,
          steps: walkRun.steps,
        });
        return;
      }

      // Un seul footing enrichi par semaine, et jamais sur une semaine de
      // récupération : `weeklyEasyVariation` rend déjà `plain` pour l'affûtage,
      // la semaine de course et la semaine entamée.
      const steps =
        easyIndex === enrichedIndex ? easySessionSteps(variation.variation, km) : undefined;

      sessions.push({
        day,
        kind: easyKind,
        // Le titre suit le déroulé réellement écrit : une séance trop courte pour
        // porter des lignes droites reste un footing, titre compris.
        title: steps === undefined ? easyTitle : EASY_VARIATION_TITLES[variation.variation],
        distanceKm: km,
        ...(steps === undefined ? {} : { steps }),
      });
    });

    if (test !== null) {
      sessions.push({
        day: test.day,
        kind: FITNESS_TEST_KIND,
        title: FITNESS_TEST_TITLE,
        distanceKm: test.km,
        steps: fitnessTestSteps(),
      });
    }

    const qualitySlots = slotDays.map((day, slotIndex) => {
      const zone = zones[slotIndex];
      return {
        day,
        phase,
        level,
        zone,
        kind: QUALITY_ZONE_KINDS[zone],
        budgetKm: slotBudgets[slotIndex].km,
        // La cible de la semaine, pas la somme réellement écrite : c'est elle
        // que la décomposition a répartie, et c'est sur elle que les plafonds de
        // volume d'effort se calculent.
        weeklyTargetKm: target.targetKm,
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
