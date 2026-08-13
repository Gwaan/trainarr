import { describe, expect, it } from 'vitest';

import { isIntensitySession, PLAN_OUTPUT_BOUNDS, weeklyVolumeTargets } from '@/lib/ai/plan-schema';
import type { PlanLevel } from '@/data/db/schema';
import type { SessionBudget } from '@/lib/ai/format';
import { REFERENCE_UPDATE_MIN_GAP_DAYS } from '@/lib/metrics/fitness-test';
import { flattenSteps } from '@/lib/plan-steps/schema';

import {
  firstEvaluableTestWeek,
  fitnessTestBudgets,
  fitnessTestSteps,
  fitnessTestWeekNumbers,
  FITNESS_TEST_CADENCE_WEEKS,
  FITNESS_TEST_EFFORT_M,
  FITNESS_TEST_KIND,
  FITNESS_TEST_SESSION_KM,
  pickFitnessTestDay,
} from './fitness-test';
import { intentRunsFitnessTests, PLAN_INTENTS, type PlanIntent } from './intent';
import { planPhases, type PlanPhase } from './phases';
import { sessionEffortKm } from './quality-load';
import { qualitySessionTemplate } from './quality-template';
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
  it('pose le premier test à la fin de la phase de base, puis toutes les quatre semaines', () => {
    // 16 semaines de `faster` : 25 % de base, soit quatre semaines (S01–S04),
    // toutes sous la première semaine évaluable. Le test glisse donc à S05, la
    // première que la cadence de Daniels autorise pour un départ le lundi.
    const phases = phasesOf('faster', 16);
    expect(phases.filter((phase) => phase === 'base')).toHaveLength(4);

    // Quatre semaines d'écart, comme la règle de mise à jour du chrono
    // (`REFERENCE_UPDATE_MIN_GAP_DAYS`) : S05, S09, S13.
    expect(fitnessTestWeekNumbers('faster', phases, 1)).toEqual([5, 9, 13]);
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

          // 4. Jamais deux tests à moins de la cadence d'intervalle — quatre
          //    semaines, soit 28 jours au jour de placement près. C'est le
          //    squelette qui referme cet écart-là en jours (bloc suivant) ;
          //    ici on ne lit que la périodisation.
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
    expect(fitnessTestWeekNumbers('faster', phases, 4)).toEqual([6, 10, 14]);
  });

  it('saute ce que la périodisation refuse au lieu d’avancer d’un cran', () => {
    // Une périodisation fabriquée : la semaine que la cadence viserait (S09)
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
      'taper',
      'build',
      'build',
      'build',
      'build',
    ];
    expect(fitnessTestWeekNumbers('faster', phases, 1)).toEqual([5, 10]);
    expect(phases[8]).toBe('taper');
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
 *
 * ## Ce que le passage à quatre semaines lui ajoute
 *
 * Tant que la cadence valait cinq semaines, l'écart entre deux tests était tenu
 * par construction : 29 jours au pire glissement de jour, contre 28 exigés. Le
 * seul bord qui pouvait mordre était le **premier** test, compté depuis le
 * départ du plan.
 *
 * À quatre semaines, l'écart tombe **pile** sur 28 : un test posé un jeudi et le
 * suivant un mardi feraient 26 jours, et le second partirait en `too-soon`. Ce
 * bloc balaie donc tout ce dont le jour retenu dépend — jour de sortie longue,
 * nombre de séances, niveau, phase de la semaine — et vérifie l'écart **entre
 * tests consécutifs**, en jours, pas seulement le premier.
 *
 * Le balayage sonde 44 100 plans. Mesuré sur le code de ce commit : aucun
 * glissement de jour vers l'amont (le jour retenu est constant ou plus tardif),
 * écart minimal observé **exactement 28 jours** — aucune marge. C'est
 * précisément pourquoi ce test existe : la moindre évolution de
 * `pickFitnessTestDay` ou de `placeSessionDays` qui avancerait un jour d'un cran
 * casserait la fonctionnalité en silence, et casse ce test à la place.
 */
describe('un test posé est un test évaluable', () => {
  /**
   * Les jours écoulés entre le départ du plan et chaque test que le squelette
   * pose. Tout ce dont le **jour** retenu dépend est un paramètre : c'est là que
   * l'écart de quatre semaines se joue.
   */
  function testDays(params: {
    intent: PlanIntent;
    weeks: number;
    firstWeekFromDay: number;
    sessionsPerWeek: number;
    longRunDay: number;
    level?: PlanLevel;
    goalDistanceKm?: number | null;
  }): number[] {
    const { intent, weeks, firstWeekFromDay, sessionsPerWeek, longRunDay } = params;
    const level = params.level ?? 'intermediate';
    const race = intent === 'race' ? ({ isMarathon: false } as const) : null;

    const skeleton = buildPlanSkeleton({
      intent,
      weeks,
      firstWeekFromDay,
      sessionsPerWeek,
      longRunDay,
      level,
      race,
      raceDay: race === null ? null : longRunDay,
      goalDistanceKm: params.goalDistanceKm ?? null,
      targets: weeklyVolumeTargets({
        weeks,
        firstWeekFromDay,
        recentWeeklyKm: 40,
        weeklyTimeMinutes: 400,
        easyPaceSecPerKm: 420,
        race,
        level,
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

  it('laisse la cadence de Daniels s’écouler avant chaque test, en jours et sur tout le domaine', () => {
    // Les intentions qui n'en programment aucun n'ont rien à prouver ici, et
    // leur balayage triplerait le coût pour zéro test posé.
    const intents = PLAN_INTENTS.filter(intentRunsFitnessTests);
    expect(intents.length).toBeGreaterThan(0);

    let placed = 0;
    for (const intent of intents) {
      for (let weeks = 1; weeks <= 30; weeks += 1) {
        for (let firstWeekFromDay = 1; firstWeekFromDay <= 7; firstWeekFromDay += 1) {
          for (const sessionsPerWeek of [3, 4, 5, 6, 7]) {
            for (let longRunDay = 1; longRunDay <= 7; longRunDay += 1) {
              // Le niveau change le nombre de créneaux de qualité, donc les
              // jours durs de la semaine, donc le jour que le test peut prendre.
              for (const level of ['beginner', 'intermediate', 'advanced'] as const) {
                const where =
                  `${intent}, ${weeks} semaines, départ jour ${firstWeekFromDay}, ` +
                  `${sessionsPerWeek} séances, sortie longue j${longRunDay}, ${level}`;
                const days = testDays({
                  intent,
                  weeks,
                  firstWeekFromDay,
                  sessionsPerWeek,
                  longRunDay,
                  level,
                });
                placed += days.length;

                // Le premier test se compte depuis le **départ du plan**, où le
                // chrono de référence a été déclaré.
                for (const elapsed of days) {
                  expect(elapsed, where).toBeGreaterThanOrEqual(REFERENCE_UPDATE_MIN_GAP_DAYS);
                }
                // Et entre deux tests consécutifs, le même écart — **en jours**,
                // semaine et jour de placement pris ensemble. C'est ce que la
                // cadence de quatre semaines ne tient plus seule.
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
    }

    // Un balayage qui ne poserait aucun test passerait sans rien prouver.
    expect(placed).toBeGreaterThan(10_000);
    // 44 100 squelettes complets : au-delà des 5 s par défaut dès que la suite
    // tourne en parallèle, comme le balayage de `skeleton.test.ts`.
  }, 120_000);

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

  /*
   * L'écart en jours doit être une propriété de **`buildPlanSkeleton`**, pas une
   * coïncidence de la périodisation.
   *
   * Le balayage ci-dessus ne peut pas le prouver : sur le code de ce commit, le
   * jour retenu ne recule jamais, donc quatre semaines valent toujours 28 jours
   * pile et le garde-fou ne se déclenche pas une seule fois. Il resterait vert si
   * on retirait le garde-fou — vérifié.
   *
   * Ce test-ci le déclenche pour de bon, en désignant les semaines de test
   * directement (`testWeeks`, le chemin qu'emprunte une reconstruction). Des
   * semaines trop rapprochées sont un cas que `fitnessTestWeekNumbers` ne produit
   * pas, et c'est justement le point : le squelette ne doit **jamais** écrire un
   * test que `fitnessTestVerdict` rejettera, quelle que soit la liste qu'on lui
   * donne.
   */
  it('n’écrit jamais deux tests à moins de la cadence, quelles que soient les semaines désignées', () => {
    const weeks = 20;
    let refused = 0;
    let written = 0;

    for (let spacing = 1; spacing <= 5; spacing += 1) {
      for (const sessionsPerWeek of [3, 4, 5, 6]) {
        for (const longRunDay of [3, 6, 7]) {
          const testWeeks: number[] = [];
          for (let week = 6; week < weeks; week += spacing) testWeeks.push(week);

          const skeleton = buildPlanSkeleton({
            intent: 'faster',
            weeks,
            firstWeekFromDay: 1,
            sessionsPerWeek,
            longRunDay,
            level: 'intermediate',
            race: null,
            raceDay: null,
            goalDistanceKm: null,
            testWeeks,
            targets: weeklyVolumeTargets({
              weeks,
              firstWeekFromDay: 1,
              recentWeeklyKm: 40,
              weeklyTimeMinutes: 400,
              easyPaceSecPerKm: 420,
              race: null,
              level: 'intermediate',
            }),
          });

          const placed: number[] = [];
          for (const week of skeleton) {
            const test = week.sessions.find((session) => session.kind === FITNESS_TEST_KIND);
            if (test === undefined) continue;
            placed.push((week.weekNumber - 1) * 7 + test.day - 1);
          }

          const where = `espacement ${spacing}, ${sessionsPerWeek} séances, sortie longue j${longRunDay}`;
          for (let index = 1; index < placed.length; index += 1) {
            expect(placed[index] - placed[index - 1], where).toBeGreaterThanOrEqual(
              REFERENCE_UPDATE_MIN_GAP_DAYS,
            );
          }
          written += placed.length;
          refused += testWeeks.length - placed.length;
        }
      }
    }

    // Le garde-fou a bien mordu : sans lui, toutes les semaines désignées
    // porteraient un test, y compris celles espacées d'une seule semaine.
    expect(refused).toBeGreaterThan(0);
    expect(written).toBeGreaterThan(0);
  });

  it('pose bien les tests à 28 jours, et pas un de plus, sur seize semaines', () => {
    // Le plan de référence du chantier : trois mesures au lieu de trois, mais
    // quatre semaines plus tôt chacune — S05, S09, S13 au lieu de S05, S10, S15.
    // L'écart réel est de 28 jours pile, ce que seule la stabilité du jour
    // retenu (jeudi à chaque fois) rend possible.
    expect(
      testDays({
        intent: 'faster',
        weeks: 16,
        firstWeekFromDay: 1,
        sessionsPerWeek: 4,
        longRunDay: 7,
      }),
    ).toEqual([32, 60, 88]);
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

  it('efface les autres créneaux de qualité et rend leurs kilomètres aux footings', () => {
    // La semaine de test ne porte **que** le test comme séance dure : le second
    // créneau devient un footing, et le pot des footings se repartage à égalité.
    const two: SessionBudget[] = [
      { role: 'long', km: 14 },
      { role: 'quality', km: 6 },
      { role: 'quality', km: 6 },
      { role: 'easy', km: 10 },
    ];
    const budgets = fitnessTestBudgets(two) ?? [];
    expect(budgets.filter((budget) => budget.role === 'quality').map((budget) => budget.km)).toEqual(
      [FITNESS_TEST_SESSION_KM],
    );
    // 6 + 10 − (7,5 − 6) = 14,5 km à deux, au dixième.
    expect(budgets.filter((budget) => budget.role === 'easy').map((budget) => budget.km)).toEqual([
      7.3, 7.2,
    ]);
    expect(budgets.find((budget) => budget.role === 'long')?.km).toBe(14);
    expect(budgets.reduce((sum, budget) => sum + budget.km, 0)).toBeCloseTo(36, 6);
  });

  it('laisse la semaine à un seul créneau exactement où elle était', () => {
    // La régression à ne pas commettre : `weight_loss` n'ouvre qu'un créneau de
    // qualité, donc le dépeuplement n'a rien à y retirer.
    const budgets = fitnessTestBudgets(WEEK) ?? [];
    expect(budgets.map((budget) => budget.role)).toEqual(['long', 'quality', 'easy', 'easy']);
  });
});

describe('pickFitnessTestDay', () => {
  it('choisit le jour de qualité le plus éloigné du jour dur précédent', () => {
    // Sortie longue le dimanche, qualité mardi et vendredi : le mardi n'a que
    // deux jours depuis le dimanche, le vendredi en a cinq.
    expect(pickFitnessTestDay([2, 5], 7)).toBe(5);
  });

  it('compte la semaine comme circulaire : un lundi suit un dimanche', () => {
    // Sortie longue le dimanche, qualité lundi et jeudi : le lundi est le
    // lendemain de la sortie longue, le jeudi est à quatre jours.
    expect(pickFitnessTestDay([1, 4], 7)).toBe(4);
  });

  it('ignore les créneaux que le test efface — le cas du plan de production', () => {
    // Sortie longue le samedi, créneaux le mardi et le jeudi : la semaine exacte
    // du plan de l'utilisatrice. Le jeudi n'était pénalisé que par le mardi qui
    // le précède — or ce mardi devient un footing le jour où le test tombe. Il
    // ne reste devant le jeudi que la sortie longue, à cinq jours, contre trois
    // pour le mardi.
    //
    // C'est le **cœur de la régression** : l'ancien calcul posait le test le
    // mardi, et la séance de seuil du jeudi tombait 48 h après un effort
    // maximal.
    expect(pickFitnessTestDay([2, 4], 6)).toBe(4);
  });

  it('compte encore les créneaux de la semaine précédente', () => {
    // Sortie longue le mercredi, créneaux le lundi et le samedi. Le lundi est à
    // cinq jours de la sortie longue, mais à **deux jours** du créneau du samedi
    // précédent — la semaine d'avant n'est pas une semaine de test, ce créneau-là
    // est bien une séance dure. Le samedi, lui, n'a devant lui que la sortie
    // longue à trois jours et un lundi devenu footing.
    expect(pickFitnessTestDay([1, 6], 3)).toBe(6);
  });

  it('départage à égalité par le jour le plus tôt, et reste déterministe', () => {
    // Sortie longue le vendredi, créneaux le mardi et le dimanche : le mardi est
    // à deux jours du dimanche précédent, le dimanche à deux jours du vendredi.
    // Le plus tôt gagne, deux fois de suite.
    expect(pickFitnessTestDay([2, 7], 5)).toBe(2);
    expect(pickFitnessTestDay([2, 7], 5)).toBe(2);
  });

  it('ne rend rien quand la semaine ne pose aucune qualité', () => {
    expect(pickFitnessTestDay([], 7)).toBeNull();
  });

  /*
   * Le plancher de cadence : à quatre semaines d'écart, 28 jours ne tiennent que
   * si le jour ne recule pas. Un jour plus frais ne rachète jamais une mesure que
   * `fitnessTestVerdict` jettera en `too-soon`.
   */
  it('écarte les jours que la cadence rejetterait, même les plus frais', () => {
    // Sortie longue le samedi, créneaux mardi et jeudi : sans plancher, le jeudi
    // l'emporte (cinq jours de fraîcheur contre trois).
    expect(pickFitnessTestDay([2, 4], 6)).toBe(4);
    // Le test précédent est tombé un vendredi quatre semaines plus tôt : il faut
    // au moins le vendredi, et aucun créneau ne l'atteint.
    expect(pickFitnessTestDay([2, 4], 6, 5)).toBeNull();
    // Un plancher au mardi laisse les deux candidats, et l'arbitrage de
    // fraîcheur reprend la main.
    expect(pickFitnessTestDay([2, 4], 6, 2)).toBe(4);
    // Un plancher au jeudi élimine le mardi.
    expect(pickFitnessTestDay([2, 5], 7, 4)).toBe(5);
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

  /*
   * La régression mesurée en production, et les trois faits qui la ferment.
   *
   * Sur ce plan-là, chaque semaine de test ouvrait **deux** créneaux de qualité :
   * le test en consommait un, l'autre restait. La semaine cumulait donc un 5 km
   * à fond et une séance de seuil — 7,2 km d'intensité sur 29,2 km, soit 24,7 %,
   * contre 10,7 à 15,5 % sur les autres semaines du même plan — et le seuil
   * tombait **48 h après** l'effort maximal.
   */
  it('ne laisse aucune autre séance dure dans la semaine du test', () => {
    expect(testWeeks.length).toBeGreaterThan(0);
    for (const week of testWeeks) {
      // Aucun créneau à faire remplir : le test est la séance dure de sa semaine.
      expect(week.qualitySlots, `semaine ${week.weekNumber}`).toEqual([]);

      const test = week.sessions.find((session) => session.kind === FITNESS_TEST_KIND);
      expect(test, `semaine ${week.weekNumber}`).toBeDefined();
      if (test === undefined) continue;

      // Et rien de dur derrière lui : ce qui suit le test dans sa semaine est du
      // footing, la sortie longue mise à part — elle se court en endurance.
      const after = week.sessions.filter((session) => session.day > test.day);
      for (const session of after) {
        expect(isIntensitySession(session), `semaine ${week.weekNumber}, ${session.kind}`).toBe(
          false,
        );
      }
    }
  });

  it('rend la semaine de test aussi calme que les autres', () => {
    // La mesure du dossier, refaite ici : le volume à haute intensité d'une
    // semaine de test, bloc d'effort du test compris, ne dépasse plus le double
    // de ce que porte une semaine ordinaire. Il vaut exactement les 5 km du
    // test, qui sont son plancher incompressible.
    const intensityKm = (week: (typeof skeleton)[number]): number => {
      const fromSlots = week.qualitySlots.reduce(
        (sum, slot) =>
          sum +
          sessionEffortKm(
            slot.zone,
            qualitySessionTemplate({
              zone: slot.zone,
              budgetKm: slot.budgetKm,
              phase: slot.phase,
              level: slot.level,
              weeklyTargetKm: slot.weeklyTargetKm,
            }),
          ),
        0,
      );
      const fromTest = week.sessions.some((session) => session.kind === FITNESS_TEST_KIND)
        ? FITNESS_TEST_EFFORT_M / 1_000
        : 0;
      return fromSlots + fromTest;
    };

    for (const week of testWeeks) {
      expect(intensityKm(week), `semaine ${week.weekNumber}`).toBeCloseTo(
        FITNESS_TEST_EFFORT_M / 1_000,
        6,
      );
    }

    // Et la part de volume qui en résulte reste du même ordre que celle des
    // semaines ordinaires : 15,7 à 17,1 % contre 10,7 à 15,5 %, là où le cumul
    // faisait monter la semaine de test à 24,0 voire 25,4 %.
    for (const week of testWeeks) {
      expect(intensityKm(week) / week.target.targetKm, `semaine ${week.weekNumber}`).toBeLessThan(
        0.18,
      );
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
