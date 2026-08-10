/**
 * Séries et abscisses des graphes de la page de détail d'une séance.
 *
 * Ce module décrit **ce qui est tracé** (les cinq mesures d'une séance et les
 * deux abscisses possibles) ; la géométrie et l'assemblage du modèle sont
 * génériques et vivent dans `src/lib/chart/`.
 *
 * Règle de dataviz appliquée ici (cf. brief D2) : **jamais deux axes Y sur un
 * même graphe**. Allure, fréquence cardiaque, altitude, cadence et foulée forment des
 * panneaux empilés (small multiples), un seul axe chacun, partageant la même
 * abscisse et un survol synchronisé. Une seule série par panneau → pas de
 * légende, le titre du panneau nomme la série.
 */

import {
  buildChartsModel,
  type ChartsModel,
  type SeriesSpec,
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

export type SeriesKey = "pace" | "hr" | "altitude" | "cadence" | "stride";

/**
 * Couleurs : accent pour l'allure (la série reine), `negative` pour la FC
 * (sémantiquement cohérent — c'est la couleur de l'effort excessif), neutre
 * pour l'altitude (un décor, pas une mesure d'effort), et deux teintes froides
 * dédiées pour les deux mesures de la mécanique de course — cadence en bleu,
 * foulée en teal. Panneaux séparés : aucune contrainte d'adjacence.
 */
export const SERIES_SPECS: readonly (SeriesSpec<ChartPoint> & { key: SeriesKey })[] = [
  {
    key: "pace",
    title: "Allure (min/km)",
    strokeClass: "stroke-accent",
    dotClass: "bg-accent",
    fill: { className: "fill-accent", opacity: 0.12 },
    invertY: true,
    stepKind: "time",
    hasZero: false,
    targetTicks: 4,
    heightClass: "h-36 sm:h-44",
    format: (value) => `${formatPaceValue(value)}/km`,
    formatTick: formatPaceValue,
    read: (point) => point.paceSecPerKm,
  },
  {
    key: "hr",
    title: "Fréquence cardiaque (bpm)",
    strokeClass: "stroke-negative",
    dotClass: "bg-negative",
    fill: null,
    invertY: false,
    stepKind: "decimal",
    hasZero: true,
    targetTicks: 4,
    heightClass: "h-36 sm:h-44",
    format: formatHeartRate,
    formatTick: (value) => String(Math.round(value)),
    read: (point) => point.hrBpm,
  },
  {
    key: "altitude",
    title: "Altitude (m)",
    strokeClass: "stroke-fg-faint",
    dotClass: "bg-fg-faint",
    fill: { className: "fill-fg-faint", opacity: 0.15 },
    invertY: false,
    stepKind: "decimal",
    hasZero: true,
    targetTicks: 3,
    heightClass: "h-24 sm:h-28",
    format: formatAltitude,
    formatTick: (value) => String(Math.round(value)),
    read: (point) => point.altitudeM,
  },
  {
    key: "cadence",
    title: "Cadence (spm)",
    strokeClass: "stroke-chart-cadence",
    dotClass: "bg-chart-cadence",
    fill: null,
    invertY: false,
    stepKind: "decimal",
    hasZero: true,
    targetTicks: 3,
    heightClass: "h-24 sm:h-28",
    format: formatCadence,
    formatTick: (value) => String(Math.round(value)),
    read: (point) => point.cadenceSpm,
  },
  {
    key: "stride",
    title: "Foulée (m)",
    strokeClass: "stroke-chart-stride",
    dotClass: "bg-chart-stride",
    fill: null,
    invertY: false,
    // Pas de zéro physique : une foulée de 0 m n'existe pas en course — même
    // plancher physique que l'allure, l'axe se cale sous la plus courte mesurée
    // au lieu de descendre jusqu'à zéro et de tasser la courbe en haut.
    stepKind: "decimal",
    hasZero: false,
    targetTicks: 3,
    heightClass: "h-24 sm:h-28",
    format: formatStride,
    formatTick: formatStrideTick,
    read: (point) => point.strideM,
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
): ChartsModel<ChartPoint> | null {
  const xs = abscissas(points, xKind);
  if (xs === null) return null;

  return buildChartsModel({ points, xs, axis: X_AXIS_SPECS[xKind], specs: SERIES_SPECS });
}
