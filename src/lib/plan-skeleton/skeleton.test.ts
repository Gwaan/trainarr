import { describe, expect, it } from 'vitest';

import type { PlanLevel } from '@/data/db/schema';
import {
  applyDerivedMeasures,
  applyImposedPaces,
  isIntensitySession,
  PLAN_OUTPUT_BOUNDS,
  sessionPaceZone,
  validatePlanBusinessRules,
  VOLUME_RULES,
  weeklyVolumeTargets,
  type PlanExpectations,
  type PlanRaceGoal,
  type PlanSessionOutput,
  type PlanValidationContext,
  type PlanWeekOutput,
  type WeeklyVolumeTarget,
} from '@/lib/ai/plan-schema';
import { trainingPacesFromRace, type TrainingPaces } from '@/lib/metrics/vdot';
import { flattenSteps, type PlanStep } from '@/lib/plan-steps/schema';

import { isDevelopmentPhase } from './composition';
import { PlanSkeletonInfeasibleError } from './feasibility';
import { PLAN_INTENTS, type PlanIntent } from './intent';
import { planPhases, type PlanPhase } from './phases';
import { buildPlanSkeleton, type QualitySlot, type SkeletonWeek } from './skeleton';

/*
 * Le squelette est écrit pour passer les règles du plan : c'est toute sa raison
 * d'être. Un squelette qui les viole ne vaut rien, puisque le service le ferait
 * régénérer — sauf que plus rien ne serait à régénérer, l'appli l'ayant écrit
 * elle-même.
 *
 * D'où la forme de ce fichier : un balayage de toute la matrice des
 * configurations, chaque squelette étant complété par des séances de qualité
 * factices (le modèle ne tourne pas dans un test), **post-traité comme le
 * pipeline le post-traite**, puis soumis au juge.
 *
 * ## Le coût de ce balayage, et ce qui le borne
 *
 * 42 336 combinaisons (12 durées × 6 comptes de séances × 7 couples de jours ×
 * 2 niveaux × 7 objectifs × 6 athlètes), soit environ 7 s — l'essentiel du temps
 * de `pnpm test`, et une suite relancée à chaque vérification. Le croisement naïf
 * en compterait 444 528 et coûterait 67 s ; les deux seules dimensions resserrées
 * l'ont été parce que le **code sous test n'en distingue pas les valeurs**, et
 * chacune porte sa démonstration : les jours ({@link DAY_SETTINGS}) et les
 * niveaux ({@link SWEPT_LEVELS}).
 *
 * **Les quatre autres sont exhaustives et doivent le rester** : nombre de
 * séances, profils d'athlète (les trois à très faible volume surtout), durées de
 * plan et objectifs portent chacun une branche du code, pas un échantillon d'un
 * continuum.
 *
 * Le pouvoir de détection de ce qui reste est vérifié par mutation, et pas
 * seulement supposé — trois fautes plantées le font échouer : des cibles faussées
 * (`targetKm × 1,3`, semaines hors bande dès la première combinaison), des
 * séances de qualité privées de leur déroulé, et le refus d'infaisabilité
 * neutralisé (`minFundableWeeklyKm` rendant 0), qui échoue sur l'athlète à
 * 3 km/semaine — le domaine même où la revue avait trouvé ses échecs.
 *
 * ## Deux pièges que ce fichier a appris à ne plus tendre
 *
 * 1. **Valider sans post-traitement ne prouve rien.** Le pipeline réel passe
 *    toujours par `applyImposedPaces` (avec table VDOT) ou `applyDerivedMeasures`
 *    (sans) avant de valider, et ces deux-là recalculent la distance d'une
 *    séance depuis son déroulé. Un test qui valide la sortie nue du squelette
 *    valide un objet que personne ne verra jamais.
 * 2. **Le déroulé des créneaux se mesure en distance.** Mesuré sur les 3 024
 *    combinaisons que ce balayage comptait alors : un déroulé en durée fait
 *    sortir 2 973 semaines sur 3 024 (98,3 %) de leur cible une fois
 *    `applyImposedPaces` passé — `imposedDistanceKm` remplace la distance
 *    déclarée par la couverture du déroulé dès qu'elle lui est supérieure, et
 *    « 15 min + 4 × (3 min + 2 min) + 10 min » couvre ~11 km à l'allure seuil
 *    pour un créneau budgété 4,5 km. Le même remplissage en distance : zéro
 *    sortie de cible, dans les deux régimes.
 */

/** Une étape mesurée en distance, sans cible : le squelette n'écrit aucune allure. */
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

/** Une étape mesurée en durée — ce que le remplissage ne doit **pas** produire. */
function durationStep(role: PlanStep['role'], durationS: number, note: string): PlanStep {
  return {
    role,
    distanceM: null,
    durationS,
    paceMinSecPerKm: null,
    paceMaxSecPerKm: null,
    hrZone: null,
    note,
  };
}

/**
 * Ce que le coach écrira dans un créneau, en plus court : le `kind` du créneau,
 * son budget kilométrique, et un déroulé minimal mais valide — échauffement, bloc
 * répété avec sa récupération, retour au calme. C'est ce que `sessionStepViolations`
 * exige de toute séance d'intensité.
 *
 * Le déroulé est **mesuré en distance** et couvre exactement le budget : c'est le
 * contrat que {@link QualitySlot} pose au remplissage à venir, et c'est ce qui
 * empêche `imposedDistanceKm` de réécrire la distance de la séance en aval.
 */
function fillQualitySlot(slot: QualitySlot): PlanSessionOutput {
  const totalM = Math.round(slot.budgetKm * 1_000);
  const warmupM = Math.round(totalM * 0.25);
  const cooldownM = Math.round(totalM * 0.25);
  const bodyM = totalM - warmupM - cooldownM;
  const repeats = 4;
  const runM = Math.round((bodyM * 0.6) / repeats);
  const recoverM = Math.round((bodyM * 0.4) / repeats);
  // Le retour au calme absorbe le reliquat des divisions : le déroulé couvre la
  // séance au mètre près, ni plus ni moins.
  const remainderM = bodyM - repeats * (runM + recoverM);

  return {
    day: slot.day,
    kind: slot.kind,
    title: `Séance de ${slot.kind}`,
    distanceKm: slot.budgetKm,
    steps: [
      { repeat: 1, steps: [distanceStep('warmup', warmupM, 'Échauffement progressif')] },
      {
        repeat: repeats,
        steps: [
          distanceStep('run', runM, 'Effort régulier'),
          distanceStep('recover', recoverM, 'Récupération trottée'),
        ],
      },
      {
        repeat: 1,
        steps: [distanceStep('cooldown', cooldownM + remainderM, 'Retour au calme')],
      },
    ],
  };
}

/** Le même créneau rempli en durée : le piège que le test 2 documente. */
function fillQualitySlotWithDurations(slot: QualitySlot): PlanSessionOutput {
  return {
    day: slot.day,
    kind: slot.kind,
    title: `Séance de ${slot.kind}`,
    distanceKm: slot.budgetKm,
    steps: [
      { repeat: 1, steps: [durationStep('warmup', 900, 'Échauffement progressif')] },
      {
        repeat: 4,
        steps: [
          durationStep('run', 180, 'Effort régulier'),
          durationStep('recover', 120, 'Récupération trottée'),
        ],
      },
      { repeat: 1, steps: [durationStep('cooldown', 600, 'Retour au calme')] },
    ],
  };
}

/** Le squelette complété, tel que le service le soumettra à la validation. */
function fillSkeleton(
  skeleton: readonly SkeletonWeek[],
  fill: (slot: QualitySlot) => PlanSessionOutput = fillQualitySlot,
): PlanWeekOutput[] {
  return skeleton.map((week) => ({
    sessions: [...week.sessions, ...week.qualitySlots.map(fill)].sort(
      (left, right) => left.day - right.day,
    ),
  }));
}

/** Ce que la validation sait de l'athlète — et ce dont les cibles sont calculées. */
type Athlete = {
  label: string;
  recentWeeklyKm: number | null;
  weeklyTimeMinutes: number | null;
  easyPaceSecPerKm: number | null;
  paces: TrainingPaces | null;
};

const ATHLETES: Athlete[] = [
  {
    label: 'sans historique ni budget',
    recentWeeklyKm: null,
    weeklyTimeMinutes: null,
    easyPaceSecPerKm: null,
    paces: null,
  },
  {
    label: 'reprise, budget serré',
    recentWeeklyKm: 14,
    weeklyTimeMinutes: 240,
    easyPaceSecPerKm: 420,
    paces: null,
  },
  {
    label: 'confirmée, table d’allures',
    recentWeeklyKm: 42,
    weeklyTimeMinutes: 420,
    easyPaceSecPerKm: 330,
    // 45 min au 10 km : une table réaliste, qui arme le corridor d'allures.
    paces: trainingPacesFromRace(10_000, 45 * 60),
  },
  /*
   * Les très petits volumes, sans budget temps ni allure déclarés : le domaine
   * exact où la revue a trouvé les 12 596 semaines invalides. Une athlète à 3 km
   * par semaine qui demande 6 séances demande 500 m par séance — le squelette
   * doit refuser ({@link PlanSkeletonInfeasibleError}), jamais écrire une
   * semaine que la validation recalera.
   */
  {
    label: 'très faible volume, 3 km/semaine',
    recentWeeklyKm: 3,
    weeklyTimeMinutes: null,
    easyPaceSecPerKm: null,
    paces: null,
  },
  {
    label: 'très faible volume, 6 km/semaine',
    recentWeeklyKm: 6,
    weeklyTimeMinutes: null,
    easyPaceSecPerKm: null,
    paces: null,
  },
  {
    label: 'très faible volume, 10 km/semaine, table d’allures',
    recentWeeklyKm: 10,
    weeklyTimeMinutes: null,
    easyPaceSecPerKm: null,
    paces: trainingPacesFromRace(5_000, 30 * 60),
  },
];

/**
 * La table qui sert au régime « avec table » pour les athlètes qui n'en ont pas.
 *
 * Le balayage éprouve les **deux** post-traitements sur chaque combinaison, y
 * compris pour une athlète sans chrono : ce qui est jugé ici est la distance des
 * séances, et elle ne doit dépendre d'aucun des deux. La table est celle d'une
 * coureuse plus rapide que toutes les athlètes de la matrice, ce qui raccourcit
 * les durées imposées — un budget temps déclaré ne peut donc pas être dépassé
 * par la faute d'une table de test.
 */
const REFERENCE_PACES = trainingPacesFromRace(10_000, 45 * 60);

/** Objectif et course vont ensemble : c'est la distance visée qui décide de l'affûtage. */
type Goal = { label: string; goalDistanceKm: number | null; race: PlanRaceGoal | null };

const GOALS: Goal[] = [
  { label: 'libre', goalDistanceKm: null, race: null },
  { label: '5 km daté', goalDistanceKm: 5, race: { isMarathon: false } },
  { label: '10 km sans date', goalDistanceKm: 10, race: null },
  { label: '10 km daté', goalDistanceKm: 10, race: { isMarathon: false } },
  { label: 'semi daté', goalDistanceKm: 21.0975, race: { isMarathon: false } },
  { label: 'marathon sans date', goalDistanceKm: 42.195, race: null },
  { label: 'marathon daté', goalDistanceKm: 42.195, race: { isMarathon: true } },
];

const FREE_GOAL = GOALS[0];
const TEN_K_GOAL = GOALS[3];
const HALF_GOAL = GOALS[4];
const MARATHON_SANS_DATE_GOAL = GOALS[5];
const MARATHON_GOAL = GOALS[6];

/** Les quatre objectifs **datés** — le domaine de l'intention `race`. */
const DATED_GOALS = GOALS.filter((goal) => goal.race !== null);

/** Les trois niveaux du contrat — ce que les tests ciblés éprouvent un par un. */
const LEVELS: PlanLevel[] = ['beginner', 'intermediate', 'advanced'];

/**
 * Les niveaux **balayés**, et pourquoi il n'en faut que deux ici.
 *
 * Ce n'est pas un échantillonnage : c'est le constat que `buildPlanSkeleton` ne
 * voit que **deux** niveaux. Le sien n'atteint qu'un seul embranchement,
 * `qualitySlotCount` :
 *
 * ```ts
 * const wanted = level === 'beginner' ? 1 : 2;
 * ```
 *
 * `intermediate` et `advanced` y sont littéralement la même valeur — un créneau
 * de qualité de plus, et rien d'autre ne dépend du niveau dans tout le module
 * (le grep tient en une ligne : `qualitySlotCount`, appelé depuis `assertFundable`
 * et depuis la boucle d'écriture). Balayer les trois ferait tourner deux fois la
 * même branche.
 *
 * Le niveau n'agit ailleurs qu'**en amont**, sur les cibles que le squelette
 * reçoit toutes faites (`weeklyGrowth` 1,07/1,08/1,09 et `defaultStartKm`
 * 12/24/32 km, ce dernier n'ayant d'effet que sur l'athlète sans historique) —
 * deux scalaires dont `intermediate` occupe le milieu, entre deux valeurs
 * conservées. Et l'échelle des cibles, elle, est déjà échantillonnée par six
 * autres axes : 6 athlètes (de 3 km/semaine à 42), 12 durées, 7 objectifs.
 *
 * On garde donc les deux bouts : `beginner` pour la branche à un créneau et les
 * plus petits volumes (le domaine des échecs de la revue), `advanced` pour la
 * branche à deux créneaux et les plus gros (montée la plus rapide, départ le plus
 * haut — c'est là que les bornes hautes du contrat de sortie se font sentir).
 * `intermediate` reste éprouvé par cinq tests ciblés de ce fichier, dont celui
 * qui vérifie précisément le compte de créneaux niveau par niveau.
 */
const SWEPT_LEVELS: PlanLevel[] = ['beginner', 'advanced'];

/**
 * Les durées de plan balayées : 3 à 10 semaines sans en sauter une — c'est là que
 * les règles s'activent ou se désactivent une à une (semaine allégée, anti-plat,
 * troisième semaine d'affûtage) —, puis un échantillon jusqu'au maximum du
 * contrat.
 */
const WEEKS = [3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 52];

/**
 * De 2 à 7 séances : le minimum du contrat de plan, pas celui du formulaire.
 *
 * Deux séances par semaine sont la configuration la plus tendue pour la
 * décomposition des budgets (la sortie longue y prend jusqu'à 80 % du volume), et
 * sept la plus tendue pour le plancher de 0,5 km par séance. Les deux bouts sont
 * exactement là où la revue a trouvé ses échecs.
 */
const SESSIONS_PER_WEEK = [2, 3, 4, 5, 6, 7];

/**
 * Le jour de sortie longue et le jour de reprise, **appariés** au lieu d'être
 * croisés : 7 couples au lieu de 49, et c'est le seul rétrécissement de cette
 * matrice.
 *
 * ## Pourquoi ces deux-là s'apparient sans rien perdre
 *
 * Les 49 croisements ne portent pas 49 comportements. Ce que chacun des deux
 * réglages décide, séparément :
 *
 * - `firstWeekFromDay` n'agit **que sur la première semaine** (`buildPlanSkeleton`
 *   force `fromDay = 1` dès l'index 1) : il proratise sa cible, la marque
 *   `partial`, et plafonne ses séances à `8 − fromDay`. Les semaines 2 à N sont
 *   identiques quel que soit le jour de reprise.
 * - `longRunDay` ne décide que du **placement** des jours dans une semaine
 *   pleine, et ce placement se dérobe à toute translation près des bords : les
 *   écarts se comptent modulo 7 (`circularDayGap`), mais la fenêtre `[fromDay, 7]`
 *   n'est pas circulaire, elle.
 *
 * Le seul endroit où les deux se **rencontrent** est la première semaine, et il
 * n'y a que trois cas : le jour de sortie longue est passé (`longRunDay <
 * firstWeekFromDay` → séance abandonnée, budget reversé aux footings, et la
 * validation cesse d'exiger la sortie longue), il tombe pile sur le jour de
 * reprise, ou il est encore à venir. Croiser les 49 couples rejoue ces trois cas
 * sept fois chacun.
 *
 * ## Ce que les sept couples couvrent
 *
 * Chaque valeur de 1 à 7 apparaît **exactement une fois dans chaque colonne** —
 * aucun jour de sortie longue ni aucun jour de reprise n'est perdu — et les trois
 * relations sont représentées, dont les deux bords et l'égalité :
 *
 * | sortie longue | reprise | ce que le couple met à l'épreuve |
 * | --- | --- | --- |
 * | 7 | 1 | la configuration canonique : dimanche, semaine pleine |
 * | 1 | 2 | sortie longue le lundi, passée d'un seul jour — le bord bas |
 * | 4 | 3 | sortie longue en milieu de semaine, encore à venir |
 * | 5 | 4 | reprise le jeudi : 4 jours restants, juste au-dessus du plafond |
 * | 2 | 5 | 3 jours restants — la semaine entamée sous 4 jours, séances plafonnées |
 * | 6 | 6 | égalité `longRunDay === fromDay` : le bord exact de `free.includes` |
 * | 3 | 7 | un seul jour restant, sortie longue passée : la semaine à une séance |
 *
 * Les deux dernières lignes sont celles qui font travailler le refus
 * d'infaisabilité sur un compte de séances réduit (`minFundableWeeklyKm(2, …)`,
 * `(1, 0)`), et la ligne `2 | 5` est exactement la configuration du test ciblé
 * « sur une première semaine entamée ».
 *
 * **Ne pas rétrécir plus.** Six couples ne peuvent plus couvrir sept jours de
 * chaque côté : on perdrait un jour de sortie longue ou un jour de reprise, donc
 * un placement ou un plafond de séances, en silence.
 *
 * ## Le jour J s'apparie ici plutôt que de multiplier la matrice
 *
 * `raceDay` ne décide que d'une chose, et sur une seule semaine : quel jour de la
 * **semaine de course** porte le rôle `long` ({@link buildPlanSkeleton}). Deux
 * relations seulement comptent — le jour J tombe sur le jour de sortie longue de
 * l'athlète (cas le plus fréquent : une course le dimanche, des sorties longues
 * le dimanche) ou il tombe ailleurs, auquel cas le placement de toute la semaine
 * de course se réorganise autour de lui. Les deux sont représentées, quatre fois
 * l'une et trois fois l'autre, sans ajouter une seule combinaison.
 */
const DAY_SETTINGS: { longRunDay: number; firstWeekFromDay: number; raceDay: number }[] = [
  { longRunDay: 7, firstWeekFromDay: 1, raceDay: 7 },
  { longRunDay: 1, firstWeekFromDay: 2, raceDay: 6 },
  { longRunDay: 4, firstWeekFromDay: 3, raceDay: 7 },
  { longRunDay: 5, firstWeekFromDay: 4, raceDay: 5 },
  { longRunDay: 2, firstWeekFromDay: 5, raceDay: 3 },
  { longRunDay: 6, firstWeekFromDay: 6, raceDay: 6 },
  { longRunDay: 3, firstWeekFromDay: 7, raceDay: 1 },
];

type Combination = {
  /**
   * L'intention du plan — **déduite de l'objectif** quand elle n'est pas dite :
   * un objectif daté est une préparation de course, tout le reste une recherche
   * de vitesse. C'est exactement la correspondance que `plan-service` applique en
   * attendant que le formulaire pose la question, et elle garde à ce fichier les
   * cas qu'il éprouvait déjà.
   */
  intent?: PlanIntent;
  /** Antécédent de blessure — ne joue qu'en `return`. */
  returnInjuryHistory?: boolean;
  /** Le plafond de la première sortie longue, quand l'appelant en a un. */
  longRunCapKm?: number | null;
  weeks: number;
  sessionsPerWeek: number;
  longRunDay: number;
  firstWeekFromDay: number;
  /** Le jour J tel que le formulaire le donnerait — ignoré quand l'objectif n'est pas daté. */
  raceDay: number;
  level: PlanLevel;
  goal: Goal;
  athlete: Athlete;
};

/**
 * Le jour J **effectif** d'une combinaison : celui d'un objectif daté, `null`
 * sinon — un objectif libre ou une distance sans date n'a pas de semaine de
 * course, et le squelette comme la validation l'ignorent alors.
 */
function raceDayOf(combination: Combination): number | null {
  return combination.goal.race === null ? null : combination.raceDay;
}

/** L'intention d'une combinaison, dite ou déduite de son objectif. */
function intentOf(combination: Combination): PlanIntent {
  return combination.intent ?? (combination.goal.race === null ? 'faster' : 'race');
}

function describeCombination(combination: Combination): string {
  const raceDay = raceDayOf(combination);
  return (
    `intention ${intentOf(combination)}` +
    `${combination.returnInjuryHistory === true ? ' (antécédent)' : ''}` +
    `${combination.longRunCapKm == null ? '' : ` plafond SL ${combination.longRunCapKm} km`}, ` +
    `${combination.weeks} semaines, ${combination.sessionsPerWeek} séances, ` +
    `sortie longue jour ${combination.longRunDay}, départ jour ${combination.firstWeekFromDay}, ` +
    `${raceDay === null ? 'sans jour J' : `jour J ${raceDay}`}, ` +
    `${combination.level}, objectif ${combination.goal.label}, athlète ${combination.athlete.label}`
  );
}

/** Les cibles de l'appli — celles que le prompt annonce et que la validation vérifie. */
function targetsFor(combination: Combination): WeeklyVolumeTarget[] {
  return weeklyVolumeTargets({
    weeks: combination.weeks,
    firstWeekFromDay: combination.firstWeekFromDay,
    recentWeeklyKm: combination.athlete.recentWeeklyKm,
    weeklyTimeMinutes: combination.athlete.weeklyTimeMinutes,
    easyPaceSecPerKm: combination.athlete.easyPaceSecPerKm,
    race: combination.goal.race,
    level: combination.level,
  });
}

function skeletonFor(combination: Combination, targets: readonly WeeklyVolumeTarget[]) {
  return buildPlanSkeleton({
    intent: intentOf(combination),
    returnInjuryHistory: combination.returnInjuryHistory,
    longRunCapKm: combination.longRunCapKm,
    weeks: combination.weeks,
    firstWeekFromDay: combination.firstWeekFromDay,
    sessionsPerWeek: combination.sessionsPerWeek,
    longRunDay: combination.longRunDay,
    level: combination.level,
    race: combination.goal.race,
    raceDay: raceDayOf(combination),
    goalDistanceKm: combination.goal.goalDistanceKm,
    targets,
  });
}

/**
 * La FC max sur laquelle le troisième régime est balayé — celle de l'athlète du
 * projet. Sa valeur exacte n'a aucune importance pour la propriété (seules les
 * distances et les durées sont jugées) ; ce qui compte est qu'elle soit
 * exploitable, donc que la prescription en fréquence cardiaque s'active.
 */
const PROPERTY_MAX_HR_BPM = 184;

/**
 * Les post-traitements du pipeline, appliqués au squelette rempli — et la
 * validation qui va avec chacun.
 *
 * Les deux régimes tournent sur **chaque** combinaison, table ou pas : ce qui
 * est jugé ici est la distance des séances, et elle ne doit dépendre ni de la
 * table ni du post-traitement. Le contexte de validation suit le régime, sans
 * quoi le corridor d'allures jugerait des allures posées depuis une table qu'il
 * ne connaît pas.
 */
function postProcessed(
  weeks: readonly PlanWeekOutput[],
  athlete: Athlete,
): { label: string; weeks: PlanWeekOutput[]; context: PlanValidationContext }[] {
  return [
    {
      label: 'sans table (applyDerivedMeasures)',
      weeks: applyDerivedMeasures(weeks, athlete.easyPaceSecPerKm),
      context: {
        paces: null,
        weeklyTimeMinutes: athlete.weeklyTimeMinutes,
        recentWeeklyKm: athlete.recentWeeklyKm,
        referencePaceSecPerKm: athlete.easyPaceSecPerKm,
      },
    },
    {
      label: 'avec table (applyImposedPaces)',
      weeks: applyImposedPaces(weeks, athlete.paces ?? REFERENCE_PACES, null),
      context: {
        paces: athlete.paces ?? REFERENCE_PACES,
        weeklyTimeMinutes: athlete.weeklyTimeMinutes,
        recentWeeklyKm: athlete.recentWeeklyKm,
      },
    },
    /*
     * Le même régime, **FC max renseignée** : le corps des séances faciles
     * passe alors de la plage d'allure à la zone cardiaque, et les footings
     * jusque-là dépourvus de déroulé en reçoivent un.
     *
     * Il est balayé à part et sur toutes les combinaisons parce que c'est
     * exactement ce que la propriété doit démontrer : changer l'unité de la
     * **cible** ne déplace ni un mètre ni une minute. Les volumes hebdomadaires,
     * les budgets temps et les parts de sortie longue restent dans leurs cibles,
     * et le corridor d'allures — qui ne juge que des allures — n'a rien à
     * redire d'une étape qui n'en porte plus.
     */
    {
      label: 'avec table et FC max (endurance prescrite en FC)',
      weeks: applyImposedPaces(weeks, athlete.paces ?? REFERENCE_PACES, null, PROPERTY_MAX_HR_BPM),
      context: {
        paces: athlete.paces ?? REFERENCE_PACES,
        weeklyTimeMinutes: athlete.weeklyTimeMinutes,
        recentWeeklyKm: athlete.recentWeeklyKm,
        maxHrBpm: PROPERTY_MAX_HR_BPM,
      },
    },
  ];
}

/**
 * Ce que chaque **intention** balaie, et ce qu'elle n'a pas besoin de balayer.
 *
 * Les quatre autres axes (durées, séances, jours, athlètes) restent exhaustifs
 * pour toutes : ils portent chacun une branche du code, pas un échantillon d'un
 * continuum. Ce qui se resserre est ce que l'intention rend **inerte** — et
 * chaque resserrement porte sa démonstration, comme les deux d'origine.
 *
 * - **`race` — les quatre objectifs datés, les deux niveaux.** C'est la seule
 *   intention dont la grille dépend de la distance visée (une famille par
 *   colonne : 5 km, 10 km, semi, marathon) et dont le niveau change le nombre de
 *   créneaux. Rien à retirer.
 * - **`faster` — deux objectifs, les deux niveaux.** Sa grille ne regarde plus la
 *   distance (`qualityZones` l'ignore hors `race`) : elle ne sert plus qu'à
 *   `wantsSpecificLongRun`, dont les deux issues sont représentées — objectif
 *   libre (aucune distance, pas de bloc spécifique) et marathon sans date (le
 *   bloc s'écrit). Le niveau, lui, décide toujours du nombre de créneaux.
 * - **`weight_loss` — un objectif, un niveau.** Un seul créneau quel que soit le
 *   niveau, aucune phase spécifique, aucune distance lue : les trois axes
 *   retirés ne changent pas une ligne du squelette. Le plafond de sortie longue y
 *   est éprouvé sur son second variant.
 * - **`return` — un objectif, un niveau, deux variants.** Aucun créneau, aucune
 *   spécificité, aucune distance lue ; ce qui reste à éprouver est ce qui lui est
 *   propre, et c'est ce que les variants portent : la marche/course avec et sans
 *   antécédent, et le plafond de sortie longue.
 */
const SWEPT_INTENTS: {
  intent: PlanIntent;
  goals: Goal[];
  levels: PlanLevel[];
  /** Ce qui, en plus, distingue deux plans de même intention. */
  variants: Pick<Combination, 'returnInjuryHistory' | 'longRunCapKm'>[];
}[] = [
  { intent: 'race', goals: DATED_GOALS, levels: SWEPT_LEVELS, variants: [{}] },
  {
    intent: 'faster',
    goals: [FREE_GOAL, MARATHON_SANS_DATE_GOAL],
    levels: SWEPT_LEVELS,
    variants: [{}],
  },
  {
    intent: 'weight_loss',
    goals: [FREE_GOAL],
    levels: ['beginner'],
    // Le plafond hors reprise : il doit rester inoffensif partout où il ne
    // s'applique pas, et céder proprement là où il ne peut pas s'appliquer.
    variants: [{}, { longRunCapKm: 5 }],
  },
  {
    intent: 'return',
    goals: [FREE_GOAL],
    levels: ['beginner'],
    variants: [{}, { returnInjuryHistory: true, longRunCapKm: 5 }],
  },
];

/** Toutes les combinaisons de la matrice, dans un ordre fixe. */
function allCombinations(): Combination[] {
  const combinations: Combination[] = [];
  for (const weeks of WEEKS) {
    for (const sessionsPerWeek of SESSIONS_PER_WEEK) {
      for (const { longRunDay, firstWeekFromDay, raceDay } of DAY_SETTINGS) {
        for (const { intent, goals, levels, variants } of SWEPT_INTENTS) {
          for (const level of levels) {
            for (const goal of goals) {
              for (const variant of variants) {
                for (const athlete of ATHLETES) {
                  combinations.push({
                    intent,
                    ...variant,
                    weeks,
                    sessionsPerWeek,
                    longRunDay,
                    firstWeekFromDay,
                    raceDay,
                    level,
                    goal,
                    athlete,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return combinations;
}

/** Les dix premiers manquements suffisent : au-delà, c'est la même faute répétée. */
const MAX_REPORTED_FAILURES = 10;

/**
 * Ce que les bornes du contrat de sortie exigent de chaque séance écrite.
 *
 * `validatePlanBusinessRules` ne les vérifie pas — c'est le rôle de Zod, en amont
 * —, mais une séance de 0,3 km ou de 120 km serait refusée avant même d'arriver
 * au juge. Vérifié dans le même balayage plutôt que dans un second : la matrice
 * est assez grosse pour qu'on ne la parcoure qu'une fois.
 */
function boundsFailures(skeleton: readonly SkeletonWeek[], where: string): string[] {
  const failures: string[] = [];

  for (const week of skeleton) {
    const label = `${where}, semaine ${week.weekNumber}`;
    for (const session of week.sessions) {
      const distanceKm = session.distanceKm ?? 0;
      if (distanceKm < PLAN_OUTPUT_BOUNDS.distanceKm.min) {
        failures.push(`${label} : ${distanceKm} km, sous la borne basse.`);
      }
      if (distanceKm > PLAN_OUTPUT_BOUNDS.distanceKm.max) {
        failures.push(`${label} : ${distanceKm} km, au-dessus de la borne haute.`);
      }
      if (session.kind.length > PLAN_OUTPUT_BOUNDS.kindChars) {
        failures.push(`${label} : \`kind\` trop long.`);
      }
      if (session.title.length === 0 || session.title.length > PLAN_OUTPUT_BOUNDS.titleChars) {
        failures.push(`${label} : titre hors bornes.`);
      }
    }
    for (const slot of week.qualitySlots) {
      if (slot.budgetKm < PLAN_OUTPUT_BOUNDS.distanceKm.min) {
        failures.push(`${label} : créneau de ${slot.budgetKm} km, sous la borne basse.`);
      }
    }
  }

  return failures;
}

describe('buildPlanSkeleton', () => {
  /*
   * LE test. Tout le reste de ce fichier documente des cas particuliers ; celui-ci
   * est le contrat, et il n'a que deux issues admissibles par combinaison :
   *
   * - **zéro manquement** une fois la semaine remplie et post-traitée, dans les
   *   deux régimes ;
   * - **un refus typé** ({@link PlanSkeletonInfeasibleError}) quand la cible ne
   *   finance pas les séances demandées.
   *
   * Jamais une semaine invalide rendue en silence, jamais un `TypeError`. La
   * matrice couvre exprès le domaine où la revue a trouvé ses échecs : très
   * petits volumes, sans budget temps ni historique, de 2 à 7 séances.
   */
  it('produit des semaines que les règles du plan acceptent, ou refuse le plan', () => {
    const failures: string[] = [];
    let refused = 0;

    for (const combination of allCombinations()) {
      const targets = targetsFor(combination);
      const where = describeCombination(combination);

      let skeleton;
      try {
        skeleton = skeletonFor(combination, targets);
      } catch (error) {
        if (!(error instanceof PlanSkeletonInfeasibleError)) {
          failures.push(`${where} → exception inattendue : ${String(error)}`);
          break;
        }
        // Un refus doit rester actionnable : les semaines fautives et un repli
        // qui n'est pas le réglage refusé.
        refused += 1;
        if (error.weeks.length === 0) failures.push(`${where} → refus sans semaine fautive.`);
        if (error.fundableSessionsPerWeek >= combination.sessionsPerWeek) {
          failures.push(`${where} → refus dont le repli vaut le réglage refusé.`);
        }
        continue;
      }

      const filled = fillSkeleton(skeleton);
      const expectations: PlanExpectations = {
        scope: 'creation',
        weeks: combination.weeks,
        sessionsPerWeek: combination.sessionsPerWeek,
        longRunDay: combination.longRunDay,
        firstWeekFromDay: combination.firstWeekFromDay,
        race: combination.goal.race,
        // La semaine de course se juge sur son jour J, pas sur le jour de sortie
        // longue de l'athlète — exactement ce que `writeGeneratedPlan` passe.
        raceDay: raceDayOf(combination),
        weeklyTargets: targets,
      };

      for (const pass of postProcessed(filled, combination.athlete)) {
        const violations = validatePlanBusinessRules(pass.weeks, expectations, pass.context);
        if (violations.length > 0) failures.push(`${where}, ${pass.label} → ${violations[0]}`);
      }
      failures.push(...boundsFailures(skeleton, where));

      if (failures.length >= MAX_REPORTED_FAILURES) break;
    }

    expect(failures).toEqual([]);
    // Le refus existe vraiment dans la matrice : sans cela, ce test ne
    // prouverait plus rien du chemin d'infaisabilité.
    expect(refused).toBeGreaterThan(0);
  }, 300_000);

  it('est déterministe : mêmes paramètres, même squelette', () => {
    const combination: Combination = {
      weeks: 16,
      sessionsPerWeek: 5,
      longRunDay: 7,
      firstWeekFromDay: 1,
      raceDay: 7,
      level: 'intermediate',
      goal: MARATHON_GOAL,
      athlete: ATHLETES[2],
    };
    const targets = targetsFor(combination);
    expect(skeletonFor(combination, targets)).toEqual(skeletonFor(combination, targets));
  });

  describe('ce que chaque semaine porte', () => {
    // Jour J le dimanche, sorties longues le samedi : les deux jours diffèrent,
    // donc la semaine de course se distingue de toutes les autres.
    const combination: Combination = {
      weeks: 16,
      sessionsPerWeek: 5,
      longRunDay: 6,
      firstWeekFromDay: 1,
      raceDay: 7,
      level: 'intermediate',
      goal: MARATHON_GOAL,
      athlete: ATHLETES[2],
    };
    const targets = targetsFor(combination);
    const skeleton = skeletonFor(combination, targets);

    it('numérote les semaines dans la numérotation du plan entier', () => {
      expect(skeleton.map((week) => week.weekNumber)).toEqual(
        Array.from({ length: 16 }, (_, index) => index + 1),
      );
    });

    it('reprend les cibles telles quelles, sans les recalculer', () => {
      skeleton.forEach((week, index) => {
        expect(week.target).toBe(targets[index]);
      });
    });

    it('retombe sur la cible hebdomadaire au dixième près', () => {
      for (const week of skeleton) {
        const total = [
          ...week.sessions.map((session) => session.distanceKm ?? 0),
          ...week.qualitySlots.map((slot) => slot.budgetKm),
        ].reduce((sum, km) => sum + km, 0);
        expect(total, `semaine ${week.weekNumber}`).toBeCloseTo(week.target.targetKm, 1);
      }
    });

    it('pose la sortie longue le jour réglé, et c’est la plus longue séance', () => {
      // La semaine de course n'a pas de sortie longue : elle est jugée à part
      // (cf. « la semaine de course »).
      for (const week of skeleton.filter((candidate) => candidate.phase !== 'race')) {
        const longRun = week.sessions.find((session) => session.day === 6);
        expect(longRun?.kind, `semaine ${week.weekNumber}`).toBe('Sortie longue');
        const others = [
          ...week.sessions.filter((session) => session.day !== 6).map((s) => s.distanceKm ?? 0),
          ...week.qualitySlots.map((slot) => slot.budgetKm),
        ];
        for (const km of others) {
          expect(longRun?.distanceKm ?? 0, `semaine ${week.weekNumber}`).toBeGreaterThanOrEqual(km);
        }
      }
    });

    it('n’écrit ni allure ni durée : le post-traitement s’en charge', () => {
      for (const week of skeleton) {
        for (const session of week.sessions) {
          expect(session.targetPaceSecPerKm).toBeUndefined();
          expect(session.durationMin).toBeUndefined();
          for (const step of flattenSteps(session.steps ?? [])) {
            expect(step.paceMinSecPerKm).toBeNull();
            expect(step.paceMaxSecPerKm).toBeNull();
            expect(step.hrZone).toBeNull();
          }
        }
      }
    });

    it('n’écrit aucune sortie longue la semaine de la course', () => {
      const raceWeek = skeleton[15];
      expect(raceWeek.phase).toBe('race');
      expect(raceWeek.sessions.map((session) => session.kind)).not.toContain('Sortie longue');
    });

    /*
     * Ce que le déroulé d'une séance écrite peut être, depuis que les séances
     * faciles varient (cf. `variations.ts`) : une sortie longue découpée, ou
     * **un** footing enrichi par semaine — jamais deux, et jamais une course.
     */
    it('ne laisse porter un déroulé qu’à la sortie longue et à un seul footing par semaine', () => {
      for (const week of skeleton) {
        const withSteps = week.sessions.filter((session) => session.steps !== undefined);
        const easyWithSteps = withSteps.filter((session) => session.kind !== 'Sortie longue');
        expect(easyWithSteps.length, `semaine ${week.weekNumber}`).toBeLessThanOrEqual(1);
        for (const session of easyWithSteps) {
          expect(session.kind, `semaine ${week.weekNumber}`).toBe('Endurance fondamentale');
        }
      }
    });

    it('découpe la sortie longue spécifique en mise en route, allure objectif, retour au calme', () => {
      const specific = skeleton.find(
        (week) =>
          week.phase === 'specific' &&
          week.sessions.some((s) => s.kind === 'Sortie longue' && s.steps !== undefined),
      );
      const longRun = specific?.sessions.find(
        (session) => session.kind === 'Sortie longue' && session.steps !== undefined,
      );
      const steps = flattenSteps(longRun?.steps ?? []);

      expect(steps.map((step) => step.role)).toEqual(['warmup', 'run', 'cooldown']);
      // Le déroulé couvre toute la séance : rien à arbitrer en aval entre la
      // distance déclarée et celle des étapes.
      const covered = steps.reduce((sum, step) => sum + (step.distanceM ?? 0), 0);
      expect(covered).toBe(Math.round((longRun?.distanceKm ?? 0) * 1_000));
      // Le bloc central vaut environ un tiers, et sa note est ce qui lui vaudra
      // l'allure de l'objectif en aval.
      expect((steps[1].distanceM ?? 0) / covered).toBeCloseTo(1 / 3, 2);
      expect(steps[1].note).toContain('allure objectif');
    });

    /*
     * Répéter l'allure de course sur la fatigue est le travail de la
     * **spécificité** : en base et en développement, la sortie longue reste du
     * temps passé en endurance (au plus une fin de parcours appuyée). Sans ce
     * cas, élargir `wantsSpecificLongRun` au développement passerait inaperçu.
     */
    it('réserve le bloc à allure objectif à la phase spécifique', () => {
      const weeks = skeleton.filter((week) =>
        week.sessions.some((session) => session.title === 'Sortie longue avec bloc à allure objectif'),
      );
      // Et il existe vraiment sur cette préparation marathon : sans cela, la
      // règle ci-dessous ne prouverait rien.
      expect(weeks.length).toBeGreaterThan(0);

      for (const week of weeks) {
        expect(week.phase, `semaine ${week.weekNumber}`).toBe('specific');
      }
    });

    it('ne programme pas de qualité la semaine de la course', () => {
      const raceWeek = skeleton[15];
      expect(raceWeek.phase).toBe('race');
      expect(raceWeek.qualitySlots).toEqual([]);
      // Et les footings y sont des récupérations, qui ne reçoivent aucune cible.
      for (const session of raceWeek.sessions) {
        expect(['Récupération', 'Course']).toContain(session.kind);
      }
    });
  });

  /*
   * Le jour J.
   *
   * Ce que ces cas protègent est un défaut vu en production : le squelette
   * écrivait « Sortie longue » sur le jour de sortie longue de l'athlète, y
   * compris quand ce jour-là était celui de sa course — l'athlète lisait
   * « 8,5 km à 5:54/km » sur la case de son marathon.
   */
  describe('la semaine de course', () => {
    /** Le squelette d'une préparation marathon, jour J au jour ISO donné. */
    function raceSkeleton(longRunDay: number, raceDay: number): SkeletonWeek[] {
      const combination: Combination = {
        weeks: 12,
        sessionsPerWeek: 5,
        longRunDay,
        firstWeekFromDay: 1,
        raceDay,
        level: 'intermediate',
        goal: MARATHON_GOAL,
        athlete: ATHLETES[2],
      };
      return skeletonFor(combination, targetsFor(combination));
    }

    it('écrit la course le jour J, et rien d’autre ce jour-là', () => {
      const raceWeek = raceSkeleton(7, 6)[11];

      const raceSession = raceWeek.sessions.filter((session) => session.day === 6);
      expect(raceSession).toHaveLength(1);
      expect(raceSession[0].kind).toBe('Course');
      expect(raceSession[0].title).toBe('Jour J : la course');
      // Aucun déroulé : une course ne se découpe pas en échauffement et blocs.
      expect(raceSession[0].steps).toBeUndefined();
    });

    it('remplace la sortie longue au lieu de s’y ajouter', () => {
      const raceWeek = raceSkeleton(7, 6)[11];

      expect(raceWeek.sessions.map((session) => session.kind)).not.toContain('Sortie longue');
      // Le jour de sortie longue de l'athlète ne porte plus rien de long : ce qui
      // s'y trouve, s'il s'y trouve quelque chose, est un footing de récupération.
      const onLongRunDay = raceWeek.sessions.find((session) => session.day === 7);
      expect(onLongRunDay?.kind ?? 'Récupération').toBe('Récupération');
    });

    it('donne à la course le budget de la sortie longue, jamais la distance réelle', () => {
      const raceWeek = raceSkeleton(7, 7)[11];
      const race = raceWeek.sessions.find((session) => session.day === 7);

      expect(race?.kind).toBe('Course');
      // Le plus gros budget de la semaine, et de très loin sous les 42,195 km
      // d'un marathon : un plan porte des volumes d'entraînement.
      for (const session of raceWeek.sessions) {
        expect(race?.distanceKm ?? 0).toBeGreaterThanOrEqual(session.distanceKm ?? 0);
      }
      expect(race?.distanceKm ?? 0).toBeLessThan(42.195);
    });

    it('classe la séance du jour J en zone objectif, pas en endurance', () => {
      const raceWeek = raceSkeleton(7, 6)[11];
      const race = raceWeek.sessions.find((session) => session.day === 6);

      expect(sessionPaceZone(race?.kind ?? '')).toBe('marathon');
    });

    it('laisse les autres semaines à leur sortie longue habituelle', () => {
      const skeleton = raceSkeleton(7, 6);

      for (const week of skeleton.slice(0, 11)) {
        const longRun = week.sessions.find((session) => session.day === 7);
        expect(longRun?.kind, `semaine ${week.weekNumber}`).toBe('Sortie longue');
      }
    });

    /*
     * Le jour J est une **borne**, pas seulement un jour de plus.
     *
     * Mesuré avant correction, marathon un lundi et 6 séances : la semaine de
     * course portait **5 séances et 23,3 km après la course**, dont une le
     * lendemain du marathon. `placeSessionDays` étalait les footings sur les
     * sept jours sans savoir que la semaine s'arrêtait au jour J.
     */
    it('ne programme aucune séance après le jour J', () => {
      for (const raceDay of [1, 3, 5]) {
        const raceWeek = raceSkeleton(7, raceDay)[11];
        for (const session of raceWeek.sessions) {
          expect(session.day, `jour J ${raceDay}`).toBeLessThanOrEqual(raceDay);
        }
        // La course est bien là : la borne n'a pas emporté le jour J lui-même.
        expect(
          raceWeek.sessions.some((session) => session.day === raceDay && session.kind === 'Course'),
          `jour J ${raceDay}`,
        ).toBe(true);
      }
    });

    /*
     * Retirer des séances ne retire pas leurs kilomètres : la cible de la semaine
     * de course reste celle que `weeklyVolumeTargets` a chiffrée, et un budget
     * abandonné la ferait passer sous sa barre — donc hors de sa bande de ±10 %.
     */
    it('réabsorbe le budget des séances supprimées : la semaine tient sa cible', () => {
      for (const raceDay of [1, 3, 5]) {
        const raceWeek = raceSkeleton(7, raceDay)[11];
        const total = raceWeek.sessions.reduce((sum, s) => sum + (s.distanceKm ?? 0), 0);
        expect(total, `jour J ${raceDay}`).toBeCloseTo(raceWeek.target.targetKm, 1);
      }
    });

    it('ne change rien sans jour J : un objectif libre garde sa sortie longue', () => {
      const combination: Combination = {
        weeks: 12,
        sessionsPerWeek: 5,
        longRunDay: 7,
        firstWeekFromDay: 1,
        raceDay: 7,
        level: 'intermediate',
        goal: GOALS[0],
        athlete: ATHLETES[2],
      };
      const skeleton = skeletonFor(combination, targetsFor(combination));

      for (const week of skeleton) {
        const longRun = week.sessions.find((session) => session.day === 7);
        expect(longRun?.kind, `semaine ${week.weekNumber}`).toBe('Sortie longue');
      }
    });
  });

  describe('sur une première semaine entamée', () => {
    const combination: Combination = {
      weeks: 10,
      sessionsPerWeek: 5,
      longRunDay: 2,
      firstWeekFromDay: 5,
      raceDay: 7,
      level: 'intermediate',
      goal: HALF_GOAL,
      athlete: ATHLETES[2],
    };
    const skeleton = skeletonFor(combination, targetsFor(combination));

    it('ne place aucune séance sur les jours déjà passés', () => {
      for (const session of skeleton[0].sessions) {
        expect(session.day).toBeGreaterThanOrEqual(5);
      }
    });

    it('n’y programme aucune qualité : on ignore ce qui a déjà été couru', () => {
      expect(skeleton[0].phase).toBe('partial');
      expect(skeleton[0].qualitySlots).toEqual([]);
    });

    it('renonce à la sortie longue dont le jour est passé, sans perdre son budget', () => {
      expect(skeleton[0].sessions.some((session) => session.kind === 'Sortie longue')).toBe(false);
      const total = skeleton[0].sessions.reduce((sum, s) => sum + (s.distanceKm ?? 0), 0);
      expect(total).toBeCloseTo(skeleton[0].target.targetKm, 1);
    });

    it('revient à une semaine pleine dès la deuxième', () => {
      expect(skeleton[1].sessions.length + skeleton[1].qualitySlots.length).toBe(5);
      expect(skeleton[1].sessions.some((session) => session.day === 2)).toBe(true);
    });
  });

  it('ne donne qu’un créneau de qualité par semaine à une débutante', () => {
    for (const level of LEVELS) {
      const combination: Combination = {
        weeks: 12,
        sessionsPerWeek: 6,
        longRunDay: 7,
        firstWeekFromDay: 1,
        raceDay: 7,
        level,
        goal: TEN_K_GOAL,
        athlete: ATHLETES[2],
      };
      const skeleton = skeletonFor(combination, targetsFor(combination));
      const buildWeek = skeleton.find((week) => week.phase === 'build');
      expect(buildWeek?.qualitySlots, level).toHaveLength(level === 'beginner' ? 1 : 2);
    }
  });

  it('ne double pas la séance dure de la semaine de base ni de l’affûtage', () => {
    const combination: Combination = {
      weeks: 16,
      sessionsPerWeek: 6,
      longRunDay: 7,
      firstWeekFromDay: 1,
      raceDay: 7,
      level: 'advanced',
      goal: MARATHON_GOAL,
      athlete: ATHLETES[2],
    };
    const skeleton = skeletonFor(combination, targetsFor(combination));

    for (const week of skeleton) {
      if (week.phase === 'base' || week.phase === 'taper') {
        expect(week.qualitySlots, `semaine ${week.weekNumber}`).toHaveLength(1);
      }
    }
  });

  /*
   * L'affûtage **raccourcit** les séances, il n'en supprime aucune.
   *
   * C'est le point le mieux établi du dossier : la méta-analyse de Bosquet (2007,
   * 27 études) associe le gain de performance à une baisse de **volume** de 41 à
   * 60 %, à **fréquence maintenue** — réduire le nombre de séances est le seul
   * geste d'affûtage que les données contredisent franchement. Le squelette le
   * satisfait par construction (l'affûtage n'agit que sur les cibles
   * hebdomadaires), et ce test le gèle.
   */
  it('garde toutes ses séances pendant l’affûtage : il raccourcit, il ne supprime pas', () => {
    for (const sessionsPerWeek of [3, 4, 5, 6]) {
      const combination: Combination = {
        weeks: 16,
        sessionsPerWeek,
        longRunDay: 7,
        firstWeekFromDay: 1,
        raceDay: 7,
        level: 'intermediate',
        goal: MARATHON_GOAL,
        athlete: ATHLETES[2],
      };
      const skeleton = skeletonFor(combination, targetsFor(combination));
      const tapers = skeleton.filter((week) => week.phase === 'taper');
      expect(tapers.length, `${sessionsPerWeek} séances`).toBeGreaterThan(0);

      for (const week of tapers) {
        expect(
          week.sessions.length + week.qualitySlots.length,
          `${sessionsPerWeek} séances, semaine ${week.weekNumber}`,
        ).toBe(sessionsPerWeek);
        // Et une séance de qualité y survit : ce qu'on retire est du volume, pas
        // de l'intensité.
        expect(week.qualitySlots.length, `semaine ${week.weekNumber}`).toBeGreaterThan(0);
      }

      // Ce qui baisse, c'est le kilométrage — strictement, chaque semaine.
      const volumes = skeleton.map(
        (week) =>
          week.sessions.reduce((sum, session) => sum + (session.distanceKm ?? 0), 0) +
          week.qualitySlots.reduce((sum, slot) => sum + slot.budgetKm, 0),
      );
      for (const week of tapers) {
        const index = week.weekNumber - 1;
        expect(volumes[index], `semaine ${week.weekNumber}`).toBeLessThan(volumes[index - 1]);
      }
    }
  });

  it('ne rend rien pour un plan sans semaine', () => {
    expect(
      buildPlanSkeleton({
        intent: 'race',
        weeks: 0,
        firstWeekFromDay: 1,
        sessionsPerWeek: 4,
        longRunDay: 7,
        level: 'intermediate',
        race: null,
        raceDay: null,
        goalDistanceKm: null,
        targets: [],
      }),
    ).toEqual([]);
  });

  /*
   * Le piège que le remplissage à venir doit éviter, énoncé plutôt que subi.
   *
   * Ce n'est pas un défaut du squelette : ses budgets sont justes, et sa sortie
   * longue spécifique — dont il écrit lui-même le déroulé, en distance — traverse
   * `applyImposedPaces` sans dériver d'un mètre. C'est le contrat de
   * {@link QualitySlot} : un créneau rempli en durée voit sa distance réécrite
   * par la couverture de son déroulé, et la semaine sort de sa cible.
   */
  describe('le déroulé qui remplit un créneau se mesure en distance', () => {
    /*
     * Une athlète de reprise : ses créneaux valent 2 à 3 km, quand le déroulé en
     * durée d'une séance de qualité ordinaire (15 min + 4 × (3 + 2 min) + 10 min)
     * en couvre près de 9 à l'allure seuil. C'est là que l'écart se voit ; sur
     * une athlète à 60 km par semaine, le déroulé en durée tombe par hasard près
     * du budget et ne dit rien.
     */
    const combination: Combination = {
      weeks: 12,
      sessionsPerWeek: 4,
      longRunDay: 7,
      firstWeekFromDay: 1,
      raceDay: 7,
      level: 'intermediate',
      goal: TEN_K_GOAL,
      athlete: ATHLETES[1],
    };
    const targets = targetsFor(combination);
    const skeleton = skeletonFor(combination, targets);
    const paces = combination.athlete.paces ?? REFERENCE_PACES;

    /** Le volume d'une semaine, tel que la validation le comptera. */
    const volumes = (weeks: readonly PlanWeekOutput[]): number[] =>
      weeks.map((week) =>
        week.sessions.reduce((total, session) => total + (session.distanceKm ?? 0), 0),
      );

    it('en distance : le post-traitement ne touche à aucune distance', () => {
      const filled = fillSkeleton(skeleton);
      const imposed = applyImposedPaces(filled, paces, null);
      const derived = applyDerivedMeasures(filled, combination.athlete.easyPaceSecPerKm);

      volumes(imposed).forEach((volume, index) => {
        expect(volume, `semaine ${index + 1}`).toBeCloseTo(targets[index].targetKm, 1);
      });
      expect(volumes(derived)).toEqual(volumes(imposed));
    });

    it('en durée : la couverture du déroulé l’emporte et fait gonfler la semaine', () => {
      const filled = fillSkeleton(skeleton, fillQualitySlotWithDurations);
      const imposed = applyImposedPaces(filled, paces, null);

      // Avant post-traitement, la semaine tombe pourtant juste : c'est bien le
      // post-traitement qui révèle la faute, d'où l'inutilité d'un test qui
      // validerait la sortie nue du squelette.
      volumes(filled).forEach((volume, index) => {
        expect(volume, `semaine ${index + 1}`).toBeCloseTo(targets[index].targetKm, 1);
      });

      const drifted = volumes(imposed).filter(
        (volume, index) => volume > targets[index].targetKm * 1.1,
      );
      expect(drifted.length).toBeGreaterThan(0);
    });

    it('la sortie longue spécifique, elle, traverse le post-traitement sans bouger', () => {
      // Un plan marathon : c'est lui qui porte des sorties longues à déroulé, et
      // ce déroulé-là est écrit en distance par le squelette lui-même.
      const marathon: Combination = { ...combination, goal: MARATHON_GOAL, athlete: ATHLETES[2] };
      const specific = skeletonFor(marathon, targetsFor(marathon));
      const imposed = applyImposedPaces(fillSkeleton(specific), REFERENCE_PACES, null);

      let checked = 0;
      for (const [index, week] of specific.entries()) {
        for (const session of week.sessions) {
          if (session.steps === undefined) continue;
          checked += 1;
          const after = imposed[index].sessions.find((other) => other.day === session.day);
          expect(after?.distanceKm, `semaine ${week.weekNumber}`).toBe(session.distanceKm);
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  });

  /*
   * La variété **à l'intérieur** des séances faciles.
   *
   * Le constat de l'utilisatrice sur son premier plan : « pas trop de variété,
   * beaucoup de séances d'endurance ». La proportion d'endurance, elle, est
   * juste — ce qui manquait était la variété dans ces séances-là : deux footings
   * par semaine écrits à l'identique (« Footing en endurance » 6,7 km lundi,
   * « Footing en endurance » 6,7 km jeudi), seize semaines durant.
   *
   * Ce bloc rejoue son cas exact et éprouve chaque variation sur les trois
   * choses qui pourraient casser en aval : la couverture du déroulé, la
   * traversée des deux post-traitements, et le classement de la séance (une
   * séance facile enrichie reste facile).
   */
  describe('la variété des séances faciles', () => {
    /**
     * L'athlète du constat : 16 semaines, 4 séances, objectif libre, 4 h par
     * semaine — et une table d'allures, pour que `applyImposedPaces` ait de quoi
     * écrire.
     */
    const GWEN: Athlete = {
      label: 'l’utilisatrice du constat',
      recentWeeklyKm: 22,
      weeklyTimeMinutes: 240,
      easyPaceSecPerKm: 420,
      paces: trainingPacesFromRace(10_000, 55 * 60),
    };

    const combination: Combination = {
      weeks: 16,
      sessionsPerWeek: 4,
      longRunDay: 7,
      firstWeekFromDay: 1,
      raceDay: 7,
      level: 'beginner',
      goal: GOALS[0],
      athlete: GWEN,
    };
    const targets = targetsFor(combination);
    const skeleton = skeletonFor(combination, targets);

    /** Les séances faciles d'une semaine, sortie longue et créneaux exclus. */
    const easySessions = (week: SkeletonWeek): PlanSessionOutput[] =>
      week.sessions.filter((session) => session.kind !== 'Sortie longue' && session.kind !== 'Course');

    /** Ce qui distingue deux séances sur la timeline : son titre, sa distance, son déroulé. */
    const signature = (session: PlanSessionOutput): string =>
      `${session.title}|${session.distanceKm}|${JSON.stringify(session.steps ?? null)}`;

    it('ne laisse plus deux footings jumeaux dans une même semaine', () => {
      for (const week of skeleton) {
        const signatures = easySessions(week).map(signature);
        expect(signatures.length, `semaine ${week.weekNumber}`).toBe(2);
        expect(new Set(signatures).size, `semaine ${week.weekNumber}`).toBe(signatures.length);
      }
    });

    it('n’enrichit qu’un footing par semaine, jamais les deux', () => {
      for (const week of skeleton) {
        const enriched = easySessions(week).filter((session) => session.steps !== undefined);
        expect(enriched.length, `semaine ${week.weekNumber}`).toBeLessThanOrEqual(1);
      }
    });

    it('différencie les longueurs sans bouger la somme de la semaine', () => {
      for (const week of skeleton) {
        const total = [
          ...week.sessions.map((session) => session.distanceKm ?? 0),
          ...week.qualitySlots.map((slot) => slot.budgetKm),
        ].reduce((sum, km) => sum + km, 0);
        expect(total, `semaine ${week.weekNumber}`).toBeCloseTo(week.target.targetKm, 1);

        // Et la sortie longue reste la plus longue séance de sa semaine : c'est
        // la borne que le rééquilibrage des footings ne doit pas franchir.
        const longRun = week.sessions.find((session) => session.kind === 'Sortie longue');
        for (const session of week.sessions) {
          expect(longRun?.distanceKm ?? 0, `semaine ${week.weekNumber}`).toBeGreaterThanOrEqual(
            session.distanceKm ?? 0,
          );
        }
      }
    });

    it('couvre exactement la distance déclarée par chaque déroulé', () => {
      let checked = 0;
      for (const week of skeleton) {
        for (const session of week.sessions) {
          if (session.steps === undefined) continue;
          checked += 1;
          const covered = flattenSteps(session.steps).reduce(
            (sum, step) => sum + (step.distanceM ?? 0),
            0,
          );
          expect(covered, `semaine ${week.weekNumber}, ${session.title}`).toBe(
            Math.round((session.distanceKm ?? 0) * 1_000),
          );
          // Aucune étape en durée : c'est la contrainte qui fait tenir les
          // volumes une fois `imposedDistanceKm` passé.
          for (const step of flattenSteps(session.steps)) {
            expect(step.durationS, `semaine ${week.weekNumber}`).toBeNull();
            expect(step.distanceM).not.toBeNull();
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it('traverse les deux post-traitements sans qu’aucune distance ne bouge', () => {
      const filled = fillSkeleton(skeleton);
      for (const pass of postProcessed(filled, GWEN)) {
        pass.weeks.forEach((week, index) => {
          week.sessions.forEach((session, position) => {
            expect(session.distanceKm, `${pass.label}, semaine ${index + 1}`).toBe(
              filled[index].sessions[position].distanceKm,
            );
          });
          const total = week.sessions.reduce((sum, session) => sum + (session.distanceKm ?? 0), 0);
          expect(total, `${pass.label}, semaine ${index + 1}`).toBeCloseTo(
            targets[index].targetKm,
            1,
          );
        });
      }
    });

    /*
     * Un footing enrichi n'est **pas** une séance de qualité : son `kind` reste
     * « Endurance fondamentale », donc `sessionPaceZone` le range en `easy` et
     * `isIntensitySession` le laisse tranquille — sans quoi la validation lui
     * réclamerait un échauffement et un retour au calme, et le plan basculerait
     * hors de sa répartition 80/20.
     */
    it('garde les footings enrichis en zone facile', () => {
      for (const week of skeleton) {
        for (const session of easySessions(week)) {
          expect(sessionPaceZone(session.kind), `semaine ${week.weekNumber}`).toBe('easy');
          expect(isIntensitySession(session), `semaine ${week.weekNumber}`).toBe(false);
        }
      }
    });

    /*
     * Aucune note ne déplace la zone d'une étape (`STEP_NOTE_ZONES` ne réagit
     * qu'à « seuil/tempo » et « allure objectif / course / spécifique /
     * marathon ») : après `applyImposedPaces`, toutes les étapes d'effort d'un
     * footing enrichi portent la **plage d'endurance**, et rien d'autre.
     */
    it('ne fait sortir aucune étape de la plage d’endurance après imposition des allures', () => {
      const easy = GWEN.paces?.easy;
      const imposed = applyImposedPaces(fillSkeleton(skeleton), GWEN.paces ?? REFERENCE_PACES, null);

      let checked = 0;
      for (const week of imposed) {
        for (const session of week.sessions) {
          if (session.kind !== 'Endurance fondamentale' || session.steps === undefined) continue;
          checked += 1;
          for (const step of flattenSteps(session.steps)) {
            if (step.role === 'run') {
              checked += 1;
              expect(step.paceMinSecPerKm).toBe(easy?.minSecPerKm);
              expect(step.paceMaxSecPerKm).toBe(easy?.maxSecPerKm);
            } else {
              // Enveloppe et récupérations d'une séance d'endurance : aucune
              // cible, la note dit tout (cf. `envelopePaceZone`).
              expect(step.paceMinSecPerKm).toBeNull();
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it('termine un footing par 4 à 6 lignes droites, récupération comprise', () => {
      const strides = skeleton
        .flatMap((week) => easySessions(week))
        .find((session) => session.title === 'Footing avec lignes droites');

      expect(strides).toBeDefined();
      const blocks = strides?.steps ?? [];
      expect(blocks).toHaveLength(2);
      // Le corps d'abord, la section d'accélérations ensuite : les lignes droites
      // se courent sur une foulée déjà chaude.
      expect(blocks[0].repeat).toBe(1);
      expect(blocks[0].steps[0].role).toBe('run');
      expect(blocks[1].repeat).toBeGreaterThanOrEqual(4);
      expect(blocks[1].repeat).toBeLessThanOrEqual(6);
      expect(blocks[1].steps.map((step) => step.role)).toEqual(['run', 'recover']);
      // ~20 s d'accélération, soit 80 à 100 m — au-dessus du plancher de 10 m des
      // étapes, et sous les 200 m d'une « étape courte » pour la validation.
      expect(blocks[1].steps[0].distanceM).toBeGreaterThanOrEqual(80);
      expect(blocks[1].steps[0].distanceM).toBeLessThanOrEqual(100);
      // La section reste une fin de séance, pas la séance.
      const section = blocks[1].repeat * (blocks[1].steps[0].distanceM ?? 0);
      expect(section / ((strides?.distanceKm ?? 1) * 1_000)).toBeLessThan(0.1);
    });

    it('réserve les côtes courtes à la phase de base', () => {
      for (const week of skeleton) {
        const hills = easySessions(week).filter(
          (session) => session.title === 'Footing avec côtes courtes',
        );
        if (hills.length === 0) continue;
        expect(week.phase, `semaine ${week.weekNumber}`).toBe('base');
      }
      // Et elles existent : sans cela, la règle ci-dessus ne prouverait rien.
      const base = skeleton.filter((week) => week.phase === 'base');
      expect(
        base.flatMap(easySessions).filter((s) => s.title === 'Footing avec côtes courtes').length,
      ).toBeGreaterThan(0);
    });

    it('monte le footing progressif en trois tranches décroissantes, hors phase de base', () => {
      const weeks = skeleton.filter((week) =>
        easySessions(week).some((session) => session.title === 'Footing progressif'),
      );
      expect(weeks.length).toBeGreaterThan(0);

      for (const week of weeks) {
        expect(['build', 'specific'], `semaine ${week.weekNumber}`).toContain(week.phase);
        const progressive = easySessions(week).find((s) => s.title === 'Footing progressif');
        const steps = flattenSteps(progressive?.steps ?? []);
        // Trois tranches de course, de plus en plus courtes : c'est la forme
        // d'un progressif. La première en est une aussi — elle pèse 40 % de la
        // séance, et l'avoir laissée en `warmup` la privait de toute cible.
        expect(steps.map((step) => step.role)).toEqual(['run', 'run', 'run']);
        expect(steps[0].distanceM ?? 0).toBeGreaterThan(steps[1].distanceM ?? 0);
        expect(steps[1].distanceM ?? 0).toBeGreaterThan(steps[2].distanceM ?? 0);
        // Et trois cibles distinctes, du bas vers le haut de la plage
        // d'endurance : c'est ce qui rend la progression visible sur la montre.
        expect(steps.map((step) => step.hrPercentMin)).toEqual([65, 70, 74]);
        expect(steps.map((step) => step.hrPercentMax)).toEqual([71, 75, 79]);
      }
    });

    it('appuie la fin d’une sortie longue sur trois, en développement et en spécificité', () => {
      const finishes = skeleton.filter((week) =>
        week.sessions.some((session) => session.title === 'Sortie longue, fin de parcours appuyée'),
      );
      expect(finishes.length).toBeGreaterThan(0);

      for (const week of finishes) {
        expect(['build', 'specific'], `semaine ${week.weekNumber}`).toContain(week.phase);
        expect(week.weekNumber % 3, `semaine ${week.weekNumber}`).toBe(0);
        const steps = flattenSteps(
          week.sessions.find((s) => s.title === 'Sortie longue, fin de parcours appuyée')?.steps ??
            [],
        );
        expect(steps.map((step) => step.role)).toEqual(['run', 'run']);
        // Le dernier cinquième, pas plus : une sortie longue reste du temps passé
        // en endurance.
        const covered = steps.reduce((sum, step) => sum + (step.distanceM ?? 0), 0);
        expect((steps[1].distanceM ?? 0) / covered).toBeCloseTo(0.2, 2);
      }

      // La plupart des sorties longues restent nues : la variation est
      // périodique, pas systématique.
      const longRuns = skeleton.flatMap((week) =>
        week.sessions.filter((session) => session.kind === 'Sortie longue'),
      );
      expect(finishes.length * 2).toBeLessThan(longRuns.length);
    });

    /*
     * Deux semaines n'ont rien à recevoir : la première d'un plan démarré en
     * cours de route (on ignore ce qui y a déjà été couru) et celle de la course
     * (ses footings sont des récupérations, dont le seul contrat est « plus lent
     * que l'endurance »).
     */
    it('n’enrichit ni la semaine entamée ni l’affûtage ni la semaine de course', () => {
      const dated: Combination = {
        weeks: 12,
        sessionsPerWeek: 5,
        longRunDay: 7,
        firstWeekFromDay: 5,
        raceDay: 7,
        level: 'intermediate',
        goal: TEN_K_GOAL,
        athlete: ATHLETES[2],
      };
      const raced = skeletonFor(dated, targetsFor(dated));

      for (const week of raced) {
        if (week.phase !== 'partial' && week.phase !== 'taper' && week.phase !== 'race') continue;
        for (const session of week.sessions) {
          expect(session.steps, `semaine ${week.weekNumber} (${week.phase})`).toBeUndefined();
        }
      }
      // Les trois phases sont bien représentées dans ce plan-là.
      expect(raced.map((week) => week.phase)).toEqual(
        expect.arrayContaining(['partial', 'taper', 'race']),
      );
    });

    it('reste déterministe : mêmes paramètres, mêmes variations', () => {
      expect(skeletonFor(combination, targets)).toEqual(skeletonFor(combination, targetsFor(combination)));
    });
  });

  /*
   * Le refus : ce que le squelette répond quand l'arithmétique ne tient pas.
   */
  describe('quand la cible ne finance pas les séances demandées', () => {
    /** Le cas de la revue : 3 km récents, 6 séances, marathon dans 8 semaines. */
    const combination: Combination = {
      weeks: 8,
      sessionsPerWeek: 6,
      longRunDay: 7,
      firstWeekFromDay: 1,
      raceDay: 7,
      level: 'beginner',
      goal: MARATHON_GOAL,
      athlete: ATHLETES[3],
    };

    it('refuse le plan au lieu d’écrire des semaines que la validation recalera', () => {
      const targets = targetsFor(combination);
      expect(() => skeletonFor(combination, targets)).toThrow(PlanSkeletonInfeasibleError);
    });

    it('dit quelles semaines, quelle cible, quel minimum et combien de séances tiendraient', () => {
      const targets = targetsFor(combination);
      let thrown: PlanSkeletonInfeasibleError | null = null;
      try {
        skeletonFor(combination, targets);
      } catch (error) {
        thrown = error instanceof PlanSkeletonInfeasibleError ? error : null;
      }

      expect(thrown).not.toBeNull();
      const error = thrown as PlanSkeletonInfeasibleError;
      expect(error.weeks.length).toBeGreaterThan(0);
      for (const week of error.weeks) {
        expect(week.targetKm).toBe(targets[week.weekNumber - 1].targetKm);
        expect(week.targetKm).toBeLessThan(week.minimumKm);
        expect(week.sessionCount).toBe(6);
      }
      expect(error.requestedSessionsPerWeek).toBe(6);
      expect(error.fundableSessionsPerWeek).toBeLessThan(6);
    });

    it('accepte le même plan dès que le nombre de séances redescend à ce qui tient', () => {
      const targets = targetsFor(combination);
      let fundable = 0;
      try {
        skeletonFor(combination, targets);
      } catch (error) {
        fundable = (error as PlanSkeletonInfeasibleError).fundableSessionsPerWeek;
      }

      expect(fundable).toBeGreaterThan(0);
      const smaller = { ...combination, sessionsPerWeek: fundable };
      const skeleton = skeletonFor(smaller, targetsFor(smaller));
      for (const week of skeleton) {
        const total = [
          ...week.sessions.map((session) => session.distanceKm ?? 0),
          ...week.qualitySlots.map((slot) => slot.budgetKm),
        ].reduce((sum, km) => sum + km, 0);
        expect(total, `semaine ${week.weekNumber}`).toBeCloseTo(week.target.targetKm, 6);
      }
    });

    /*
     * Une cible nulle ou négative n'est que le cas dégénéré du même refus. Elle
     * n'est pas atteignable depuis le formulaire (le budget temps y a un
     * plancher de 60 min, 30 en réglage), mais `PLAN_LIMITS.weeklyTimeMinutes.min`
     * vaut 1 et le squelette ne vérifie rien de ce qu'on lui passe : à 1 min par
     * semaine, `weeklyVolumeTargets` rend jusqu'à neuf semaines à zéro ou moins
     * (−0,6 km mesuré), et le module levait alors un `TypeError`.
     */
    it('refuse une cible nulle ou négative plutôt que de planter', () => {
      const target = (targetKm: number): WeeklyVolumeTarget => ({
        targetKm,
        targetMinutes: 0,
        kind: 'build',
      });

      for (const targetKm of [0, -0.6]) {
        expect(() =>
          buildPlanSkeleton({
            intent: 'race',
            weeks: 1,
            firstWeekFromDay: 1,
            sessionsPerWeek: 5,
            longRunDay: 7,
            level: 'intermediate',
            race: null,
            raceDay: null,
            goalDistanceKm: null,
            targets: [target(targetKm)],
          }),
        ).toThrow(PlanSkeletonInfeasibleError);
      }
    });
  });
  /**
   * La périodisation imposée par l'appelant.
   *
   * Le chemin qu'emprunte la reconstruction de la fin d'un plan en cours
   * (`rewriteRemainingPlan`) : les phases y sont calculées sur le plan **entier**
   * puis tranchées, sans quoi une fenêtre de six semaines redeviendrait un plan
   * de six semaines — base comprise — à chaque ajustement.
   */
  describe('périodisation imposée', () => {
    /** Six semaines, comme la fin d'un plan long : spécificité, affûtage, course. */
    const combination: Combination = {
      weeks: 6,
      sessionsPerWeek: 4,
      longRunDay: 7,
      firstWeekFromDay: 1,
      raceDay: 7,
      level: 'intermediate',
      goal: MARATHON_GOAL,
      athlete: ATHLETES[0],
    };

    const imposed: PlanPhase[] = [
      'specific',
      'specific',
      'specific',
      'specific',
      'taper',
      'race',
    ];

    it('reprend les phases de l’appelant plutôt que de les recalculer', () => {
      const targets = targetsFor(combination);
      const skeleton = buildPlanSkeleton({
        intent: intentOf(combination),
        weeks: combination.weeks,
        firstWeekFromDay: combination.firstWeekFromDay,
        sessionsPerWeek: combination.sessionsPerWeek,
        longRunDay: combination.longRunDay,
        level: combination.level,
        race: combination.goal.race,
        raceDay: combination.raceDay,
        goalDistanceKm: combination.goal.goalDistanceKm,
        targets,
        phases: imposed,
      });

      expect(skeleton.map((week) => week.phase)).toEqual(imposed);
      // Et les phases décident bien de la qualité : la phase de base est la
      // seule à prescrire des répétitions courtes, elle ne peut donc pas
      // reparaître ici.
      const kinds = skeleton.flatMap((week) => week.qualitySlots.map((slot) => slot.kind));
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds).not.toContain('Répétitions');
    });

    it('retombe sur la périodisation de la fenêtre quand l’appelant n’en impose aucune', () => {
      const targets = targetsFor(combination);
      const own = skeletonFor(combination, targets);

      // Sans consigne, six semaines forment un plan de six semaines : une base,
      // et donc des répétitions courtes.
      expect(own.map((week) => week.phase)).toContain('base');
      expect(own.flatMap((week) => week.qualitySlots.map((slot) => slot.kind))).toContain(
        'Répétitions',
      );
    });
  });
});

/*
 * ------------------------------------------------------------------------
 * La rampe de composition, éprouvée sur le plan qui l'a fait écrire.
 * ------------------------------------------------------------------------
 *
 * Le constat d'origine, mesuré en production : 16 semaines, 4 séances, budget
 * 4 h, endurance à 7:23/km. Le budget plafonne le volume à 30,8 km dès la
 * semaine 3, et les cibles se mettent à tourner en rond —
 * **26,1 · 28,1 · 30,3 · 30,8**, trois fois de la semaine 5 à la semaine 14.
 * Comme la décomposition ne dépendait que de la cible, les semaines de même
 * volume recevaient des séances identiques au dixième.
 *
 * Ce que ces tests fixent est le résultat : à cibles **inchangées** (elles ne
 * bougent pas d'un dixième, cf. le témoin SHA de `plan-schema.test.ts`), deux
 * semaines de même volume ne se composent plus pareil.
 */
describe('la rampe de composition sur le plan de l’utilisatrice', () => {
  const USER_ATHLETE = {
    recentWeeklyKm: 30,
    weeklyTimeMinutes: 240,
    /** 7:23/km — l'allure d'endurance relevée sur son historique. */
    easyPaceSecPerKm: 443,
  };

  const USER_RACE: PlanRaceGoal = { isMarathon: false };
  const USER_WEEKS = 16;
  const USER_SESSIONS = 4;

  function userTargets(): WeeklyVolumeTarget[] {
    return weeklyVolumeTargets({
      weeks: USER_WEEKS,
      firstWeekFromDay: 1,
      recentWeeklyKm: USER_ATHLETE.recentWeeklyKm,
      weeklyTimeMinutes: USER_ATHLETE.weeklyTimeMinutes,
      easyPaceSecPerKm: USER_ATHLETE.easyPaceSecPerKm,
      race: USER_RACE,
      level: 'intermediate',
    });
  }

  function userSkeleton(targets: readonly WeeklyVolumeTarget[]): SkeletonWeek[] {
    return buildPlanSkeleton({
      intent: 'race',
      weeks: USER_WEEKS,
      firstWeekFromDay: 1,
      sessionsPerWeek: USER_SESSIONS,
      longRunDay: 7,
      level: 'intermediate',
      race: USER_RACE,
      raceDay: 7,
      goalDistanceKm: HALF_GOAL.goalDistanceKm,
      targets,
    });
  }

  /** La composition d'une semaine : ce que la rampe décide, et rien d'autre. */
  function composition(week: SkeletonWeek) {
    const longRun = week.sessions.find(
      (session) => session.kind === 'Sortie longue' || session.kind === 'Course',
    );
    return {
      longRunKm: longRun?.distanceKm ?? null,
      qualityKm: week.qualitySlots.map((slot) => slot.budgetKm),
      easyKm: week.sessions
        .filter((session) => session !== longRun)
        .map((session) => session.distanceKm),
    };
  }

  it('reproduit bien le plan du constat : le même quatuor de volumes, trois fois', () => {
    // Si cette ligne bouge, ce n'est plus le plan de l'utilisatrice qu'on teste.
    expect(userTargets().map((target) => target.targetKm)).toEqual([
      26.8, 28.9, 30.8, 26.1, 28.1, 30.3, 30.8, 26.1, 28.1, 30.3, 30.8, 26.1, 28.1, 30.3, 22.7,
      16.6,
    ]);
  });

  it('ne touche pas à un seul kilomètre des cibles hebdomadaires', () => {
    // Le contrat du chantier : la progression passe par la composition, à
    // kilométrage hebdomadaire strictement inchangé.
    const targets = userTargets();
    for (const week of userSkeleton(targets)) {
      const written =
        week.sessions.reduce((sum, session) => sum + (session.distanceKm ?? 0), 0) +
        week.qualitySlots.reduce((sum, slot) => sum + slot.budgetKm, 0);
      expect(Math.round(written * 10) / 10, `semaine ${week.weekNumber}`).toBe(
        week.target.targetKm,
      );
    }
  });

  it('sépare les semaines jumelles que le constat désignait', () => {
    const skeleton = userSkeleton(userTargets());
    const at = (weekNumber: number) => JSON.stringify(composition(skeleton[weekNumber - 1]));

    // Les deux paires de même volume ET de même phase — celles que rien ne
    // distinguait, et le cœur du reproche.
    expect(at(5), 's5 vs s9 (28,1 km, développement)').not.toBe(at(9));
    expect(at(6), 's6 vs s10 (30,3 km, développement)').not.toBe(at(10));

    // Et les paires de même volume à cheval sur deux phases.
    expect(at(7), 's7 vs s11 (30,8 km)').not.toBe(at(11));
    expect(at(8), 's8 vs s12 (26,1 km)').not.toBe(at(12));
    expect(at(5), 's5 vs s13 (28,1 km)').not.toBe(at(13));
    expect(at(6), 's6 vs s14 (30,3 km)').not.toBe(at(14));
  });

  it('fait croître le budget de qualité de la semaine 5 à la semaine 14', () => {
    const skeleton = userSkeleton(userTargets());

    // Le tableau du chantier, semaine par semaine : la qualité monte, les
    // footings absorbent en sens inverse, la sortie longue reste à son plafond.
    expect(skeleton.slice(4, 14).map((week) => composition(week).qualityKm)).toEqual([
      [4, 4], //     s5  build     28,1 km
      [4.5, 4.5], // s6  build     30,3 km
      [5, 5], //     s7  build     30,8 km
      [4.5, 4.5], // s8  build     26,1 km
      [4.5, 4.5], // s9  build     28,1 km
      [5, 5], //     s10 build     30,3 km
      [5.5, 5.5], // s11 specific  30,8 km
      [4.5, 4.5], // s12 specific  26,1 km
      [5, 5], //     s13 specific  28,1 km
      [6, 6], //     s14 specific  30,3 km
    ]);
  });

  it('tient le budget temps de 4 h sur chaque semaine', () => {
    // Le calcul le plus défavorable : **tout** le kilométrage à l'allure
    // d'endurance. Les kilomètres de qualité se courent plus vite, donc la durée
    // réelle est en dessous — c'est le sens dans lequel la rampe pousse.
    const ceilingMinutes = USER_ATHLETE.weeklyTimeMinutes * VOLUME_RULES.weeklyTimeTolerance;

    for (const week of userSkeleton(userTargets())) {
      const km =
        week.sessions.reduce((sum, session) => sum + (session.distanceKm ?? 0), 0) +
        week.qualitySlots.reduce((sum, slot) => sum + slot.budgetKm, 0);
      const minutes = (km * USER_ATHLETE.easyPaceSecPerKm) / 60;
      expect(minutes, `semaine ${week.weekNumber}`).toBeLessThanOrEqual(ceilingMinutes);
    }
  });

  /*
   * LE test d'ancrage. Une rampe calée sur la position dans la **fenêtre** — et
   * non dans le plan — remettrait la composition au bas de sa progression à
   * chaque réadaptation. Comme la révision se déclenche toutes les quatre
   * séances, la préparation n'avancerait jamais.
   *
   * On rejoue donc ici ce que `rewriteRemainingPlan` fait : les phases du plan
   * entier, tranchées, et l'ancrage calculé par la même soustraction. Les cibles
   * sont celles de la création, tranchées elles aussi — ce qui isole la
   * composition de l'arithmétique des volumes, qui a ses propres tests.
   */
  describe('création et reconstruction se rejoignent', () => {
    const FULL_PHASES = planPhases({
      intent: 'race',
      weeks: USER_WEEKS,
      firstWeekFromDay: 1,
      race: USER_RACE,
    });
    const PLAN_DEVELOPMENT_WEEKS = FULL_PHASES.filter(isDevelopmentPhase).length;

    /** La fenêtre restante de `weeks` semaines, telle que le service la construit. */
    function rebuild(weeks: number, firstWeekFromDay: number): SkeletonWeek[] {
      const targets = userTargets();
      const offset = USER_WEEKS - weeks;
      const phases: PlanPhase[] = FULL_PHASES.slice(offset);
      if (firstWeekFromDay > 1 && phases[0] !== 'race') phases[0] = 'partial';

      return buildPlanSkeleton({
        intent: 'race',
        weeks,
        firstWeekFromDay,
        sessionsPerWeek: USER_SESSIONS,
        longRunDay: 7,
        level: 'intermediate',
        race: USER_RACE,
        raceDay: 7,
        goalDistanceKm: HALF_GOAL.goalDistanceKm,
        targets: targets.slice(offset),
        phases,
        // La soustraction de `remainingComposition` : les semaines de
        // développement que la fenêtre ne porte pas, démotion comprise.
        compositionAnchor: {
          planDevelopmentWeeks: PLAN_DEVELOPMENT_WEEKS,
          completedDevelopmentWeeks:
            PLAN_DEVELOPMENT_WEEKS - phases.filter(isDevelopmentPhase).length,
        },
        // Et l'ancrage plan-relatif des formes, que le service passe lui aussi.
        planWeekOffset: offset,
        completedBaseWeeks:
          FULL_PHASES.filter((phase) => phase === 'base').length -
          phases.filter((phase) => phase === 'base').length,
      });
    }

    it('donne la même composition à une semaine calendaire, quelle que soit la fenêtre', () => {
      const created = userSkeleton(userTargets());

      // Toutes les reconstructions possibles, de la plus longue à la plus
      // courte : c'est la même semaine calendaire qu'on suit à chaque fois.
      for (let weeks = 1; weeks <= USER_WEEKS; weeks += 1) {
        const offset = USER_WEEKS - weeks;
        const rebuilt = rebuild(weeks, 1);

        for (let index = 0; index < weeks; index += 1) {
          expect(
            composition(rebuilt[index]),
            `fenêtre de ${weeks} semaines, semaine calendaire ${offset + index + 1}`,
          ).toEqual(composition(created[offset + index]));
        }
      }
    });

    it('garde le bon rang quand la fenêtre s’ouvre sur une semaine déjà entamée', () => {
      const created = userSkeleton(userTargets());

      // Une fenêtre entamée démote sa première semaine en `partial` : elle perd
      // sa qualité, mais **les suivantes gardent leur rang**. C'est la
      // soustraction qui le garantit — un décompte du préfixe les décalerait
      // toutes d'un cran.
      for (const weeks of [10, 9, 7, 6, 5]) {
        const offset = USER_WEEKS - weeks;
        const rebuilt = rebuild(weeks, 4);

        expect(rebuilt[0].qualitySlots, `fenêtre de ${weeks} semaines`).toEqual([]);
        for (let index = 1; index < weeks; index += 1) {
          expect(
            composition(rebuilt[index]),
            `fenêtre entamée de ${weeks} semaines, semaine calendaire ${offset + index + 1}`,
          ).toEqual(composition(created[offset + index]));
        }
      }
    });
  });
});

/*
 * ------------------------------------------------------------------------
 * Création et reconstruction se rejoignent, **intention par intention**.
 * ------------------------------------------------------------------------
 *
 * Le test ci-dessus prouve l'ancrage de composition sur le plan de
 * l'utilisatrice ; celui-ci le rejoue pour les quatre intentions, parce que
 * chacune apporte ses propres décisions de structure (longueur de la base,
 * existence d'une spécificité, zones, plafond de sortie longue). Toutes doivent
 * être des **fonctions pures de (intention, phase, position dans le plan)** :
 * c'est ce qui permet à `rewriteRemainingPlan` de réécrire la fin d'un plan sans
 * remettre la préparation au début de sa progression.
 *
 * La reconstruction reçoit les phases du plan entier, tranchées, et l'ancrage
 * calculé par la même soustraction que le service — exactement comme en
 * production.
 */
describe('création et reconstruction se rejoignent, intention par intention', () => {
  const PLAN_WEEKS = 16;
  const PLAN_SESSIONS = 4;

  /**
   * Ce que la reconstruction doit reproduire à l'identique, semaine par semaine
   * — **séance par séance**, titres et distances compris.
   *
   * ## Ce que cette comparaison a coûté avant d'être écrite
   *
   * Elle ne portait que sur le **total** des footings, et une note expliquait
   * pourquoi : `weeklyEasyVariation` et `longRunFinishSteps` se décidaient sur le
   * numéro de semaine de la **fenêtre**, renumérotée depuis 1 à chaque
   * reconstruction. Mesuré alors, sur `race` : 16 semaines, 6 séances, débutante,
   * fenêtre de 15 — la semaine calendaire 5 sortait en `6,1 · 6,8 · 6,8 · 7,4` km
   * à la création et en `7,5 · 6,8 · 6,8 · 6,0` à la reconstruction. Mêmes
   * kilomètres au total, autres séances : le total ne le voyait pas.
   *
   * La même cause déplaçait la sortie longue à fin appuyée (une sur trois) et
   * rouvrait la fenêtre de marche/course d'une reprise. Les trois se referment par
   * l'ancrage plan-relatif que l'appelant passe désormais
   * (`planWeekOffset`, `completedBaseWeeks`), et c'est **cette égalité-ci** qui le
   * prouve : les formes individuelles, pas leur somme.
   */
  function composition(week: SkeletonWeek) {
    const longRun = week.sessions.find(
      (session) => session.kind === 'Sortie longue' || session.kind === 'Course',
    );
    const easy = week.sessions.filter((session) => session !== longRun);
    return {
      phase: week.phase,
      // Le titre **et** le déroulé de la sortie longue : « fin de parcours
      // appuyée » ou marche/course sont des formes, pas des kilomètres.
      longRun:
        longRun === undefined
          ? null
          : `${longRun.title} ${longRun.distanceKm} ${JSON.stringify(longRun.steps ?? null)}`,
      quality: week.qualitySlots.map((slot) => `${slot.kind} ${slot.budgetKm}`),
      // Chaque footing dans l'ordre des jours : sa forme, sa longueur, son
      // déroulé. C'est ce que l'athlète lit sur sa timeline.
      easy: easy.map(
        (session) =>
          `j${session.day} ${session.title} ${session.distanceKm} ${JSON.stringify(session.steps ?? null)}`,
      ),
    };
  }

  for (const intent of PLAN_INTENTS) {
    describe(intent, () => {
      const race: PlanRaceGoal | null = intent === 'race' ? { isMarathon: false } : null;
      const goalDistanceKm = intent === 'race' ? HALF_GOAL.goalDistanceKm : null;
      const returnInjuryHistory = intent === 'return';

      const targets = weeklyVolumeTargets({
        weeks: PLAN_WEEKS,
        firstWeekFromDay: 1,
        recentWeeklyKm: 30,
        weeklyTimeMinutes: 240,
        easyPaceSecPerKm: 443,
        race,
        level: 'intermediate',
      });

      const fullPhases = planPhases({
        intent,
        weeks: PLAN_WEEKS,
        firstWeekFromDay: 1,
        race,
        returnInjuryHistory,
      });
      const planDevelopmentWeeks = fullPhases.filter(isDevelopmentPhase).length;

      /** La fenêtre de `weeks` semaines finales, telle que le service la construit. */
      function build(weeks: number, firstWeekFromDay: number): SkeletonWeek[] {
        const offset = PLAN_WEEKS - weeks;
        const isWindow = weeks < PLAN_WEEKS;
        const phases: PlanPhase[] = fullPhases.slice(offset);
        if (firstWeekFromDay > 1 && phases[0] !== 'race') phases[0] = 'partial';

        return buildPlanSkeleton({
          intent,
          returnInjuryHistory,
          weeks,
          firstWeekFromDay,
          sessionsPerWeek: PLAN_SESSIONS,
          longRunDay: 7,
          level: 'intermediate',
          race,
          raceDay: race === null ? null : 7,
          goalDistanceKm,
          targets: targets.slice(offset),
          ...(isWindow
            ? {
                phases,
                compositionAnchor: {
                  planDevelopmentWeeks,
                  completedDevelopmentWeeks:
                    planDevelopmentWeeks - phases.filter(isDevelopmentPhase).length,
                },
                // Les deux ancrages plan-relatifs, comptés exactement comme
                // `remainingComposition` les compte : par soustraction, pour que
                // la démotion de la première semaine en `partial` ne décale pas
                // les suivantes.
                planWeekOffset: fullPhases.length - phases.length,
                completedBaseWeeks:
                  fullPhases.filter((phase) => phase === 'base').length -
                  phases.filter((phase) => phase === 'base').length,
              }
            : {}),
        });
      }

      it('donne la même composition à une semaine calendaire, quelle que soit la fenêtre', () => {
        const created = build(PLAN_WEEKS, 1);

        for (let weeks = 1; weeks <= PLAN_WEEKS; weeks += 1) {
          const offset = PLAN_WEEKS - weeks;
          const rebuilt = build(weeks, 1);

          for (let index = 0; index < weeks; index += 1) {
            expect(
              composition(rebuilt[index]),
              `fenêtre de ${weeks} semaines, semaine calendaire ${offset + index + 1}`,
            ).toEqual(composition(created[offset + index]));
          }
        }
      });

      it('garde le bon rang quand la fenêtre s’ouvre sur une semaine déjà entamée', () => {
        const created = build(PLAN_WEEKS, 1);

        for (const weeks of [10, 9, 7, 6, 5]) {
          const offset = PLAN_WEEKS - weeks;
          const rebuilt = build(weeks, 4);

          // La première semaine d'une fenêtre entamée est démotée en `partial` :
          // elle perd sa qualité, mais les suivantes gardent leur rang.
          expect(rebuilt[0].qualitySlots, `fenêtre de ${weeks} semaines`).toEqual([]);
          for (let index = 1; index < weeks; index += 1) {
            expect(
              composition(rebuilt[index]),
              `fenêtre entamée de ${weeks} semaines, semaine calendaire ${offset + index + 1}`,
            ).toEqual(composition(created[offset + index]));
          }
        }
      });
    });
  }
});
