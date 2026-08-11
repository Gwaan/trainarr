import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  applyImposedPaces,
  validatePlanBusinessRules,
  PLAN_OUTPUT_BOUNDS,
  type PlanExpectations,
  type PlanSessionOutput,
  type PlanWeekOutput,
} from '@/lib/ai/plan-schema';
import { trainingPacesFromRace } from '@/lib/metrics/vdot';
import {
  flattenSteps,
  planSessionStepsSchema,
  sessionStepsTotals,
  type PlanSessionSteps,
} from '@/lib/plan-steps/schema';

import type { PlanPhase } from './phases';
import { QUALITY_ZONE_KINDS, type QualityZone } from './quality';
import { qualitySessionTemplate } from './quality-template';

/*
 * Ce que ce fichier doit prouver, et pourquoi chaque preuve existe.
 *
 * Le déroulé écrit ici est le **repli** du remplissage par le modèle : il sert
 * quand le modèle échoue, c'est-à-dire au pire moment. Il n'a donc pas droit à
 * l'à-peu-près — un repli qui produit une séance que la validation refuse ne
 * rattrape rien, il remplace un échec par un autre.
 *
 * D'où un balayage de tout le domaine plutôt que quelques cas choisis : toutes
 * les zones × toutes les phases × tous les budgets au dixième de kilomètre, du
 * plus petit que {@link weeklySessionBudgets} puisse produire à quinze
 * kilomètres. Chaque combinaison passe les quatre juges qui la jugeront en
 * production (la somme, `sessionStepViolations`, `applyImposedPaces`, le schéma
 * des étapes), puis un cinquième que rien n'impose mais qui garde la séance
 * crédible : le format lui-même.
 */

const ZONES: QualityZone[] = ['threshold', 'interval', 'repetition', 'marathon'];

/**
 * Toutes les phases, y compris les deux qui ne portent jamais de créneau.
 *
 * `partial` et `race` sont vides côté grille de qualité ({@link qualityZones}),
 * mais le type les admet et un appelant distrait les passera un jour : elles ne
 * doivent pas produire un déroulé différemment valide des autres.
 */
const PHASES: PlanPhase[] = ['partial', 'base', 'build', 'specific', 'taper', 'race'];

/**
 * Le plus petit budget qu'un créneau puisse porter, en km.
 *
 * Ce n'est pas un choix de test : `weeklySessionBudgets` arrondit chaque budget
 * de séance au demi-kilomètre **sans jamais descendre sous le plancher du
 * contrat de sortie** (`halfKm`), qui est ce chiffre-là. C'est donc exactement
 * le bord du domaine, et c'est là que l'enveloppe et le format sont le plus
 * contraints.
 */
const MIN_BUDGET_KM = PLAN_OUTPUT_BOUNDS.distanceKm.min;

/**
 * Le plus gros budget balayé, en km.
 *
 * Une séance de qualité prend 16 % du volume hebdomadaire : quinze kilomètres,
 * c'est une semaine à plus de 90 km. Au-delà, on ne décrit plus l'athlète de
 * cette appli.
 */
const MAX_BUDGET_KM = 15;

/** Le pas de mesure du projet : une distance s'écrit au dixième de kilomètre. */
const BUDGET_STEP_KM = 0.1;

/**
 * La tolérance sur la somme, en mètres — l'arrondi de 100 m, pas davantage.
 *
 * Le déroulé retombe en réalité **exactement** sur le budget (tout le calcul se
 * fait en mètres entiers, le retour au calme prend le reliquat), et un test le
 * vérifie séparément. Cette tolérance-là est le contrat public, plus lâche que
 * l'implémentation.
 */
const TOLERANCE_M = 100;

type SweptCase = { zone: QualityZone; phase: PlanPhase; budgetKm: number; label: string };

/** Le domaine complet : 4 zones × 6 phases × 146 budgets = 3 504 déroulés. */
const SWEEP: SweptCase[] = ZONES.flatMap((zone) =>
  PHASES.flatMap((phase) =>
    Array.from(
      { length: Math.round((MAX_BUDGET_KM - MIN_BUDGET_KM) / BUDGET_STEP_KM) + 1 },
      (_, index) => {
        // Reconstruit depuis un entier de dixièmes : une accumulation de 0,1 en
        // flottant produirait des budgets comme 4,300000000000001, qui ne sont
        // pas ceux que `weeklySessionBudgets` écrit.
        const budgetKm = (Math.round(MIN_BUDGET_KM * 10) + index) / 10;
        return { zone, phase, budgetKm, label: `${zone} ${phase} ${budgetKm} km` };
      },
    ),
  ),
);

/** La séance telle que le pipeline la verra : le `kind` de la zone, sa distance, son déroulé. */
function sessionFor(swept: SweptCase, steps: PlanSessionSteps): PlanSessionOutput {
  return {
    day: 3,
    kind: QUALITY_ZONE_KINDS[swept.zone],
    title: `Séance de ${QUALITY_ZONE_KINDS[swept.zone]}`,
    distanceKm: swept.budgetKm,
    steps,
  };
}

/**
 * Ce que `sessionStepViolations` reproche au déroulé d'une séance.
 *
 * Cette fonction-là n'est pas exportée par `plan-schema` : on passe donc par
 * `validatePlanBusinessRules`, qui l'appelle sur chaque séance, et on ne garde
 * que ses messages. Ils se reconnaissent à leur préfixe (`Semaine 1, séance du
 * mercredi (VMA) : …`), qui n'est partagé qu'avec les violations d'allure — et
 * celles-ci sont désarmées par un contexte vide, sans table ni allure de
 * référence, donc sans corridor à opposer.
 *
 * Les attentes décrivent une semaine d'une seule séance, placée le jour de la
 * sortie longue : tout ce qui n'est pas le déroulé est ainsi satisfait, et de
 * toute façon filtré.
 */
function stepViolations(session: PlanSessionOutput): string[] {
  const weeks: PlanWeekOutput[] = [{ sessions: [session] }];
  const expected: PlanExpectations = {
    scope: 'creation',
    weeks: 1,
    sessionsPerWeek: 1,
    longRunDay: session.day,
  };

  return validatePlanBusinessRules(weeks, expected, {}).filter((violation) =>
    violation.includes(`séance du `),
  );
}

/** La distance totale d'un déroulé, en mètres — `null` si une étape se mesure en durée. */
function totalDistanceM(steps: PlanSessionSteps): number | null {
  return sessionStepsTotals(steps).distanceM;
}

/** Le corps de séance : le bloc du milieu, celui que la zone décide. */
function body(steps: PlanSessionSteps): PlanSessionSteps[number] {
  return steps[1];
}

describe('qualitySessionTemplate — la somme retombe sur le budget', () => {
  /*
   * Le contrat cardinal. Le budget d'un créneau est la part que la cible
   * hebdomadaire a réservée à cette séance, enveloppe comprise : une séance qui
   * le dépasse fait sortir la semaine de sa bande de ±10 %, et l'appli l'ayant
   * écrite elle-même, plus personne n'est là pour la rattraper.
   */
  it('couvre exactement le budget, sur tout le domaine', () => {
    for (const swept of SWEEP) {
      const steps = qualitySessionTemplate(swept);
      const totalM = totalDistanceM(steps);
      expect(totalM, swept.label).not.toBeNull();
      expect(Math.abs((totalM ?? 0) - swept.budgetKm * 1_000), swept.label).toBeLessThanOrEqual(
        TOLERANCE_M,
      );
    }
  });

  it('tombe même au mètre près, l’arrondi du budget mis à part', () => {
    // L'implémentation ne s'autorise pas la tolérance publique : elle calcule en
    // mètres entiers et fait absorber le reliquat par le retour au calme. Seul
    // subsiste l'arrondi du budget lui-même en mètres, soit un demi-mètre.
    for (const swept of SWEEP) {
      const totalM = totalDistanceM(qualitySessionTemplate(swept));
      expect(totalM, swept.label).toBe(Math.round(swept.budgetKm * 1_000));
    }
  });

  /*
   * Le piège documenté par {@link QualitySlot} : mesuré sur les 3 024
   * combinaisons du test de propriété du squelette, un déroulé en durée fait
   * sortir 98,3 % des semaines de leur cible une fois `applyImposedPaces` passé.
   * `sessionStepsTotals` rend `null` dès qu'une seule étape est chronométrée —
   * les tests ci-dessus le vérifient donc déjà, celui-ci le dit à voix haute.
   */
  it('ne mesure aucune étape en durée', () => {
    for (const swept of SWEEP) {
      for (const step of flattenSteps(qualitySessionTemplate(swept))) {
        expect(step.distanceM, swept.label).not.toBeNull();
        expect(step.durationS, swept.label).toBeNull();
      }
    }
  });
});

describe('qualitySessionTemplate — ce que la validation exige', () => {
  it('ne laisse aucune violation de déroulé, sur tout le domaine', () => {
    for (const swept of SWEEP) {
      const session = sessionFor(swept, qualitySessionTemplate(swept));
      expect(stepViolations(session), swept.label).toEqual([]);
    }
  });

  /*
   * Le filtre de {@link stepViolations} ne vaut que s'il attrape quelque chose :
   * une séance de qualité sans échauffement ni retour au calme, et un bloc
   * répété sans récupération, sont exactement les trois fautes que
   * `sessionStepViolations` connaît.
   */
  it('et le juge, lui, sait dire non', () => {
    const naked: PlanSessionOutput = {
      day: 3,
      kind: QUALITY_ZONE_KINDS.interval,
      title: 'Séance sans rien autour',
      distanceKm: 6,
      steps: [
        {
          repeat: 4,
          steps: [
            {
              role: 'run',
              distanceM: 1_500,
              durationS: null,
              paceMinSecPerKm: null,
              paceMaxSecPerKm: null,
              hrZone: null,
              note: 'Effort',
            },
          ],
        },
      ],
    };

    expect(stepViolations(naked)).toHaveLength(3);
  });

  it('respecte les invariants et les bornes des étapes, sur tout le domaine', () => {
    // Le schéma les vérifie tous d'un coup — une mesure par étape, toutes les
    // clés présentes, bornes de distance, de répétitions, de taille de bloc et
    // de nombre de blocs. Les réasserter à la main en oublierait un.
    for (const swept of SWEEP) {
      const steps = qualitySessionTemplate(swept);
      expect(() => planSessionStepsSchema.parse(steps), swept.label).not.toThrow();
      expect(planSessionStepsSchema.parse(steps), swept.label).toEqual(steps);
    }
  });
});

describe('qualitySessionTemplate — le post-traitement des allures', () => {
  /** Une table réaliste : 45 min au 10 km, celle des tests du squelette. */
  const PACES = trainingPacesFromRace(10_000, 45 * 60);

  /** Une allure d'objectif plausible pour cette table (5:00/km) : elle arme `goalPaceZone`. */
  const GOAL_PACE_SEC_PER_KM = 300;

  /*
   * Le piège qui a coûté 98,3 % des plans, verrouillé : `applyImposedPaces`
   * recalcule la distance d'une séance depuis la couverture de son déroulé et
   * remplace la distance déclarée dès qu'elle lui est inférieure. Un déroulé
   * mesuré en distance et qui couvre exactement le budget ne peut pas déclencher
   * cette substitution — c'est toute la raison d'être du contrat de mesure.
   */
  it('traverse applyImposedPaces sans que la distance de la séance change', () => {
    for (const swept of SWEEP) {
      const session = sessionFor(swept, qualitySessionTemplate(swept));
      const [week] = applyImposedPaces(
        [{ sessions: [session] }],
        PACES,
        GOAL_PACE_SEC_PER_KM,
      );

      expect(week.sessions[0].distanceKm, swept.label).toBeCloseTo(swept.budgetKm, 6);
    }
  });

  it('en ressort avec le même déroulé, aux seules allures près', () => {
    for (const swept of SWEEP) {
      const steps = qualitySessionTemplate(swept);
      const [week] = applyImposedPaces([{ sessions: [sessionFor(swept, steps)] }], PACES);
      const after = week.sessions[0].steps;

      expect(after, swept.label).toBeDefined();
      expect(
        after?.map((block) => ({
          repeat: block.repeat,
          steps: block.steps.map((step) => ({
            role: step.role,
            distanceM: step.distanceM,
            durationS: step.durationS,
            note: step.note,
          })),
        })),
        swept.label,
      ).toEqual(
        steps.map((block) => ({
          repeat: block.repeat,
          steps: block.steps.map((step) => ({
            role: step.role,
            distanceM: step.distanceM,
            durationS: step.durationS,
            note: step.note,
          })),
        })),
      );
    }
  });

  it('n’écrit lui-même aucune allure ni aucune zone cardiaque', () => {
    // Un seul endroit décide des allures, et ce n'est pas ici : deux sources qui
    // les écrivent, c'est toujours la mauvaise qui gagne.
    for (const swept of SWEEP) {
      for (const step of flattenSteps(qualitySessionTemplate(swept))) {
        expect(step.paceMinSecPerKm, swept.label).toBeNull();
        expect(step.paceMaxSecPerKm, swept.label).toBeNull();
        expect(step.hrZone, swept.label).toBeNull();
      }
    }
  });

  /*
   * Les notes ne sont pas décoratives : `stepNotePaceZone` y cherche « seuil »
   * ou « allure objectif » pour poser sur une étape isolée un créneau autre que
   * celui de sa séance. Une note de VMA qui contiendrait « spécifique » ferait
   * prescrire l'allure marathon sur une répétition de 400 m.
   */
  it('pose sur chaque étape d’effort l’allure du créneau de sa zone', () => {
    const zoneOf = {
      threshold: PACES.threshold,
      interval: PACES.interval,
      repetition: PACES.repetition,
      // La zone M cède la place à l'allure objectif chiffrée quand il y en a une.
      marathon: {
        minSecPerKm: GOAL_PACE_SEC_PER_KM - 8,
        maxSecPerKm: GOAL_PACE_SEC_PER_KM + 8,
      },
    } as const;

    for (const swept of SWEEP) {
      const session = sessionFor(swept, qualitySessionTemplate(swept));
      const [week] = applyImposedPaces([{ sessions: [session] }], PACES, GOAL_PACE_SEC_PER_KM);
      const efforts = flattenSteps(week.sessions[0].steps ?? []).filter(
        (step) => step.role === 'run',
      );

      expect(efforts.length, swept.label).toBeGreaterThan(0);
      for (const effort of efforts) {
        expect(effort.paceMinSecPerKm, swept.label).toBe(zoneOf[swept.zone].minSecPerKm);
        expect(effort.paceMaxSecPerKm, swept.label).toBe(zoneOf[swept.zone].maxSecPerKm);
      }
    }
  });
});

describe('qualitySessionTemplate — déterminisme', () => {
  it('rend deux fois la même chose', () => {
    for (const swept of SWEEP) {
      expect(qualitySessionTemplate(swept), swept.label).toEqual(qualitySessionTemplate(swept));
    }
  });

  /*
   * Un test de sortie ne prouve pas l'absence d'horloge : deux appels dans la
   * même milliseconde rendraient la même chose. Le module est un repli — il doit
   * écrire la même séance aujourd'hui et dans six mois, sur n'importe quelle
   * machine —, alors on le vérifie à la source.
   */
  it('n’a ni horloge ni aléa dans son code', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./quality-template.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(/Math\.random|Date\.now|new Date/);
  });
});

describe('qualitySessionTemplate — le format des séances', () => {
  /*
   * Ce que la structure de chaque zone doit rester, indépendamment de
   * l'implémentation : c'est la seule chose qui empêchera une « optimisation »
   * future de produire 40 répétitions de 150 m parce que la somme tombait juste.
   *
   * Les bornes sont écrites ici en toutes lettres plutôt qu'importées du module :
   * un test qui relit les constantes du code sous test ne prouve rien.
   */
  const EXPECTED_SHAPES = {
    threshold: {
      // Peu de répétitions, longues, et une récupération courte relativement à
      // l'effort : ce qui compte au seuil est le temps passé à cette intensité.
      effort: { min: 1_000, max: 3_000 },
      maxReps: 6,
      recoveryRatio: { min: 0.1, max: 0.4 },
    },
    interval: {
      // Assez long pour monter à VO2max, assez récupéré pour refaire le suivant
      // à la même vitesse.
      effort: { min: 400, max: 1_000 },
      maxReps: 10,
      recoveryRatio: { min: 0.6, max: 2 },
    },
    repetition: {
      // Court, rapide, récupération au moins aussi longue que l'effort : c'est du
      // travail de foulée, pas du travail cardiaque.
      effort: { min: 200, max: 400 },
      maxReps: 14,
      recoveryRatio: { min: 1, max: 3 },
    },
    marathon: {
      // Un ou deux blocs longs, récupération symbolique : fractionner rendrait
      // facile ce que la course rendra difficile.
      effort: { min: 2_000, max: 6_000 },
      maxReps: 2,
      recoveryRatio: { min: 0, max: 0.15 },
    },
  } as const satisfies Record<
    QualityZone,
    {
      effort: { min: number; max: number };
      maxReps: number;
      recoveryRatio: { min: number; max: number };
    }
  >;

  it('garde le format de sa zone partout où il y a la place de le tenir', () => {
    for (const swept of SWEEP) {
      const block = body(qualitySessionTemplate(swept));
      // Un bloc d'une seule étape est le repli continu : sur un créneau qui ne
      // finance même pas une répétition, un effort continu vaut mieux que des
      // fragments. Il est vérifié par le test suivant.
      if (block.steps.length === 1) continue;

      const shape = EXPECTED_SHAPES[swept.zone];
      const effortM = block.steps[0].distanceM ?? 0;
      const recoverM = block.steps[1].distanceM ?? 0;

      expect(block.repeat, swept.label).toBeLessThanOrEqual(shape.maxReps);
      expect(effortM, swept.label).toBeGreaterThanOrEqual(shape.effort.min);
      expect(effortM, swept.label).toBeLessThanOrEqual(shape.effort.max);
      expect(recoverM / effortM, swept.label).toBeGreaterThanOrEqual(shape.recoveryRatio.min);
      expect(recoverM / effortM, swept.label).toBeLessThanOrEqual(shape.recoveryRatio.max);
    }
  });

  /**
   * Le plus gros budget qui puisse encore se rabattre sur l'effort continu, en
   * km.
   *
   * Mesuré sur le balayage : 2,2 km au seuil, 0,8 km en VMA, jamais en
   * répétitions, 3,9 km en spécifique — la zone dont la répétition minimale est
   * la plus longue (2 km) est aussi celle qui se rabat le plus tard. Au-delà,
   * un repli signalerait que le format ne tient plus là où il devrait.
   */
  const CONTINUOUS_MAX_BUDGET_KM = 4;

  it('ne se rabat sur l’effort continu que faute de place pour une répétition', () => {
    for (const swept of SWEEP) {
      const block = body(qualitySessionTemplate(swept));
      if (block.steps.length > 1) continue;

      // Un bloc unique n'a rien à séparer : pas de récupération à exiger. Il
      // porte soit une répétition en bonne et due forme, soit — quand le budget
      // ne finance même pas celle-là — un effort continu plus court.
      const effortM = block.steps[0].distanceM ?? 0;
      expect(block.repeat, swept.label).toBe(1);
      expect(block.steps[0].role, swept.label).toBe('run');
      expect(effortM, swept.label).toBeLessThanOrEqual(EXPECTED_SHAPES[swept.zone].effort.max);

      if (effortM >= EXPECTED_SHAPES[swept.zone].effort.min) continue;
      expect(swept.budgetKm, swept.label).toBeLessThanOrEqual(CONTINUOUS_MAX_BUDGET_KM);
    }
  });

  it('donne à l’enveloppe une part significative, qui croît quand le budget rétrécit', () => {
    for (const swept of SWEEP) {
      const steps = qualitySessionTemplate(swept);
      const flat = flattenSteps(steps);
      const envelopeM = (flat[0].distanceM ?? 0) + (flat[flat.length - 1].distanceM ?? 0);
      const share = envelopeM / (totalDistanceM(steps) ?? 1);

      expect(flat[0].role, swept.label).toBe('warmup');
      expect(flat[flat.length - 1].role, swept.label).toBe('cooldown');
      // Le quart et le cinquième au minimum ; au plus, ce que laisse un créneau
      // trop petit pour financer autre chose qu'un échauffement et un peu de
      // travail — le coût d'une mise en route ne se divise pas.
      expect(share, swept.label).toBeGreaterThanOrEqual(0.44);
      expect(share, swept.label).toBeLessThanOrEqual(0.85);
    }
  });

  it('fait croître la part de l’enveloppe à mesure que le budget baisse', () => {
    const shareAt = (budgetKm: number): number => {
      const steps = qualitySessionTemplate({ zone: 'interval', budgetKm, phase: 'build' });
      const flat = flattenSteps(steps);
      return (
        ((flat[0].distanceM ?? 0) + (flat[flat.length - 1].distanceM ?? 0)) /
        (totalDistanceM(steps) ?? 1)
      );
    };

    // Des budgets bien séparés : d'un dixième à l'autre, le reliquat du format
    // fait osciller la part de quelques points, et ce n'est pas cette
    // oscillation-là que la règle décrit.
    expect(shareAt(12)).toBeLessThan(shareAt(4));
    expect(shareAt(4)).toBeLessThan(shareAt(2));
    // Sur 12 km, la part nominale (un quart et un cinquième) plus le reliquat.
    expect(shareAt(12)).toBeGreaterThanOrEqual(0.45);
    expect(shareAt(12)).toBeLessThanOrEqual(0.48);
    // Sur 2 km, les planchers de mise en route ont pris la moitié du budget.
    expect(shareAt(2)).toBeGreaterThanOrEqual(0.5);
  });
});

describe('qualitySessionTemplate — les séances qu’on obtient', () => {
  /*
   * Quatre déroulés figés, lisibles tels quels par un entraîneur. Ils ne testent
   * pas une propriété : ils **montrent** ce que le module écrit, pour que toute
   * dérive future soit visible en revue plutôt que noyée dans un balayage.
   */
  it('une VMA de 6 km : 4 × 400 m, récupération 400 m', () => {
    expect(qualitySessionTemplate({ zone: 'interval', budgetKm: 6, phase: 'build' })).toEqual([
      {
        repeat: 1,
        steps: [
          {
            role: 'warmup',
            distanceM: 1_550,
            durationS: null,
            paceMinSecPerKm: null,
            paceMaxSecPerKm: null,
            hrZone: null,
            note: 'Échauffement progressif en endurance',
          },
        ],
      },
      {
        repeat: 4,
        steps: [
          {
            role: 'run',
            distanceM: 400,
            durationS: null,
            paceMinSecPerKm: null,
            paceMaxSecPerKm: null,
            hrZone: null,
            note: 'Effort à VMA, en contrôle',
          },
          {
            role: 'recover',
            distanceM: 400,
            durationS: null,
            paceMinSecPerKm: null,
            paceMaxSecPerKm: null,
            hrZone: null,
            note: 'Récupération trottée',
          },
        ],
      },
      {
        repeat: 1,
        steps: [
          {
            role: 'cooldown',
            distanceM: 1_250,
            durationS: null,
            paceMinSecPerKm: null,
            paceMaxSecPerKm: null,
            hrZone: null,
            note: 'Retour au calme en endurance',
          },
        ],
      },
    ]);
  });

  it('un seuil de 8 km : 3 × 1 200 m, récupération 250 m', () => {
    const steps = qualitySessionTemplate({ zone: 'threshold', budgetKm: 8, phase: 'build' });

    expect(steps.map((block) => [block.repeat, block.steps.map((step) => step.distanceM)])).toEqual([
      [1, [2_050]],
      [3, [1_200, 250]],
      [1, [1_600]],
    ]);
    // La note nomme le créneau : `stepNotePaceZone` la lit, et une séance dont le
    // `kind` serait réécrit garderait son allure de seuil.
    expect(body(steps).steps[0].note).toBe('Effort au seuil, régulier et contrôlé');
  });

  it('des répétitions de 4 km : 4 × 200 m, récupération 300 m', () => {
    const steps = qualitySessionTemplate({ zone: 'repetition', budgetKm: 4, phase: 'build' });

    expect(steps.map((block) => [block.repeat, block.steps.map((step) => step.distanceM)])).toEqual([
      [1, [1_200]],
      [4, [200, 300]],
      [1, [800]],
    ]);
  });

  it('un spécifique de 12 km : 2 × 3 100 m à allure objectif, coupure 200 m', () => {
    const steps = qualitySessionTemplate({ zone: 'marathon', budgetKm: 12, phase: 'build' });

    expect(steps.map((block) => [block.repeat, block.steps.map((step) => step.distanceM)])).toEqual([
      [1, [3_000]],
      [2, [3_100, 200]],
      [1, [2_400]],
    ]);
    expect(body(steps).steps[0].note).toBe('Bloc à allure objectif, souple et régulier');
  });

  /*
   * La phase ne change pas le budget, elle change ce que le budget achète :
   * allonger la récupération, c'est dépenser en trot des mètres qui seraient
   * allés à l'effort. Sur le même créneau de 9 km, la base rend deux kilomètres
   * à VMA sur quatre répétitions là où la spécificité en rend deux et demi.
   */
  it('la phase resserre ou relâche la récupération, à budget égal', () => {
    const formatFor = (phase: PlanPhase): [number, (number | null)[]] => {
      const block = body(qualitySessionTemplate({ zone: 'interval', budgetKm: 9, phase }));
      return [block.repeat, block.steps.map((step) => step.distanceM)];
    };

    expect(formatFor('base')).toEqual([4, [500, 700]]);
    expect(formatFor('build')).toEqual([6, [400, 400]]);
    expect(formatFor('specific')).toEqual([3, [900, 750]]);
    // L'affûtage garde la vitesse et retire la charge : le format de la base, sur
    // un budget que la cible hebdomadaire a déjà rétréci.
    expect(formatFor('taper')).toEqual(formatFor('base'));
  });

  it('reste écrivable sur le plus petit budget qu’un créneau puisse porter', () => {
    const steps = qualitySessionTemplate({
      zone: 'repetition',
      budgetKm: MIN_BUDGET_KM,
      phase: 'base',
    });

    // 200 m d'échauffement, 200 m vite, 100 m pour rentrer : ce n'est plus une
    // séance, c'est ce qu'un budget de 500 m permet d'écrire. Le module l'écrit
    // quand même plutôt que d'échouer — c'est le refus d'infaisabilité du
    // squelette qui décide qu'un tel plan ne doit pas exister, pas celui-ci.
    expect(steps.map((block) => [block.repeat, block.steps.map((step) => step.distanceM)])).toEqual([
      [1, [200]],
      [1, [200]],
      [1, [100]],
    ]);
  });
});
