/**
 * Séries de la monotonie et de la contrainte : ce que le panneau « Monotonie et
 * contrainte » trace, et comment.
 *
 * **Un panneau, deux axes.** Contrairement à la charge — où CTL, ATL et TSB se
 * comptent dans la même unité et partagent donc un axe unique —, ces deux
 * grandeurs n'ont ni la même unité ni le même ordre de grandeur : la monotonie
 * est un quotient sans dimension qui vit entre 0,5 et 3, la contrainte est un
 * produit en unités TRIMP qui se compte par centaines ou par milliers. Sur un
 * axe commun, la monotonie serait une ligne plate collée au zéro. C'est le cas
 * d'usage exact du double axe autorisé par `buildMultiChartsModel`.
 *
 * Elles restent dans **le même** panneau parce qu'elles ne se lisent pas
 * séparément : la contrainte n'est que la charge de la semaine multipliée par sa
 * monotonie, et c'est leur écart qui distingue une semaine uniforme mais légère
 * d'une semaine uniforme et lourde.
 *
 * Couleurs : `chart-cadence` (bleu) pour la monotonie, `chart-stride` (teal)
 * pour la contrainte — deux jetons de série déjà validés ensemble par le
 * système. Ni l'accent (pris par la CTL du panneau voisin, et réservé à
 * l'interaction) ni les jetons sémantiques (`warning`, `negative`) qui
 * décriraient un état alors qu'une monotonie haute n'en est pas un.
 *
 * Aucun seuil n'est tracé ici : le repère de Foster est une **lecture**, elle
 * vit dans `(app)/_lib/metric-tone.ts` et s'écrit en toutes lettres sous le
 * graphe.
 */

import { civilDateToMs } from "@/lib/dates/civil";
import {
  buildMultiChartsModel,
  type MultiChartsModel,
  type MultiPanelSpec,
} from "@/lib/chart/series";
import type { MonotonyPoint } from "@/lib/metrics";

import { formatMonotony, formatStrain } from "../../_lib/format";
import { DATE_AXIS } from "./date-axis";

export const MONOTONY_PANEL: MultiPanelSpec<MonotonyPoint> = {
  key: "monotony",
  // Le titre nomme les deux séries, donc il ment dès que l'une manque : d'où le
  // `titleFor` ci-dessous, qui reprend les libellés survivants.
  title: "Monotonie et contrainte",
  titleFor: (labels) => labels.join(" et "),
  heightClass: "h-44 sm:h-56",
  axes: {
    left: {
      side: "left",
      stepKind: "decimal",
      hasZero: true,
      invertY: false,
      targetTicks: 4,
      formatTick: formatMonotony,
    },
    right: {
      side: "right",
      stepKind: "decimal",
      hasZero: true,
      invertY: false,
      targetTicks: 4,
      formatTick: formatStrain,
    },
  },
  series: [
    {
      key: "monotony",
      label: "Monotonie",
      axis: "left",
      strokeClass: "stroke-chart-cadence",
      dotClass: "bg-chart-cadence",
      legendClass: "bg-chart-cadence",
      // La seule aire du panneau : c'est la série que le titre annonce en
      // premier, et deux remplissages superposés ne se distingueraient plus.
      fill: { className: "fill-chart-cadence", opacity: 0.12 },
      format: formatMonotony,
      // Les fenêtres incomplètes et les semaines à écart-type nul valent `null`
      // dans le socle : elles restent des trous, jamais des zéros.
      read: (point) => point.monotony,
    },
    {
      key: "strain",
      label: "Contrainte",
      axis: "right",
      strokeClass: "stroke-chart-stride",
      dotClass: "bg-chart-stride",
      legendClass: "bg-chart-stride",
      fill: null,
      format: formatStrain,
      read: (point) => point.strain,
    },
  ],
};

/** Abscisses de la série : un point par jour, en millisecondes. */
export function monotonyAbscissas(points: readonly MonotonyPoint[]): number[] {
  return points.map((point) => civilDateToMs(point.date));
}

/**
 * Modèle du panneau, ou `null` quand la période ne porte pas de quoi tracer une
 * ligne — la page affiche alors sa cause.
 */
export function buildMonotonyChartsModel(
  points: readonly MonotonyPoint[],
): MultiChartsModel<MonotonyPoint> | null {
  return buildMultiChartsModel({
    points,
    xs: monotonyAbscissas(points),
    axis: DATE_AXIS,
    panels: [MONOTONY_PANEL],
  });
}

/** Ce que la note de lecture commente : une valeur, et la semaine qu'elle décrit. */
export type MonotonyReading = {
  monotony: number;
  /** Dernier jour de la fenêtre de sept jours dont sort cette monotonie. */
  date: string;
  /**
   * Cette fenêtre s'achève-t-elle au dernier jour de la période affichée ?
   *
   * Quand elle ne s'y achève pas, la note **doit dire la date** : la valeur
   * décrit une semaine plus ancienne, et l'annoncer comme celle « des sept
   * derniers jours » lui attribuerait une période qui n'est pas la sienne.
   */
  atPeriodEnd: boolean;
};

/**
 * Le dernier point **mesuré** de la série, situé dans la période, `null` s'il
 * n'y en a aucun.
 *
 * C'est lui que la note de lecture commente. Prendre le dernier point tout
 * court commenterait un trou : une semaine dont l'écart-type est nul — sept
 * jours de repos, typiquement — rend `monotony` à `null`, et il n'y a alors
 * rien à dire de l'alternance.
 *
 * **Mais sauter les trous déplace la valeur dans le temps**, et c'est tout
 * l'objet d'`atPeriodEnd`. Le cas est courant : une semaine de séances sans
 * ceinture cardio ne produit aucun TRIMP, donc sept jours de charge nulle, donc
 * un écart-type nul, donc `monotony === null` sur tous les points récents. La
 * dernière valeur mesurée peut alors dater de dix jours — avec son ton d'alerte
 * éventuel. Elle reste la bonne chose à afficher (c'est la dernière semaine dont
 * on sache quelque chose), à condition de la dater.
 */
export function monotonyReading(points: readonly MonotonyPoint[]): MonotonyReading | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point.monotony !== null) {
      return {
        monotony: point.monotony,
        date: point.date,
        atPeriodEnd: index === points.length - 1,
      };
    }
  }
  return null;
}
