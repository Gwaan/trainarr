import { describe, expect, it } from 'vitest';

import {
  applyImposedPaces,
  PLAN_OUTPUT_BOUNDS,
  isIntensitySession,
  sessionPaceZone,
  VOLUME_RULES,
  weeklyVolumeTargets,
  type PlanRaceGoal,
  type PlanSessionOutput,
  type WeeklyVolumeTarget,
} from '@/lib/ai/plan-schema';
import { trainingPacesFromRace } from '@/lib/metrics/vdot';
import { flattenSteps, PLAN_STEP_BOUNDS } from '@/lib/plan-steps/schema';

import { FITNESS_TEST_KIND } from './fitness-test';
import { intentQualitySlots, intentWalkRunBaseWeeks, type PlanIntent } from './intent';
import { buildPlanSkeleton, type SkeletonWeek } from './skeleton';

/*
 * ------------------------------------------------------------------------
 * Ce qu'une intention change, plan en main.
 * ------------------------------------------------------------------------
 *
 * `skeleton.test.ts` prouve que **toutes** les combinaisons produisent des
 * semaines valides ; ce fichier-ci dit ce qu'elles produisent. Les quatre
 * premiers cas sont des plans types écrits en toutes lettres — phases, créneaux,
 * zones, titres, kilomètres — parce que la seule façon de vérifier une structure
 * d'entraînement est de la lire. Ce sont eux qu'on relira dans six mois pour
 * savoir ce qu'un plan de reprise **est**.
 *
 * Les paramètres de ces structures, et la recherche qui les fonde, vivent dans
 * `intent.ts`. Ici, on constate.
 */

/** Une athlète ordinaire : 30 km par semaine, 5 h disponibles, endurance à 7:00/km. */
const ATHLETE = { recentWeeklyKm: 30, weeklyTimeMinutes: 300, easyPaceSecPerKm: 420 };

/** 16 semaines, 4 séances, sortie longue le dimanche : le plan type du chantier. */
const WEEKS = 16;
const SESSIONS = 4;

function targetsFor(race: PlanRaceGoal | null, weeks = WEEKS): WeeklyVolumeTarget[] {
  return weeklyVolumeTargets({
    weeks,
    firstWeekFromDay: 1,
    recentWeeklyKm: ATHLETE.recentWeeklyKm,
    weeklyTimeMinutes: ATHLETE.weeklyTimeMinutes,
    easyPaceSecPerKm: ATHLETE.easyPaceSecPerKm,
    race,
    level: 'intermediate',
  });
}

type SkeletonOptions = {
  race?: PlanRaceGoal | null;
  goalDistanceKm?: number | null;
  returnInjuryHistory?: boolean;
  longRunCapKm?: number | null;
  sessionsPerWeek?: number;
  weeks?: number;
  targets?: readonly WeeklyVolumeTarget[];
};

function skeletonFor(intent: PlanIntent, options: SkeletonOptions = {}): SkeletonWeek[] {
  const race = options.race ?? null;
  const weeks = options.weeks ?? WEEKS;
  return buildPlanSkeleton({
    intent,
    returnInjuryHistory: options.returnInjuryHistory,
    longRunCapKm: options.longRunCapKm,
    weeks,
    firstWeekFromDay: 1,
    sessionsPerWeek: options.sessionsPerWeek ?? SESSIONS,
    longRunDay: 7,
    level: 'intermediate',
    race,
    raceDay: race === null ? null : 7,
    goalDistanceKm: options.goalDistanceKm ?? null,
    targets: options.targets ?? targetsFor(race, weeks),
  });
}

/** `13,5` — la virgule décimale de l'UI française, au dixième comme les budgets. */
const km = (value: number | undefined): string => (value ?? 0).toFixed(1).replace('.', ',');

/**
 * Une semaine par ligne : phase, sortie longue, créneaux de qualité, footings.
 *
 * Tout ce qu'une intention décide tient dans cette ligne — et rien d'autre n'y
 * tient, ce qui est le but : un test qui figerait aussi les jours de la semaine
 * échouerait au premier réglage de placement, qui n'a rien à voir avec ce
 * fichier.
 */
function planTable(weeks: readonly SkeletonWeek[]): string[] {
  return weeks.map((week) => {
    const long = week.sessions.find(
      (session) => session.kind === 'Sortie longue' || session.kind === 'Course',
    );
    const quality =
      week.qualitySlots.map((slot) => `${slot.kind} ${km(slot.budgetKm)}`).join(' + ') || '—';
    const easy = week.sessions
      .filter((session) => session !== long)
      .map((session) => `${session.title} ${km(session.distanceKm)}`)
      .join(' · ');
    return (
      `S${String(week.weekNumber).padStart(2, '0')} ${week.phase.padEnd(8)} | ` +
      `${long?.title ?? '—'} ${km(long?.distanceKm)} | ${quality} | ${easy}`
    );
  });
}

describe('le plan type de chaque intention', () => {
  /*
   * `race` — la structure historique, celle que ce chantier ne devait pas
   * toucher : 30 % de base, 40 % de développement, 30 % de spécificité, deux
   * créneaux par semaine, la grille par famille de distance, la sortie longue
   * spécifique à partir du semi, puis l'affûtage et le jour J.
   */
  it('préparation d’un semi daté', () => {
    expect(
      planTable(skeletonFor('race', { race: { isMarathon: false }, goalDistanceKm: 21.0975 })),
    ).toEqual([
      'S01 base     | Sortie longue en endurance 13,5 | Répétitions 5,0 | Footing avec lignes droites 7,6 · Footing en endurance 9,3',
      'S02 base     | Sortie longue en endurance 14,5 | Répétitions 5,5 | Footing avec côtes courtes 8,2 · Footing en endurance 10,0',
      'S03 base     | Sortie longue en endurance 15,5 | Répétitions 5,5 | Footing avec lignes droites 8,9 · Footing en endurance 10,8',
      'S04 base     | Sortie longue en endurance 13,0 | Répétitions 5,0 | Footing avec côtes courtes 7,5 · Footing en endurance 9,0',
      'S05 build    | Sortie longue en endurance 14,8 | Seuil 5,5 + VMA 5,5 | Footing avec lignes droites 11,4',
      'S06 build    | Sortie longue, fin de parcours appuyée 16,0 | Seuil 6,0 + VMA 6,0 | Footing progressif 12,1',
      'S07 build    | Sortie longue en endurance 16,2 | Seuil 6,5 + VMA 6,5 | Footing avec lignes droites 11,5',
      'S08 build    | Sortie longue en endurance 13,8 | Seuil 5,5 + VMA 5,5 | Footing progressif 9,7',
      'S09 build    | Sortie longue, fin de parcours appuyée 14,8 | Seuil 6,0 + VMA 6,0 | Footing avec lignes droites 10,4',
      'S10 build    | Sortie longue en endurance 16,0 | Seuil 7,0 + VMA 7,0 | Footing progressif 10,1',
      'S11 specific | Sortie longue avec bloc à allure objectif 16,0 | Seuil 7,0 + Spécifique allure course 7,0 | Footing avec lignes droites 10,7',
      'S12 specific | Sortie longue avec bloc à allure objectif 13,5 | Seuil 6,0 + Spécifique allure course 6,0 | Footing progressif 9,0',
      'S13 specific | Sortie longue avec bloc à allure objectif 14,5 | Seuil 7,0 + Spécifique allure course 7,0 | Footing avec lignes droites 8,7',
      'S14 specific | Sortie longue avec bloc à allure objectif 15,5 | Seuil 7,5 + Spécifique allure course 7,5 | Footing progressif 9,6',
      'S15 taper    | Sortie longue en endurance 11,5 | Seuil 4,0 | Footing de récupération 6,6 · Footing de récupération 7,9',
      'S16 race     | Jour J : la course 7,5 | — | Footing de récupération 4,3 · Footing de récupération 4,9 · Footing de récupération 5,3',
    ]);
  });

  /*
   * `faster` — la même mécanique, sans date : pas d'affûtage, pas de semaine de
   * course, et surtout **aucune séance « Spécifique allure course »**. Le seuil
   * mène le développement (Scudamore 2017 ; Filipas 2022), la VMA prend la tête
   * en fin de cycle (Filipas 2022 ; Casado 2022).
   */
  it('courir plus vite, sans date', () => {
    expect(planTable(skeletonFor('faster'))).toEqual([
      'S01 base     | Sortie longue en endurance 13,5 | Répétitions 5,0 | Footing avec lignes droites 7,6 · Footing en endurance 9,3',
      'S02 base     | Sortie longue en endurance 14,5 | Répétitions 5,5 | Footing avec côtes courtes 8,2 · Footing en endurance 10,0',
      'S03 base     | Sortie longue en endurance 15,5 | Répétitions 5,5 | Footing avec lignes droites 8,9 · Footing en endurance 10,8',
      'S04 base     | Sortie longue en endurance 13,0 | Répétitions 5,0 | Footing avec côtes courtes 7,5 · Footing en endurance 9,0',
      // Le premier test tombe en S05, et pas à la fin de la base (S04) : c'est
      // la première semaine dont **tous** les jours sont à 28 jours ou plus du
      // départ, donc la première où la cadence de Daniels le rend évaluable
      // (`firstEvaluableTestWeek`). Le créneau qu'il remplace est le second de
      // la semaine — celui qui reste est le plus important des deux.
      'S05 build    | Sortie longue en endurance 14,8 | Seuil 5,5 | Footing avec lignes droites 9,4 · Test chronométré : 5 km à fond 7,5',
      'S06 build    | Sortie longue, fin de parcours appuyée 16,0 | Seuil 6,0 + VMA 6,0 | Footing progressif 12,1',
      'S07 build    | Sortie longue en endurance 16,2 | Seuil 6,5 + VMA 6,5 | Footing avec lignes droites 11,5',
      'S08 build    | Sortie longue en endurance 13,8 | Seuil 5,5 + VMA 5,5 | Footing progressif 9,7',
      'S09 build    | Sortie longue, fin de parcours appuyée 14,8 | Seuil 6,0 + VMA 6,0 | Footing avec lignes droites 10,4',
      'S10 build    | Sortie longue en endurance 16,0 | Seuil 6,5 | Footing progressif 10,1 · Test chronométré : 5 km à fond 7,5',
      'S11 build    | Sortie longue en endurance 16,2 | Seuil 7,0 + VMA 7,0 | Footing avec lignes droites 10,5',
      'S12 specific | Sortie longue, fin de parcours appuyée 13,8 | VMA 6,0 + Seuil 6,0 | Footing progressif 8,7',
      'S13 specific | Sortie longue en endurance 14,5 | VMA 6,5 + Seuil 6,5 | Footing avec lignes droites 9,7',
      'S14 specific | Sortie longue en endurance 15,5 | VMA 7,5 + Seuil 7,5 | Footing progressif 9,6',
      'S15 specific | Sortie longue, fin de parcours appuyée 15,5 | VMA 7,5 | Footing avec lignes droites 10,2 · Test chronométré : 5 km à fond 7,5',
      'S16 specific | Sortie longue en endurance 13,0 | VMA 6,5 + Seuil 6,5 | Footing progressif 8,5',
    ]);
  });

  /*
   * `weight_loss` — base longue, **build prolongé jusqu'au bout**, une seule
   * séance dure par semaine (VMA, pour la VO2max : Weeldreyer 2024), et une part
   * de qualité plate : les budgets de créneau ne montent pas, tout le reste du
   * volume est du facile, qui est l'actif à protéger.
   */
  it('perdre du poids', () => {
    expect(planTable(skeletonFor('weight_loss'))).toEqual([
      'S01 base     | Sortie longue en endurance 13,5 | Répétitions 5,0 | Footing avec lignes droites 7,6 · Footing en endurance 9,3',
      'S02 base     | Sortie longue en endurance 14,5 | Répétitions 5,5 | Footing avec côtes courtes 8,2 · Footing en endurance 10,0',
      'S03 base     | Sortie longue en endurance 15,5 | Répétitions 5,5 | Footing avec lignes droites 8,9 · Footing en endurance 10,8',
      'S04 base     | Sortie longue en endurance 13,0 | Répétitions 5,0 | Footing avec côtes courtes 7,5 · Footing en endurance 9,0',
      'S05 base     | Sortie longue en endurance 14,0 | Répétitions 5,0 | Footing avec lignes droites 8,2 · Footing en endurance 10,0',
      'S06 base     | Sortie longue en endurance 15,5 | — | Footing avec côtes courtes 7,7 · Test chronométré : 5 km à fond 7,5 · Footing en endurance 9,4',
      'S07 build    | Sortie longue en endurance 15,5 | VMA 5,5 | Footing avec lignes droites 8,9 · Footing en endurance 10,8',
      'S08 build    | Sortie longue en endurance 13,0 | VMA 5,0 | Footing en endurance 9,1 · Footing progressif 7,4',
      'S09 build    | Sortie longue, fin de parcours appuyée 14,0 | VMA 5,0 | Footing avec lignes droites 8,2 · Footing en endurance 10,0',
      'S10 build    | Sortie longue en endurance 15,5 | VMA 5,5 | Footing en endurance 10,6 · Footing progressif 8,5',
      'S11 build    | Sortie longue en endurance 15,5 | — | Footing avec lignes droites 8,0 · Test chronométré : 5 km à fond 7,5 · Footing en endurance 9,7',
      'S12 build    | Sortie longue, fin de parcours appuyée 13,0 | VMA 5,0 | Footing en endurance 9,1 · Footing progressif 7,4',
      'S13 build    | Sortie longue en endurance 14,0 | VMA 5,0 | Footing avec lignes droites 8,2 · Footing en endurance 10,0',
      'S14 build    | Sortie longue en endurance 15,5 | VMA 5,5 | Footing en endurance 10,6 · Footing progressif 8,5',
      'S15 build    | Sortie longue, fin de parcours appuyée 15,5 | VMA 5,5 | Footing avec lignes droites 8,9 · Footing en endurance 10,8',
      // Pas de troisième test en S16 : un test sur la dernière semaine d'un
      // plan n'a plus une seule semaine à recalibrer.
      'S16 build    | Sortie longue en endurance 13,0 | VMA 5,0 | Footing en endurance 9,1 · Footing progressif 7,4',
    ]);
  });

  /*
   * `return` — la moitié du plan en base, **aucune séance dure**, les deux
   * premières semaines en marche/course (Hottenrott 2016) **sortie longue
   * comprise**, et une sortie longue plafonnée à 30 % de la semaine au lieu de
   * 40 % (Frandsen 2025). Ce qui reste de vivacité : les lignes droites et les
   * côtes courtes des footings.
   *
   * La sortie longue de S01 et S02 porte le même format et le même ratio que les
   * footings de sa semaine, pour son propre kilométrage : une semaine dont tous
   * les footings alternent marche et course et dont la séance **la plus longue**
   * se courrait d'un trait ne suit aucune consigne — c'est le défaut mesuré au
   * chantier précédent (footings en marche/course et sortie longue continue de
   * 10,6 km à côté).
   */
  it('reprendre la course', () => {
    expect(planTable(skeletonFor('return'))).toEqual([
      'S01 base     | Marche/course : 17 × (200 m course / 400 m marche) 10,6 | — | Marche/course : 12 × (200 m course / 400 m marche) 7,5 · Marche/course : 13 × (200 m course / 400 m marche) 8,3 · Marche/course : 15 × (200 m course / 400 m marche) 9,0',
      'S02 base     | Marche/course : 19 × (400 m course / 200 m marche) 11,4 | — | Marche/course : 13 × (400 m course / 200 m marche) 8,0 · Marche/course : 15 × (400 m course / 200 m marche) 9,0 · Marche/course : 16 × (400 m course / 200 m marche) 9,8',
      'S03 base     | Sortie longue en endurance 12,2 | — | Footing avec lignes droites 8,5 · Footing en endurance 9,5 · Footing en endurance 10,5',
      'S04 base     | Sortie longue en endurance 10,3 | — | Footing avec côtes courtes 7,3 · Footing en endurance 8,1 · Footing en endurance 8,8',
      'S05 base     | Sortie longue en endurance 11,1 | — | Footing avec lignes droites 7,9 · Footing en endurance 8,7 · Footing en endurance 9,5',
      'S06 base     | Sortie longue en endurance 12,0 | — | Footing avec côtes courtes 8,5 · Footing en endurance 9,4 · Footing en endurance 10,2',
      'S07 base     | Sortie longue en endurance 12,2 | — | Footing avec lignes droites 8,5 · Footing en endurance 9,5 · Footing en endurance 10,5',
      'S08 base     | Sortie longue en endurance 10,3 | — | Footing avec côtes courtes 7,3 · Footing en endurance 8,1 · Footing en endurance 8,8',
      'S09 build    | Sortie longue, fin de parcours appuyée 11,1 | — | Footing avec lignes droites 7,9 · Footing en endurance 8,7 · Footing en endurance 9,5',
      'S10 build    | Sortie longue en endurance 12,0 | — | Footing en endurance 10,3 · Footing en endurance 9,4 · Footing progressif 8,4',
      'S11 build    | Sortie longue en endurance 12,2 | — | Footing avec lignes droites 8,5 · Footing en endurance 9,5 · Footing en endurance 10,5',
      'S12 build    | Sortie longue, fin de parcours appuyée 10,3 | — | Footing en endurance 8,9 · Footing en endurance 8,1 · Footing progressif 7,2',
      'S13 build    | Sortie longue en endurance 11,1 | — | Footing avec lignes droites 7,9 · Footing en endurance 8,7 · Footing en endurance 9,5',
      'S14 build    | Sortie longue en endurance 12,0 | — | Footing en endurance 10,3 · Footing en endurance 9,4 · Footing progressif 8,4',
      'S15 build    | Sortie longue, fin de parcours appuyée 12,2 | — | Footing avec lignes droites 8,5 · Footing en endurance 9,5 · Footing en endurance 10,5',
      'S16 build    | Sortie longue en endurance 10,3 | — | Footing en endurance 8,9 · Footing en endurance 8,1 · Footing progressif 7,2',
    ]);
  });

  /*
   * Le point commun des trois intentions sans date, énoncé une fois : aucune
   * séance ne prescrit l'allure d'une course. C'est le défaut de production que
   * ce chantier corrige, et il ne doit pas revenir par un autre chemin — un
   * titre de sortie longue, par exemple.
   */
  it('ne prescrit jamais d’allure de course sans course', () => {
    for (const intent of ['faster', 'weight_loss', 'return'] as const) {
      const skeleton = skeletonFor(intent);
      for (const week of skeleton) {
        for (const slot of week.qualitySlots) {
          expect(slot.zone, `${intent}, semaine ${week.weekNumber}`).not.toBe('marathon');
        }
        for (const session of week.sessions) {
          expect(session.title, `${intent}, semaine ${week.weekNumber}`).not.toContain(
            'allure objectif',
          );
          // Le test chronométré est la seule séance que `sessionPaceZone` range
          // hors endurance sans qu'aucune allure de course ne soit prescrite :
          // le classement ne sert qu'à donner l'endurance à son enveloppe, et
          // `TEST_KIND_PATTERN` lui coupe ensuite toute cible (vérifié dans
          // `plan-schema.test.ts`).
          if (session.kind === FITNESS_TEST_KIND) continue;
          expect(sessionPaceZone(session.kind), `${intent}, ${session.kind}`).not.toBe('marathon');
        }
      }
    }
  });

  it('donne à chaque intention le nombre de créneaux qu’elle veut', () => {
    // Le tableau du dossier, vérifié sur un plan réel plutôt que sur la seule
    // fonction : une intention peut vouloir deux créneaux et n'en obtenir qu'un
    // si sa phase ne propose qu'une zone.
    const slotsOf = (intent: PlanIntent): number[] => {
      const skeleton = skeletonFor(intent, {
        race: intent === 'race' ? { isMarathon: false } : null,
        goalDistanceKm: intent === 'race' ? 21.0975 : null,
      });
      return [...new Set(skeleton.map((week) => week.qualitySlots.length))].sort();
    };

    expect(slotsOf('race')).toEqual([0, 1, 2]); // base et affûtage à 1, course à 0
    // Le `0` de `weight_loss` est celui d'une **semaine de test** : le test
    // remplace un créneau de qualité, et une semaine qui n'en ouvrait qu'un (la
    // base, dont la grille ne propose qu'une zone) se retrouve sans créneau à
    // faire remplir par le modèle. `faster` n'en a plus : ses tests tombent tous
    // hors de la base, sur des semaines à deux créneaux, dont il en reste un.
    expect(slotsOf('faster')).toEqual([1, 2]);
    expect(slotsOf('weight_loss')).toEqual([0, 1]);
    expect(slotsOf('return')).toEqual([0]);

    // Et une débutante n'en reçoit jamais deux, sauf là où l'intention en veut un
    // seul de toute façon.
    for (const intent of ['race', 'faster'] as const) {
      expect(intentQualitySlots(intent, 'beginner'), intent).toBe(1);
      expect(intentQualitySlots(intent, 'advanced'), intent).toBe(2);
    }
    expect(intentQualitySlots('weight_loss', 'advanced')).toBe(1);
    expect(intentQualitySlots('return', 'advanced')).toBe(0);
  });
});

/*
 * ------------------------------------------------------------------------
 * La marche/course d'une reprise.
 * ------------------------------------------------------------------------
 *
 * Le seul format de reprise appuyé par un essai contrôlé randomisé (Hottenrott
 * 2016 : moins de douleurs et moins de fatigue à performance égale). C'est un
 * argument de **confort démontré**, pas de prévention — rien ici ne prétend
 * l'inverse.
 */
describe('la marche/course d’une reprise', () => {
  const walkRunSessions = (week: SkeletonWeek): PlanSessionOutput[] =>
    week.sessions.filter((session) => session.title.startsWith('Marche/course'));

  it('ne se prescrit que sur les premières semaines de base', () => {
    const skeleton = skeletonFor('return');
    const weeksWithWalkRun = skeleton
      .filter((week) => walkRunSessions(week).length > 0)
      .map((week) => week.weekNumber);

    expect(weeksWithWalkRun).toEqual([1, 2]);
    // **Toutes** les séances de ces semaines-là, sortie longue comprise : ce
    // n'est pas une variation qu'on saupoudre, c'est la forme de la semaine. La
    // sortie longue en était exclue, ce qui donnait une semaine 1 de reprise
    // dont la séance la plus coûteuse était la seule à se courir d'un trait.
    for (const weekNumber of weeksWithWalkRun) {
      const week = skeleton[weekNumber - 1];
      expect(walkRunSessions(week), `semaine ${weekNumber}`).toHaveLength(week.sessions.length);
      const longRun = week.sessions.find((session) => session.kind === 'Sortie longue');
      expect(longRun?.title, `semaine ${weekNumber}`).toMatch(/^Marche\/course/);
    }
  });

  it('donne à la sortie longue le ratio de sa semaine, sans toucher à son budget', () => {
    // Même rampe que les footings (1:2 puis 2:1), et le kilométrage de la
    // décomposition reste intact : la forme change, pas la charge.
    const skeleton = skeletonFor('return');
    const longRunOf = (index: number) =>
      skeleton[index].sessions.find((session) => session.kind === 'Sortie longue');

    expect(longRunOf(0)?.title).toContain('200 m course / 400 m marche');
    expect(longRunOf(1)?.title).toContain('400 m course / 200 m marche');
    expect(longRunOf(0)?.distanceKm).toBe(10.6);
    expect(longRunOf(1)?.distanceKm).toBe(11.4);
    // Et hors fenêtre, la sortie longue redevient une sortie longue.
    expect(longRunOf(2)?.title).toBe('Sortie longue en endurance');
  });

  it('double la fenêtre quand un antécédent de blessure est déclaré', () => {
    const skeleton = skeletonFor('return', { returnInjuryHistory: true });
    expect(
      skeleton.filter((week) => walkRunSessions(week).length > 0).map((week) => week.weekNumber),
    ).toEqual([1, 2, 3, 4]);
    expect(intentWalkRunBaseWeeks('return', true)).toBe(4);
    expect(intentWalkRunBaseWeeks('return', false)).toBe(2);
  });

  it('n’existe sous aucune autre intention', () => {
    for (const intent of ['race', 'faster', 'weight_loss'] as const) {
      const skeleton = skeletonFor(intent, {
        race: intent === 'race' ? { isMarathon: false } : null,
        // Même en réclamant un antécédent de blessure : le paramètre ne joue
        // qu'en reprise, et une préparation de course n'est pas une reprise.
        returnInjuryHistory: true,
      });
      for (const week of skeleton) {
        expect(walkRunSessions(week), `${intent}, semaine ${week.weekNumber}`).toEqual([]);
      }
    }
  });

  it('ouvre à 1:2 course/marche et finit à 2:1', () => {
    const first = walkRunSessions(skeletonFor('return')[0])[0];
    const last = walkRunSessions(skeletonFor('return')[1])[0];

    expect(first.title).toContain('200 m course / 400 m marche');
    expect(last.title).toContain('400 m course / 200 m marche');

    // Avec un antécédent, la fenêtre compte quatre semaines et passe par le 1:1.
    const long = skeletonFor('return', { returnInjuryHistory: true });
    expect(walkRunSessions(long[1])[0].title).toContain('300 m course / 300 m marche');
    expect(walkRunSessions(long[3])[0].title).toContain('400 m course / 200 m marche');
  });

  it('écrit un déroulé en distance qui couvre exactement la séance', () => {
    let checked = 0;
    for (const week of skeletonFor('return', { returnInjuryHistory: true })) {
      for (const session of walkRunSessions(week)) {
        checked += 1;
        const steps = flattenSteps(session.steps ?? []);
        const covered = steps.reduce((sum, step) => sum + (step.distanceM ?? 0), 0);
        // Le piège à 98,3 % : une étape en durée verrait sa couverture réécrire
        // la distance de la séance, et la semaine sortirait de sa cible.
        expect(covered, session.title).toBe(Math.round((session.distanceKm ?? 0) * 1_000));
        for (const step of steps) {
          expect(step.durationS, session.title).toBeNull();
          expect(step.distanceM ?? 0).toBeGreaterThanOrEqual(PLAN_STEP_BOUNDS.distanceM.min);
        }
        for (const block of session.steps ?? []) {
          expect(block.repeat).toBeLessThanOrEqual(PLAN_STEP_BOUNDS.repeat.max);
          // Tout bloc répété porte sa récupération — ici, la marche.
          if (block.repeat > 1) {
            expect(block.steps.map((step) => step.role)).toEqual(['run', 'recover']);
          }
        }
        expect(session.title.length).toBeLessThanOrEqual(PLAN_OUTPUT_BOUNDS.titleChars);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('dit « marche » en toutes lettres sur les étapes marchées', () => {
    const session = walkRunSessions(skeletonFor('return')[0])[0];
    const steps = flattenSteps(session.steps ?? []);

    for (const step of steps.filter((candidate) => candidate.role !== 'run')) {
      expect((step.note ?? '').toLowerCase()).toContain('march');
    }
  });

  /*
   * Une séance de marche/course reste une séance **facile** : son `kind` ne
   * bouge pas, donc `sessionPaceZone` la range en endurance et
   * `isIntensitySession` la laisse tranquille — sans quoi la validation lui
   * réclamerait un échauffement et le plan basculerait hors de sa répartition
   * 80/20.
   */
  it('reste une séance facile, et ses étapes marchées ne reçoivent aucune allure', () => {
    const paces = trainingPacesFromRace(10_000, 55 * 60);
    const skeleton = skeletonFor('return');
    const filled = skeleton.map((week) => ({ sessions: week.sessions }));
    const imposed = applyImposedPaces(filled, paces, null);

    for (const session of skeleton[0].sessions) {
      if (!session.title.startsWith('Marche/course')) continue;
      expect(sessionPaceZone(session.kind)).toBe('easy');
      expect(isIntensitySession(session)).toBe(false);
    }

    let checked = 0;
    for (const session of imposed[0].sessions) {
      if (!session.title.startsWith('Marche/course')) continue;
      for (const step of flattenSteps(session.steps ?? [])) {
        checked += 1;
        if (step.role === 'run') {
          expect(step.paceMinSecPerKm).toBe(paces.easy.minSecPerKm);
          expect(step.paceMaxSecPerKm).toBe(paces.easy.maxSecPerKm);
        } else {
          // Marche : aucune allure prescrite, la note dit tout. C'est le
          // comportement existant des étapes `recover` et de l'enveloppe d'une
          // séance facile, et il tombe juste ici.
          expect(step.paceMinSecPerKm).toBeNull();
          expect(step.paceMaxSecPerKm).toBeNull();
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/*
 * ------------------------------------------------------------------------
 * Le plafond de la sortie longue.
 * ------------------------------------------------------------------------
 *
 * Deux plafonds, une mécanique : celui que l'appelant calcule sur les données
 * réelles (la plus longue séance des trente derniers jours, majorée de 10 % —
 * Frandsen 2025) et celui que l'intention impose (30 % du volume en reprise).
 * Les deux se redistribuent aux footings, et les deux **cèdent** dès que la
 * semaine n'y survivrait pas.
 */
describe('le plafond de la sortie longue', () => {
  const longRunKm = (week: SkeletonWeek): number =>
    week.sessions.find((session) => session.kind === 'Sortie longue')?.distanceKm ?? 0;

  const weekTotalKm = (week: SkeletonWeek): number =>
    week.sessions.reduce((sum, session) => sum + (session.distanceKm ?? 0), 0) +
    week.qualitySlots.reduce((sum, slot) => sum + slot.budgetKm, 0);

  it('sans plafond, ne change rien au plan d’avant', () => {
    expect(skeletonFor('faster', { longRunCapKm: null })).toEqual(skeletonFor('faster'));
  });

  /*
   * Le cas nominal : une athlète dont la plus longue séance récente vaut 10 km,
   * donc un plafond à 11 km, sur un plan qui commencerait sinon par une sortie
   * longue de 13,5 km. Le plafond mord, puis se relâche de 10 % par semaine —
   * et la semaine 4, plus légère, repasse d'elle-même sous son plafond.
   */
  it('ramène la première sortie longue sous le plafond, puis la laisse monter de 10 %', () => {
    const capped = skeletonFor('faster', { longRunCapKm: 11 });
    const free = skeletonFor('faster');

    expect(longRunKm(free[0])).toBe(13.5);
    // S04 est une semaine allégée : sa sortie longue redescend d'elle-même, et
    // le plafond de S05 se mesure sur le **pic déjà couru** (13,3 km en S03), pas
    // sur les 13,0 km de la semaine d'avant — un rebond n'est pas un nouveau pic.
    expect(capped.slice(0, 6).map(longRunKm)).toEqual([11, 12.1, 13.3, 13, 14.6, 16]);

    // Aucune semaine ne dépasse de plus de 10 % le pic couru avant elle.
    let peak = 0;
    for (const week of capped) {
      const long = longRunKm(week);
      if (peak > 0) {
        expect(long, `semaine ${week.weekNumber}`).toBeLessThanOrEqual(peak * 1.1 + 1e-9);
      }
      peak = Math.max(peak, long);
    }
  });

  it('reverse l’excédent aux footings : la semaine tient sa cible au dixième', () => {
    const capped = skeletonFor('faster', { longRunCapKm: 11 });
    for (const week of capped) {
      expect(Math.round(weekTotalKm(week) * 10) / 10, `semaine ${week.weekNumber}`).toBe(
        week.target.targetKm,
      );
    }
  });

  /*
   * Le renoncement, et c'est le point le plus important de ce mécanisme : un
   * plafond ne casse jamais un invariant. À 4 séances, la sortie longue ne peut
   * céder que ~5 % du volume hebdomadaire avant qu'un footing ne devienne plus
   * long qu'elle — au-delà, la semaine repart telle quelle.
   */
  it('cède quand la redistribution ferait un footing plus long que la sortie longue', () => {
    // 6 km demandés sur un plan qui vise 35 km la première semaine : impossible.
    const capped = skeletonFor('faster', { longRunCapKm: 6 });
    expect(capped).toEqual(skeletonFor('faster'));
    expect(longRunKm(capped[0])).toBe(13.5);
  });

  it('n’écrase jamais un plafond tenable par un plafond intenable', () => {
    // Une reprise plafonnée à 6 km par l'appelant : ce plafond-là est
    // inapplicable, mais celui de l'intention (30 % du volume) tient, et c'est
    // lui qui doit s'appliquer. Prendre le minimum des deux rendait une sortie
    // longue **plus longue** que sans plafond du tout — 12,5 km au lieu de 10,6.
    const both = skeletonFor('return', { longRunCapKm: 6 });
    const shareOnly = skeletonFor('return');

    expect(longRunKm(both[0])).toBe(longRunKm(shareOnly[0]));
    expect(longRunKm(both[0])).toBe(10.6);
  });

  it('garde la sortie longue plus longue que toutes les autres séances', () => {
    for (const cap of [6, 8, 11, 14, null]) {
      for (const week of skeletonFor('faster', { longRunCapKm: cap })) {
        const long = longRunKm(week);
        for (const session of week.sessions) {
          expect(long, `plafond ${String(cap)}, semaine ${week.weekNumber}`).toBeGreaterThanOrEqual(
            session.distanceKm ?? 0,
          );
        }
        for (const slot of week.qualitySlots) {
          expect(long, `plafond ${String(cap)}, semaine ${week.weekNumber}`).toBeGreaterThanOrEqual(
            slot.budgetKm,
          );
        }
        // Et dans sa part réglementaire, qui est la seconde chose que le plafond
        // pourrait casser en la raccourcissant.
        expect(long / weekTotalKm(week)).toBeGreaterThanOrEqual(VOLUME_RULES.longRunShare.min);
      }
    }
  });

  /*
   * Le plafond de part, propre à la reprise : 30 % au lieu des 40 % de la règle
   * générale — mais il cède lui aussi, et il faut savoir où. À 2 ou 3 séances,
   * la sortie longue pèse structurellement 44 à 62 % du volume : la ramener à
   * 30 % ferait des footings plus longs qu'elle.
   */
  it('plafonne la sortie longue d’une reprise à 30 % — là où c’est possible', () => {
    for (const sessionsPerWeek of [4, 5, 6, 7]) {
      const skeleton = skeletonFor('return', { sessionsPerWeek });
      for (const week of skeleton) {
        expect(
          longRunKm(week) / weekTotalKm(week),
          `${sessionsPerWeek} séances, semaine ${week.weekNumber}`,
        ).toBeLessThanOrEqual(0.3 + 1e-9);
      }
    }

    // Et à 2 ou 3 séances, il cède — la sortie longue reprend la part que la
    // décomposition lui donne, parce qu'aucune autre ne tient debout.
    for (const sessionsPerWeek of [2, 3]) {
      const skeleton = skeletonFor('return', { sessionsPerWeek });
      const shares = skeleton.map((week) => longRunKm(week) / weekTotalKm(week));
      expect(Math.max(...shares), `${sessionsPerWeek} séances`).toBeGreaterThan(0.3);
    }
  });

  it('ne plafonne pas la part sous les autres intentions', () => {
    // 30 % est une décision de reprise, pas une règle générale : ailleurs, la
    // sortie longue garde les 40 % que la règle de volume autorise.
    const shares = skeletonFor('faster').map((week) => longRunKm(week) / weekTotalKm(week));
    expect(Math.max(...shares)).toBeGreaterThan(0.3);
  });
});
