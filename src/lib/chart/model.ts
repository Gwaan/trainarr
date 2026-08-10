/**
 * Géométrie des graphes maison — fonctions pures, testées.
 *
 * Aucun JSX ici : les composants SVG restent déclaratifs et se contentent de
 * consommer les échelles, chemins et graduations calculés dans ce module.
 *
 * Repère interne des panneaux : `VIEW_W` × `VIEW_H` unités, étiré via
 * `preserveAspectRatio="none"` (comme `src/components/sparkline.tsx`). Les
 * traits portent `vector-effect="non-scaling-stroke"` pour ne pas se déformer,
 * et tout le texte est rendu en HTML positionné en pourcentage — jamais dans le
 * SVG, qui l'étirerait.
 */

/** Largeur du repère interne : assez fine pour 600 points sans marches d'escalier. */
export const VIEW_W = 1000;
/** Hauteur du repère interne — la hauteur réelle est fixée en CSS. */
export const VIEW_H = 100;

export type Domain = { min: number; max: number };

export type Pt = { x: number; y: number };

/*
 * Domaines et graduations
 */

/** Pas « ronds » décimaux : 1, 2, 2,5, 5 × 10ⁿ — les repères qu'on lit vite. */
const DECIMAL_STEPS = [1, 2, 2.5, 5] as const;

/**
 * Pas de graduation « rond » couvrant `span` en environ `targetCount` intervalles.
 *
 * Renvoie toujours une valeur strictement positive : un domaine plat (span nul
 * ou non fini) retombe sur 1, charge à l'appelant d'élargir le domaine.
 */
export function niceStep(span: number, targetCount: number): number {
  if (!Number.isFinite(span) || span <= 0 || targetCount <= 0) return 1;

  const rough = span / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const step of DECIMAL_STEPS) {
    if (step * magnitude >= rough) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * Pas de graduation d'un axe de temps ou d'allure, **en secondes**.
 *
 * Les décimales n'ont pas de sens sur du sexagésimal : on choisit dans une
 * échelle de durées lisibles (15 s, 1 min, 5 min…) plutôt que 2,5 s ou 250 s.
 */
const TIME_STEPS = [
  1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
] as const;

export function timeStep(span: number, targetCount: number): number {
  if (!Number.isFinite(span) || span <= 0 || targetCount <= 0) return TIME_STEPS[0];

  const rough = span / targetCount;
  for (const step of TIME_STEPS) {
    if (step >= rough) return step;
  }
  return TIME_STEPS[TIME_STEPS.length - 1];
}

/** Étendue des valeurs finies d'une série. `null` s'il n'y en a aucune. */
export function extentOf(values: readonly (number | null)[]): Domain | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    // Un NaN/Infinity contaminerait le domaine et produirait un chemin « M NaN ».
    if (value === null || !Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return min === Number.POSITIVE_INFINITY ? null : { min, max };
}

/**
 * Domaine d'axe Y : l'étendue des données élargie aux multiples du pas, pour
 * que chaque graduation tombe juste et que la courbe ne colle pas aux bords.
 *
 * Une série plate (étendue nulle) est centrée sur un domaine d'un pas de part
 * et d'autre — sans quoi la division par l'amplitude serait impossible.
 */
export function niceDomain(extent: Domain, step: number): Domain {
  const safeStep = step > 0 ? step : 1;
  const min = Math.floor(extent.min / safeStep) * safeStep;
  const max = Math.ceil(extent.max / safeStep) * safeStep;
  if (max > min) return { min, max };
  return { min: min - safeStep, max: max + safeStep };
}

/**
 * Graduations aux multiples du pas contenus dans le domaine, bornes incluses.
 *
 * Le compte est borné : un pas incohérent avec le domaine ne doit pas produire
 * des milliers d'étiquettes.
 */
export function ticksIn(domain: Domain, step: number): number[] {
  if (!(step > 0) || !Number.isFinite(domain.min) || !Number.isFinite(domain.max)) {
    return [];
  }

  const ticks: number[] = [];
  const first = Math.ceil(domain.min / step) * step;
  for (let value = first; value <= domain.max + step * 1e-6 && ticks.length < 24; value += step) {
    // Les multiples flottants dérivent (0,1 × 3 = 0,30000000000000004), et la
    // dérive remonte jusqu'à l'étiquette : on recale chaque graduation sur le
    // pas, puis on tronque le bruit de représentation.
    ticks.push(Number((Math.round(value / step) * step).toPrecision(12)));
  }
  return ticks;
}

/*
 * Projection
 */

/** Position d'une valeur dans son domaine, ramenée à 0..1. */
export function normalize(value: number, domain: Domain): number {
  const span = domain.max - domain.min;
  return span === 0 ? 0.5 : (value - domain.min) / span;
}

/** Abscisse en unités de vue. */
export function projectX(value: number, domain: Domain): number {
  return normalize(value, domain) * VIEW_W;
}

/**
 * Ordonnée en unités de vue.
 *
 * `invert` sert l'axe des allures : une allure plus **basse** (plus rapide) doit
 * apparaître plus **haut** — convention universelle en course à pied.
 */
export function projectY(value: number, domain: Domain, invert: boolean): number {
  const t = normalize(value, domain);
  return invert ? t * VIEW_H : (1 - t) * VIEW_H;
}

/**
 * Projette une série dans le repère du panneau. Les trous (`null`, valeur non
 * finie) sont conservés comme tels : jamais interpolés — un capteur muet ne
 * doit pas produire de donnée inventée.
 */
export function projectSeries(
  xs: readonly number[],
  values: readonly (number | null)[],
  xDomain: Domain,
  yDomain: Domain,
  invertY: boolean,
): (Pt | null)[] {
  return values.map((value, index) => {
    const x = xs[index];
    if (value === null || !Number.isFinite(value) || !Number.isFinite(x)) return null;
    return { x: projectX(x, xDomain), y: projectY(value, yDomain, invertY) };
  });
}

const round = (n: number) => n.toFixed(2);

/**
 * Chemin de la courbe : segments droits (la précision prime sur le lissage,
 * une cubique ferait mentir la valeur entre deux points) et un `M` par tronçon
 * continu, pour que les trous restent des trous.
 */
export function linePath(points: readonly (Pt | null)[]): string {
  let d = "";
  let pen: "up" | "down" = "up";

  for (const point of points) {
    if (point === null) {
      pen = "up";
      continue;
    }
    d += pen === "up" ? `M ${round(point.x)} ${round(point.y)}` : ` L ${round(point.x)} ${round(point.y)}`;
    if (pen === "up") pen = "down";
  }

  return d;
}

/**
 * Chemin de l'aire sous la courbe, tronçon continu par tronçon continu (un
 * tronçon d'un seul point ne produit rien : il n'a pas de surface).
 */
export function areaPath(points: readonly (Pt | null)[]): string {
  let d = "";
  let run: Pt[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const first = run[0];
      const last = run[run.length - 1];
      d += `M ${round(first.x)} ${VIEW_H}`;
      for (const point of run) d += ` L ${round(point.x)} ${round(point.y)}`;
      d += ` L ${round(last.x)} ${VIEW_H} Z`;
    }
    run = [];
  };

  for (const point of points) {
    if (point === null) flush();
    else run.push(point);
  }
  flush();

  return d;
}

/** Aire d'un tronçon continu, refermée sur une ordonnée de référence. */
function areaAgainst(run: readonly Pt[], baselineY: number): string {
  if (run.length < 2) return "";

  const first = run[0];
  const last = run[run.length - 1];
  let d = `M ${round(first.x)} ${round(baselineY)}`;
  for (const point of run) d += ` L ${round(point.x)} ${round(point.y)}`;
  return `${d} L ${round(last.x)} ${round(baselineY)} Z`;
}

/** Point où le segment `from`→`to` croise l'ordonnée `y`. */
function crossing(from: Pt, to: Pt, y: number): Pt {
  const span = to.y - from.y;
  // Les deux points sont de part et d'autre de `y` : `span` ne peut pas être nul.
  return { x: from.x + ((y - from.y) / span) * (to.x - from.x), y };
}

/**
 * Aires d'une série **divergente** : ce qui est au-dessus de la ligne de zéro
 * d'un côté, ce qui est en dessous de l'autre, chaque tronçon coupé net à la
 * traversée.
 *
 * Sans cette découpe, une seule aire remplirait tout l'écart à zéro et les deux
 * signes porteraient la même couleur — or c'est précisément le signe que le TSB
 * raconte (frais au-dessus, en dette en dessous). Le point de croisement est
 * interpolé linéairement, comme le segment qui le porte : la courbe ne dit rien
 * de plus que ce qu'elle traçait déjà.
 *
 * `zeroY` est en unités de vue (l'axe Y du SVG descend) : « au-dessus » signifie
 * donc une ordonnée **plus petite**. Les trous coupent les aires comme les
 * courbes — jamais d'interpolation par-dessus une mesure absente.
 */
export function divergingAreaPaths(
  points: readonly (Pt | null)[],
  zeroY: number,
): { above: string; below: string } {
  let above = "";
  let below = "";

  let run: Pt[] = [];
  // -1 au-dessus de zéro, 1 en dessous, 0 tant que la série colle à la ligne.
  let side: -1 | 0 | 1 = 0;

  const sideOf = (y: number): -1 | 0 | 1 => (y < zeroY ? -1 : y > zeroY ? 1 : 0);

  const flush = () => {
    if (side === -1) above += areaAgainst(run, zeroY);
    else if (side === 1) below += areaAgainst(run, zeroY);
    run = [];
    side = 0;
  };

  for (const point of points) {
    if (point === null) {
      flush();
      continue;
    }

    const pointSide = sideOf(point.y);
    if (run.length === 0) {
      run.push(point);
      side = pointSide;
      continue;
    }

    if (side === 0 || pointSide === 0 || pointSide === side) {
      run.push(point);
      // Une série partie de la ligne de zéro prend le signe de son premier écart.
      if (side === 0) side = pointSide;
      continue;
    }

    // Changement de signe : le point de croisement ferme l'aire courante et
    // ouvre la suivante, pour que les deux se rejoignent exactement sur la ligne.
    const cross = crossing(run[run.length - 1], point, zeroY);
    run.push(cross);
    flush();
    run = [cross, point];
    side = pointSide;
  }
  flush();

  return { above, below };
}

/*
 * Survol
 */

/**
 * Index du point le plus proche de `target` dans une suite **croissante**
 * (distance cumulée ou temps écoulé). Recherche dichotomique : le survol suit
 * le doigt sans coût, même sur 600 points.
 */
export function nearestIndex(xs: readonly number[], target: number): number {
  if (xs.length === 0) return -1;

  let low = 0;
  let high = xs.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (xs[mid] < target) low = mid + 1;
    else high = mid;
  }

  const previous = low - 1;
  if (previous >= 0 && Math.abs(xs[previous] - target) <= Math.abs(xs[low] - target)) {
    return previous;
  }
  return low;
}

/** Ancre d'une étiquette posée sur l'axe, pour qu'elle ne déborde jamais. */
export type EdgeAnchor = "start" | "center" | "end";

export function edgeAnchor(ratio: number, margin = 0.18): EdgeAnchor {
  if (ratio < margin) return "start";
  if (ratio > 1 - margin) return "end";
  return "center";
}

/**
 * Côté où poser l'étiquette de survol : à l'opposé de la courbe, pour ne pas
 * masquer la valeur qu'on est en train de lire.
 */
export function chipSide(y: number | null): "top" | "bottom" {
  return y !== null && y < VIEW_H * 0.45 ? "bottom" : "top";
}

/** Ramène un ratio de pointeur dans les bornes du panneau. */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}
