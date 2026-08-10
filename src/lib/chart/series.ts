/**
 * Construction du modèle de rendu des graphes empilés — fonctions pures, testées.
 *
 * Règle de dataviz appliquée ici (cf. brief D2) : **jamais deux axes Y sur un
 * même graphe**. Les séries forment des panneaux empilés (small multiples), un
 * seul axe chacun, partageant la même abscisse et un survol synchronisé. Une
 * seule série par panneau → pas de légende, le titre du panneau nomme la série.
 *
 * Module générique : ni les points ni l'abscisse ne sont connus d'ici. Chaque
 * page décrit ses séries ({@link SeriesSpec}) et son axe des abscisses
 * ({@link XAxisSpec}) ; le rendu vit dans `src/components/chart/`.
 */

import {
  VIEW_H,
  areaPath,
  divergingAreaPaths,
  extentOf,
  linePath,
  niceDomain,
  niceStep,
  normalize,
  projectSeries,
  projectY,
  ticksIn,
  timeStep,
  type Domain,
  type Pt,
} from "./model";

/**
 * Valeur absente : tiret cadratin, jamais une case vide ni un zéro inventé.
 * Même convention que le formatage des pages (`MISSING`), redéclarée ici pour
 * que le module reste sans dépendance vers une route.
 */
const MISSING = "—";

/**
 * Description d'une série et de son panneau. `P` est le type d'un point de la
 * page appelante — c'est `read` qui en extrait la mesure.
 */
export type SeriesSpec<P> = {
  /** Identifiant stable du panneau (clé de rendu). */
  key: string;
  /** Le titre du panneau **est** la légende : une seule série par panneau. */
  title: string;
  /** Classe Tailwind du trait — une couleur par panneau, jamais par point. */
  strokeClass: string;
  /** Classe Tailwind du point de survol, dans la couleur de la série. */
  dotClass: string;
  /** Remplissage sous la courbe, quand il aide à lire le relief. */
  fill: { className: string; opacity: number } | null;
  /**
   * Série **divergente** : le remplissage change de couleur de part et d'autre
   * de zéro, qui devient une ligne de référence tracée dans le panneau.
   *
   * Réservé aux mesures dont le signe est le message (le TSB : frais au-dessus,
   * en dette en dessous). Absent partout ailleurs — un remplissage à deux
   * couleurs sur une série sans zéro physique n'aurait rien à dire. Il exclut
   * `fill`, qui ignore le signe.
   */
  diverging?: { positiveClass: string; negativeClass: string; opacity: number };
  /** Axe inversé : réservé à l'allure (plus rapide = plus haut). */
  invertY: boolean;
  /** Sexagésimal pour les durées et les allures, décimal pour le reste. */
  stepKind: "time" | "decimal";
  /**
   * La série a-t-elle un zéro physique ? Non pour l'allure : 0:00/km serait une
   * vitesse infinie. Un axe sans zéro physique est planché sous sa valeur la
   * plus basse (cf. {@link physicalFloor}) plutôt qu'arrondi jusqu'à zéro.
   */
  hasZero: boolean;
  targetTicks: number;
  /** Hauteur du panneau — les séries qui portent la lecture priment. */
  heightClass: string;
  /** Valeur avec son unité (survol). */
  format: (value: number) => string;
  /** Graduation d'axe : sans unité, l'unité est dans le titre du panneau. */
  formatTick: (value: number) => string;
  /** Mesure du point, `null` quand la série est absente à cet endroit. */
  read: (point: P) => number | null;
};

/**
 * Axe des abscisses enfichable : la distance, le temps ou une suite de jours
 * n'ont ni le même pas de graduation ni le même formatage, mais la géométrie
 * qui les consomme est la même.
 */
export type XAxisSpec = {
  /** Pas « rond » couvrant `span` en environ `target` intervalles. */
  step: (span: number, target: number) => number;
  /**
   * Densité visée, quand celle par défaut ne convient pas à ce que l'axe écrit.
   * Une date (« 21 mai ») est trois fois plus large qu'une distance (« 2,5 ») :
   * à six graduations, les étiquettes se touchent sur un téléphone.
   */
  targetTicks?: number;
  /** Étiquette d'une graduation ; le pas retenu en fixe la précision. */
  formatTick: (value: number, step: number) => string;
  /** Étendue de l'axe en toutes lettres, pour les descriptions accessibles. */
  label: (domain: Domain) => string;
};

/** Une graduation prête à poser : sa valeur, sa position en %, son étiquette. */
export type Tick = {
  value: number;
  /** Position dans le panneau, en pourcentage (0 = haut / gauche). */
  offsetPct: number;
  label: string;
};

/** Aires d'une série divergente et position de sa ligne de zéro. */
export type DivergingAreas = {
  /** Aire entre la courbe et zéro, là où la mesure est positive. */
  above: string;
  below: string;
  /** Ordonnée de la ligne de zéro dans le panneau, en pourcentage. */
  zeroOffsetPct: number;
};

export type PanelModel<P> = {
  spec: SeriesSpec<P>;
  values: readonly (number | null)[];
  domain: Domain;
  ticks: readonly Tick[];
  projected: readonly (Pt | null)[];
  line: string;
  area: string | null;
  /** Non-`null` pour les seules séries divergentes (cf. `SeriesSpec.diverging`). */
  diverging: DivergingAreas | null;
  /** Étendue mesurée, ex. `112 – 178 bpm` : lisible sans survoler. */
  rangeLabel: string;
  /** Description du panneau pour les lecteurs d'écran. */
  ariaLabel: string;
};

export type ChartsModel<P> = {
  /** Abscisse de chaque point, dans l'unité de l'axe. */
  xs: readonly number[];
  xDomain: Domain;
  xTicks: readonly Tick[];
  panels: readonly PanelModel<P>[];
};

/**
 * Six intervalles visés plutôt que cinq : avec cinq, une séance de 12,7 km
 * tombe juste au-dessus du pas de 2,5 km et n'obtient plus que deux
 * graduations — l'axe devient illisible.
 */
const X_TARGET_TICKS = 6;

/** Il faut deux points mesurés pour tracer une ligne — sinon pas de panneau. */
function hasEnoughData(values: readonly (number | null)[]): boolean {
  let count = 0;
  for (const value of values) {
    if (value !== null && Number.isFinite(value)) count += 1;
    if (count >= 2) return true;
  }
  return false;
}

function stepFor<P>(spec: SeriesSpec<P>, extent: Domain): number {
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
function physicalFloor<P>(spec: SeriesSpec<P>, extent: Domain): number {
  if (spec.hasZero) return Number.NEGATIVE_INFINITY;

  const step = stepFor(spec, { min: 0, max: extent.min });
  return Math.floor(extent.min / step) * step;
}

function describeSpan<P>(spec: SeriesSpec<P>, extent: Domain, xLabel: string): string {
  return `${spec.title} : de ${spec.format(extent.min)} à ${spec.format(extent.max)}, sur ${xLabel}.`;
}

function buildPanel<P>(
  spec: SeriesSpec<P>,
  points: readonly P[],
  xs: readonly number[],
  xDomain: Domain,
  xLabel: string,
): PanelModel<P> | null {
  const values = points.map(spec.read);
  if (!hasEnoughData(values)) return null;

  const extent = extentOf(values);
  if (extent === null) return null;

  // Une série divergente doit contenir sa ligne de zéro, même si toutes ses
  // valeurs sont du même côté : sans elle, le signe ne se lit plus nulle part.
  const spread = spec.diverging
    ? { min: Math.min(extent.min, 0), max: Math.max(extent.max, 0) }
    : extent;

  const step = stepFor(spec, spread);
  const rounded = niceDomain(spread, step);
  const domain = { min: Math.max(rounded.min, physicalFloor(spec, extent)), max: rounded.max };
  const projected = projectSeries(xs, values, xDomain, domain, spec.invertY);

  const ticks = ticksIn(domain, step).map((value) => ({
    value,
    offsetPct: (projectY(value, domain, spec.invertY) / VIEW_H) * 100,
    label: spec.formatTick(value),
  }));

  const zeroY = projectY(0, domain, spec.invertY);

  return {
    spec,
    values,
    domain,
    ticks,
    projected,
    line: linePath(projected),
    area: spec.fill ? areaPath(projected) : null,
    diverging: spec.diverging
      ? { ...divergingAreaPaths(projected, zeroY), zeroOffsetPct: (zeroY / VIEW_H) * 100 }
      : null,
    // Unité portée par la seule borne haute : « 112 – 178 bpm » se lit d'un trait.
    rangeLabel: `${spec.formatTick(extent.min)} – ${spec.format(extent.max)}`,
    ariaLabel: describeSpan(spec, extent, xLabel),
  };
}

/**
 * Modèle complet des graphes empilés pour une abscisse donnée.
 *
 * `points` et `xs` sont parallèles : c'est l'appelant qui projette ses points
 * sur l'axe (une abscisse partielle ne fait pas un axe, il lui revient de
 * renoncer avant d'appeler).
 *
 * `null` quand rien n'est traçable : la page affiche alors son message sobre
 * plutôt qu'un cadre vide.
 */
export function buildChartsModel<P>(input: {
  points: readonly P[];
  xs: readonly number[];
  axis: XAxisSpec;
  specs: readonly SeriesSpec<P>[];
}): ChartsModel<P> | null {
  const { points, xs, axis, specs } = input;
  if (points.length < 2) return null;

  const xExtent = extentOf(xs);
  if (xExtent === null || xExtent.max <= xExtent.min) return null;

  // Abscisse au plus juste (pas d'arrondi du domaine) : la courbe doit occuper
  // toute la largeur, les graduations tombent aux multiples ronds à l'intérieur.
  const xDomain = xExtent;
  const step = axis.step(xDomain.max - xDomain.min, axis.targetTicks ?? X_TARGET_TICKS);
  const label = axis.label(xDomain);

  const xTicks = ticksIn(xDomain, step).map((value) => ({
    value,
    offsetPct: normalize(value, xDomain) * 100,
    label: axis.formatTick(value, step),
  }));

  const panels = specs
    .map((spec) => buildPanel(spec, points, xs, xDomain, label))
    .filter((panel): panel is PanelModel<P> => panel !== null);

  if (panels.length === 0) return null;

  return { xs, xDomain, xTicks, panels };
}

/**
 * Valeur formatée du point survolé d'un panneau.
 *
 * Un trou reste un tiret : jamais interpolé, jamais remplacé par le point
 * voisin — le graphe ne doit pas inventer une mesure que le capteur n'a pas
 * faite.
 */
export function panelValueAt<P>(panel: PanelModel<P>, index: number | null): string {
  if (index === null) return MISSING;
  const value = panel.values[index];
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return panel.spec.format(value);
}
