/**
 * Géométrie du tableau des splits — fonctions pures, testées.
 *
 * La barre d'allure d'un kilomètre se lit **relativement à la séance** : les
 * bornes sont l'allure la plus rapide et la plus lente de l'activité, jamais
 * une échelle absolue arbitraire.
 */

/** Le km le plus lent garde une barre visible : une barre nulle se lit « pas de donnée ». */
export const MIN_BAR_RATIO = 0.14;

export type PaceExtent = {
  /** Allure la plus rapide, en secondes par km (donc la plus petite valeur). */
  fastest: number;
  slowest: number;
};

/** Bornes d'allure de la séance. `null` si aucun split n'est mesuré. */
export function paceExtent(paces: readonly (number | null)[]): PaceExtent | null {
  let fastest = Number.POSITIVE_INFINITY;
  let slowest = Number.NEGATIVE_INFINITY;

  for (const pace of paces) {
    if (pace === null || !Number.isFinite(pace) || pace <= 0) continue;
    if (pace < fastest) fastest = pace;
    if (pace > slowest) slowest = pace;
  }

  return fastest === Number.POSITIVE_INFINITY ? null : { fastest, slowest };
}

/**
 * Longueur de la barre d'un split, de {@link MIN_BAR_RATIO} (le plus lent) à 1
 * (le plus rapide) : plus rapide = plus long, comme l'axe d'allure inversé des
 * graphes. `null` quand l'allure n'est pas mesurée — pas de barre du tout.
 *
 * Tous les kilomètres à la même allure prennent la barre pleine : les départager
 * serait inventer un écart inexistant.
 */
export function splitBarRatio(
  pace: number | null,
  extent: PaceExtent | null,
): number | null {
  if (pace === null || !Number.isFinite(pace) || pace <= 0 || extent === null) return null;

  const span = extent.slowest - extent.fastest;
  if (span <= 0) return 1;

  const clamped = Math.min(extent.slowest, Math.max(extent.fastest, pace));
  const t = (extent.slowest - clamped) / span;
  return MIN_BAR_RATIO + t * (1 - MIN_BAR_RATIO);
}

/**
 * Index du kilomètre le plus rapide — le premier en cas d'égalité. `null` si
 * aucun split n'a d'allure : rien à distinguer.
 */
export function fastestSplitIndex(paces: readonly (number | null)[]): number | null {
  let best: number | null = null;
  let bestPace = Number.POSITIVE_INFINITY;

  paces.forEach((pace, index) => {
    if (pace === null || !Number.isFinite(pace) || pace <= 0) return;
    if (pace < bestPace) {
      bestPace = pace;
      best = index;
    }
  });

  return best;
}
