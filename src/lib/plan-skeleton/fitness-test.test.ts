import { describe, expect, it } from 'vitest';

import { PLAN_OUTPUT_BOUNDS, weeklyVolumeTargets } from '@/lib/ai/plan-schema';
import type { SessionBudget } from '@/lib/ai/format';
import { REFERENCE_UPDATE_MIN_GAP_DAYS } from '@/lib/metrics/fitness-test';
import { flattenSteps } from '@/lib/plan-steps/schema';

import {
  firstEvaluableTestWeek,
  fitnessTestBudgets,
  fitnessTestSteps,
  fitnessTestWeekNumbers,
  FITNESS_TEST_CADENCE_WEEKS,
  FITNESS_TEST_KIND,
  FITNESS_TEST_SESSION_KM,
  pickFitnessTestDay,
} from './fitness-test';
import { PLAN_INTENTS, type PlanIntent } from './intent';
import { planPhases, type PlanPhase } from './phases';
import { buildPlanSkeleton } from './skeleton';

/*
 * Ce que ce fichier prouve : **où** un test tombe, **ce qu'il coûte** à la
 * semaine, et **ce qu'il se court**. Le fait que les semaines qui le portent
 * restent valides est prouvé ailleurs, par le balayage de `skeleton.test.ts` —
 * ici on lit la structure.
 */

/** Les phases d'un plan sans date, tel que `planPhases` les calcule. */
function phasesOf(intent: PlanIntent, weeks: number, firstWeekFromDay = 1): PlanPhase[] {
  return planPhases({ intent, weeks, firstWeekFromDay, race: null });
}

describe('firstEvaluableTestWeek', () => {
  it('exige au moins la cadence de Daniels depuis le premier jour du plan', () => {
    // Le jour le plus tôt de la semaine `N` tombe `(N − 1) × 7 − (départ − 1)`
    // jours après le départ : c'est lui qui doit déjà satisfaire la cadence.
    for (let firstWeekFromDay = 1; firstWeekFromDay <= 7; firstWeekFromDay += 1) {
      const week = firstEvaluableTestWeek(firstWeekFromDay);
      const earliest = (week - 1) * 7 - (firstWeekFromDay - 1);
      expect(earliest, `départ jour ${firstWeekFromDay}`).toBeGreaterThanOrEqual(
        REFERENCE_UPDATE_MIN_GAP_DAYS,
      );
      // Et pas une semaine de plus que nécessaire : la semaine précédente ne
      // satisferait pas la cadence.
      expect((week - 2) * 7 - (firstWeekFromDay - 1), `départ jour ${firstWeekFromDay}`).toBeLessThan(
        REFERENCE_UPDATE_MIN_GAP_DAYS,
      );
    }
  });

  it('vaut la semaine 5 pour un départ le lundi, la 6 pour tous les autres', () => {
    expect(firstEvaluableTestWeek(1)).toBe(5);
    for (let firstWeekFromDay = 2; firstWeekFromDay <= 7; firstWeekFromDay += 1) {
      expect(firstEvaluableTestWeek(firstWeekFromDay), `départ jour ${firstWeekFromDay}`).toBe(6);
    }
  });
});

describe('fitnessTestWeekNumbers', () => {
  it('pose le premier test à la fin de la phase de base, puis tous les cinq semaines', () => {
    // 16 semaines de `faster` : 25 % de base, soit quatre semaines (S01–S04),
    // toutes sous la première semaine évaluable. Le test glisse donc à S05, la
    // première que la cadence de Daniels autorise pour un départ le lundi.
    const phases = phasesOf('faster', 16);
    expect(phases.filter((phase) => phase === 'base')).toHaveLength(4);

    expect(fitnessTestWeekNumbers('faster', phases, 1)).toEqual([5, 10, 15]);
  });

  it('n’en programme aucun sous les intentions qui n’en veulent pas', () => {
    for (const intent of ['race', 'return'] as const) {
      const phases = planPhases({
        intent,
        weeks: 16,
        firstWeekFromDay: 1,
        race: intent === 'race' ? { isMarathon: false } : null,
      });
      expect(fitnessTestWeekNumbers(intent, phases, 1), intent).toEqual([]);
    }
  });

  /*
   * Les quatre invariants de placement, balayés sur tout ce qu'un plan peut
   * être : chacun a été demandé nommément, et chacun se lit ici sur la
   * périodisation réelle plutôt que sur la fonction seule.
   */
  it('respecte ses quatre bornes sur toutes les durées et toutes les intentions', () => {
    for (const intent of PLAN_INTENTS) {
      for (let weeks = 1; weeks <= 30; weeks += 1) {
        for (const firstWeekFromDay of [1, 4]) {
          const race = intent === 'race' ? { isMarathon: false } : null;
          const phases = planPhases({ intent, weeks, firstWeekFromDay, race });
          const tests = fitnessTestWeekNumbers(intent, phases, firstWeekFromDay);
          const where = `${intent}, ${weeks} semaines, départ jour ${firstWeekFromDay}`;

          for (const week of tests) {
            // 1. Jamais avant la première semaine évaluable — donc jamais dans
            //    la première, entamée ou non.
            expect(week, where).toBeGreaterThanOrEqual(firstEvaluableTestWeek(firstWeekFromDay));
            // 2. Jamais sur la dernière semaine du plan.
            expect(week, where).toBeLessThan(weeks);
            // 3. Jamais en affûtage, en semaine de course ni en semaine entamée.
            expect(phases[week - 1], `${where}, S${week}`).not.toBe('taper');
            expect(phases[week - 1], `${where}, S${week}`).not.toBe('race');
            expect(phases[week - 1], `${where}, S${week}`).not.toBe('partial');
          }

          // 4. Jamais deux tests à moins de la cadence d'intervalle — cinq
          //    semaines, soit 29 jours au pire écart de placement, donc jamais
          //    moins que la cadence de Daniels.
          for (let index = 1; index < tests.length; index += 1) {
            expect(tests[index] - tests[index - 1], where).toBeGreaterThanOrEqual(
              FITNESS_TEST_CADENCE_WEEKS,
            );
          }
        }
      }
    }
  });

  it('n’en programme aucun sur un plan trop court pour en porter un', () => {
    // Cinq semaines : la seule semaine qui passerait le plancher est la
    // dernière, et la dernière ne porte jamais de test.
    expect(fitnessTestWeekNumbers('faster', phasesOf('faster', 5), 1)).toEqual([]);
    expect(fitnessTestWeekNumbers('faster', phasesOf('faster', 2), 1)).toEqual([]);
  });

  it('décale le premier test quand la base est entièrement sous le plancher', () => {
    // Sept semaines de `faster` : la base tient sur S01–S02, toutes deux sous la
    // première semaine évaluable. Le test glisse à la première semaine éligible,
    // S05 pour un départ le lundi.
    const phases = phasesOf('faster', 7);
    expect(phases.filter((phase) => phase === 'base')).toHaveLength(2);
    expect(fitnessTestWeekNumbers('faster', phases, 1)).toEqual([5]);
  });

  it('recule le premier test d’une semaine quand le plan ne démarre pas un lundi', () => {
    // Même plan, départ le jeudi : la semaine 5 ne laisse plus que 25 jours
    // depuis le départ dans le pire placement, la cadence en exige 28.
    const phases = phasesOf('faster', 16, 4);
    expect(fitnessTestWeekNumbers('faster', phases, 4)).toEqual([6, 11]);
  });

  it('saute ce que la périodisation refuse au lieu d’avancer d’un cran', () => {
    // Une périodisation fabriquée : la semaine que la cadence viserait (S10)
    // est un affûtage. Le test suivant se pose donc plus loin, jamais plus tôt.
    const phases: PlanPhase[] = [
      'base',
      'base',
      'base',
      'base',
      'base',
      'build',
      'build',
      'build',
      'build',
      'taper',
      'build',
      'build',
      'build',
    ];
    expect(fitnessTestWeekNumbers('faster', phases, 1)).toEqual([5, 11]);
    expect(phases[9]).toBe('taper');
  });
});

/*
 * Le défaut que ce bloc existe pour fermer : le placement se décidait en
 * **semaines**, la cadence se vérifie en **jours**, et rien n'alignait les deux
 * unités. Chaque premier test partait donc en `too-soon` — un 5 km à fond
 * prescrit, un créneau de qualité dépensé pour le financer, et le résultat jeté.
 *
 * Ce test-ci prend les deux bouts ensemble : ce que `buildPlanSkeleton` **pose**
 * réellement (semaine et jour compris), et ce que `fitnessTestVerdict`
 * **exigera** de l'écart en jours.
 */
describe('un test posé est un test évaluable', () => {
  /** Les jours écoulés entre le départ du plan et chaque test que le squelette pose. */
  function testDays(params: {
    intent: PlanIntent;
    weeks: number;
    firstWeekFromDay: number;
    sessionsPerWeek: number;
    longRunDay: number;
  }): number[] {
    const { intent, weeks, firstWeekFromDay, sessionsPerWeek, longRunDay } = params;
    const race = intent === 'race' ? ({ isMarathon: false } as const) : null;

    const skeleton = buildPlanSkeleton({
      intent,
      weeks,
      firstWeekFromDay,
      sessionsPerWeek,
      longRunDay,
      level: 'intermediate',
      race,
      raceDay: race === null ? null : longRunDay,
      goalDistanceKm: null,
      targets: weeklyVolumeTargets({
        weeks,
        firstWeekFromDay,
        recentWeeklyKm: 40,
        weeklyTimeMinutes: 400,
        easyPaceSecPerKm: 420,
        race,
        level: 'intermediate',
      }),
    });

    const days: number[] = [];
    for (const week of skeleton) {
      const test = week.sessions.find((session) => session.kind === FITNESS_TEST_KIND);
      if (test === undefined) continue;
      // La semaine `N` du plan commence `(N − 1) × 7` jours après l'ancre (le
      // lundi de la semaine du départ), et le départ est `firstWeekFromDay − 1`
      // jours après cette même ancre. C'est l'arithmétique de
      // `mapPlanWeeksToSessions`, qui pose les séances depuis l'ancre.
      days.push((week.weekNumber - 1) * 7 + test.day - firstWeekFromDay);
    }
    return days;
  }

  it('laisse la cadence de Daniels s’écouler avant le premier test, quel que soit le jour de départ', () => {
    for (const intent of PLAN_INTENTS) {
      for (let weeks = 1; weeks <= 30; weeks += 1) {
        for (let firstWeekFromDay = 1; firstWeekFromDay <= 7; firstWeekFromDay += 1) {
          for (const sessionsPerWeek of [3, 4, 5, 6, 7]) {
            for (const longRunDay of [1, 3, 6, 7]) {
              const where =
                `${intent}, ${weeks} semaines, départ jour ${firstWeekFromDay}, ` +
                `${sessionsPerWeek} séances, sortie longue j${longRunDay}`;
              const days = testDays({
                intent,
                weeks,
                firstWeekFromDay,
                sessionsPerWeek,
                longRunDay,
              });

              for (const elapsed of days) {
                expect(elapsed, where).toBeGreaterThanOrEqual(REFERENCE_UPDATE_MIN_GAP_DAYS);
              }
              // Et entre deux tests, le même écart : c'est la cadence de cinq
              // semaines qui le tient, mais le jour de placement peut bouger
              // d'une semaine à l'autre.
              for (let index = 1; index < days.length; index += 1) {
                expect(days[index] - days[index - 1], where).toBeGreaterThanOrEqual(
                  REFERENCE_UPDATE_MIN_GAP_DAYS,
                );
              }
            }
          }
        }
      }
    }
  });

  it('garde un test sur un plan de huit semaines', () => {
    // Le plan le plus court qui en porte encore un, dans les deux cas de départ.
    // Sans cette borne, la fonctionnalité entière serait morte sur ce format.
    expect(testDays({
      intent: 'faster',
      weeks: 8,
      firstWeekFromDay: 1,
      sessionsPerWeek: 4,
      longRunDay: 7,
    })).toHaveLength(1);
    expect(testDays({
      intent: 'faster',
      weeks: 8,
      firstWeekFromDay: 7,
      sessionsPerWeek: 4,
      longRunDay: 7,
    })).toHaveLength(1);
  });
});

describe('fitnessTestSteps', () => {
  it('couvre exactement la distance de la séance, en distance et sans cible', () => {
    const steps = fitnessTestSteps();
    const flat = flattenSteps(steps);

    const covered = flat.reduce((sum, step) => sum + (step.distanceM ?? 0), 0);
    expect(covered).toBe(Math.round(FITNESS_TEST_SESSION_KM * 1_000));

    for (const step of flat) {
      // Le déroulé se mesure en distance : c'est la condition pour que le
      // volume de la semaine tienne une fois `imposedDistanceKm` passé.
      expect(step.durationS).toBeNull();
      expect(step.distanceM).not.toBeNull();
      // Aucune allure ni zone écrite à la source : c'est le post-traitement qui
      // les pose — et, pour un test, qui n'en pose aucune sur l'effort.
      expect(step.paceMinSecPerKm).toBeNull();
      expect(step.hrZone).toBeNull();
    }
  });

  it('encadre les 5 km d’un échauffement et d’un retour au calme', () => {
    const flat = flattenSteps(fitnessTestSteps());
    expect(flat.map((step) => step.role)).toEqual(['warmup', 'run', 'cooldown']);
    expect(flat[1].distanceM).toBe(5_000);
  });
});

describe('fitnessTestBudgets', () => {
  /** La semaine type de l'utilisatrice : 30 km, 4 séances, un créneau de qualité. */
  const WEEK: SessionBudget[] = [
    { role: 'long', km: 11 },
    { role: 'quality', km: 4.5 },
    { role: 'easy', km: 7.3 },
    { role: 'easy', km: 7.2 },
  ];
  const TARGET_KM = 30;

  it('donne au test son coût réel sans bouger la somme de la semaine', () => {
    const budgets = fitnessTestBudgets(WEEK);
    expect(budgets).not.toBeNull();
    if (budgets === null) return;

    expect(budgets.find((budget) => budget.role === 'quality')?.km).toBe(FITNESS_TEST_SESSION_KM);
    const total = budgets.reduce((sum, budget) => sum + budget.km, 0);
    expect(total).toBeCloseTo(TARGET_KM, 6);
  });

  it('prend la différence aux footings, jamais à la sortie longue', () => {
    const budgets = fitnessTestBudgets(WEEK) ?? [];

    expect(budgets.find((budget) => budget.role === 'long')?.km).toBe(11);
    expect(budgets.filter((budget) => budget.role === 'easy').map((budget) => budget.km)).toEqual([
      5.8, 5.7,
    ]);
  });

  it('renonce quand la sortie longue ne serait plus la séance la plus longue', () => {
    // Une semaine à petit volume : 7,5 km de test dépasseraient la sortie
    // longue, et la validation refuserait la semaine.
    const small: SessionBudget[] = [
      { role: 'long', km: 6 },
      { role: 'quality', km: 2.5 },
      { role: 'easy', km: 3.5 },
      { role: 'easy', km: 3 },
    ];
    expect(fitnessTestBudgets(small)).toBeNull();
  });

  it('renonce quand un footing passerait sous la plus petite distance du contrat', () => {
    const tight: SessionBudget[] = [
      { role: 'long', km: 12 },
      { role: 'quality', km: 3 },
      { role: 'easy', km: 3 },
    ];
    const budgets = fitnessTestBudgets(tight);
    expect(budgets).toBeNull();
    // Et c'est bien le plancher qui refuse : 3 − 4,5 km serait négatif.
    expect(PLAN_OUTPUT_BOUNDS.distanceKm.min).toBeGreaterThan(0);
  });

  it('renonce quand la semaine n’a ni créneau de qualité ni footing', () => {
    expect(fitnessTestBudgets([{ role: 'long', km: 12 }])).toBeNull();
    expect(
      fitnessTestBudgets([
        { role: 'long', km: 12 },
        { role: 'quality', km: 5 },
      ]),
    ).toBeNull();
  });

  it('ne convertit qu’un seul créneau quand la semaine en porte deux', () => {
    const two: SessionBudget[] = [
      { role: 'long', km: 14 },
      { role: 'quality', km: 6 },
      { role: 'quality', km: 6 },
      { role: 'easy', km: 10 },
    ];
    const budgets = fitnessTestBudgets(two) ?? [];
    expect(budgets.filter((budget) => budget.role === 'quality').map((budget) => budget.km)).toEqual(
      [FITNESS_TEST_SESSION_KM, 6],
    );
    expect(budgets.reduce((sum, budget) => sum + budget.km, 0)).toBeCloseTo(36, 6);
  });
});

describe('pickFitnessTestDay', () => {
  it('choisit le jour de qualité le plus éloigné du jour dur précédent', () => {
    // Sortie longue le dimanche, qualité mardi et vendredi : le mardi n'a que
    // deux jours depuis le dimanche, le vendredi en a trois.
    expect(pickFitnessTestDay([2, 5], [7, 2, 5])).toBe(5);
  });

  it('compte la semaine comme circulaire : un lundi suit un dimanche', () => {
    // Sortie longue le dimanche, qualité lundi et jeudi : le lundi est le
    // lendemain de la sortie longue, le jeudi est à quatre jours.
    expect(pickFitnessTestDay([1, 4], [7, 1, 4])).toBe(4);
  });

  it('départage à égalité par le jour le plus tôt, et reste déterministe', () => {
    // Deux candidats à écart égal du seul jour dur : le plus tôt gagne, deux
    // fois de suite.
    expect(pickFitnessTestDay([2, 5], [2, 5])).toBe(2);
    expect(pickFitnessTestDay([2, 5], [2, 5])).toBe(2);
  });

  it('ne rend rien quand la semaine ne pose aucune qualité', () => {
    expect(pickFitnessTestDay([], [7])).toBeNull();
  });
});

describe('le test dans le squelette', () => {
  const WEEKS = 16;

  const targets = weeklyVolumeTargets({
    weeks: WEEKS,
    firstWeekFromDay: 1,
    recentWeeklyKm: 30,
    weeklyTimeMinutes: 300,
    easyPaceSecPerKm: 420,
    race: null,
    level: 'intermediate',
  });

  const skeleton = buildPlanSkeleton({
    intent: 'faster',
    weeks: WEEKS,
    firstWeekFromDay: 1,
    sessionsPerWeek: 4,
    longRunDay: 7,
    level: 'intermediate',
    race: null,
    raceDay: null,
    goalDistanceKm: null,
    targets,
  });

  const testWeeks = skeleton.filter((week) =>
    week.sessions.some((session) => session.kind === 'Test 5 km'),
  );

  it('écrit un test aux semaines que la périodisation désigne', () => {
    expect(testWeeks.map((week) => week.weekNumber)).toEqual(
      fitnessTestWeekNumbers('faster', phasesOf('faster', WEEKS), 1),
    );
  });

  it('remplace un créneau de qualité au lieu de s’y ajouter', () => {
    for (const week of testWeeks) {
      const ordinary = skeleton.find(
        (other) => other.phase === week.phase && other.qualitySlots.length > 0 && other !== week,
      );
      expect(ordinary, `semaine ${week.weekNumber}`).toBeDefined();
      // Une séance dure de plus, une séance de qualité de moins : le compte de
      // séances de la semaine, lui, ne change pas.
      expect(
        week.sessions.length + week.qualitySlots.length,
        `semaine ${week.weekNumber}`,
      ).toBe(4);
    }
  });

  it('laisse la semaine sur sa cible, au dixième près', () => {
    for (const week of testWeeks) {
      const total = [
        ...week.sessions.map((session) => session.distanceKm ?? 0),
        ...week.qualitySlots.map((slot) => slot.budgetKm),
      ].reduce((sum, km) => sum + km, 0);
      expect(total, `semaine ${week.weekNumber}`).toBeCloseTo(week.target.targetKm, 1);
    }
  });

  it('ne pose jamais le test le lendemain d’un autre jour dur', () => {
    for (const week of testWeeks) {
      const test = week.sessions.find((session) => session.kind === 'Test 5 km');
      expect(test, `semaine ${week.weekNumber}`).toBeDefined();
      if (test === undefined) continue;

      const eve = test.day === 1 ? 7 : test.day - 1;
      const hardDays = [
        ...week.sessions
          .filter((session) => session.kind === 'Sortie longue')
          .map((session) => session.day),
        ...week.qualitySlots.map((slot) => slot.day),
      ];
      expect(hardDays, `semaine ${week.weekNumber}`).not.toContain(eve);
    }
  });

  it('espace les tests d’au moins la cadence sur ce plan-là', () => {
    const numbers = testWeeks.map((week) => week.weekNumber);
    for (let index = 1; index < numbers.length; index += 1) {
      expect(numbers[index] - numbers[index - 1]).toBeGreaterThanOrEqual(
        FITNESS_TEST_CADENCE_WEEKS,
      );
    }
  });
});
