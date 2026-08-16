/**
 * Séries de la charge d'entraînement : ce que le graphe de « Forme » trace, et
 * comment.
 *
 * **Un seul panneau, un seul axe.** CTL, ATL et TSB se comptent dans la même
 * unité — des unités TRIMP par jour — et le TSB *est* la différence des deux
 * autres. Les séparer en trois cadres obligeait à comparer trois échelles pour
 * lire un écart qui est la donnée elle-même ; les superposer sur un axe commun
 * le rend visible d'un coup d'œil, comme le fait un Performance Management
 * Chart. C'est aussi ce qu'impose l'honnêteté du tracé : trois axes distincts
 * auraient fait croiser des courbes là où leurs valeurs ne se croisent pas.
 *
 * Le titre du panneau porte donc l'unité, pas les noms des séries : c'est la
 * légende qui les nomme, et la card qui les annonce.
 */

import { civilDateToMs } from "@/lib/dates/civil";
import {
  buildMultiChartsModel,
  type MultiChartsModel,
  type MultiPanelSpec,
} from "@/lib/chart/series";
import type { LoadPoint } from "@/lib/metrics";

import { formatLoad } from "../../_lib/format";
import { DATE_AXIS } from "./date-axis";

/**
 * Le panneau combiné.
 *
 * Couleurs : `accent` pour la CTL (la série reine de la page, seule à porter une
 * aire — c'est le socle sur lequel les deux autres se lisent), `warning` pour
 * l'ATL — c'est le token de la « fatigue modérée » du design system, et l'ATL
 * *est* la fatigue —, et pour le TSB un trait neutre sur des aires signées :
 * `positive` au-dessus de zéro (frais), `negative` en dessous (en dette). La
 * couleur du TSB dit son signe, elle ne peut donc pas être fixe.
 *
 * Une seule aire pleine sur les trois : deux remplissages superposés se
 * confondraient, et celui du TSB porte une information que les autres n'ont pas.
 *
 * L'ordre des séries est celui du tracé : la CTL d'abord, puisque son aire doit
 * rester derrière les courbes de l'ATL et du TSB.
 */
export const LOAD_PANEL: MultiPanelSpec<LoadPoint> = {
  key: "load",
  // La card dit déjà « Forme, fatigue et fraîcheur » : le panneau, lui, dit dans
  // quoi ça se compte — répéter le titre ferait bégayer la lecture.
  title: "TRIMP par jour",
  // Généreux : ce panneau porte à lui seul ce que trois cadres montraient, et
  // trois courbes serrées dans la hauteur d'une seule ne se distinguent plus.
  heightClass: "h-56 sm:h-72",
  axes: {
    left: {
      side: "left",
      stepKind: "decimal",
      hasZero: true,
      invertY: false,
      targetTicks: 5,
      formatTick: formatLoad,
    },
  },
  series: [
    {
      key: "ctl",
      label: "Forme — CTL",
      axis: "left",
      strokeClass: "stroke-accent",
      dotClass: "bg-accent",
      legendClass: "bg-accent",
      fill: { className: "fill-accent", opacity: 0.12 },
      format: formatLoad,
      read: (point) => point.ctl,
    },
    {
      key: "atl",
      label: "Fatigue — ATL",
      axis: "left",
      strokeClass: "stroke-warning",
      dotClass: "bg-warning",
      legendClass: "bg-warning",
      fill: null,
      format: formatLoad,
      read: (point) => point.atl,
    },
    {
      key: "tsb",
      label: "Fraîcheur — TSB",
      axis: "left",
      strokeClass: "stroke-fg-muted",
      dotClass: "bg-fg-muted",
      legendClass: "bg-fg-muted",
      fill: null,
      diverging: {
        positiveClass: "fill-positive",
        negativeClass: "fill-negative",
        opacity: 0.15,
      },
      format: formatLoad,
      read: (point) => point.tsb,
    },
  ],
};

/** Abscisses de la série de charge : un point par jour, en millisecondes. */
export function loadAbscissas(load: readonly LoadPoint[]): number[] {
  return load.map((point) => civilDateToMs(point.date));
}

/**
 * Modèle du panneau combiné, ou `null` quand la période ne porte pas de quoi
 * tracer une ligne — la page affiche alors son message sobre.
 */
export function buildLoadChartsModel(
  load: readonly LoadPoint[],
): MultiChartsModel<LoadPoint> | null {
  return buildMultiChartsModel({
    points: load,
    xs: loadAbscissas(load),
    axis: DATE_AXIS,
    panels: [LOAD_PANEL],
  });
}
