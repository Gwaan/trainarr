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
 * Ce module est donc le **repli déterministe** : à partir des quatre seules
 * données d'un créneau — la zone, le budget, la phase, le niveau —, il écrit un déroulé
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
 * **3. Le volume d'effort reste sous le plafond de sa zone.** Le déroulé est le
 * repli d'une validation qui refuse une séance dépassant le plafond de Daniels
 * (`quality-load.ts`) : un repli qui le dépasserait ne replierait rien. Le
 * plafond agit à deux endroits, et à deux endroits seulement — il **écarte** les
 * formats qui le dépassent ({@link chooseFormat}), et il borne l'effort continu.
 * Le reliquat va à l'enveloppe, comme tous les autres reliquats de ce module.
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

import type { PlanLevel } from '@/data/db/schema';
import { PLAN_STEP_BOUNDS, type PlanSessionSteps, type PlanStep } from '@/lib/plan-steps/schema';

import type { PlanPhase } from './phases';
import type { QualityZone } from './quality';
import { qualityEffortCapKm } from './quality-load';

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
 * Ce que le retour au calme coûte au minimum, en mètres, quel que soit le
 * budget — l'échauffement a le sien, par niveau ({@link LEVEL_WARMUP_FLOOR_M}).
 *
 * **Ces planchers sont ce qui fait croître la part de l'enveloppe sur les
 * petites séances**, et l'argument est physiologique : le coût de la mise en
 * route et celui du retour au repos sont quasi fixes. Il faut une dizaine de
 * minutes de course pour élever la température musculaire et ouvrir la filière
 * aérobie — ce délai ne se réduit pas parce que la séance est courte. Sur une
 * séance de 4 km, l'enveloppe pèse donc la moitié du budget au lieu de 45 %, et
 * c'est la bonne réponse : on n'y fait pas 3 km de travail.
 *
 * 800 m : environ 7 minutes à allure d'endurance, le minimum que tout entraîneur
 * écrit. Il ne dépend pas du niveau — ramener au repos prend le même temps pour
 * tout le monde, là où se préparer à l'effort n'en prend pas.
 */
const COOLDOWN_FLOOR_M = 800;

/**
 * Le plancher d'échauffement, **par niveau** — et la troisième prescription que
 * la bascule sur squelette avait perdue.
 *
 * ## Ce qu'elle disait, et ce qui l'avait remplacée
 *
 * Le prompt du plan entier portait, pour une débutante : « échauffement long,
 * 15 à 20 min de footing très souple avant toute séance de qualité ». Il a
 * disparu avec le plan entier, et l'enveloppe s'est mise à appliquer le même
 * plancher de 1 200 m à tout le monde — soit, sur un créneau débutant de 6 km,
 * 1 500 m d'échauffement, environ 11 minutes à l'allure d'endurance d'une
 * débutante : la moitié basse de ce que la règle demandait, et pas ce qu'elle
 * demandait.
 *
 * ## Pourquoi ce n'est pas un second bouton sur le même effet
 *
 * {@link LEVEL_RECOVERY_FACTOR} pose que le niveau n'agit **que** sur la
 * récupération, pour ne pas empiler deux réglages tirant vers « plus facile »
 * sans savoir lequel produit quoi. Cette règle vaut toujours, et elle porte sur
 * le **corps** de séance : le rapport effort/récupération, donc la difficulté du
 * travail. L'échauffement est une autre dimension — il ne rend pas le travail
 * plus facile, il rend l'athlète prête à le faire, et une débutante met plus
 * longtemps à l'être. Les deux se lisent séparément dans le déroulé écrit
 * (l'étape `warmup` d'un côté, les `recover` de l'autre), donc l'objection
 * « personne ne saura lequel a produit quoi » ne tient pas ici.
 *
 * ## Le chiffre
 *
 * 2 000 m pour une débutante : environ 15 minutes à l'allure d'endurance qu'on
 * lui suppose (7:30/km), soit le bas de la fourchette prescrite. En mètres et
 * non en minutes parce que tout ce module compte en mètres — le budget d'un
 * créneau est une distance, et convertir ici demanderait une allure que le
 * squelette n'a pas.
 *
 * 1 200 m pour les deux autres niveaux : la valeur d'avant, inchangée au mètre
 * près. Le déroulé d'une intermédiaire ou d'une confirmée ne bouge pas.
 *
 * Le plafond d'enveloppe ({@link ENVELOPE_MAX_SHARE}) continue de s'appliquer
 * par-dessus : sur un créneau minuscule, l'échauffement long est ramené au
 * prorata comme le reste, sans quoi il ne resterait plus de séance. La
 * conséquence mesurée sur le balayage : le budget au-delà duquel un format à
 * répétitions tient toujours passe de 3,9 à 4,4 km pour une débutante en zone
 * `marathon`, et ne bouge nulle part ailleurs. Un demi-kilomètre de budget
 * bascule donc sur l'effort continu — soit exactement les cas où il ne restait
 * plus que 2 km de travail après l'enveloppe, et où un bloc continu vaut mieux
 * que deux fragments.
 */
const LEVEL_WARMUP_FLOOR_M = {
  beginner: 2_000,
  intermediate: 1_200,
  advanced: 1_200,
} as const satisfies Record<PlanLevel, number>;

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
 * récupération** — celui-là même que le niveau de l'athlète actionne de son côté
 * ({@link LEVEL_RECOVERY_FACTOR}), les deux facteurs se multipliant.
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
 * Comment le **niveau de l'athlète** module le format — et pourquoi c'est encore
 * la récupération, comme pour la phase.
 *
 * ## Ce que ce facteur répare
 *
 * Avant la bascule sur squelette, le niveau décidait du contenu des séances
 * dures par le prompt du plan entier (« NIVEAU DÉBUTANT — au plus une séance de
 * qualité, courte et douce, fractionné court. Jamais de bloc de seuil long »
 * contre « CONFIRMÉ — blocs de seuil plus longs »). Ce prompt a
 * disparu avec le plan entier, et la règle avec lui : **mesuré sur un semi en
 * 1 h 45 à 4 séances, une débutante recevait 9 séances de seuil à la structure
 * exacte d'une confirmée, et `advanced` produisait un plan strictement identique
 * à `intermediate`.** Seul le nombre de créneaux distinguait encore les niveaux.
 *
 * ## Pourquoi la récupération, et pas la longueur des répétitions
 *
 * Parce que c'est le seul paramètre qui produise les **deux** effets attendus
 * d'un seul geste. À budget fixé, l'effort se déduit de la récupération
 * (`roughEffortM = workTargetM / (reps × (1 + ratio))`) : allonger la
 * récupération raccourcit mécaniquement les efforts. Une débutante obtient donc
 * des efforts plus courts *et* plus de trot, sans qu'on ait à le demander deux
 * fois.
 *
 * Le levier évident — resserrer les bornes de longueur de la zone
 * ({@link ZONE_SHAPES}) — a été mesuré et écarté : ces bornes ne mordent que sur
 * les bords du domaine. Sur un créneau de seuil de 9 km en développement, les
 * bornes de `intermediate` (1 000–3 000 m) et celles d'un `advanced` élargi
 * (1 400–4 200 m) rendent **le même déroulé**, `3 × 1 300 m` : la longueur
 * retenue vient du budget, pas de la borne. Le défaut qu'on répare serait resté.
 *
 * ## Un seul bouton sur la difficulté du travail, et pas deux
 *
 * Sur le **corps** de séance, le niveau n'agit que sur ce facteur — ni sur les
 * bornes de longueur, ni sur le nombre de répétitions préféré. Deux réglages
 * tirant tous les deux vers « plus facile » se composeraient sans que personne
 * ne sache lequel a produit quoi, et le module a déjà tranché la question pour
 * la phase : un seul levier, la récupération.
 *
 * Le plancher d'échauffement ({@link LEVEL_WARMUP_FLOOR_M}) est la seule
 * exception, et il n'en est pas vraiment une : il ne touche pas au travail, il
 * touche à la préparation du travail. Le pourquoi de cette frontière est écrit
 * là-bas.
 *
 * Le facteur du niveau et celui de la phase se **multiplient**, et les bornes en
 * mètres de chaque zone ({@link ZONE_SHAPES}) bornent le produit : une base pour
 * une débutante (1,3 × 1,5) ne peut pas dépasser la récupération maximale de sa
 * zone, une spécificité pour une confirmée (0,8 × 0,8) pas descendre sous sa
 * minimale. Le balayage complet du domaine le vérifie zone par zone.
 *
 * - **`beginner`** — la qualité est neuve : des efforts courts, et de quoi
 *   revenir au calme entre chacun. C'est ce que disait la règle de prompt
 *   disparue, et c'est ce qui fait qu'une séance dure se termine fraîche.
 * - **`intermediate`** — le format de référence, sans correction : le facteur
 *   vaut exactement 1, et les déroulés d'aujourd'hui ne bougent pas d'un mètre.
 * - **`advanced`** — on serre. Tenir l'allure sur une récupération incomplète
 *   est ce qui distingue une athlète installée, et le budget rendu par le trot
 *   part dans des blocs plus longs.
 *
 * ## Ce qu'il ne change pas, et c'est voulu
 *
 * La zone `marathon` a des bornes de récupération **égales** (200 m, cf.
 * {@link ZONE_SHAPES}) : sa coupure est une respiration entre deux blocs, pas
 * une récupération. Elle ne dépend déjà pas de la phase ; elle ne dépend pas
 * davantage du niveau, et un bloc à allure objectif s'écrit pareil pour tout le
 * monde. Ce que le niveau change alors est ailleurs — le *nombre* de créneaux
 * ({@link qualitySlotCount}) et le volume que les cibles autorisent.
 */
const LEVEL_RECOVERY_FACTOR = {
  beginner: 1.5,
  intermediate: 1,
  advanced: 0.8,
} as const satisfies Record<PlanLevel, number>;

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
    hrPercentMin: null,
    hrPercentMax: null,
    note,
  };
}

/**
 * Ce que l'enveloppe **vise**, avant que le reliquat du corps de séance ne s'y
 * ajoute : sa part nominale du budget, jamais moins que son plancher, le tout
 * ramené sous le plafond quand le budget ne paye pas les deux planchers.
 *
 * Le plancher d'échauffement dépend du niveau ({@link LEVEL_WARMUP_FLOOR_M}) —
 * c'est la seule chose que le niveau change en dehors du corps de séance, et le
 * pourquoi est écrit là-bas.
 */
function envelopeTargets(totalM: number, level: PlanLevel): { warmupM: number; cooldownM: number } {
  const warmupIdealM = Math.max(LEVEL_WARMUP_FLOOR_M[level], totalM * WARMUP_SHARE);
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
function chooseFormat(
  zone: QualityZone,
  phase: PlanPhase,
  level: PlanLevel,
  workTargetM: number,
  effortCapM: number | null,
): SessionFormat | null {
  const shape = ZONE_SHAPES[zone];
  // Le contrat des étapes borne aussi les répétitions : au-delà, c'est un bloc
  // mal découpé, et le schéma refuserait le déroulé.
  const maxReps = Math.min(shape.reps.max, PLAN_STEP_BOUNDS.repeat.max);
  const preferredReps = Math.min(shape.reps.preferred, maxReps);
  // Les deux seuls modulateurs du format, et ils tirent la même corde : la
  // récupération. Le produit reste borné par les bornes en mètres de la zone.
  const ratio =
    shape.recovery.ratio * PHASE_RECOVERY_FACTOR[phase] * LEVEL_RECOVERY_FACTOR[level];

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
    // Le plafond de volume d'effort **écarte** le format, il ne le rogne pas :
    // rogner l'effort sous la longueur minimale de la zone changerait la nature
    // de la séance (un « seuil » de 3 × 700 m n'est plus un seuil), là où le
    // format voisin — une répétition de plus, donc plus courte — reste celui que
    // la zone décrit. Quand aucun ne tient, c'est l'effort continu qui prend la
    // suite, plafonné lui aussi.
    if (effortCapM !== null && reps * effortM > effortCapM) continue;

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
 * @param level le niveau de l'athlète, second et dernier modulateur du format
 * ({@link LEVEL_RECOVERY_FACTOR}). Sans lui, le repli écrirait à une débutante
 * la séance d'une confirmée — c'est le défaut mesuré que ce paramètre répare.
 * @param weeklyTargetKm la cible hebdomadaire de la semaine où tombe le créneau,
 * qui plafonne le **volume d'effort** de la séance ({@link qualityEffortCapKm}).
 *
 * Paramètre **obligatoire**, et c'est délibéré : ce déroulé est le repli d'une
 * validation qui, elle, refuse une séance au-dessus du plafond. Un défaut ici
 * produirait un repli que la validation rejetterait — un repli qui ne replie
 * rien. Mesuré avant qu'il n'existe : sur 49 671 créneaux plafonnés issus de
 * squelettes réels, le déroulé déterministe en dépassait **2 444 (4,9 %)**,
 * jusqu'à 1,48 fois le plafond, tous dans le coin des petits volumes
 * hebdomadaires — où le plancher de 0,5 km par séance (`halfKm`) découple le
 * budget du créneau de la semaine qui le finance.
 */
export function qualitySessionTemplate(params: {
  zone: QualityZone;
  budgetKm: number;
  phase: PlanPhase;
  level: PlanLevel;
  weeklyTargetKm: number;
}): PlanSessionSteps {
  const { zone, budgetKm, phase, level, weeklyTargetKm } = params;

  // Tout se calcule en mètres entiers : c'est la seule façon de faire retomber
  // une somme sur un total sans traîner d'erreur de flottant.
  const totalM = Math.round(budgetKm * 1_000);
  const targets = envelopeTargets(totalM, level);
  const workTargetM = totalM - targets.warmupM - targets.cooldownM;

  const capKm = qualityEffortCapKm(zone, weeklyTargetKm);
  const effortCapM = capKm === null ? null : Math.round(capKm * 1_000);

  const format = chooseFormat(zone, phase, level, workTargetM, effortCapM);
  const notes = ZONE_NOTES[zone];
  // L'effort continu est plafonné comme les autres. Le plancher d'une étape
  // reste le dernier mot : c'est ce qui garde le déroulé valide par
  // construction, y compris sur un plafond que le contrat ne saurait pas
  // exprimer (moins de 10 m, soit une semaine sous 200 m — que nulle
  // configuration finançable ne produit).
  const continuousM =
    effortCapM === null
      ? workTargetM
      : Math.max(PLAN_STEP_BOUNDS.distanceM.min, Math.min(workTargetM, effortCapM));
  const usedM = format === null ? continuousM : format.reps * (format.effortM + format.recoverM);

  // Le corps de séance tombe sur des nombres ronds, l'enveloppe absorbe l'écart
  // — et le retour au calme prend le reliquat exact, ce qui fait la somme juste.
  const slackM = workTargetM - usedM;
  const warmupM = roundTo(targets.warmupM + slackM * ENVELOPE_SLACK_WARMUP_SHARE, ENVELOPE_GRID_M);
  const cooldownM = totalM - warmupM - usedM;

  const body =
    format === null
      ? { repeat: 1, steps: [distanceStep('run', continuousM, notes.continuous)] }
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
