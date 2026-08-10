/**
 * Séries de la charge d'entraînement : ce que les trois panneaux de « Forme »
 * tracent, et comment.
 *
 * Un panneau par composante, un seul axe Y chacun — CTL, ATL et TSB n'ont ni la
 * même amplitude ni le même signe, les superposer sur deux échelles inventerait
 * des croisements. Les titres portent la légende : une seule série par panneau.
 */

import { civilDateToMs } from "@/lib/dates/civil";
import { buildChartsModel, type ChartsModel, type SeriesSpec } from "@/lib/chart/series";
import type { LoadPoint } from "@/lib/metrics";

import { formatLoad } from "../../_lib/format";
import { DATE_AXIS } from "./date-axis";

/**
 * Couleurs : `accent` pour la CTL (la série reine de la page), `warning` pour
 * l'ATL — c'est le token de la « fatigue modérée » du design system, et l'ATL
 * *est* la fatigue —, et pour le TSB un trait neutre sur des aires signées :
 * `positive` au-dessus de zéro (frais), `negative` en dessous (en dette). La
 * couleur du TSB dit son signe, elle ne peut donc pas être fixe.
 */
export const LOAD_SPECS: readonly SeriesSpec<LoadPoint>[] = [
  {
    key: "ctl",
    title: "Forme — CTL",
    strokeClass: "stroke-accent",
    dotClass: "bg-accent",
    fill: { className: "fill-accent", opacity: 0.12 },
    invertY: false,
    stepKind: "decimal",
    hasZero: true,
    targetTicks: 4,
    heightClass: "h-36 sm:h-44",
    format: formatLoad,
    formatTick: formatLoad,
    read: (point) => point.ctl,
  },
  {
    key: "atl",
    title: "Fatigue — ATL",
    strokeClass: "stroke-warning",
    dotClass: "bg-warning",
    fill: null,
    invertY: false,
    stepKind: "decimal",
    hasZero: true,
    targetTicks: 3,
    heightClass: "h-24 sm:h-28",
    format: formatLoad,
    formatTick: formatLoad,
    read: (point) => point.atl,
  },
  {
    key: "tsb",
    title: "Fraîcheur — TSB",
    strokeClass: "stroke-fg-muted",
    dotClass: "bg-fg-muted",
    fill: null,
    diverging: {
      positiveClass: "fill-positive",
      negativeClass: "fill-negative",
      opacity: 0.15,
    },
    invertY: false,
    stepKind: "decimal",
    hasZero: true,
    targetTicks: 3,
    heightClass: "h-24 sm:h-28",
    format: formatLoad,
    formatTick: formatLoad,
    read: (point) => point.tsb,
  },
];

/** Abscisses de la série de charge : un point par jour, en millisecondes. */
export function loadAbscissas(load: readonly LoadPoint[]): number[] {
  return load.map((point) => civilDateToMs(point.date));
}

/**
 * Modèle des trois panneaux, ou `null` quand la période ne porte pas de quoi
 * tracer une ligne — la page affiche alors son message sobre.
 */
export function buildLoadChartsModel(
  load: readonly LoadPoint[],
): ChartsModel<LoadPoint> | null {
  return buildChartsModel({
    points: load,
    xs: loadAbscissas(load),
    axis: DATE_AXIS,
    specs: LOAD_SPECS,
  });
}
