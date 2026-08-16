/**
 * Constantes de mise en page partagées par les graphes empilés.
 *
 * Elles vivent à part parce que **tous** les panneaux d'un même graphe doivent
 * les partager au pixel près : c'est la largeur de gouttière identique qui fait
 * que deux tracés superposés se lisent à la même abscisse d'un panneau à
 * l'autre. Une valeur recopiée dans un composant voisin finirait par diverger.
 */

import type { EdgeAnchor } from "@/lib/chart/model";

/** Gouttière des étiquettes d'axe Y — identique sur tous les panneaux, ils s'alignent. */
export const GUTTER = "w-9 shrink-0 sm:w-12";

/** Ancre horizontale d'une étiquette, exprimée en transformation CSS. */
export const ANCHOR_TRANSFORM: Record<EdgeAnchor, string> = {
  start: "translateX(0)",
  center: "translateX(-50%)",
  end: "translateX(-100%)",
};
