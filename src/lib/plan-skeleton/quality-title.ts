/**
 * Le **titre d'une séance de qualité**, écrit depuis son déroulé.
 *
 * ## Le défaut de production qui a ouvert ce fichier
 *
 * « Seuil en 3 × 1,5 km + 1 × 1,0 km », sur une séance de 5 km dont le déroulé
 * ne contenait que **deux** efforts (1,5 km puis 1 km). Le titre annonçait
 * 5,5 km d'effort dans une séance de 5 km : arithmétiquement impossible, et
 * pourtant c'est ce que l'athlète lisait sur sa timeline et sur son calendrier
 * intervals.icu (`name` de l'event, cf. `lib/intervals/push-plan`).
 *
 * La cause n'était pas un mauvais modèle mais une mauvaise division du travail :
 * c'est **lui** qui écrivait le titre, dans le même objet que les étapes, et
 * rien ne vérifiait que les deux disent la même chose. C'est exactement le
 * genre d'arithmétique que le projet ne lui confie plus depuis la bascule sur
 * squelette — *le modèle structure, l'appli chiffre*. Le champ `title` a donc
 * disparu de sa grammaire comme de son schéma Zod : ce qu'il ne peut pas écrire
 * ne peut pas être faux, et sa sortie est plus courte d'autant.
 *
 * ## Une seule source pour les deux chemins
 *
 * Le déroulé d'un créneau vient soit du modèle, soit de l'appli
 * ({@link qualitySessionTemplate}). Les deux passent par ici, et c'est le point
 * de ce module : le repli avait ses propres titres fixes (« Séance de seuil »),
 * si bien qu'une séance écrite par l'appli et la même séance écrite par le
 * modèle ne se présentaient pas pareil. Ils ne peuvent plus diverger — il n'y a
 * plus qu'un générateur.
 *
 * Module **pur** et déterministe : un déroulé, un titre, toujours le même.
 */

import { PLAN_OUTPUT_BOUNDS } from '@/lib/ai/plan-schema';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import type { QualityZone } from './quality';

/**
 * Ce qui **nomme** la zone dans un titre — le premier mot que l'athlète lit.
 *
 * Court, et dans le vocabulaire du plan : c'est le même mot que le `kind` du
 * créneau porte, sans le redire en entier (l'event intervals.icu s'intitule
 * `kind — titre`, et « Seuil — Seuil en 3 × 1 km » serait du bégaiement).
 */
const ZONE_PREFIXES = {
  threshold: 'Seuil',
  interval: 'VMA',
  repetition: 'Répétitions',
  marathon: 'Allure objectif',
} as const satisfies Record<QualityZone, string>;

/**
 * Le titre **générique** d'une zone : celui qu'on écrit quand le déroulé ne se
 * résume pas honnêtement.
 *
 * C'est l'ancien titre du repli déterministe, mot pour mot. Il ne disparaît pas
 * avec l'arrivée du générateur : un déroulé inclassable (aucun effort mesuré en
 * distance, ou trop de formats différents pour tenir dans un titre) vaut mieux
 * annoncé par sa zone que par une énumération illisible ou, pire, par des
 * chiffres qui ne seraient pas les siens.
 */
export const QUALITY_ZONE_TITLES = {
  threshold: 'Séance de seuil',
  interval: 'Séance de VMA',
  repetition: 'Séance de répétitions',
  marathon: "Bloc à l'allure de l'objectif",
} as const satisfies Record<QualityZone, string>;

/**
 * Le titre de l'ultime recours, qui ne peut nommer aucune zone — c'est
 * précisément parce que la zone n'est pas exploitable qu'on en est là.
 */
export const LAST_RESORT_TITLE = 'Séance de qualité';

/**
 * Nombre de formats distincts qu'un titre énumère.
 *
 * Trois : « Seuil en 3 × 1,5 km + 1 km » se lit d'un coup d'œil, « Seuil en
 * 3 × 1,5 km + 1 km + 800 m + 2 × 600 m » est un déroulé recopié dans un titre.
 * Au-delà, la séance s'annonce par sa zone et se lit dans son déroulé — c'est
 * là qu'elle est écrite en entier, à sa place.
 */
const MAX_TITLE_GROUPS = 3;

/** Un format d'effort du déroulé : sa longueur, et le nombre de fois qu'il revient. */
type EffortGroup = { distanceM: number; count: number };

/**
 * Les formats d'effort du déroulé, dans l'ordre, formats identiques consécutifs
 * fusionnés.
 *
 * Seules les étapes de **course** comptent, et seulement celles mesurées en
 * distance : un échauffement, une récupération ou un retour au calme ne sont pas
 * le contenu de la séance, et une étape chronométrée ne s'annonce pas en
 * kilomètres. Le `repeat` du bloc porte le nombre de passages — c'est lui qui
 * fait le « 3 × » du titre, et c'est ce que le titre de production avait perdu.
 */
function effortGroups(steps: PlanSessionSteps): EffortGroup[] {
  const groups: EffortGroup[] = [];

  for (const block of steps) {
    for (const step of block.steps) {
      if (step.role !== 'run' || step.distanceM === null) continue;

      const distanceM = Math.round(step.distanceM);
      const last = groups.at(-1);
      if (last !== undefined && last.distanceM === distanceM) last.count += block.repeat;
      else groups.push({ distanceM, count: block.repeat });
    }
  }

  return groups;
}

/**
 * Une longueur d'effort telle qu'on la nomme : `400 m`, `1 km`, `1,5 km`,
 * `1,25 km`.
 *
 * Au centième de kilomètre au plus, zéros inutiles retirés : un titre annonce
 * une séance, pas une mesure. Sous le kilomètre, les mètres — « 0,4 km » n'est
 * pas une façon d'écrire un 400.
 */
function formatEffortDistance(distanceM: number): string {
  if (distanceM < 1_000) return `${distanceM} m`;

  const km = (distanceM / 1_000).toFixed(2).replace(/\.?0+$/, '');
  return `${km.replace('.', ',')} km`;
}

/** Un format : `3 × 1,5 km`, ou la seule longueur quand il ne revient qu'une fois. */
function formatGroup(group: EffortGroup): string {
  const distance = formatEffortDistance(group.distanceM);
  return group.count > 1 ? `${group.count} × ${distance}` : distance;
}

/**
 * Le titre d'une séance de qualité, **déduit de son déroulé**.
 *
 * Quatre formes, dans l'ordre où elles se présentent :
 *
 * - un format répété : « Seuil en 3 × 1 km », « VMA en 4 × 400 m » ;
 * - plusieurs formats : « Seuil en 3 × 1,5 km + 1 km » ;
 * - un effort unique et continu : « Seuil en continu 3 km » — c'est ce que le
 *   déroulé déterministe écrit sur les petits budgets, où l'enveloppe ne laisse
 *   pas la place à des fragments ;
 * - le titre générique de la zone ({@link QUALITY_ZONE_TITLES}) quand rien de
 *   tout cela ne s'écrit honnêtement : aucun effort mesuré en distance, plus de
 *   {@link MAX_TITLE_GROUPS} formats, ou un titre qui dépasserait les bornes du
 *   contrat de sortie.
 *
 * @param zone la zone du créneau. Hors contrat — ce qui ne peut arriver que par
 * un `as`, mais le repli déterministe le prévoit déjà —, le titre ne nomme
 * aucune zone ({@link LAST_RESORT_TITLE}) : inventer un nom serait pire que de
 * n'en donner aucun.
 */
export function qualitySessionTitle(zone: QualityZone, steps: PlanSessionSteps): string {
  const prefix: string | undefined = ZONE_PREFIXES[zone];
  const generic: string | undefined = QUALITY_ZONE_TITLES[zone];
  if (prefix === undefined || generic === undefined) return LAST_RESORT_TITLE;

  const groups = effortGroups(steps);
  if (groups.length === 0 || groups.length > MAX_TITLE_GROUPS) return generic;

  const title =
    groups.length === 1 && groups[0].count === 1
      ? `${prefix} en continu ${formatEffortDistance(groups[0].distanceM)}`
      : `${prefix} en ${groups.map(formatGroup).join(' + ')}`;

  return title.length > PLAN_OUTPUT_BOUNDS.titleChars ? generic : title;
}
