/**
 * Le déroulé d'une séance de qualité, **écrit par l'appli** — le chemin qui
 * n'appelle personne.
 *
 * ## Pourquoi ce fichier existe
 *
 * Le squelette ({@link buildPlanSkeleton}) laisse des créneaux typés
 * ({@link QualitySlot}) qu'un modèle local doit remplir. Ce modèle est lent,
 * faible, et l'expérience du projet est sans appel : il échoue, il tronque, il
 * répond à côté. Un plan d'entraînement ne peut pas dépendre de lui.
 *
 * Ce module est donc le **repli déterministe** : à partir des trois seules
 * données d'un créneau — la zone, le budget, la phase —, il écrit un déroulé
 * complet, valide et physiologiquement sensé. Il sert quand le modèle échoue, et
 * il rend accessoirement le squelette utilisable seul, sans le moindre appel
 * réseau. Ce que le modèle apporte quand il fonctionne, c'est de la variété et
 * du jugement contextuel ; ce que ce fichier garantit, c'est qu'il y ait
 * toujours une séance.
 *
 * ## Les deux contrats non négociables
 *
 * **1. La somme retombe exactement sur le budget.** Le budget d'un créneau est
 * la part que {@link weeklySessionBudgets} a réservée à cette séance dans la
 * cible hebdomadaire, **enveloppe comprise** : échauffement, récupérations et
 * retour au calme en font partie. Une séance qui dépasse son budget fait sortir
 * la semaine de sa bande de ±10 %, et personne en aval ne la rattrape puisque
 * c'est l'appli qui l'a écrite. Tout le calcul se fait donc en **mètres
 * entiers**, et le retour au calme prend le reliquat exact
 * (`total − échauffement − corps`) : la somme *est* le budget, elle n'en est pas
 * une approximation.
 *
 * **2. Toutes les étapes se mesurent en distance.** Jamais en durée. C'est le
 * contrat que porte la JSDoc de {@link QualitySlot}, et il est mesuré :
 * `imposedDistanceKm` remplace la distance déclarée d'une séance par la
 * couverture de son déroulé dès que celle-ci lui est supérieure. Un créneau
 * budgété 4,5 km rempli en durée (« 15 min + 4 × (3 min + 2 min) + 10 min »)
 * couvre ~11 km à l'allure seuil, et fait sortir de sa cible **2 973 semaines
 * sur 3 024 (98,3 %)** du balayage de propriété. En distance : zéro.
 *
 * ## Ce que ce module n'écrit surtout pas
 *
 * **Aucune allure, aucune zone cardiaque.** `applyImposedPaces` les pose en
 * aval, depuis le `kind` de la séance et les notes des étapes. Écrire une allure
 * ici la ferait diverger de celle que le reste du plan reçoit — leçon de
 * production : quand deux sources écrivent les allures, c'est toujours la
 * mauvaise qui gagne. Les **notes**, elles, comptent : `stepNotePaceZone` y lit
 * « seuil » ou « allure objectif » pour poser sur une étape isolée un créneau
 * différent de celui de sa séance, et les libellés ci-dessous sont choisis pour
 * ce mécanisme-là (cf. {@link ZONE_NOTES}).
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`, ni import Next, ni
 * horloge, ni aléa. Deux appels aux mêmes paramètres rendent le même déroulé, et
 * un test le vérifie.
 */

import { PLAN_STEP_BOUNDS, type PlanSessionSteps, type PlanStep } from '@/lib/plan-steps/schema';

import type { PlanPhase } from './phases';
import type { QualityZone } from './quality';

/*
 * ------------------------------------------------------------------------
 * L'enveloppe : échauffement et retour au calme.
 * ------------------------------------------------------------------------
 */

/**
 * Part nominale du budget consacrée à l'échauffement, puis au retour au calme.
 *
 * Un quart et un cinquième, soit 45 % du budget pour la seule enveloppe. Ce
 * n'est pas du gaspillage de kilomètres : c'est le chiffre qui rend le budget
 * cohérent avec ce que {@link SESSION_BUDGET_SHARES.quality} suppose — « une VMA
 * de 5 km de corps en fait 9 avec son enveloppe », soit 44 %. Un échauffement
 * plus court n'ouvre pas la filière aérobie et fait attaquer le premier effort à
 * froid ; un retour au calme plus court laisse l'athlète sur son pic de lactate.
 *
 * L'échauffement est le plus long des deux parce qu'il porte tout le travail de
 * mise en route (élévation de la température musculaire, montée progressive de
 * l'intensité), là où le retour au calme n'a qu'à ramener au repos.
 */
const WARMUP_SHARE = 0.25;
const COOLDOWN_SHARE = 0.2;

/**
 * Ce qu'échauffement et retour au calme coûtent au minimum, en mètres, quel que
 * soit le budget.
 *
 * **C'est ce qui fait croître la part de l'enveloppe sur les petites séances**,
 * et l'argument est physiologique : le coût de la mise en route est quasi fixe.
 * Il faut une dizaine de minutes de course pour élever la température
 * musculaire et ouvrir la filière aérobie — ce délai ne se réduit pas parce que
 * la séance est courte. Sur une séance de 4 km, l'enveloppe pèse donc la moitié
 * du budget au lieu de 45 %, et c'est la bonne réponse : on n'y fait pas 3 km de
 * travail.
 *
 * 1 200 m et 800 m : environ 10 et 7 minutes à allure d'endurance, le minimum
 * que tout entraîneur écrit.
 */
const WARMUP_FLOOR_M = 1_200;
const COOLDOWN_FLOOR_M = 800;

/**
 * Part maximale du budget que l'enveloppe peut prendre.
 *
 * Sur les budgets minuscules (une semaine à très faible volume peut ne réserver
 * que 500 m à un créneau), les planchers ci-dessus dépasseraient le budget
 * entier. Ils sont alors ramenés au prorata sous ce plafond, qui garde 45 % du
 * budget au travail : une séance de qualité sans travail de qualité n'est plus
 * une séance de qualité, c'est un footing.
 */
const ENVELOPE_MAX_SHARE = 0.55;

/**
 * Part du reliquat de la répartition qui va à l'échauffement, le solde allant au
 * retour au calme.
 *
 * Le corps de séance est fait de nombres ronds (400 m, 1 200 m…) qui ne tombent
 * pas pile sur ce que l'enveloppe lui laisse ; l'écart est absorbé par
 * l'enveloppe, qui est élastique par nature — personne ne chronomètre son
 * échauffement au décamètre. Un peu plus de la moitié pour l'échauffement, comme
 * pour la sortie longue spécifique du squelette : mieux vaut arriver trop chaud
 * sur le premier effort que rentrer trop longtemps une fois la séance faite.
 */
const ENVELOPE_SLACK_WARMUP_SHARE = 0.55;

/** Pas d'écriture de l'enveloppe, en mètres : « 1 550 m », pas « 1 547 m ». */
const ENVELOPE_GRID_M = 50;

/*
 * ------------------------------------------------------------------------
 * Le corps de séance : format par zone.
 * ------------------------------------------------------------------------
 */

/** Pas d'écriture d'un effort, en mètres — les distances que l'on court vraiment. */
const EFFORT_GRID_M = 100;

/** Pas d'écriture d'une récupération, en mètres : plus fin, elle est moins normée. */
const RECOVERY_GRID_M = 50;

/**
 * Ce que coûte, en mètres de reliquat, un écart d'une répétition au format de
 * référence de la zone.
 *
 * Le choix du nombre de répétitions est un compromis entre deux exigences qui ne
 * se mesurent pas dans la même unité : **coller au budget** (le reliquat, en
 * mètres) et **rester dans le format de la zone** (l'écart au nombre de
 * répétitions de référence). Ce coefficient les rend comparables.
 *
 * 25 m par répétition d'écart : un format qui colle 100 m mieux au budget vaut
 * qu'on s'éloigne de quatre répétitions du format de référence, pas davantage.
 * Sans ce terme, un créneau de répétitions de 4 km rendrait `2 × 400 m` — la
 * somme tombe juste, mais 400 m est le bord haut de la zone R et deux
 * répétitions n'installent aucune foulée. Avec, il rend `4 × 200 m`, qui est la
 * séance qu'un entraîneur écrit.
 */
const REPS_PREFERENCE_PENALTY_M = 25;

/** Le format de référence d'une zone : ce qu'un entraîneur y écrit par défaut. */
type ZoneShape = {
  /** Bornes de la longueur d'une répétition, en mètres. */
  effort: { min: number; max: number };
  /** Nombre de répétitions : le maximum admis, et celui vers lequel on penche. */
  reps: { max: number; preferred: number };
  /**
   * La récupération, en part de l'effort qui la précède, puis bornée en mètres.
   *
   * C'est **le** paramètre qui distingue les quatre zones : ce n'est pas la
   * vitesse qui définit une séance (l'appli ne l'écrit pas), c'est le rapport
   * entre l'effort et ce qui le sépare du suivant.
   */
  recovery: { ratio: number; min: number; max: number };
};

/**
 * Les quatre formats, tels que la doctrine les écrit (Daniels, *Running
 * Formula* ; Pfitzinger & Douglas, *Advanced Marathoning*).
 *
 * - **Seuil (T)** — peu de répétitions, longues, récupération courte
 *   *relativement à l'effort*. L'intérêt du travail au seuil est le temps passé
 *   à cette intensité : couper trop souvent ou trop longtemps fait retomber le
 *   lactate et transforme la séance en fractionné. D'où des blocs du kilomètre
 *   à trois, et une récupération au cinquième de l'effort.
 * - **VMA (I)** — répétitions moyennes, récupération du même ordre que
 *   l'effort. On cherche à cumuler du temps à VO2max : chaque répétition doit
 *   être assez longue pour y monter (400 m à 1 km), et la récupération assez
 *   généreuse pour pouvoir refaire la suivante à la même vitesse.
 * - **Répétitions (R)** — répétitions courtes et rapides, récupération **plus
 *   longue que l'effort**. C'est du travail de foulée et d'économie de course,
 *   pas du travail cardiaque : la qualité du geste prime, donc on récupère
 *   presque complètement.
 * - **Spécifique allure course (M)** — un ou deux blocs longs, récupération
 *   symbolique. Ce qui s'y apprend est la tenue de l'allure sur la durée ;
 *   fractionner reviendrait à rendre facile ce que la course rendra difficile.
 *
 * Les nombres de répétitions de référence sont ceux des séances classiques :
 * 3 × 1 500 m au seuil, 6 × 800 m en VMA, 8 × 200 m en répétitions, 2 blocs à
 * allure course. La longueur réelle, elle, n'est pas figée : elle se déduit du
 * budget ({@link chooseFormat}), parce qu'un créneau de 12 km et un créneau de
 * 4 km ne se remplissent pas avec le même format.
 */
const ZONE_SHAPES = {
  threshold: {
    effort: { min: 1_000, max: 3_000 },
    reps: { max: 6, preferred: 3 },
    recovery: { ratio: 0.2, min: 100, max: 400 },
  },
  interval: {
    effort: { min: 400, max: 1_000 },
    reps: { max: 10, preferred: 6 },
    recovery: { ratio: 1, min: 200, max: 800 },
  },
  repetition: {
    effort: { min: 200, max: 400 },
    reps: { max: 14, preferred: 8 },
    recovery: { ratio: 1.5, min: 200, max: 600 },
  },
  marathon: {
    effort: { min: 2_000, max: 6_000 },
    reps: { max: 2, preferred: 2 },
    // Bornes égales : la coupure entre deux blocs à allure course est un temps
    // de respiration, pas une récupération. Elle ne dépend ni de la longueur du
    // bloc ni de la phase.
    recovery: { ratio: 0.05, min: 200, max: 200 },
  },
} as const satisfies Record<QualityZone, ZoneShape>;

/**
 * Comment la phase de la semaine module le format : **un seul levier, la
 * récupération**.
 *
 * Le budget est fixé par ailleurs, et c'est ce qui rend ce levier suffisant :
 * allonger la récupération, c'est dépenser en trot des mètres qui seraient allés
 * à l'effort. Le même créneau de 9 km rend, en VMA, `4 × 500 m` récupération
 * 700 m en base contre `6 × 400 m` récupération 400 m en développement — deux
 * kilomètres à intensité au lieu de deux et demi, sur des répétitions moins
 * nombreuses. C'est exactement la prudence qu'on veut d'un socle qui n'est pas
 * encore posé, et le nombre de répétitions suit tout seul : chacune coûtant plus
 * cher, il en tient moins.
 *
 * - **`base`** — la qualité y est neuve : récupération longue, presque complète.
 *   Ce sont la mécanique et l'économie de course qu'on installe, pas le volume à
 *   intensité.
 * - **`build`** — le format de référence de la zone, sans correction.
 * - **`specific`** — on serre. Tenir l'allure sur une récupération incomplète
 *   *est* la difficulté de la course, et c'est le dernier moment pour
 *   l'apprendre.
 * - **`taper`** — comme la base : on garde la vitesse, on retire la charge. Le
 *   volume, lui, a déjà été retiré par le budget.
 *
 * `partial` et `race` ne portent jamais de créneau de qualité
 * ({@link qualityZones} les rend vides), mais le type les admet : ils prennent
 * le format de référence plutôt que d'ouvrir un cas d'erreur pour une situation
 * qui ne se produit pas.
 */
const PHASE_RECOVERY_FACTOR = {
  partial: 1,
  base: 1.3,
  build: 1,
  specific: 0.8,
  taper: 1.3,
  race: 1,
} as const satisfies Record<PlanPhase, number>;

/**
 * Les consignes écrites sur les étapes, zone par zone.
 *
 * Elles ne sont pas décoratives : `stepNotePaceZone` les lit pour poser sur une
 * étape un créneau d'allure différent de celui de sa séance, par deux motifs
 * (`STEP_NOTE_ZONES`) — « allure objectif / allure de course / spécifique /
 * marathon » range en M, « seuil / tempo » range en T.
 *
 * D'où deux règles d'écriture, et elles se vérifient à la lecture :
 *
 * - sur les zones **seuil** et **spécifique allure course**, la note nomme le
 *   créneau et **confirme** ce que le `kind` dit déjà — ce qui rend la séance
 *   robuste même si le `kind` était réécrit, et donne à l'étape d'effort
 *   l'allure de l'objectif chiffré quand il y en a un (`goalPaceZone`) ;
 * - sur les zones **VMA** et **répétitions**, la note ne contient **aucun** de
 *   ces mots. « Spécifique » dans une note de VMA ferait prescrire l'allure
 *   marathon sur une répétition de 400 m — c'est-à-dire une séance ratée, sans
 *   que rien ne le signale.
 */
const ZONE_NOTES = {
  threshold: {
    effort: 'Effort au seuil, régulier et contrôlé',
    recover: 'Récupération trottée, courte',
    continuous: 'Tempo continu au seuil, allure soutenable',
  },
  interval: {
    effort: 'Effort à VMA, en contrôle',
    recover: 'Récupération trottée',
    continuous: 'Effort continu à VMA, en contrôle',
  },
  repetition: {
    effort: 'Effort vif et relâché, foulée ample',
    recover: 'Récupération complète, trot ou marche',
    continuous: 'Effort vif et relâché, foulée ample',
  },
  marathon: {
    effort: 'Bloc à allure objectif, souple et régulier',
    recover: 'Respiration trottée entre les blocs',
    continuous: 'Bloc continu à allure objectif, souple et régulier',
  },
} as const satisfies Record<QualityZone, { effort: string; recover: string; continuous: string }>;

/** Ce que l'enveloppe dit — elle ne nomme aucun créneau, elle se court en endurance. */
const WARMUP_NOTE = 'Échauffement progressif en endurance';
const COOLDOWN_NOTE = 'Retour au calme en endurance';

/*
 * ------------------------------------------------------------------------
 * Arithmétique.
 * ------------------------------------------------------------------------
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Au multiple de `grid` le plus proche. */
function roundTo(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

/**
 * Au multiple de `grid` **inférieur**.
 *
 * Vers le bas, et pas au plus proche : le corps de séance ne doit jamais
 * dépasser ce que l'enveloppe lui laisse, sans quoi c'est l'échauffement qui
 * paierait l'arrondi.
 */
function floorTo(value: number, grid: number): number {
  return Math.floor(value / grid) * grid;
}

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
 * Ce que l'enveloppe **vise**, avant que le reliquat du corps de séance ne s'y
 * ajoute : sa part nominale du budget, jamais moins que son plancher, le tout
 * ramené sous le plafond quand le budget ne paye pas les deux planchers.
 */
function envelopeTargets(totalM: number): { warmupM: number; cooldownM: number } {
  const warmupIdealM = Math.max(WARMUP_FLOOR_M, totalM * WARMUP_SHARE);
  const cooldownIdealM = Math.max(COOLDOWN_FLOOR_M, totalM * COOLDOWN_SHARE);
  // Au prorata, pour que le rapport échauffement/retour au calme survive au
  // rabotage : sur une séance minuscule, c'est encore l'échauffement qui prime.
  const scale = Math.min(1, (totalM * ENVELOPE_MAX_SHARE) / (warmupIdealM + cooldownIdealM));

  return {
    warmupM: roundTo(warmupIdealM * scale, ENVELOPE_GRID_M),
    cooldownM: roundTo(cooldownIdealM * scale, ENVELOPE_GRID_M),
  };
}

/** Un corps de séance : `recoverM` à 0 quand il n'y a qu'un bloc, qui n'a rien à séparer. */
type SessionFormat = { reps: number; effortM: number; recoverM: number };

/**
 * Le format qui remplit le mieux `workTargetM` sans le dépasser — `null` quand
 * aucun ne tient, c'est-à-dire quand le budget ne paye même pas une répétition
 * de la longueur minimale de la zone.
 *
 * ## Pourquoi une recherche et pas une formule
 *
 * Parce que les trois inconnues (nombre de répétitions, longueur, récupération)
 * sont liées par des arrondis et des bornes, et qu'aucune forme close ne les
 * décrit. Le nombre de répétitions n'a que quelques valeurs possibles : on les
 * essaie toutes, et on garde la meilleure au sens du score ci-dessous. C'est
 * une poignée d'itérations sur des entiers, dans une fonction pure.
 *
 * Pour chaque nombre de répétitions, l'ordre du calcul compte : la récupération
 * se déduit d'une **estimation** de l'effort (sans quoi elle dépendrait d'un
 * effort qui dépend d'elle), puis l'effort prend ce qui reste une fois les
 * récupérations payées. C'est cette seconde étape qui fait coller le format au
 * budget : la récupération, elle, ne bouge plus. Tant qu'aucune borne de la zone
 * ne mord, l'estimation et l'effort retenu ne diffèrent que d'un arrondi, et le
 * rapport effort/récupération vaut bien celui de la zone.
 *
 * Un format qui déborde du budget est **écarté**, jamais rogné. C'est ce qui
 * garantit que l'enveloppe ne rétrécit pas sous ce qu'elle a demandé, et surtout
 * que la récupération ne se fasse jamais raboter pour faire tenir une répétition
 * de plus : « 6 × 400 m avec 150 m de récupération » n'est pas une VMA, c'est un
 * tempo mal écrit. Quand le budget ne finance pas le format, c'est le nombre de
 * répétitions qui tombe, et le reliquat va à l'enveloppe.
 *
 * Le score arbitre entre coller au budget et rester dans le format de la zone
 * ({@link REPS_PREFERENCE_PENALTY_M}). À égalité, le plus petit nombre de
 * répétitions gagne — un choix arbitraire, mais **déterministe**, qui est ce que
 * ce module doit avant tout.
 */
function chooseFormat(zone: QualityZone, phase: PlanPhase, workTargetM: number): SessionFormat | null {
  const shape = ZONE_SHAPES[zone];
  // Le contrat des étapes borne aussi les répétitions : au-delà, c'est un bloc
  // mal découpé, et le schéma refuserait le déroulé.
  const maxReps = Math.min(shape.reps.max, PLAN_STEP_BOUNDS.repeat.max);
  const preferredReps = Math.min(shape.reps.preferred, maxReps);
  const ratio = shape.recovery.ratio * PHASE_RECOVERY_FACTOR[phase];

  let best: SessionFormat | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let reps = 1; reps <= maxReps; reps += 1) {
    // L'effort qu'il faudrait pour remplir le budget de travail, récupérations
    // comprises — d'où le `1 + ratio` au dénominateur.
    const roughEffortM = workTargetM / (reps * (1 + ratio));
    // Un bloc unique n'a rien à séparer : pas de récupération, et le contrat du
    // déroulé n'en exige une que sur un bloc répété.
    const recoverM =
      reps === 1
        ? 0
        : clamp(
            roundTo(roughEffortM * ratio, RECOVERY_GRID_M),
            shape.recovery.min,
            shape.recovery.max,
          );
    const effortM = clamp(
      floorTo((workTargetM - reps * recoverM) / reps, EFFORT_GRID_M),
      shape.effort.min,
      shape.effort.max,
    );

    const usedM = reps * (effortM + recoverM);
    if (usedM > workTargetM) continue;

    const score = workTargetM - usedM + REPS_PREFERENCE_PENALTY_M * Math.abs(reps - preferredReps);
    if (score < bestScore) {
      bestScore = score;
      best = { reps, effortM, recoverM };
    }
  }

  return best;
}

/**
 * Le déroulé complet d'une séance de qualité, dont la distance totale retombe
 * **exactement** sur `budgetKm`.
 *
 * Trois blocs, toujours : l'échauffement, le corps de séance, le retour au
 * calme. C'est la forme que `sessionStepViolations` exige d'une séance
 * d'intensité (un `warmup`, un `cooldown`, et une étape `recover` dans tout bloc
 * répété plus d'une fois), et c'est aussi la forme qu'un coureur lit.
 *
 * Le corps de séance s'adapte au budget : format de la zone quand il y a la
 * place ({@link chooseFormat}), **effort continu** sinon. Ce repli n'est pas un
 * pis-aller — sur un créneau de 2 km, l'enveloppe laisse moins d'un kilomètre de
 * travail, et un kilomètre continu au seuil est une meilleure séance que trois
 * fragments de 300 m séparés par des trots.
 *
 * @param budgetKm la distance totale attendue, enveloppe comprise, telle que
 * {@link QualitySlot.budgetKm} la fixe — donc au moins
 * `PLAN_OUTPUT_BOUNDS.distanceKm.min` (0,5 km), plancher que
 * {@link weeklySessionBudgets} ne franchit jamais. Le déroulé rendu couvre ce
 * budget au mètre près, arrondi du budget en mètres compris (au plus 0,5 m).
 */
export function qualitySessionTemplate(params: {
  zone: QualityZone;
  budgetKm: number;
  phase: PlanPhase;
}): PlanSessionSteps {
  const { zone, budgetKm, phase } = params;

  // Tout se calcule en mètres entiers : c'est la seule façon de faire retomber
  // une somme sur un total sans traîner d'erreur de flottant.
  const totalM = Math.round(budgetKm * 1_000);
  const targets = envelopeTargets(totalM);
  const workTargetM = totalM - targets.warmupM - targets.cooldownM;

  const format = chooseFormat(zone, phase, workTargetM);
  const notes = ZONE_NOTES[zone];
  const usedM = format === null ? workTargetM : format.reps * (format.effortM + format.recoverM);

  // Le corps de séance tombe sur des nombres ronds, l'enveloppe absorbe l'écart
  // — et le retour au calme prend le reliquat exact, ce qui fait la somme juste.
  const slackM = workTargetM - usedM;
  const warmupM = roundTo(targets.warmupM + slackM * ENVELOPE_SLACK_WARMUP_SHARE, ENVELOPE_GRID_M);
  const cooldownM = totalM - warmupM - usedM;

  const body =
    format === null
      ? { repeat: 1, steps: [distanceStep('run', workTargetM, notes.continuous)] }
      : {
          repeat: format.reps,
          steps: [
            distanceStep('run', format.effortM, notes.effort),
            ...(format.recoverM > 0 ? [distanceStep('recover', format.recoverM, notes.recover)] : []),
          ],
        };

  return [
    { repeat: 1, steps: [distanceStep('warmup', warmupM, WARMUP_NOTE)] },
    body,
    { repeat: 1, steps: [distanceStep('cooldown', cooldownM, COOLDOWN_NOTE)] },
  ];
}
