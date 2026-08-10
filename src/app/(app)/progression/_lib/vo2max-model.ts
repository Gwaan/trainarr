/**
 * Géométrie du graphe de VO₂max — fonctions pures, testées.
 *
 * Ce graphe superpose deux choses de nature différente : le **nuage** des
 * séances (une estimation par course, bruitée par le terrain et la météo) et la
 * **tendance**, moyenne glissante sur 30 jours. C'est la seule superposition
 * légitime de la page : même grandeur, même unité, même axe — la courbe résume
 * le nuage, elle ne le concurrence pas. D'où un rendu qui les hiérarchise : les
 * points restent discrets et neutres, seule la tendance porte l'accent.
 */

import {
  VIEW_H,
  extentOf,
  linePath,
  niceDomain,
  niceStep,
  normalize,
  projectSeries,
  projectY,
  ticksIn,
  type Domain,
} from "@/lib/chart/model";
import type { Tick } from "@/lib/chart/series";
import { civilDateToMs } from "@/lib/dates/civil";

import { formatVo2max } from "../../_lib/format";
import { DATE_AXIS, DATE_TARGET_TICKS, formatFullDay } from "./date-axis";

/** Un point du DAL : VO₂max effective d'une course, ou valeur de la tendance. */
export type Vo2maxPoint = { date: string; value: number };

/** Une séance posée dans le panneau, en pourcentage — jamais dans le viewBox. */
export type Vo2maxDot = {
  key: string;
  leftPct: number;
  topPct: number;
};

export type Vo2maxChartModel = {
  xDomain: Domain;
  xTicks: readonly Tick[];
  yTicks: readonly Tick[];
  dots: readonly Vo2maxDot[];
  /** Abscisses des séances, croissantes — c'est la cible du survol. */
  xs: readonly number[];
  /** Chemin de la tendance dans le repère étiré. */
  trendPath: string;
  /** Lecture du curseur, index par index sur `xs`. */
  readouts: readonly string[];
  ariaLabel: string;
};

const Y_TARGET_TICKS = 4;

/**
 * Modèle complet, ou `null` s'il n'y a pas de quoi tracer : moins de deux
 * séances, ou toutes le même jour (l'axe des dates serait plat).
 */
export function buildVo2maxChartModel(
  points: readonly Vo2maxPoint[],
  trend: readonly Vo2maxPoint[],
): Vo2maxChartModel | null {
  if (points.length < 2) return null;

  const xs = points.map((point) => civilDateToMs(point.date));
  const trendXs = trend.map((point) => civilDateToMs(point.date));

  const xDomain = extentOf([...xs, ...trendXs]);
  if (xDomain === null || xDomain.max <= xDomain.min) return null;

  // Domaine Y commun aux deux séries : la tendance doit rester dans le cadre,
  // et le nuage garder ses extrêmes — c'est l'écart entre eux qui se lit.
  const yExtent = extentOf([
    ...points.map((point) => point.value),
    ...trend.map((point) => point.value),
  ]);
  if (yExtent === null) return null;

  const yStep = niceStep(yExtent.max - yExtent.min, Y_TARGET_TICKS);
  const yDomain = niceDomain(yExtent, yStep);

  const xStep = DATE_AXIS.step(xDomain.max - xDomain.min, DATE_TARGET_TICKS);

  const trendByDate = new Map(trend.map((point) => [point.date, point.value]));

  return {
    xDomain,
    xTicks: ticksIn(xDomain, xStep).map((value) => ({
      value,
      offsetPct: normalize(value, xDomain) * 100,
      label: DATE_AXIS.formatTick(value, xStep),
    })),
    yTicks: ticksIn(yDomain, yStep).map((value) => ({
      value,
      offsetPct: (projectY(value, yDomain, false) / VIEW_H) * 100,
      label: formatVo2max(value),
    })),
    dots: points.map((point, index) => ({
      key: `${point.date}-${index}`,
      leftPct: normalize(xs[index], xDomain) * 100,
      topPct: (projectY(point.value, yDomain, false) / VIEW_H) * 100,
    })),
    xs,
    trendPath: linePath(
      projectSeries(
        trendXs,
        trend.map((point) => point.value),
        xDomain,
        yDomain,
        false,
      ),
    ),
    readouts: points.map((point) => readoutFor(point, trendByDate.get(point.date))),
    ariaLabel: `VO₂max effective : ${points.length} courses, de ${formatVo2max(yExtent.min)} à ${formatVo2max(yExtent.max)} ml/kg/min, ${DATE_AXIS.label(xDomain)}.`,
  };
}

/** Lecture du curseur : la séance survolée, et la tendance ce jour-là. */
function readoutFor(point: Vo2maxPoint, trendValue: number | undefined): string {
  const parts = [formatFullDay(civilDateToMs(point.date)), formatVo2max(point.value)];
  // La tendance manque quand la fenêtre de 30 jours ne couvre pas ce jour — ce
  // qui n'arrive pas ici, mais rien ne le garantit côté contrat.
  if (trendValue !== undefined) parts.push(`tendance ${formatVo2max(trendValue)}`);
  return parts.join(" · ");
}
