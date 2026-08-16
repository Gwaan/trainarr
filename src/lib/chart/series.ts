/**
 * Construction du modèle de rendu des graphes empilés — fonctions pures, testées.
 *
 * Règle de dataviz appliquée ici (cf. `.claude/rules/design.md`, section
 * Graphes, décision Gwen du 16/08/2026) : **la superposition est la norme**.
 * Les séries d'une même grandeur — ou d'une même lecture — se lisent ensemble
 * dans un panneau, avec jusqu'à **deux axes Y** (gauche et droit). L'ancienne
 * règle « un panneau = une série, jamais deux axes » est abandonnée.
 *
 * Ce qui n'a pas changé : les panneaux restent **empilés** sur une abscisse
 * commune, avec un survol synchronisé ; c'est ce qui permet la lecture croisée
 * (« HRV basse *et* FC de repos haute la même nuit »).
 *
 * Deux niveaux d'API, le second bâti sur le premier :
 *
 * - {@link buildMultiChartsModel} — le modèle courant : un panneau porte n
 *   séries réparties sur un ou deux axes ({@link MultiPanelSpec}) ;
 * - {@link buildChartsModel} — l'ancien modèle « une série par panneau »
 *   ({@link SeriesSpec}), conservé tel quel pour les pages qui n'ont pas encore
 *   migré. Ce n'est plus qu'un habillage du précédent : un panneau, une série,
 *   un axe gauche — donc aucune divergence de calcul possible entre les deux.
 *
 * Module générique : ni les points ni l'abscisse ne sont connus d'ici. Chaque
 * page décrit ses panneaux et son axe des abscisses ({@link XAxisSpec}) ; le
 * rendu vit dans `src/components/chart/`.
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

/*
 * Descripteurs — ce que la page déclare
 */

/**
 * Un axe Y de panneau : ce qui décide de la graduation et du sens de lecture.
 *
 * L'axe est déclaré par le **panneau**, jamais par la série : deux séries de
 * même grandeur (CTL et ATL, tous deux en TSS/j) doivent partager un domaine
 * unique, sinon leur superposition ferait mentir l'écart entre elles.
 */
export type PanelAxisSpec = {
  /**
   * Gouttière où se posent ses graduations. Redondant avec sa place dans
   * {@link MultiPanelSpec.axes} — c'est cette place qui fait foi ; le champ ne
   * sert qu'à rendre le descripteur lisible seul.
   */
  side: "left" | "right";
  /** Sexagésimal pour les durées et les allures, décimal pour le reste. */
  stepKind: "time" | "decimal";
  /**
   * L'axe a-t-il un zéro physique ? Non pour l'allure : 0:00/km serait une
   * vitesse infinie. Un axe sans zéro physique est planché sous sa valeur la
   * plus basse (cf. {@link physicalFloor}) plutôt qu'arrondi jusqu'à zéro.
   */
  hasZero: boolean;
  /** Axe inversé : réservé à l'allure (plus rapide = plus haut). */
  invertY: boolean;
  targetTicks: number;
  /**
   * Graduation d'axe : sans unité — l'unité est portée par le titre du panneau
   * ou par la légende de la série.
   */
  formatTick: (value: number) => string;
};

/**
 * Une série superposée dans un panneau. `P` est le type d'un point de la page
 * appelante — c'est `read` qui en extrait la mesure.
 */
export type PanelSeriesSpec<P> = {
  /** Identifiant stable de la série (clé de rendu, clé de lecture au survol). */
  key: string;
  /** Nom de la série en légende — dès qu'un panneau en porte deux, il en faut une. */
  label: string;
  /**
   * Axe de rattachement. Une série qui réclame l'axe droit sans qu'il soit
   * déclaré retombe sur l'axe gauche : mieux vaut un tracé mal gradué qu'une
   * série muette.
   */
  axis: "left" | "right";
  /** Classe Tailwind du trait — une couleur par série, jamais par point. */
  strokeClass: string;
  /** Classe Tailwind du point de survol, dans la couleur de la série. */
  dotClass: string;
  /** Pastille de légende (`bg-*`), dans la couleur de la série. */
  legendClass: string;
  /** Remplissage sous la courbe, quand il aide à lire le relief. */
  fill: { className: string; opacity: number } | null;
  /**
   * Série **divergente** : le remplissage change de couleur de part et d'autre
   * de zéro, qui devient une ligne de référence tracée dans le panneau.
   *
   * Réservé aux mesures dont le signe est le message (le TSB : frais au-dessus,
   * en dette en dessous). Il exclut `fill`, qui ignore le signe, et force son
   * axe à contenir zéro.
   */
  diverging?: { positiveClass: string; negativeClass: string; opacity: number };
  /** Valeur avec son unité (survol). */
  format: (value: number) => string;
  /** Mesure du point, `null` quand la série est absente à cet endroit. */
  read: (point: P) => number | null;
};

/** Un panneau : son titre, sa hauteur, ses axes et les séries qu'il superpose. */
export type MultiPanelSpec<P> = {
  /** Identifiant stable du panneau (clé de rendu). */
  key: string;
  /** Titre du panneau ; la légende nomme les séries. */
  title: string;
  /**
   * Titre de repli quand une **partie seulement** des séries déclarées survit
   * (l'appel reçoit les `label` des survivantes, dans l'ordre du descripteur).
   *
   * Un titre qui énumère ses séries ment dès que l'une d'elles manque : sans
   * ceinture cardio, « Allure et fréquence cardiaque » annoncerait une courbe
   * qu'aucun capteur n'a tracée. À fournir dans ce cas — et inutile quand le
   * titre ne nomme aucune série (une unité, par exemple) : il ne peut alors pas
   * mentir, et le descripteur garde {@link MultiPanelSpec.title}.
   */
  titleFor?: (survivingLabels: readonly string[]) => string;
  /** Hauteur du panneau — les séries qui portent la lecture priment. */
  heightClass: string;
  /** L'axe gauche est obligatoire : c'est lui qui porte la grille. */
  axes: { left: PanelAxisSpec; right?: PanelAxisSpec };
  /** Au moins une série ; chacune référence un axe déclaré ci-dessus. */
  series: readonly PanelSeriesSpec<P>[];
};

/**
 * Description d'une série et de son panneau — **ancien modèle**, un panneau une
 * série. Conservé pour les pages non migrées ; les nouveaux graphes décrivent
 * un {@link MultiPanelSpec}.
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

/*
 * Modèles — ce que le rendu consomme
 */

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

/** Un axe construit : son domaine arrondi et ses graduations placées. */
export type PanelAxisModel = {
  spec: PanelAxisSpec;
  domain: Domain;
  ticks: readonly Tick[];
};

/** Une série tracée : ses valeurs brutes et sa géométrie sur l'axe qui la porte. */
export type SeriesModel<P> = {
  spec: PanelSeriesSpec<P>;
  values: readonly (number | null)[];
  projected: readonly (Pt | null)[];
  line: string;
  area: string | null;
  /** Non-`null` pour les seules séries divergentes (cf. `PanelSeriesSpec.diverging`). */
  diverging: DivergingAreas | null;
  /** Étendue mesurée, ex. `112 – 178 bpm` : lisible sans survoler. */
  rangeLabel: string;
};

/** Un panneau construit : ses axes, ses séries survivantes, ses libellés. */
export type MultiPanelModel<P> = {
  key: string;
  title: string;
  heightClass: string;
  /**
   * Axe de la gouttière gauche — **c'est lui qui porte la grille** (une seule
   * grille par panneau : deux trames superposées ne se lisent plus).
   *
   * Normalement l'axe gauche déclaré ; si aucune série gauche ne survit, l'axe
   * droit prend sa place plutôt que de laisser le panneau sans repère.
   */
  leftAxis: PanelAxisModel;
  /** `null` si aucune série survivante ne s'y rattache. */
  rightAxis: PanelAxisModel | null;
  hasRightAxis: boolean;
  /** Séries survivantes, dans l'ordre du descripteur. */
  series: readonly SeriesModel<P>[];
  /** Étendue de la **première** série survivante, comme repère du panneau. */
  rangeLabel: string;
  /** Description du panneau pour les lecteurs d'écran, série par série. */
  ariaLabel: string;
};

export type MultiChartsModel<P> = {
  /** Abscisse de chaque point, dans l'unité de l'axe. */
  xs: readonly number[];
  xDomain: Domain;
  xTicks: readonly Tick[];
  panels: readonly MultiPanelModel<P>[];
  /**
   * Au moins un panneau a un axe droit : le rendu réserve alors la gouttière
   * droite sur **tous** les panneaux, sans quoi les tracés ne s'aligneraient
   * plus verticalement d'un panneau à l'autre.
   */
  hasRightGutter: boolean;
};

/** Un panneau de l'ancien modèle : une série, un axe. */
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

/*
 * Construction
 */

/**
 * Six intervalles visés plutôt que cinq : avec cinq, une séance de 12,7 km
 * tombe juste au-dessus du pas de 2,5 km et n'obtient plus que deux
 * graduations — l'axe devient illisible.
 */
const X_TARGET_TICKS = 6;

/** Il faut deux points mesurés pour tracer une ligne — sinon pas de série. */
function hasEnoughData(values: readonly (number | null)[]): boolean {
  let count = 0;
  for (const value of values) {
    if (value !== null && Number.isFinite(value)) count += 1;
    if (count >= 2) return true;
  }
  return false;
}

/**
 * Les seuls champs d'axe dont dépendent le pas et le plancher. Les deux modèles
 * les portent (l'ancien sur la série, le nouveau sur l'axe) : typer au strict
 * besoin évite de convertir l'un en l'autre juste pour calculer un pas.
 */
type AxisShape = Pick<PanelAxisSpec, "stepKind" | "targetTicks" | "hasZero">;

function stepFor(axis: AxisShape, extent: Domain): number {
  const span = extent.max - extent.min;
  return axis.stepKind === "time"
    ? timeStep(span, axis.targetTicks)
    : niceStep(span, axis.targetTicks);
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
function physicalFloor(axis: AxisShape, extent: Domain): number {
  if (axis.hasZero) return Number.NEGATIVE_INFINITY;

  const step = stepFor(axis, { min: 0, max: extent.min });
  return Math.floor(extent.min / step) * step;
}

/**
 * Domaine et graduations d'un axe, à partir de l'étendue **agrégée** des séries
 * qu'il porte.
 *
 * `needsZero` vient des séries divergentes : leur axe doit contenir sa ligne de
 * zéro même si toutes leurs valeurs sont du même côté, sans quoi le signe ne se
 * lit plus nulle part. Le plancher physique, lui, se mesure sur l'étendue
 * réellement mesurée — pas sur cet élargissement.
 */
function buildAxisModel(
  spec: PanelAxisSpec,
  extent: Domain,
  needsZero: boolean,
): PanelAxisModel {
  const spread = needsZero
    ? { min: Math.min(extent.min, 0), max: Math.max(extent.max, 0) }
    : extent;

  const step = stepFor(spec, spread);
  const rounded = niceDomain(spread, step);
  const domain = { min: Math.max(rounded.min, physicalFloor(spec, extent)), max: rounded.max };

  const ticks = ticksIn(domain, step).map((value) => ({
    value,
    offsetPct: (projectY(value, domain, spec.invertY) / VIEW_H) * 100,
    label: spec.formatTick(value),
  }));

  return { spec, domain, ticks };
}

function buildSeriesModel<P>(
  spec: PanelSeriesSpec<P>,
  values: readonly (number | null)[],
  extent: Domain,
  xs: readonly number[],
  xDomain: Domain,
  axis: PanelAxisModel,
): SeriesModel<P> {
  const projected = projectSeries(xs, values, xDomain, axis.domain, axis.spec.invertY);
  const zeroY = projectY(0, axis.domain, axis.spec.invertY);

  return {
    spec,
    values,
    projected,
    line: linePath(projected),
    area: spec.fill ? areaPath(projected) : null,
    diverging: spec.diverging
      ? { ...divergingAreaPaths(projected, zeroY), zeroOffsetPct: (zeroY / VIEW_H) * 100 }
      : null,
    // Unité portée par la seule borne haute : « 112 – 178 bpm » se lit d'un trait.
    rangeLabel: `${axis.spec.formatTick(extent.min)} – ${spec.format(extent.max)}`,
  };
}

function describeSpan<P>(
  spec: PanelSeriesSpec<P>,
  extent: Domain,
  xLabel: string,
): string {
  return `${spec.label} : de ${spec.format(extent.min)} à ${spec.format(extent.max)}, sur ${xLabel}.`;
}

/** Une série retenue : ses valeurs, son étendue et l'axe qui la portera. */
type KeptSeries<P> = {
  spec: PanelSeriesSpec<P>;
  values: readonly (number | null)[];
  extent: Domain;
  side: "left" | "right";
};

/** Étendue agrégée d'un groupe **non vide** de séries : l'union de leurs extents. */
function groupExtent<P>(group: readonly KeptSeries<P>[]): Domain {
  let min = group[0].extent.min;
  let max = group[0].extent.max;
  for (const entry of group) {
    if (entry.extent.min < min) min = entry.extent.min;
    if (entry.extent.max > max) max = entry.extent.max;
  }
  return { min, max };
}

function hasDiverging<P>(group: readonly KeptSeries<P>[]): boolean {
  return group.some((entry) => entry.spec.diverging !== undefined);
}

function buildMultiPanel<P>(
  spec: MultiPanelSpec<P>,
  points: readonly P[],
  xs: readonly number[],
  xDomain: Domain,
  xLabel: string,
): MultiPanelModel<P> | null {
  const rightSpec = spec.axes.right;

  const kept: KeptSeries<P>[] = [];
  for (const series of spec.series) {
    const values = points.map((point) => series.read(point));
    if (!hasEnoughData(values)) continue;

    const extent = extentOf(values);
    if (extent === null) continue;

    kept.push({
      spec: series,
      values,
      extent,
      side: series.axis === "right" && rightSpec !== undefined ? "right" : "left",
    });
  }

  // Plus une seule série traçable : pas de cadre vide, pas de panneau.
  if (kept.length === 0) return null;

  // Aucune survivante à gauche : l'axe droit prend la gouttière gauche. Un
  // panneau à axe unique n'a pas de côté « juste », et la grille doit s'ancrer
  // quelque part — la laisser sans repère serait pire que la déplacer.
  const promoted = rightSpec !== undefined && !kept.some((entry) => entry.side === "left");
  const leftSpec = promoted && rightSpec !== undefined ? rightSpec : spec.axes.left;
  const onLeft = promoted ? kept : kept.filter((entry) => entry.side === "left");
  const onRight = promoted ? [] : kept.filter((entry) => entry.side === "right");

  const leftAxis = buildAxisModel(leftSpec, groupExtent(onLeft), hasDiverging(onLeft));
  const rightAxis =
    onRight.length > 0 && rightSpec !== undefined
      ? buildAxisModel(rightSpec, groupExtent(onRight), hasDiverging(onRight))
      : null;

  const series = kept.map((entry) =>
    buildSeriesModel(
      entry.spec,
      entry.values,
      entry.extent,
      xs,
      xDomain,
      entry.side === "right" && rightAxis !== null ? rightAxis : leftAxis,
    ),
  );

  const spans = kept.map((entry) => describeSpan(entry.spec, entry.extent, xLabel));

  // Toutes les séries déclarées sont là : le titre du descripteur les couvre.
  // Sinon il faut demander à la page comment nommer ce qui reste — un titre qui
  // annonce une série écartée est un mensonge (cf. `MultiPanelSpec.titleFor`).
  const title =
    kept.length === spec.series.length
      ? spec.title
      : (spec.titleFor?.(kept.map((entry) => entry.spec.label)) ?? spec.title);

  return {
    key: spec.key,
    title,
    heightClass: spec.heightClass,
    leftAxis,
    rightAxis,
    hasRightAxis: rightAxis !== null,
    series,
    rangeLabel: series[0].rangeLabel,
    // Une seule série : son titre **est** celui du panneau, le répéter en tête
    // ferait bégayer le lecteur d'écran.
    ariaLabel: spans.length === 1 ? spans[0] : `${title} — ${spans.join(" ")}`,
  };
}

/** Domaine et graduations de l'abscisse ; `null` si elle n'en fait pas une. */
function buildXAxis(
  xs: readonly number[],
  axis: XAxisSpec,
): { domain: Domain; ticks: Tick[]; label: string } | null {
  const extent = extentOf(xs);
  if (extent === null || extent.max <= extent.min) return null;

  // Abscisse au plus juste (pas d'arrondi du domaine) : la courbe doit occuper
  // toute la largeur, les graduations tombent aux multiples ronds à l'intérieur.
  const domain = extent;
  const step = axis.step(domain.max - domain.min, axis.targetTicks ?? X_TARGET_TICKS);

  const ticks = ticksIn(domain, step).map((value) => ({
    value,
    offsetPct: normalize(value, domain) * 100,
    label: axis.formatTick(value, step),
  }));

  return { domain, ticks, label: axis.label(domain) };
}

/**
 * Modèle complet des graphes empilés multi-séries pour une abscisse donnée.
 *
 * `points` et `xs` sont parallèles : c'est l'appelant qui projette ses points
 * sur l'axe (une abscisse partielle ne fait pas un axe, il lui revient de
 * renoncer avant d'appeler).
 *
 * `null` quand rien n'est traçable : la page affiche alors son message sobre
 * plutôt qu'un cadre vide.
 */
export function buildMultiChartsModel<P>(input: {
  points: readonly P[];
  xs: readonly number[];
  axis: XAxisSpec;
  panels: readonly MultiPanelSpec<P>[];
}): MultiChartsModel<P> | null {
  const { points, xs, axis } = input;
  if (points.length < 2) return null;

  const x = buildXAxis(xs, axis);
  if (x === null) return null;

  const panels = input.panels
    .map((spec) => buildMultiPanel(spec, points, xs, x.domain, x.label))
    .filter((panel): panel is MultiPanelModel<P> => panel !== null);

  if (panels.length === 0) return null;

  return {
    xs,
    xDomain: x.domain,
    xTicks: x.ticks,
    panels,
    hasRightGutter: panels.some((panel) => panel.hasRightAxis),
  };
}

/** L'ancien descripteur, relu comme un panneau à une série sur l'axe gauche. */
function asMultiPanel<P>(spec: SeriesSpec<P>): MultiPanelSpec<P> {
  return {
    key: spec.key,
    title: spec.title,
    heightClass: spec.heightClass,
    axes: {
      left: {
        side: "left",
        stepKind: spec.stepKind,
        hasZero: spec.hasZero,
        invertY: spec.invertY,
        targetTicks: spec.targetTicks,
        formatTick: spec.formatTick,
      },
    },
    series: [
      {
        key: spec.key,
        // Le titre du panneau **est** la légende : une seule série par panneau.
        label: spec.title,
        axis: "left",
        strokeClass: spec.strokeClass,
        dotClass: spec.dotClass,
        legendClass: spec.dotClass,
        fill: spec.fill,
        diverging: spec.diverging,
        format: spec.format,
        read: spec.read,
      },
    ],
  };
}

/**
 * Modèle complet des graphes empilés, **un panneau par série** (ancien modèle).
 *
 * Habillage de {@link buildMultiChartsModel} : chaque série devient un panneau
 * à une série sur son axe gauche. Les deux modèles partagent donc exactement le
 * même calcul de domaine, de graduations et de chemins.
 */
export function buildChartsModel<P>(input: {
  points: readonly P[];
  xs: readonly number[];
  axis: XAxisSpec;
  specs: readonly SeriesSpec<P>[];
}): ChartsModel<P> | null {
  const { points, xs, axis, specs } = input;

  const model = buildMultiChartsModel({
    points,
    xs,
    axis,
    panels: specs.map((spec) => asMultiPanel(spec)),
  });
  if (model === null) return null;

  // Les clés de panneau sont celles des séries : c'est par elles qu'on retrouve
  // le descripteur d'origine, seul à porter la forme attendue par les pages.
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));

  const panels: PanelModel<P>[] = [];
  for (const panel of model.panels) {
    const spec = byKey.get(panel.key);
    if (spec === undefined) continue;

    const series = panel.series[0];
    panels.push({
      spec,
      values: series.values,
      domain: panel.leftAxis.domain,
      ticks: panel.leftAxis.ticks,
      projected: series.projected,
      line: series.line,
      area: series.area,
      diverging: series.diverging,
      rangeLabel: panel.rangeLabel,
      ariaLabel: panel.ariaLabel,
    });
  }

  if (panels.length === 0) return null;

  return { xs: model.xs, xDomain: model.xDomain, xTicks: model.xTicks, panels };
}

/*
 * Lecture au survol
 */

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

/**
 * Valeur formatée d'une série donnée du panneau, au point survolé.
 *
 * Même règle que {@link panelValueAt} : un trou reste `—`. Une clé inconnue
 * (série écartée faute de mesures) l'est aussi — l'appelant n'a pas à savoir
 * laquelle a survécu pour poser sa question.
 */
export function multiPanelValueAt<P>(
  panel: MultiPanelModel<P>,
  seriesKey: string,
  index: number | null,
): string {
  if (index === null) return MISSING;

  const series = panel.series.find((entry) => entry.spec.key === seriesKey);
  if (series === undefined) return MISSING;

  const value = series.values[index];
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return series.spec.format(value);
}
