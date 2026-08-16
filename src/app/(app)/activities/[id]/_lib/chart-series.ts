/**
 * Panneaux et abscisses des graphes de la page de détail d'une séance.
 *
 * Ce module décrit **ce qui est tracé** (les trois panneaux d'une séance et les
 * deux abscisses possibles) ; la géométrie et l'assemblage du modèle sont
 * génériques et vivent dans `src/lib/chart/`.
 *
 * Règle de dataviz appliquée ici (cf. `.claude/rules/design.md`, section
 * Graphes, décision Gwen du 16/08/2026) : **la superposition est la norme**, et
 * un panneau peut porter deux axes Y. Les cinq mesures se regroupent donc en
 * trois panneaux, selon ce qu'on cherche à lire :
 *
 * - **allure + FC** : le cœur de l'analyse. C'est leur écart qui se lit — le
 *   cœur qui monte à allure constante, la relance qui ne coûte rien — et cet
 *   écart n'existe pas tant que les deux courbes vivent dans deux cadres. Deux
 *   axes, forcément : des secondes par kilomètre et des battements par minute
 *   ne partagent aucune échelle ;
 * - **cadence + foulée** : les deux moitiés d'une même grandeur (vitesse =
 *   cadence × foulée). Superposées, on voit laquelle des deux a cédé quand
 *   l'allure a lâché ; séparées, il fallait faire le va-et-vient soi-même ;
 * - **altitude** : le contexte, seule dans son panneau. La coller sur l'axe de
 *   la FC ou de l'allure lui donnerait une échelle qui n'est pas la sienne et
 *   ferait croire à une corrélation que la graduation aurait fabriquée.
 *
 * Les trois restent **empilés** sur une abscisse commune, avec un survol
 * synchronisé : la lecture croisée d'un panneau à l'autre reste possible.
 */

import {
  buildMultiChartsModel,
  type MultiChartsModel,
  type MultiPanelSpec,
  type PanelSeriesSpec,
  type XAxisSpec,
} from "@/lib/chart/series";
import { niceStep, timeStep } from "@/lib/chart/model";

import {
  formatAltitude,
  formatCadence,
  formatDistanceTick,
  formatPaceValue,
  formatStride,
  formatStrideTick,
  formatTimeTick,
} from "./format-detail";
import { formatHeartRate } from "../../../_lib/format";

/** Un point de la série temporelle d'une activité, tel que le livre le DAL. */
export type ChartPoint = {
  timeS: number;
  /** `null` quand la séance n'a pas de stream de distance (tapis sans capteur). */
  distanceM: number | null;
  paceSecPerKm: number | null;
  hrBpm: number | null;
  altitudeM: number | null;
  cadenceSpm: number | null;
  /** Longueur de foulée en mètres, `null` sans vitesse ou sans cadence ici. */
  strideM: number | null;
};

/** Abscisse commune à tous les panneaux. */
export type XAxisKind = "distance" | "time";

export type PanelKey = "pace-hr" | "altitude" | "cadence-stride";

export type SeriesKey = "pace" | "hr" | "altitude" | "cadence" | "stride";

/** Un panneau de cette page, clés de panneau et de série contraintes. */
type ActivityPanelSpec = MultiPanelSpec<ChartPoint> & {
  key: PanelKey;
  series: readonly (PanelSeriesSpec<ChartPoint> & { key: SeriesKey })[];
};

/** Graduation décimale d'un axe entier (bpm, spm, mètres) — sans unité. */
function roundedTick(value: number): string {
  return String(Math.round(value));
}

/**
 * Titre d'un panneau double amputé d'une de ses séries : les survivantes, et
 * elles seules. Une sortie sans ceinture cardio garde un panneau d'allure — il
 * s'appelle alors « Allure », pas « Allure et fréquence cardiaque ».
 */
function joinLabels(labels: readonly string[]): string {
  return labels.join(" et ");
}

/**
 * Couleurs : accent pour l'allure (la série reine), `negative` pour la FC
 * (sémantiquement cohérent — c'est la couleur de l'effort excessif), neutre
 * pour l'altitude (un décor, pas une mesure d'effort), et deux teintes froides
 * dédiées pour les deux mesures de la mécanique de course — cadence en bleu,
 * foulée en teal.
 *
 * Ces paires-là sont désormais **superposées** : chaque couple a été validé
 * comme séparable (cf. `.claude/rules/design.md`), et une seule des quatre
 * séries porte un remplissage — deux aires l'une sur l'autre ne se lisent plus.
 */
export const PANEL_SPECS: readonly ActivityPanelSpec[] = [
  {
    key: "pace-hr",
    title: "Allure et fréquence cardiaque",
    titleFor: joinLabels,
    // Le panneau principal : c'est celui qu'on regarde, il prend la hauteur.
    heightClass: "h-44 sm:h-60",
    axes: {
      left: {
        side: "left",
        stepKind: "time",
        // Pas de zéro physique : 0:00/km serait une vitesse infinie.
        hasZero: false,
        // Seul axe inversé de la page : plus rapide = plus haut, comme le veut
        // l'intuition — une courbe qui monte est une course qui accélère.
        invertY: true,
        targetTicks: 4,
        formatTick: formatPaceValue,
      },
      right: {
        side: "right",
        stepKind: "decimal",
        hasZero: true,
        invertY: false,
        targetTicks: 4,
        formatTick: roundedTick,
      },
    },
    series: [
      {
        key: "pace",
        label: "Allure",
        axis: "left",
        strokeClass: "stroke-accent",
        dotClass: "bg-accent",
        legendClass: "bg-accent",
        fill: { className: "fill-accent", opacity: 0.12 },
        format: (value) => `${formatPaceValue(value)}/km`,
        read: (point) => point.paceSecPerKm,
      },
      {
        key: "hr",
        label: "FC",
        axis: "right",
        strokeClass: "stroke-negative",
        dotClass: "bg-negative",
        legendClass: "bg-negative",
        // Trait nu : l'aire de l'allure occupe déjà le fond du panneau.
        fill: null,
        format: formatHeartRate,
        read: (point) => point.hrBpm,
      },
    ],
  },
  {
    key: "altitude",
    title: "Altitude",
    // Panneau de contexte : assez haut pour lire le relief, pas plus.
    heightClass: "h-20 sm:h-24",
    axes: {
      left: {
        side: "left",
        stepKind: "decimal",
        hasZero: true,
        invertY: false,
        targetTicks: 3,
        formatTick: roundedTick,
      },
    },
    series: [
      {
        key: "altitude",
        label: "Altitude",
        axis: "left",
        strokeClass: "stroke-fg-faint",
        dotClass: "bg-fg-faint",
        legendClass: "bg-fg-faint",
        fill: { className: "fill-fg-faint", opacity: 0.15 },
        format: formatAltitude,
        read: (point) => point.altitudeM,
      },
    ],
  },
  {
    key: "cadence-stride",
    title: "Cadence et foulée",
    titleFor: joinLabels,
    heightClass: "h-24 sm:h-32",
    axes: {
      left: {
        side: "left",
        stepKind: "decimal",
        hasZero: true,
        invertY: false,
        targetTicks: 3,
        formatTick: roundedTick,
      },
      right: {
        side: "right",
        stepKind: "decimal",
        // Pas de zéro physique : une foulée de 0 m n'existe pas en course —
        // même plancher que l'allure, l'axe se cale sous la plus courte mesurée
        // au lieu de descendre jusqu'à zéro et de tasser la courbe en haut.
        hasZero: false,
        invertY: false,
        targetTicks: 3,
        formatTick: formatStrideTick,
      },
    },
    series: [
      {
        key: "cadence",
        label: "Cadence",
        axis: "left",
        strokeClass: "stroke-chart-cadence",
        dotClass: "bg-chart-cadence",
        legendClass: "bg-chart-cadence",
        fill: null,
        format: formatCadence,
        read: (point) => point.cadenceSpm,
      },
      {
        key: "stride",
        label: "Foulée",
        axis: "right",
        strokeClass: "stroke-chart-stride",
        dotClass: "bg-chart-stride",
        legendClass: "bg-chart-stride",
        fill: null,
        format: formatStride,
        read: (point) => point.strideM,
      },
    ],
  },
];

/**
 * Les deux abscisses de la page. La distance se gradue en pas décimaux, le
 * temps en durées lisibles ; l'étiquette accessible dit l'étendue parcourue.
 */
export const X_AXIS_SPECS: Record<XAxisKind, XAxisSpec> = {
  distance: {
    step: niceStep,
    formatTick: formatDistanceTick,
    label: (domain) => `${formatDistanceTick(domain.max - domain.min, 100)} km`,
  },
  time: {
    step: timeStep,
    formatTick: formatTimeTick,
    label: (domain) => formatTimeTick(domain.max - domain.min),
  },
};

/**
 * Abscisses des points dans l'unité demandée, ou `null` si l'un d'eux n'en a
 * pas : une distance partielle ne fait pas un axe (les points manquants
 * seraient placés au hasard).
 */
function abscissas(
  points: readonly ChartPoint[],
  xKind: XAxisKind,
): number[] | null {
  const xs: number[] = [];
  for (const point of points) {
    const value = xKind === "distance" ? point.distanceM : point.timeS;
    if (value === null || !Number.isFinite(value)) return null;
    xs.push(value);
  }
  return xs;
}

/** `true` si la séance porte une distance exploitable comme abscisse. */
export function hasDistanceAxis(points: readonly ChartPoint[]): boolean {
  const xs = abscissas(points, "distance");
  return xs !== null && xs.length > 0 && xs[xs.length - 1] > xs[0];
}

/**
 * Modèle complet des graphes de la séance pour une abscisse donnée.
 *
 * `null` quand rien n'est traçable : la page affiche alors son message sobre
 * plutôt qu'un cadre vide.
 */
export function buildActivityChartsModel(
  points: readonly ChartPoint[],
  xKind: XAxisKind,
): MultiChartsModel<ChartPoint> | null {
  const xs = abscissas(points, xKind);
  if (xs === null) return null;

  return buildMultiChartsModel({ points, xs, axis: X_AXIS_SPECS[xKind], panels: PANEL_SPECS });
}
