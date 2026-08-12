/**
 * La grille **intention × phase × distance d'objectif** : quelle qualité une
 * semaine porte.
 *
 * C'est la seule décision d'entraîneur que ce module prend, et elle se prend une
 * fois pour toutes dans des tableaux lisibles plutôt qu'en cascade de `if`. Ce
 * que la grille d'une course datée encode est la doctrine commune (Daniels,
 * *Running Formula* ; Pfitzinger & Douglas, *Advanced Marathoning*) : on va du
 * général au spécifique, et le « spécifique » n'est pas le même selon la course
 * visée — les répétitions courtes préparent un 5 km, l'allure objectif prépare un
 * marathon.
 *
 * Les trois autres intentions ont chacune leur grille, plus bas, et chacune sa
 * bibliographie : elles ne visent aucune course, donc rien ne les fait converger
 * vers une allure de course.
 *
 * ## Ce qui se joue dans les libellés
 *
 * Les zones sortent d'ici sous forme de `kind` en français, et ces libellés ne
 * sont pas décoratifs : `sessionPaceZone` les reclasse par expression régulière
 * pour poser les allures en aval ({@link applyImposedPaces}). Un libellé que ces
 * motifs ne reconnaissent pas retombe en endurance — une VMA prescrite à 6:14/km.
 * D'où le vocabulaire figé ci-dessous, et le test qui confronte chaque libellé à
 * `sessionPaceZone`.
 */

import type { PaceZoneKey } from '@/lib/ai/plan-schema';

import type { PlanIntent } from './intent';
import type { PlanPhase } from './phases';

/**
 * Les créneaux d'intensité qu'une séance de qualité peut travailler.
 *
 * Un sous-ensemble strict de {@link PaceZoneKey} : l'endurance n'est pas une
 * qualité, c'est le reste de la semaine.
 */
export type QualityZone = Extract<
  PaceZoneKey,
  'threshold' | 'interval' | 'repetition' | 'marathon'
>;

/**
 * Le `kind` français de chaque zone — celui que l'UI affiche et que
 * `sessionPaceZone` sait reclasser dans la zone d'où il vient.
 *
 * « Spécifique allure course » plutôt que « Allure marathon » : la zone M de la
 * table de Daniels n'est l'allure de la course que sur un marathon, et ce libellé
 * est celui que le reste de l'appli reconnaît comme « à l'allure de l'objectif ».
 */
export const QUALITY_ZONE_KINDS = {
  threshold: 'Seuil',
  interval: 'VMA',
  repetition: 'Répétitions',
  marathon: 'Spécifique allure course',
} as const satisfies Record<QualityZone, string>;

/**
 * Les quatre familles de distances d'objectif.
 *
 * Quatre, et pas un continuum : ce qui distingue une préparation 10 km d'une
 * préparation semi n'est pas 5 kilomètres d'objectif, c'est le déplacement du
 * centre de gravité de l'entraînement — de la VMA vers le seuil, puis du seuil
 * vers l'allure spécifique.
 */
type GoalFamily = 'fiveK' | 'tenK' | 'half' | 'marathon';

/**
 * Les bornes de classement, en kilomètres.
 *
 * Elles sont posées **entre** les distances officielles (5, 10, 21,1 et 42,2 km)
 * pour que les courses de club — un 8 km, un 12 km, un « 20 km de Paris » —
 * tombent du côté dont elles ont la physiologie.
 */
const GOAL_FAMILY_BOUNDS = { fiveK: 7.5, tenK: 15, half: 30 } as const;

/**
 * La famille d'un objectif chiffré — 10 km quand il n'y a pas de chiffre.
 *
 * Un objectif libre (« reprendre la course », « courir 3 fois par semaine ») n'a
 * pas de distance : le 10 km est le repli, parce que sa préparation est la plus
 * polyvalente des quatre — elle travaille la VMA comme le seuil, et ne spécialise
 * l'athlète vers rien qu'elle n'ait demandé.
 */
export function goalFamily(goalDistanceKm: number | null): GoalFamily {
  if (goalDistanceKm === null) return 'tenK';
  if (goalDistanceKm < GOAL_FAMILY_BOUNDS.fiveK) return 'fiveK';
  if (goalDistanceKm < GOAL_FAMILY_BOUNDS.tenK) return 'tenK';
  if (goalDistanceKm < GOAL_FAMILY_BOUNDS.half) return 'half';
  return 'marathon';
}

/**
 * La grille de **`race`**, phase par phase, objectif par objectif — par ordre de
 * priorité.
 *
 * L'ordre **est** la donnée : une semaine qui n'ouvre qu'un créneau de qualité
 * prend la première zone, une semaine qui en ouvre deux prend les deux. La
 * première ligne de chaque case est donc ce qui compte le plus à ce moment-là de
 * la préparation.
 *
 * Trois lectures qui expliquent le reste :
 *
 * - **la base ne fait que des répétitions**, quelle que soit la course. Ce sont
 *   des efforts courts et rapides à récupération complète : ils installent
 *   l'économie de course et la mécanique sans coût aérobie, ce qui est
 *   exactement ce qu'un socle demande ;
 * - **le développement travaille la filière de la course**, un cran au-dessus
 *   d'elle pour les courtes distances (VMA sur 10 km) et un cran en dessous pour
 *   les longues (seuil sur semi, allure objectif sur marathon) ;
 * - **la spécificité converge vers l'allure de la course** — sauf sur 5 km, où
 *   l'allure de course *est* déjà au-dessus du seuil et où c'est la VMA qui
 *   reste la séance de référence.
 */
const RACE_QUALITY_GRID = {
  base: {
    fiveK: ['repetition'],
    tenK: ['repetition'],
    half: ['repetition'],
    marathon: ['repetition'],
  },
  build: {
    fiveK: ['repetition', 'interval'],
    tenK: ['interval', 'threshold'],
    half: ['threshold', 'interval'],
    marathon: ['marathon', 'threshold'],
  },
  specific: {
    fiveK: ['interval', 'marathon'],
    tenK: ['threshold', 'marathon'],
    half: ['threshold', 'marathon'],
    marathon: ['marathon', 'threshold'],
  },
  taper: {
    fiveK: ['repetition'],
    tenK: ['interval'],
    half: ['threshold'],
    marathon: ['marathon'],
  },
} as const satisfies Record<TrainingPhase, Record<GoalFamily, readonly QualityZone[]>>;

/** Une phase qui porte réellement de l'entraînement — ni entamée, ni courue. */
type TrainingPhase = Exclude<PlanPhase, 'partial' | 'race'>;

/**
 * La grille de **`faster`** : courir plus vite, sans date.
 *
 * Trois décisions, et chacune a sa source.
 *
 * - **Aucune zone `marathon`, nulle part.** « Spécifique allure course » n'a de
 *   sens que s'il existe une course dont on connaît l'allure. Sans objectif
 *   chiffré, ce libellé prescrit l'allure d'une épreuve imaginaire — c'est
 *   exactement le titre absurde relevé en production sur un objectif libre, et
 *   c'est ce que cette ligne corrige.
 * - **Le seuil d'abord en développement.** L'allure de seuil est la plus fiable
 *   des allures VDOT au niveau récréatif (Scudamore 2017), donc celle dont la
 *   prescription se trompe le moins quand le chrono de référence est
 *   approximatif — et l'ordre « seuil d'abord, VMA ensuite » est celui du bras
 *   gagnant de Filipas 2022.
 * - **La bascule VMA-d'abord en fin de cycle.** Toujours Filipas 2022, et Casado
 *   2022 pour la lecture d'ensemble : une progression pyramidale (dominée par le
 *   seuil) qui bascule polarisée (dominée par la VMA) en fin de cycle produit de
 *   meilleurs gains que l'une ou l'autre tenue seule. La phase spécifique **est**
 *   ce basculement : sans course, on ne converge pas vers une allure, on change
 *   de dominante.
 *
 * L'affûtage ne survient pas sous cette intention — il se déduit d'une date, et
 * `faster` n'en a pas. Sa ligne existe pour que la grille reste **totale**, donc
 * une pure fonction de (intention, phase) : un appelant qui imposerait une
 * périodisation avec affûtage recevrait la zone la plus fiable, pas une
 * exception.
 */
const FASTER_QUALITY_GRID = {
  base: ['repetition'],
  build: ['threshold', 'interval'],
  specific: ['interval', 'threshold'],
  taper: ['threshold'],
} as const satisfies Record<TrainingPhase, readonly QualityZone[]>;

/**
 * La grille de **`weight_loss`** : une séance dure par semaine, et une seule
 * raison de la faire.
 *
 * La séance de VMA du développement se justifie par la **VO2max**, jamais par la
 * masse grasse : Weeldreyer 2024 montre que le niveau de fitness annule le
 * surrisque de mortalité associé au surpoids, tandis que sur la composition
 * corporelle elle-même, intensité et continu sont équivalents à dépense égale
 * (Keating 2017 ; Wewege 2017 ; Steele 2021 ; consensus ACSM 2024). La
 * méta-analyse Viana 2019, qui concluait à la supériorité de l'intensité et qu'on
 * cite encore couramment, est **rétractée**.
 *
 * D'où une grille tenue : des répétitions courtes le temps de poser le socle,
 * puis de la VMA — une fois par semaine, sur un plan dont tout le reste est du
 * volume facile.
 *
 * Ni `specific` ni `taper` ne surviennent sous cette intention (`planPhases` n'en
 * produit pas sans date ni convergence) ; leurs lignes gardent la grille totale.
 */
const WEIGHT_LOSS_QUALITY_GRID = {
  base: ['repetition'],
  build: ['interval'],
  specific: ['interval'],
  taper: ['interval'],
} as const satisfies Record<TrainingPhase, readonly QualityZone[]>;

/**
 * La grille de **`return`** : vide, partout.
 *
 * Ce n'est pas une précaution contre l'intensité — Fredette 2022 conclut à des
 * preuves **contradictoires** sur l'intensité comme facteur de blessure. C'est la
 * **charge cumulée** qu'on limite : une reprise se joue sur la fréquence et la
 * régularité, et une séance de qualité y ajouterait une sollicitation longue dont
 * ces semaines-là n'ont aucun besoin.
 *
 * La vivacité, elle, n'est pas absente : les footings portent les variations du
 * module (lignes droites, côtes courtes), soit 15 à 20 s d'accélération à coût
 * structurel quasi nul, et les premières semaines se courent en marche/course.
 */
const RETURN_QUALITY_GRID = {
  base: [],
  build: [],
  specific: [],
  taper: [],
} as const satisfies Record<TrainingPhase, readonly QualityZone[]>;

/** Les grilles des intentions **sans distance d'objectif** — la phase suffit à décider. */
const DATELESS_QUALITY_GRIDS = {
  faster: FASTER_QUALITY_GRID,
  weight_loss: WEIGHT_LOSS_QUALITY_GRID,
  return: RETURN_QUALITY_GRID,
} as const satisfies Record<
  Exclude<PlanIntent, 'race'>,
  Record<TrainingPhase, readonly QualityZone[]>
>;

/**
 * Les zones de qualité d'une semaine, par ordre de priorité — vide quand la
 * semaine n'en porte aucune.
 *
 * Deux phases ne portent pas de qualité, et pour deux raisons différentes :
 *
 * - `partial`, la première semaine déjà entamée : on ignore ce que l'athlète a
 *   couru avant le départ du plan, et poser une séance dure derrière deux jours
 *   inconnus est un pari qu'aucun entraîneur ne prend ;
 * - `race`, la semaine de la course : la séance dure de cette semaine-là, c'est
 *   la course.
 *
 * **Seule `race` regarde la distance d'objectif.** Les trois autres intentions
 * n'en ont pas de datée, et faire dépendre leur grille d'un chiffre extrait d'un
 * texte libre est précisément ce qui prescrivait une allure de course à qui n'en
 * courait aucune.
 *
 * Fonction **pure de (intention, phase, distance)** : c'est ce qui permet à une
 * reconstruction de fin de plan de retrouver exactement les zones de la création,
 * sans rien savoir de ce qui a été écrit avant elle.
 */
export function qualityZones(
  intent: PlanIntent,
  phase: PlanPhase,
  goalDistanceKm: number | null,
): QualityZone[] {
  if (phase === 'partial' || phase === 'race') return [];
  if (intent === 'race') return [...RACE_QUALITY_GRID[phase][goalFamily(goalDistanceKm)]];
  return [...DATELESS_QUALITY_GRIDS[intent][phase]];
}
