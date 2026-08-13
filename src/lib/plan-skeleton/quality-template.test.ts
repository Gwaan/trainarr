import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { PlanLevel } from '@/data/db/schema';
import {
  applyImposedPaces,
  validatePlanBusinessRules,
  weeklyVolumeTargets,
  PLAN_OUTPUT_BOUNDS,
  type PlanExpectations,
  type PlanRaceGoal,
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

import { PlanSkeletonInfeasibleError } from './feasibility';
import { PLAN_INTENTS, type PlanIntent } from './intent';
import type { PlanPhase } from './phases';
import { QUALITY_ZONE_KINDS, type QualityZone } from './quality';
import { qualitySessionTemplate } from './quality-template';
import { buildPlanSkeleton, type SkeletonWeek } from './skeleton';

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
 * Les trois niveaux, tous balayés.
 *
 * Contrairement au squelette, qui n'en distingue que deux
 * ({@link buildPlanSkeleton} ne s'en sert que pour compter les créneaux), le
 * déroulé les distingue tous les trois : chacun ouvre son propre régime de
 * récupération, donc son propre format, et aucun ne se déduit d'un autre.
 */
const LEVELS: PlanLevel[] = ['beginner', 'intermediate', 'advanced'];

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

/**
 * La plus grosse part du volume hebdomadaire qu'un créneau puisse prendre.
 *
 * Ce n'est pas la part nominale (14 à 19 %, cf. `composition.ts`) : c'est le
 * maximum **mesuré** sur des squelettes réels — 22,7 %, sur un créneau de 1,5 km
 * dans une semaine de 6,6 km, où le plancher de 0,5 km par séance (`halfKm`)
 * découple le budget de la semaine qui le finance.
 *
 * Le balayage l'utilise pour apparier chaque budget à la semaine la plus maigre
 * qui puisse le porter, donc au **plafond de volume d'effort le plus serré**
 * (`quality-load.ts`) que ce budget puisse rencontrer. C'est le coin où le
 * plafond mord le plus fort ; les appariements réels, eux, sont balayés tels
 * quels plus bas, depuis `buildPlanSkeleton`.
 */
const MAX_QUALITY_SHARE = 0.227;

/**
 * La part **nominale** d'un créneau : celle que la décomposition pose par
 * défaut (`SESSION_BUDGET_SHARES.quality`, 16 %), au milieu de la rampe de
 * composition (14 à 19 %).
 *
 * Elle apparie les déroulés **figés** ci-dessous à la semaine qui les porterait
 * réellement. Un créneau n'existe pas sans sa semaine, et le plafond de volume
 * d'effort se calcule sur elle : illustrer une VMA de 6 km sans dire de quelle
 * semaine elle vient reviendrait à illustrer une séance impossible.
 */
const NOMINAL_QUALITY_SHARE = 0.16;

type SweptCase = {
  zone: QualityZone;
  phase: PlanPhase;
  level: PlanLevel;
  budgetKm: number;
  /** La cible hebdomadaire de la semaine qui porte ce créneau — ce qui plafonne l'effort. */
  weeklyTargetKm: number;
  label: string;
};

/**
 * Le domaine complet : 4 zones × 6 phases × 3 niveaux × 146 budgets =
 * 10 512 déroulés.
 *
 * Le niveau y entre de plein droit depuis qu'il module le format : c'est un
 * second facteur sur la récupération, qui se multiplie à celui de la phase, et
 * ce sont précisément les extrêmes du produit (base × débutante, spécificité ×
 * confirmée) qui font travailler les bornes de récupération de chaque zone.
 */
const SWEEP: SweptCase[] = ZONES.flatMap((zone) =>
  PHASES.flatMap((phase) =>
    LEVELS.flatMap((level) =>
      Array.from(
        { length: Math.round((MAX_BUDGET_KM - MIN_BUDGET_KM) / BUDGET_STEP_KM) + 1 },
        (_, index) => {
          // Reconstruit depuis un entier de dixièmes : une accumulation de 0,1 en
          // flottant produirait des budgets comme 4,300000000000001, qui ne sont
          // pas ceux que `weeklySessionBudgets` écrit.
          const budgetKm = (Math.round(MIN_BUDGET_KM * 10) + index) / 10;
          return {
            zone,
            phase,
            level,
            budgetKm,
            weeklyTargetKm: budgetKm / MAX_QUALITY_SHARE,
            label: `${zone} ${phase} ${level} ${budgetKm} km`,
          };
        },
      ),
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
            hrPercentMin: null,
            hrPercentMax: null,
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
   *
   * Les fourchettes de récupération couvrent le **produit des deux
   * modulateurs** : la phase l'étire de 0,8 à 1,3 et le niveau de 0,8 à 1,5,
   * soit un rapport qui va de 0,64 à 1,95 fois celui de la zone. C'est pour cela
   * qu'elles sont larges — ce qu'elles interdisent est le changement de nature
   * (une VMA récupérée comme un seuil), pas le dosage.
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
      recoveryRatio: { min: 0.55, max: 2 },
    },
    repetition: {
      // Court, rapide, récupération de l'ordre de l'effort ou plus longue : c'est
      // du travail de foulée, pas du travail cardiaque. Le bas de la fourchette
      // est celui d'une confirmée en spécificité, la seule qui y récupère un peu
      // moins que son effort.
      effort: { min: 200, max: 400 },
      maxReps: 14,
      recoveryRatio: { min: 0.8, max: 3 },
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
   * Mesuré sur le balayage, par zone et par niveau : 2,1 à 2,2 km au seuil,
   * 0,8 km en VMA, jamais en répétitions, 3,9 km en spécifique — 4,4 km pour une
   * **débutante** en spécifique. La zone dont la répétition minimale est la plus
   * longue (2 km) est aussi celle qui se rabat le plus tard. Au-delà, un repli
   * signalerait que le format ne tient plus là où il devrait.
   *
   * Ces 4,4 km sont le prix, mesuré, du plancher d'échauffement des débutantes
   * (`LEVEL_WARMUP_FLOOR_M`, 2 000 m contre 1 200) : 3,9 km avant lui, 4,4 après,
   * et le seul cas qui déplace la borne est `marathon · beginner`. Un demi-
   * kilomètre de budget de plus bascule alors sur l'effort continu — ce qui est
   * la bonne réponse pour une débutante à qui il ne resterait de toute façon que
   * 2 km de travail — contre cinq minutes d'échauffement gagnées partout
   * ailleurs.
   */
  const CONTINUOUS_MAX_BUDGET_KM = 4.4;

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
      //
      // Le plafond est monté de 0,85 à 0,89 avec le levier de niveau, et le
      // coin est identifié : `répétitions × base ou affûtage × débutante`, entre
      // 2,5 et 3,4 km de budget (14 déroulés sur 10 512). La récupération y est
      // si longue qu'aucun format à deux répétitions ne tient dans le budget de
      // travail, le module se rabat sur un bloc unique, et le reliquat va à
      // l'enveloppe. Une séance de foulée à 3 km pour une débutante : c'est
      // maigre, mais ce n'est pas faux.
      expect(share, swept.label).toBeGreaterThanOrEqual(0.44);
      expect(share, swept.label).toBeLessThanOrEqual(0.89);
    }
  });

  it('fait croître la part de l’enveloppe à mesure que le budget baisse', () => {
    const shareAt = (budgetKm: number): number => {
      const steps = qualitySessionTemplate({
        zone: 'interval',
        budgetKm,
        phase: 'build',
        level: 'intermediate',
        weeklyTargetKm: budgetKm / NOMINAL_QUALITY_SHARE,
      });
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
    expect(qualitySessionTemplate({
      zone: 'interval',
      budgetKm: 6,
      phase: 'build',
      level: 'intermediate',
      weeklyTargetKm: 6 / NOMINAL_QUALITY_SHARE,
    })).toEqual([
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
            hrPercentMin: null,
            hrPercentMax: null,
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
            hrPercentMin: null,
            hrPercentMax: null,
            note: 'Effort à VMA, en contrôle',
          },
          {
            role: 'recover',
            distanceM: 400,
            durationS: null,
            paceMinSecPerKm: null,
            paceMaxSecPerKm: null,
            hrZone: null,
            hrPercentMin: null,
            hrPercentMax: null,
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
            hrPercentMin: null,
            hrPercentMax: null,
            note: 'Retour au calme en endurance',
          },
        ],
      },
    ]);
  });

  it('un seuil de 8 km : 3 × 1 200 m, récupération 250 m', () => {
    const steps = qualitySessionTemplate({
      zone: 'threshold',
      budgetKm: 8,
      phase: 'build',
      level: 'intermediate',
      weeklyTargetKm: 8 / NOMINAL_QUALITY_SHARE,
    });

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
    const steps = qualitySessionTemplate({
      zone: 'repetition',
      budgetKm: 4,
      phase: 'build',
      level: 'intermediate',
      weeklyTargetKm: 4 / NOMINAL_QUALITY_SHARE,
    });

    expect(steps.map((block) => [block.repeat, block.steps.map((step) => step.distanceM)])).toEqual([
      [1, [1_200]],
      [4, [200, 300]],
      [1, [800]],
    ]);
  });

  it('un spécifique de 12 km : 2 × 3 100 m à allure objectif, coupure 200 m', () => {
    const steps = qualitySessionTemplate({
      zone: 'marathon',
      budgetKm: 12,
      phase: 'build',
      level: 'intermediate',
      weeklyTargetKm: 12 / NOMINAL_QUALITY_SHARE,
    });

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
      const block = body(
        qualitySessionTemplate({
          zone: 'interval',
          budgetKm: 9,
          phase,
          level: 'intermediate',
          weeklyTargetKm: 9 / NOMINAL_QUALITY_SHARE,
        }),
      );
      return [block.repeat, block.steps.map((step) => step.distanceM)];
    };

    expect(formatFor('base')).toEqual([4, [500, 700]]);
    expect(formatFor('build')).toEqual([6, [400, 400]]);
    expect(formatFor('specific')).toEqual([3, [900, 750]]);
    // L'affûtage garde la vitesse et retire la charge : le format de la base, sur
    // un budget que la cible hebdomadaire a déjà rétréci.
    expect(formatFor('taper')).toEqual(formatFor('base'));
  });

  /*
   * Le niveau, second modulateur du format — et le seul autre.
   *
   * Ce que ces cas protègent est une régression mesurée : après la bascule sur
   * squelette, le niveau ne décidait plus que du **nombre** de créneaux, plus
   * jamais de leur contenu. Un semi en 1 h 45, 4 séances, une **débutante**
   * recevait 9 séances de seuil à la structure exacte d'une confirmée, et
   * `advanced` produisait un plan strictement identique à `intermediate`.
   *
   * Le levier retenu est la **récupération**, comme celui de la phase : c'est le
   * seul paramètre qui, à budget fixé, raccourcit les efforts ET allonge la
   * récupération d'un même geste. Un levier sur la longueur des répétitions
   * (bornes de la zone) ne mordrait que sur les bords — mesuré : `intermediate`
   * et `advanced` rendaient encore le même déroulé.
   */
  describe('le niveau de l’athlète', () => {
    /** Le corps de séance d'un même créneau, niveau par niveau. */
    const formatFor = (
      level: PlanLevel,
      zone: QualityZone = 'threshold',
      phase: PlanPhase = 'build',
    ): [number, (number | null)[]] => {
      const block = body(
        qualitySessionTemplate({
          zone,
          budgetKm: 9,
          phase,
          level,
          weeklyTargetKm: 9 / NOMINAL_QUALITY_SHARE,
        }),
      );
      return [block.repeat, block.steps.map((step) => step.distanceM)];
    };

    it('rend trois déroulés différents à budget, zone et phase égaux', () => {
      // Le cas exact de la mesure : un créneau de seuil, où une débutante
      // recevait la séance d'une confirmée et où `advanced` ne se distinguait
      // pas d'`intermediate`.
      expect(formatFor('beginner')).toEqual([3, [1_200, 400]]);
      expect(formatFor('intermediate')).toEqual([3, [1_300, 300]]);
      expect(formatFor('advanced')).toEqual([3, [1_400, 250]]);

      // Et la VMA, dont le format bouge davantage : le nombre de répétitions
      // suit la récupération.
      const interval = LEVELS.map((level) => JSON.stringify(formatFor(level, 'interval')));
      expect(new Set(interval).size).toBe(LEVELS.length);
    });

    /*
     * L'invariant se mesure sur **tout le domaine**, pas sur un créneau : le
     * choix du format est une recherche sur des entiers arrondis au décamètre,
     * et deux niveaux voisins tombent parfois sur le même découpage. Ce qui doit
     * tenir est la tendance, et elle est nette — à budget, zone et phase égaux,
     * une débutante court moins de mètres à intensité et plus de mètres de trot
     * qu'une confirmée.
     */
    it('donne à la débutante moins d’intensité et plus de récupération qu’à la confirmée', () => {
      const totals = { beginner: { effortM: 0, recoverM: 0 }, advanced: { effortM: 0, recoverM: 0 } };

      for (const swept of SWEEP) {
        if (swept.level === 'intermediate') continue;
        const block = body(qualitySessionTemplate(swept));
        const bucket = totals[swept.level];
        bucket.effortM += block.repeat * (block.steps[0].distanceM ?? 0);
        bucket.recoverM += block.repeat * (block.steps[1]?.distanceM ?? 0);
      }

      expect(totals.beginner.effortM).toBeLessThan(totals.advanced.effortM);
      expect(totals.beginner.recoverM).toBeGreaterThan(totals.advanced.recoverM);
    });
  });

  it('reste écrivable sur le plus petit budget qu’un créneau puisse porter', () => {
    const steps = qualitySessionTemplate({
      zone: 'repetition',
      budgetKm: MIN_BUDGET_KM,
      phase: 'base',
      level: 'intermediate',
      weeklyTargetKm: MIN_BUDGET_KM / MAX_QUALITY_SHARE,
    });

    // 250 m d'échauffement, 110 m vite, 140 m pour rentrer : ce n'est plus une
    // séance, c'est ce qu'un budget de 500 m permet d'écrire. Le module l'écrit
    // quand même plutôt que d'échouer — c'est le refus d'infaisabilité du
    // squelette qui décide qu'un tel plan ne doit pas exister, pas celui-ci.
    //
    // Les 110 m sont le **plafond de volume d'effort** lui-même : une semaine de
    // 2,2 km n'autorise que 5 % de répétitions, et le module rend le plafond
    // plutôt qu'une répétition de 200 m qui le dépasserait. C'est le seul coin du
    // domaine où le plafond descend sous la longueur minimale de la zone, et le
    // reliquat part à l'enveloppe comme tous les autres.
    expect(steps.map((block) => [block.repeat, block.steps.map((step) => step.distanceM)])).toEqual([
      [1, [250]],
      [1, [110]],
      [1, [140]],
    ]);
  });
});

/*
 * Le balayage sur squelettes réels : les appariements (budget, semaine) que
 * `buildPlanSkeleton` produit vraiment, par opposition au pire cas construit
 * de {@link SWEEP}.
 *
 * Volontairement resserré — ce n'est pas le test de propriété du squelette
 * (`skeleton.test.ts`), qui balaie 42 336 combinaisons. Ici, une seule chose est
 * jugée, et elle ne dépend que de trois entrées : la zone, le budget du créneau
 * et la cible de sa semaine. Les axes gardés sont ceux qui déplacent ces
 * trois-là — le volume de l'athlète surtout, puisque c'est lui qui décide du
 * plafond.
 */

/** Objectif et course vont ensemble : c'est la distance visée qui décide de l'affûtage. */
const SKELETON_GOALS: { label: string; goalDistanceKm: number | null; race: PlanRaceGoal | null }[] =
  [
    { label: 'libre', goalDistanceKm: null, race: null },
    { label: '5 km daté', goalDistanceKm: 5, race: { isMarathon: false } },
    { label: '10 km daté', goalDistanceKm: 10, race: { isMarathon: false } },
    { label: 'semi daté', goalDistanceKm: 21.0975, race: { isMarathon: false } },
    { label: 'marathon daté', goalDistanceKm: 42.195, race: { isMarathon: true } },
  ];

/**
 * Les volumes récents balayés, en km par semaine.
 *
 * L'axe qui compte : le plafond **est** une part de ce chiffre. Les trois
 * premiers sont le domaine où le plancher de 0,5 km par séance mord, c'est-à-dire
 * exactement là où les 2 444 dépassements mesurés se trouvaient.
 */
const SKELETON_WEEKLY_KM = [3, 6, 10, 14, 27, 42, 70];

const SKELETON_WEEKS = [4, 8, 16, 24];
const SKELETON_SESSIONS = [2, 3, 4, 5, 6, 7];

/** Le squelette d'une combinaison — `null` quand le volume ne la finance pas. */
function skeletonOrNull(params: {
  intent: PlanIntent;
  goal: (typeof SKELETON_GOALS)[number];
  recentWeeklyKm: number;
  level: PlanLevel;
  weeks: number;
  sessionsPerWeek: number;
}): SkeletonWeek[] | null {
  const { intent, goal, recentWeeklyKm, level, weeks, sessionsPerWeek } = params;

  try {
    return buildPlanSkeleton({
      intent,
      weeks,
      firstWeekFromDay: 1,
      sessionsPerWeek,
      longRunDay: 7,
      level,
      race: goal.race,
      raceDay: goal.race === null ? null : 7,
      goalDistanceKm: intent === 'race' ? goal.goalDistanceKm : null,
      targets: weeklyVolumeTargets({
        weeks,
        firstWeekFromDay: 1,
        recentWeeklyKm,
        weeklyTimeMinutes: null,
        easyPaceSecPerKm: null,
        race: goal.race,
        level,
      }),
    });
  } catch (error) {
    // Le seul refus attendu : une cible que le nombre de séances ne finance pas.
    if (error instanceof PlanSkeletonInfeasibleError) return null;
    throw error;
  }
}

describe('qualitySessionTemplate — le plafond de volume d’effort', () => {
  /*
   * ## Ce que ces tests protègent
   *
   * Le déroulé écrit ici est le **repli** d'une validation qui refuse une séance
   * dépassant le plafond de Daniels (`quality-fill.ts`, `quality-load.ts`). S'il
   * le dépassait lui-même, le repli ne replierait rien : on remplacerait une
   * séance refusée par une autre séance refusée, et l'athlète recevrait quand
   * même la surcharge.
   *
   * Ce n'était pas hypothétique. Mesuré **avant** que le plafond n'entre dans ce
   * module, sur 49 671 créneaux plafonnés issus de squelettes réels : le déroulé
   * déterministe en dépassait **2 444 (4,9 %)**, jusqu'à 1,48 fois le plafond.
   * Tous dans le coin des petits volumes hebdomadaires, où le plancher de 0,5 km
   * par séance (`halfKm`) découple le budget du créneau de la semaine qui le
   * finance.
   */

  /**
   * Les plafonds, **réécrits ici en toutes lettres**.
   *
   * Comme les formats de zone plus haut : un test qui relit les constantes du
   * code sous test ne prouve rien. `marathon` n'y figure pas — la zone n'a pas de
   * plafond publié en part du volume hebdomadaire, et ce module n'en invente pas.
   */
  const EXPECTED_CAPS = {
    repetition: { share: 0.05, maxKm: 8 },
    interval: { share: 0.08, maxKm: 10 },
    threshold: { share: 0.1, maxKm: Number.POSITIVE_INFINITY },
    marathon: null,
  } as const satisfies Record<QualityZone, { share: number; maxKm: number } | null>;

  /** Le plafond en mètres, arrondi comme le module l'arrondit. */
  function capM(zone: QualityZone, weeklyTargetKm: number): number | null {
    const cap = EXPECTED_CAPS[zone];
    return cap === null ? null : Math.round(Math.min(weeklyTargetKm * cap.share, cap.maxKm) * 1_000);
  }

  /** Le volume d'effort d'un déroulé, en mètres : les `run`, répétitions comprises. */
  function effortM(steps: PlanSessionSteps): number {
    return flattenSteps(steps)
      .filter((step) => step.role === 'run')
      .reduce((total, step) => total + (step.distanceM ?? 0), 0);
  }

  it('ne dépasse jamais le plafond, sur tout le domaine', () => {
    const failures: string[] = [];

    for (const swept of SWEEP) {
      const cap = capM(swept.zone, swept.weeklyTargetKm);
      if (cap === null) continue;

      const effort = effortM(qualitySessionTemplate(swept));
      if (effort > cap) failures.push(`${swept.label} : ${effort} m > ${cap} m`);
    }

    expect(failures).toEqual([]);
  });

  /*
   * Le balayage ci-dessus apparie chaque budget à la semaine la plus maigre qui
   * puisse le porter ({@link MAX_QUALITY_SHARE}) : c'est le pire cas, pas le cas
   * réel. Celui-ci prend les appariements que `buildPlanSkeleton` produit
   * vraiment — chaque créneau avec la semaine qui l'a budgété.
   */
  it('ne dépasse jamais le plafond sur des squelettes réels non plus', () => {
    const failures: string[] = [];
    let slots = 0;

    for (const intent of PLAN_INTENTS) {
      for (const goal of SKELETON_GOALS) {
        if ((intent === 'race') !== (goal.race !== null)) continue;
        for (const recentWeeklyKm of SKELETON_WEEKLY_KM) {
          for (const level of LEVELS) {
            for (const weeks of SKELETON_WEEKS) {
              for (const sessionsPerWeek of SKELETON_SESSIONS) {
                const skeleton = skeletonOrNull({
                  intent,
                  goal,
                  recentWeeklyKm,
                  level,
                  weeks,
                  sessionsPerWeek,
                });
                if (skeleton === null) continue;

                for (const week of skeleton) {
                  for (const slot of week.qualitySlots) {
                    slots += 1;
                    const cap = capM(slot.zone, slot.weeklyTargetKm);
                    if (cap === null) continue;

                    const effort = effortM(qualitySessionTemplate(slot));
                    if (effort > cap) {
                      failures.push(
                        `${intent}/${goal.label}/${recentWeeklyKm} km/${level}/${weeks} sem/${sessionsPerWeek} séances ` +
                          `— s${week.weekNumber} ${slot.zone} (budget ${slot.budgetKm} km, semaine ${slot.weeklyTargetKm} km) : ` +
                          `${effort} m > ${cap} m`,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
    // Le balayage ne prouverait rien s'il ne voyait aucun créneau.
    expect(slots).toBeGreaterThan(10_000);
  });

  /*
   * Le plafond doit **mordre** quelque part, sinon les deux tests ci-dessus sont
   * vrais pour la mauvaise raison. Voici le cas exact, minimal et reproductible :
   * un seuil de 5,5 km dans une semaine de 29 km pour une confirmée en
   * spécificité. Sans plafond, le module écrit un bloc continu de 3 000 m — le
   * plus long que la zone autorise —, soit 100 m de plus que les 2 900 m permis.
   * Avec, il écarte ce format et prend le voisin : deux blocs de 1 300 m.
   */
  it('écarte le format qui dépasse et prend le voisin', () => {
    const slot = {
      zone: 'threshold',
      budgetKm: 5.5,
      phase: 'specific',
      level: 'advanced',
    } as const;

    // 32 km de semaine : le plafond vaut 3,2 km, le format naturel passe.
    expect(body(qualitySessionTemplate({ ...slot, weeklyTargetKm: 32 }))).toMatchObject({
      repeat: 1,
      steps: [{ distanceM: 3_000 }],
    });

    // 29 km : le plafond tombe à 2,9 km, et le bloc de 3 000 m ne tient plus.
    const capped = qualitySessionTemplate({ ...slot, weeklyTargetKm: 29 });
    expect(body(capped)).toMatchObject({
      repeat: 2,
      steps: [{ distanceM: 1_300 }, { distanceM: 150 }],
    });
    // Le reliquat va à l'enveloppe, et la somme retombe sur le budget au mètre.
    expect(totalDistanceM(capped)).toBe(5_500);
  });

  /*
   * La zone `marathon` n'a pas de plafond publié en part du volume hebdomadaire,
   * et on n'en invente pas : son déroulé ne doit dépendre en rien de la semaine
   * qui le porte.
   */
  it('n’invente pas de plafond pour la zone spécifique allure course', () => {
    for (const budgetKm of [4, 8, 12]) {
      const params = { zone: 'marathon', budgetKm, phase: 'specific', level: 'advanced' } as const;
      expect(
        qualitySessionTemplate({ ...params, weeklyTargetKm: budgetKm / MAX_QUALITY_SHARE }),
        `${budgetKm} km`,
      ).toEqual(qualitySessionTemplate({ ...params, weeklyTargetKm: 200 }));
    }
  });
});
