/**
 * Définition des panneaux de graphe et construction de leur modèle de rendu.
 *
 * Règle de dataviz appliquée ici (cf. brief D2) : **jamais deux axes Y sur un
 * même graphe**. Allure, fréquence cardiaque, altitude et cadence forment des
 * panneaux empilés (small multiples), un seul axe chacun, partageant la même
 * abscisse et un survol synchronisé. Une seule série par panneau → pas de
 * légende, le titre du panneau nomme la série.
 *
 * Fonctions pures, testées : les composants SVG restent déclaratifs.
 */

import {
  MISSING,
  formatAltitude,
  formatCadence,
  formatDistanceTick,
  formatPaceValue,
  formatTimeTick,
} from "./format-detail";
import {
  VIEW_H,
  areaPath,
  extentOf,
  linePath,
  niceDomain,
  niceStep,
  normalize,
  projectSeries,
  projectY,
  ticksIn,
  timeStep,
  type ChartPoint,
  type Domain,
  type Pt,
  type XAxisKind,
} from "./chart-model";
import { formatHeartRate } from "../../../_lib/format";

export type SeriesKey = "pace" | "hr" | "altitude" | "cadence";

export type SeriesSpec = {
  key: SeriesKey;
  /** Le titre du panneau **est** la légende : une seule série par panneau. */
  title: string;
  /** Classe Tailwind du trait — une couleur par panneau, jamais par point. */
  strokeClass: string;
  /** Classe Tailwind du point de survol, dans la couleur de la série. */
  dotClass: string;
  /** Remplissage sous la courbe, quand il aide à lire le relief. */
  fill: { className: string; opacity: number } | null;
  /** Axe inversé : réservé à l'allure (plus rapide = plus haut). */
  invertY: boolean;
  /** Sexagésimal pour l'allure, décimal pour le reste. */
  stepKind: "time" | "decimal";
  /**
   * La série a-t-elle un zéro physique ? Non pour l'allure : 0:00/km serait une
   * vitesse infinie. Un axe sans zéro physique est planché sous sa valeur la
   * plus basse (cf. {@link physicalFloor}) plutôt qu'arrondi jusqu'à zéro.
   */
  hasZero: boolean;
  targetTicks: number;
  /** Hauteur du panneau — l'allure et la FC portent la lecture, elles priment. */
  heightClass: string;
  /** Valeur avec son unité (survol). */
  format: (value: number) => string;
  /** Graduation d'axe : sans unité, l'unité est dans le titre du panneau. */
  formatTick: (value: number) => string;
  /** Valeur d'une série absente. */
  read: (point: ChartPoint) => number | null;
};

/**
 * Couleurs : accent pour l'allure (la série reine), `negative` pour la FC
 * (sémantiquement cohérent — c'est la couleur de l'effort excessif), neutre
 * pour l'altitude (un décor, pas une mesure d'effort), et une teinte froide
 * dédiée pour la cadence. Panneaux séparés : aucune contrainte d'adjacence.
 */
export const SERIES_SPECS: readonly SeriesSpec[] = [
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
];

/** Une graduation prête à poser : sa valeur, sa position en %, son étiquette. */
export type Tick = {
  value: number;
  /** Position dans le panneau, en pourcentage (0 = haut / gauche). */
  offsetPct: number;
  label: string;
};

export type PanelModel = {
  spec: SeriesSpec;
  values: readonly (number | null)[];
  domain: Domain;
  ticks: readonly Tick[];
  projected: readonly (Pt | null)[];
  line: string;
  area: string | null;
  /** Étendue mesurée, ex. `112 – 178 bpm` : lisible sans survoler. */
  rangeLabel: string;
  /** Description du panneau pour les lecteurs d'écran. */
  ariaLabel: string;
};

export type ChartsModel = {
  xKind: XAxisKind;
  /** Abscisse de chaque point, dans l'unité de `xKind`. */
  xs: readonly number[];
  xDomain: Domain;
  xTicks: readonly Tick[];
  panels: readonly PanelModel[];
};

/** Il faut deux points mesurés pour tracer une ligne — sinon pas de panneau. */
function hasEnoughData(values: readonly (number | null)[]): boolean {
  let count = 0;
  for (const value of values) {
    if (value !== null && Number.isFinite(value)) count += 1;
    if (count >= 2) return true;
  }
  return false;
}

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

function stepFor(spec: SeriesSpec, extent: Domain): number {
  const span = extent.max - extent.min;
  return spec.stepKind === "time"
    ? timeStep(span, spec.targetTicks)
    : niceStep(span, spec.targetTicks);
}

/**
 * Plancher d'un axe qui n'a pas de zéro physique.
 *
 * `niceDomain` arrondit la borne basse au multiple du pas inférieur. Sur une
 * série d'allures étalée — un trail où l'on marche à 27:47/km et où l'on
 * descend à 3:20/km — le pas vaut 10 min et cet arrondi tombe à **0:00/km**,
 * soit une vitesse infinie : un sixième du panneau reste vide sous la courbe et
 * la graduation la plus basse ment.
 *
 * Le plancher retenu est le multiple de pas immédiatement inférieur à la valeur
 * la plus basse *mesurée*, le pas étant ici choisi à l'échelle de cette valeur
 * (et non de l'étendue). Sur une série resserrée il ne mord pas — l'arrondi
 * usuel est déjà au-dessus.
 */
function physicalFloor(spec: SeriesSpec, extent: Domain): number {
  if (spec.hasZero) return Number.NEGATIVE_INFINITY;

  const step = stepFor(spec, { min: 0, max: extent.min });
  return Math.floor(extent.min / step) * step;
}

function describeSpan(spec: SeriesSpec, extent: Domain, xLabel: string): string {
  return `${spec.title} : de ${spec.format(extent.min)} à ${spec.format(extent.max)}, sur ${xLabel}.`;
}

function buildPanel(
  spec: SeriesSpec,
  points: readonly ChartPoint[],
  xs: readonly number[],
  xDomain: Domain,
  xLabel: string,
): PanelModel | null {
  const values = points.map(spec.read);
  if (!hasEnoughData(values)) return null;

  const extent = extentOf(values);
  if (extent === null) return null;

  const step = stepFor(spec, extent);
  const rounded = niceDomain(extent, step);
  const domain = { min: Math.max(rounded.min, physicalFloor(spec, extent)), max: rounded.max };
  const projected = projectSeries(xs, values, xDomain, domain, spec.invertY);

  const ticks = ticksIn(domain, step).map((value) => ({
    value,
    offsetPct: (projectY(value, domain, spec.invertY) / VIEW_H) * 100,
    label: spec.formatTick(value),
  }));

  return {
    spec,
    values,
    domain,
    ticks,
    projected,
    line: linePath(projected),
    area: spec.fill ? areaPath(projected) : null,
    // Unité portée par la seule borne haute : « 112 – 178 bpm » se lit d'un trait.
    rangeLabel: `${spec.formatTick(extent.min)} – ${spec.format(extent.max)}`,
    ariaLabel: describeSpan(spec, extent, xLabel),
  };
}

/** Étiquette de l'abscisse pour les descriptions accessibles. */
function xAxisLabel(xKind: XAxisKind, xDomain: Domain): string {
  return xKind === "distance"
    ? `${formatDistanceTick(xDomain.max - xDomain.min, 100)} km`
    : formatTimeTick(xDomain.max - xDomain.min);
}

/**
 * Modèle complet des graphes empilés pour une abscisse donnée.
 *
 * `null` quand rien n'est traçable : la page affiche alors son message sobre
 * plutôt qu'un cadre vide.
 */
export function buildChartsModel(
  points: readonly ChartPoint[],
  xKind: XAxisKind,
): ChartsModel | null {
  if (points.length < 2) return null;

  const xs = abscissas(points, xKind);
  if (xs === null) return null;

  const xExtent = extentOf(xs);
  if (xExtent === null || xExtent.max <= xExtent.min) return null;

  // Abscisse au plus juste (pas d'arrondi du domaine) : la courbe doit occuper
  // toute la largeur, les graduations tombent aux multiples ronds à l'intérieur.
  const xDomain = xExtent;
  const span = xDomain.max - xDomain.min;
  // Six intervalles visés plutôt que cinq : avec cinq, une séance de 12,7 km
  // tombe juste au-dessus du pas de 2,5 km et n'obtient plus que deux
  // graduations — l'axe devient illisible.
  const step = xKind === "distance" ? niceStep(span, 6) : timeStep(span, 6);
  const label = xAxisLabel(xKind, xDomain);

  const xTicks = ticksIn(xDomain, step).map((value) => ({
    value,
    offsetPct: normalize(value, xDomain) * 100,
    label:
      xKind === "distance" ? formatDistanceTick(value, step) : formatTimeTick(value),
  }));

  const panels = SERIES_SPECS.map((spec) =>
    buildPanel(spec, points, xs, xDomain, label),
  ).filter((panel): panel is PanelModel => panel !== null);

  if (panels.length === 0) return null;

  return { xKind, xs, xDomain, xTicks, panels };
}

/**
 * Valeur formatée du point survolé d'un panneau.
 *
 * Un trou reste un tiret : jamais interpolé, jamais remplacé par le point
 * voisin — le graphe ne doit pas inventer une mesure que le capteur n'a pas
 * faite.
 */
export function panelValueAt(panel: PanelModel, index: number | null): string {
  if (index === null) return MISSING;
  const value = panel.values[index];
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return panel.spec.format(value);
}
