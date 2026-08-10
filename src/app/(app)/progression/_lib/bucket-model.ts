/**
 * Géométrie des histogrammes par seau (semaine ISO ou mois civil) — fonctions
 * pures, testées.
 *
 * Le modèle est construit **côté serveur** : c'est lui qui porte le formatage,
 * et seule la structure résultante — des chaînes et des pourcentages — traverse
 * la frontière client. Le composant de rendu ne fait plus que poser des div et
 * suivre le pointeur.
 */

import { niceStep, ticksIn } from "@/lib/chart/model";

export type BucketBarInput = {
  /** Étiquette d'axe : « S32 », « août », « août 25 ». */
  label: string;
  value: number;
  /** Complément de la lecture au survol, ex. « 4 séances ». */
  detail: string | null;
  /** Seau entamé : sa valeur n'est pas comparable aux autres. */
  partial: boolean;
};

export type BucketBarModel = {
  label: string;
  /** Étiquette d'axe, `null` quand la densité impose de la sauter. */
  axisLabel: string | null;
  /** Valeur formatée — étiquette directe du maximum, et lecture au survol. */
  valueLabel: string;
  detail: string | null;
  /**
   * Le seau énoncé en entier — « S32, 412 TRIMP » —, porté par le bouton de la
   * barre. C'est ce qui rend la valeur atteignable autrement qu'au pointeur :
   * l'opacité du seau entamé et la hauteur de la barre ne disent rien à un
   * lecteur d'écran.
   */
  ariaLabel: string;
  /** Hauteur de la barre, en pourcentage du cadre. */
  heightPct: number;
  partial: boolean;
  /** Le seau le plus haut : le seul à porter sa valeur en clair. */
  isMax: boolean;
};

export type BucketBarsModel = {
  bars: readonly BucketBarModel[];
  /** Graduations horizontales, du haut vers le bas. */
  ticks: readonly { value: number; label: string; offsetPct: number }[];
  /**
   * Largeur minimale d'un seau, en pixels : en dessous, les étiquettes d'axe se
   * chevaucheraient. Le graphe défile plutôt que de tasser ses repères.
   */
  minBarPx: number;
  ariaLabel: string;
};

/** Trois intervalles : au-delà, la grille concurrence les barres. */
const TARGET_TICKS = 3;

/**
 * Densité maximale d'étiquettes d'axe. Au-delà, une sur `n` — jamais de
 * collision, jamais d'étiquette tournée à 45°, qui se lit deux fois moins vite.
 */
const MAX_AXIS_LABELS = 13;

/** Cible tactile minimale d'un seau, et largeur maximale d'une barre. */
const MIN_BAR_PX = 24;

/**
 * Encombrement d'un caractère d'étiquette d'axe, en pixels : JetBrains Mono à
 * 0,62 rem, avec une marge — une étiquette qui touche sa voisine ne se lit plus.
 */
const AXIS_CHAR_PX = 6.5;
const AXIS_LABEL_PADDING_PX = 8;

export function buildBucketBarsModel(input: {
  bars: readonly BucketBarInput[];
  /** Valeur avec son unité, pour l'étiquette du maximum et le survol. */
  formatValue: (value: number) => string;
  /** Graduation : sans unité, elle est dans le titre du panneau. */
  formatTick: (value: number) => string;
  /**
   * Unité à énoncer après la valeur dans l'`aria-label`, quand `formatValue` ne
   * la porte pas. À l'écran le titre du panneau suffit ; lu à voix haute, un
   * « 412 » sans unité ne veut rien dire.
   */
  valueUnit?: string;
  /** Ce que l'histogramme mesure, pour les lecteurs d'écran. */
  seriesLabel: string;
}): BucketBarsModel | null {
  const { bars, formatValue, formatTick, valueUnit, seriesLabel } = input;
  if (bars.length === 0) return null;

  const max = Math.max(...bars.map((bar) => (Number.isFinite(bar.value) ? bar.value : 0)));
  // Rien à montrer : des barres toutes nulles ne sont pas un graphe.
  if (max <= 0) return null;

  const step = niceStep(max, TARGET_TICKS);
  const domainMax = Math.ceil(max / step) * step;

  // Une sur `n`, en partant de la **dernière** : c'est le seau le plus récent
  // qu'on cherche des yeux, il doit toujours porter son étiquette.
  const every = Math.ceil(bars.length / MAX_AXIS_LABELS);
  const maxIndex = bars.findIndex((bar) => bar.value === max);

  // Une étiquette dispose de `every` seaux de place : « août 25 » exige des
  // seaux larges quand toutes les étiquettes sont montrées, beaucoup moins
  // quand on n'en montre qu'une sur trois.
  const longestLabel = Math.max(...bars.map((bar) => bar.label.length));
  const labelPx = longestLabel * AXIS_CHAR_PX + AXIS_LABEL_PADDING_PX;

  return {
    bars: bars.map((bar, index) => {
      const valueLabel = formatValue(bar.value);

      return {
        label: bar.label,
        axisLabel: (bars.length - 1 - index) % every === 0 ? bar.label : null,
        valueLabel,
        detail: bar.detail,
        ariaLabel: [
          bar.label,
          valueUnit === undefined ? valueLabel : `${valueLabel} ${valueUnit}`,
          bar.detail,
          bar.partial ? "en cours" : null,
        ]
          .filter((part) => part !== null)
          .join(", "),
        heightPct: Math.max(0, (bar.value / domainMax) * 100),
        partial: bar.partial,
        isMax: index === maxIndex,
      };
    }),
    ticks: ticksIn({ min: 0, max: domainMax }, step).map((value) => ({
      value,
      label: formatTick(value),
      offsetPct: (1 - value / domainMax) * 100,
    })),
    minBarPx: Math.max(MIN_BAR_PX, Math.ceil(labelPx / every)),
    ariaLabel: `${seriesLabel} : ${bars.length} périodes, de ${bars[0].label} à ${bars[bars.length - 1].label}, maximum ${formatValue(max)} (${bars[maxIndex].label}).`,
  };
}
