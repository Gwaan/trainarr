/**
 * La réévaluation de plan proposée, telle qu'elle se **dit** — sens, totaux,
 * origine.
 *
 * Mise en forme seule, sans aucune dépendance serveur : les deux surfaces qui
 * montrent la même proposition (la carte du tableau de bord et le bandeau de la
 * page du plan) doivent la nommer exactement pareil, sans quoi l'athlète
 * croirait lire deux choses différentes.
 *
 * ## Le sens n'est pas une alerte
 *
 * Aucun ton sémantique ici, et ce n'est pas un oubli : `negative` pour « moins
 * de charge » ferait passer un allègement pour une panne, et `positive` pour
 * « plus de charge » ferait de l'augmentation une récompense. Baisser n'est ni
 * une erreur ni un échec — c'est souvent la bonne décision. Ce qui porte
 * l'information, c'est donc le **texte** et un **signe** (↑ / ↓ / =), jamais un
 * code couleur qui moraliserait la charge.
 */

import type { PlanRevisionDirection, PlanRevisionTotals } from '@/lib/plan-revision/direction';

/** Ce que la source de la proposition dit à l'athlète, en une étiquette. */
export const PLAN_REVISION_SOURCE_LABELS = {
  review: 'Le coach a relu ton plan',
  'fitness-test': 'Après ton test chronométré',
} as const;

/** Le sens, dit d'un signe et d'une phrase. */
export const PLAN_REVISION_DIRECTIONS: Record<
  PlanRevisionDirection,
  { sign: string; label: string }
> = {
  // Le signe est décoratif : la phrase le dit déjà en toutes lettres, et un
  // lecteur d'écran n'a pas à annoncer « flèche vers le haut ».
  increase: { sign: '↑', label: 'Plus de charge' },
  decrease: { sign: '↓', label: 'Moins de charge' },
  neutral: { sign: '=', label: 'Sans changement de charge' },
};

/**
 * Un kilométrage lisible : au dixième sous 10 km, à l'unité au-dessus.
 *
 * Un plan se lit en kilomètres entiers dès qu'il y en a plusieurs dizaines ;
 * « 41,7 → 36,2 » ne dit rien de plus que « 42 → 36 » et se lit moins bien. Sous
 * 10 km, en revanche, l'unité écraserait la moitié de l'écart.
 */
export function formatRevisionKm(km: number): string {
  return km >= 10
    ? String(Math.round(km))
    : km.toFixed(1).replace('.', ',').replace(/,0$/, '');
}

/** « 3 semaines restantes », « 1 semaine restante ». */
export function formatRevisionWeeks(weeks: number): string {
  return weeks > 1 ? `${weeks} semaines restantes` : '1 semaine restante';
}

/**
 * Ce que la proposition change au kilométrage : « 42 → 36 km sur les 3 semaines
 * restantes ».
 */
export function formatRevisionVolume(
  before: PlanRevisionTotals,
  after: PlanRevisionTotals,
  weeks: number,
): string {
  return `${formatRevisionKm(before.volumeKm)} → ${formatRevisionKm(after.volumeKm)} km sur les ${formatRevisionWeeks(weeks)}`;
}

/**
 * Ce qu'elle change au volume d'intensité, `null` quand il n'y en a d'aucun
 * côté.
 *
 * Zéro des deux côtés est le cas d'un plan de reprise, où toute l'intensité est
 * absente par construction : afficher « 0 → 0 km » y ferait croire à une donnée
 * manquante plutôt qu'à une absence voulue.
 */
export function formatRevisionIntensity(
  before: PlanRevisionTotals,
  after: PlanRevisionTotals,
): string | null {
  if (before.intensityKm === 0 && after.intensityKm === 0) return null;
  return `dont ${formatRevisionKm(before.intensityKm)} → ${formatRevisionKm(after.intensityKm)} km d’intensité`;
}
