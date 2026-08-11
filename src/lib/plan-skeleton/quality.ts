/**
 * La grille **phase × distance d'objectif** : quelle qualité une semaine porte.
 *
 * C'est la seule décision d'entraîneur que ce module prend, et elle se prend une
 * fois pour toutes dans un tableau lisible plutôt qu'en cascade de `if`. Ce que
 * la grille encode est la doctrine commune (Daniels, *Running Formula* ;
 * Pfitzinger & Douglas, *Advanced Marathoning*) : on va du général au spécifique,
 * et le « spécifique » n'est pas le même selon la course visée — les répétitions
 * courtes préparent un 5 km, l'allure objectif prépare un marathon.
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
 * La grille, phase par phase, objectif par objectif — par ordre de priorité.
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
const QUALITY_GRID = {
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
} as const satisfies Record<
  Exclude<PlanPhase, 'partial' | 'race'>,
  Record<GoalFamily, readonly QualityZone[]>
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
 */
export function qualityZones(phase: PlanPhase, goalDistanceKm: number | null): QualityZone[] {
  if (phase === 'partial' || phase === 'race') return [];
  return [...QUALITY_GRID[phase][goalFamily(goalDistanceKm)]];
}
