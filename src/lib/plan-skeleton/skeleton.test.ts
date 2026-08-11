import { describe, expect, it } from 'vitest';

import type { PlanLevel } from '@/data/db/schema';
import {
  applyDerivedMeasures,
  applyImposedPaces,
  PLAN_OUTPUT_BOUNDS,
  validatePlanBusinessRules,
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

import { PlanSkeletonInfeasibleError } from './feasibility';
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

const TEN_K_GOAL = GOALS[3];
const HALF_GOAL = GOALS[4];
const MARATHON_GOAL = GOALS[6];

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
 */
const DAY_SETTINGS: { longRunDay: number; firstWeekFromDay: number }[] = [
  { longRunDay: 7, firstWeekFromDay: 1 },
  { longRunDay: 1, firstWeekFromDay: 2 },
  { longRunDay: 4, firstWeekFromDay: 3 },
  { longRunDay: 5, firstWeekFromDay: 4 },
  { longRunDay: 2, firstWeekFromDay: 5 },
  { longRunDay: 6, firstWeekFromDay: 6 },
  { longRunDay: 3, firstWeekFromDay: 7 },
];

type Combination = {
  weeks: number;
  sessionsPerWeek: number;
  longRunDay: number;
  firstWeekFromDay: number;
  level: PlanLevel;
  goal: Goal;
  athlete: Athlete;
};

function describeCombination(combination: Combination): string {
  return (
    `${combination.weeks} semaines, ${combination.sessionsPerWeek} séances, ` +
    `sortie longue jour ${combination.longRunDay}, départ jour ${combination.firstWeekFromDay}, ` +
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
    weeks: combination.weeks,
    firstWeekFromDay: combination.firstWeekFromDay,
    sessionsPerWeek: combination.sessionsPerWeek,
    longRunDay: combination.longRunDay,
    level: combination.level,
    race: combination.goal.race,
    goalDistanceKm: combination.goal.goalDistanceKm,
    targets,
  });
}

/**
 * Les deux post-traitements du pipeline, appliqués au squelette rempli — et la
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
  ];
}

/** Toutes les combinaisons de la matrice, dans un ordre fixe. */
function allCombinations(): Combination[] {
  const combinations: Combination[] = [];
  for (const weeks of WEEKS) {
    for (const sessionsPerWeek of SESSIONS_PER_WEEK) {
      for (const { longRunDay, firstWeekFromDay } of DAY_SETTINGS) {
        for (const level of SWEPT_LEVELS) {
          for (const goal of GOALS) {
            for (const athlete of ATHLETES) {
              combinations.push({
                weeks,
                sessionsPerWeek,
                longRunDay,
                firstWeekFromDay,
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
      level: 'intermediate',
      goal: MARATHON_GOAL,
      athlete: ATHLETES[2],
    };
    const targets = targetsFor(combination);
    expect(skeletonFor(combination, targets)).toEqual(skeletonFor(combination, targets));
  });

  describe('ce que chaque semaine porte', () => {
    const combination: Combination = {
      weeks: 16,
      sessionsPerWeek: 5,
      longRunDay: 6,
      firstWeekFromDay: 1,
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
      for (const week of skeleton) {
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

    it('ne laisse aucune séance écrite porter un déroulé, sauf la sortie longue spécifique', () => {
      for (const week of skeleton) {
        for (const session of week.sessions) {
          if (session.steps === undefined) continue;
          expect(session.kind, `semaine ${week.weekNumber}`).toBe('Sortie longue');
          expect(week.phase, `semaine ${week.weekNumber}`).toBe('specific');
        }
      }
    });

    it('découpe la sortie longue spécifique en mise en route, allure objectif, retour au calme', () => {
      const specific = skeleton.find(
        (week) => week.phase === 'specific' && week.sessions.some((s) => s.steps !== undefined),
      );
      const longRun = specific?.sessions.find((session) => session.steps !== undefined);
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

    it('ne programme pas de qualité la semaine de la course', () => {
      const raceWeek = skeleton[15];
      expect(raceWeek.phase).toBe('race');
      expect(raceWeek.qualitySlots).toEqual([]);
      // Et les footings y sont des récupérations, qui ne reçoivent aucune cible.
      for (const session of raceWeek.sessions) {
        expect(['Récupération', 'Sortie longue']).toContain(session.kind);
      }
    });
  });

  describe('sur une première semaine entamée', () => {
    const combination: Combination = {
      weeks: 10,
      sessionsPerWeek: 5,
      longRunDay: 2,
      firstWeekFromDay: 5,
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

  it('ne rend rien pour un plan sans semaine', () => {
    expect(
      buildPlanSkeleton({
        weeks: 0,
        firstWeekFromDay: 1,
        sessionsPerWeek: 4,
        longRunDay: 7,
        level: 'intermediate',
        race: null,
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
   * Le refus : ce que le squelette répond quand l'arithmétique ne tient pas.
   */
  describe('quand la cible ne finance pas les séances demandées', () => {
    /** Le cas de la revue : 3 km récents, 6 séances, marathon dans 8 semaines. */
    const combination: Combination = {
      weeks: 8,
      sessionsPerWeek: 6,
      longRunDay: 7,
      firstWeekFromDay: 1,
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
            weeks: 1,
            firstWeekFromDay: 1,
            sessionsPerWeek: 5,
            longRunDay: 7,
            level: 'intermediate',
            race: null,
            goalDistanceKm: null,
            targets: [target(targetKm)],
          }),
        ).toThrow(PlanSkeletonInfeasibleError);
      }
    });
  });
});
