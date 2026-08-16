/**
 * Géométrie d'une jauge en arc — fonctions pures, testées.
 *
 * Une jauge répond à une question que ni une tuile ni une courbe ne posent :
 * « où tombe cette valeur dans l'échelle qui la concerne ? ». D'où deux lectures
 * superposées — l'aiguille dit la position exacte, la bande allumée dit dans
 * quel registre elle tombe — et un domaine toujours **fourni par l'appelant** :
 * une jauge sans bornes explicites inventerait son propre référentiel.
 *
 * Repère interne carré ({@link GAUGE_VIEW} × {@link GAUGE_VIEW}), rendu **sans**
 * `preserveAspectRatio="none"` : contrairement aux panneaux de courbes, qui
 * s'étirent à la largeur disponible, un arc étiré n'est plus un arc. Les rayons
 * et les épaisseurs de trait sont donc en unités de vue, et se mettent à
 * l'échelle avec la jauge.
 *
 * L'arc couvre 240° ouverts vers le bas : de −210° (bas-gauche) à +30°
 * (bas-droite), angles croissants dans le sens horaire à l'écran — l'axe Y du
 * SVG descend, donc `(cos θ, sin θ)` tourne dans le sens des aiguilles d'une
 * montre. Le minimum est à gauche, le maximum à droite, comme un axe.
 */

/** Côté du repère interne. Carré : la jauge garde son ratio. */
export const GAUGE_VIEW = 100;

/** Centre de l'arc, descendu sous le milieu — l'ouverture est en bas. */
export const GAUGE_CENTER_X = 50;
export const GAUGE_CENTER_Y = 56;

/** Rayon de la ligne moyenne de l'anneau de bandes. */
export const GAUGE_RADIUS = 40;

/** Épaisseur de l'anneau, en unités de vue (`stroke-width` des bandes). */
export const GAUGE_BAND_WIDTH = 8;

/** Rayon du moyeu, d'où part l'aiguille. */
export const GAUGE_HUB_RADIUS = 3;

/** Angle du minimum du domaine (bas-gauche). */
export const GAUGE_START_ANGLE = -210;

/** Ouverture totale de l'arc, en degrés. */
export const GAUGE_SWEEP_ANGLE = 240;

/**
 * Espace angulaire entre deux bandes voisines.
 *
 * Deux arcs jointifs de teintes proches se lisent comme une seule bande ; un
 * liseré de fond les séparerait au prix d'une couleur de plus. Le vide fait le
 * même travail sans rien ajouter au système.
 */
const BAND_GAP_DEG = 2;

/** L'aiguille s'arrête sous l'anneau : elle pointe la bande, ne la recouvre pas. */
const NEEDLE_TIP_RADIUS = GAUGE_RADIUS - GAUGE_BAND_WIDTH;

/**
 * Une bande de la jauge : jusqu'où elle va, de quelle couleur, et ce qu'elle
 * veut dire.
 *
 * Les bornes sont **croissantes** et la dernière couvre le maximum du domaine —
 * une échelle qui s'arrête avant sa borne haute laisserait un secteur muet.
 * `upTo` appartient à la bande : une valeur posée exactement sur une borne tombe
 * dans la bande **inférieure**.
 */
export type GaugeBand = {
  /** Borne haute incluse, dans l'unité de la valeur. */
  upTo: number;
  /** Classe Tailwind de trait, ex. `stroke-zone-2` — jamais une couleur en dur. */
  className: string;
  /** Lecture qualitative de la bande, ex. « soutenue ». */
  label: string;
};

/** Un arc prêt à être tracé : le `d` d'un `<path>`, sa classe, son état. */
export type GaugeArc = {
  path: string;
  className: string;
  /**
   * `true` pour la bande où tombe la valeur. Le rendu l'allume et éteint les
   * autres : la position se lit alors deux fois, à l'aiguille et à la couleur.
   */
  active: boolean;
};

export type GaugeModel = {
  bands: readonly GaugeArc[];
  /** Angle de l'aiguille, en degrés, dans le repère décrit en tête de module. */
  valueAngle: number;
  /** Trait de l'aiguille, du moyeu vers l'anneau. */
  needlePath: string;
  /**
   * `true` quand la valeur sortait du domaine et a été posée sur la borne :
   * l'aiguille ne peut pas montrer un ailleurs, mais l'appelant doit pouvoir le
   * dire plutôt que de laisser croire à une valeur pile sur la borne.
   */
  clamped: boolean;
  /** Bande où tombe la valeur (clampée). */
  activeBand: GaugeBand;
};

type Point = { x: number; y: number };

const round = (n: number) => n.toFixed(2);

/** Point de l'arc à un angle donné, dans le repère de la vue. */
function pointAt(angleDeg: number, radius: number): Point {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: GAUGE_CENTER_X + radius * Math.cos(radians),
    y: GAUGE_CENTER_Y + radius * Math.sin(radians),
  };
}

/** Angle d'une valeur du domaine. Le domaine est supposé non dégénéré. */
function angleOf(value: number, min: number, max: number): number {
  return GAUGE_START_ANGLE + ((value - min) / (max - min)) * GAUGE_SWEEP_ANGLE;
}

/**
 * Arc de cercle entre deux angles, dans le sens horaire (`sweep-flag` à 1).
 *
 * Tracé en trait épais sans remplissage : un `fill` refermerait la corde de
 * l'arc et peindrait le vide central.
 */
function arcPath(fromDeg: number, toDeg: number, radius: number): string {
  const from = pointAt(fromDeg, radius);
  const to = pointAt(toDeg, radius);
  const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${round(from.x)} ${round(from.y)} A ${radius} ${radius} 0 ${largeArc} 1 ${round(to.x)} ${round(to.y)}`;
}

/**
 * Modèle complet d'une jauge : les arcs des bandes, l'aiguille, la bande active.
 *
 * `null` — jamais un modèle approximatif — quand rien n'est plaçable :
 *
 * - domaine dégénéré (`max <= min`) ou non fini : aucune position n'existe sur
 *   une échelle sans amplitude ;
 * - valeur non finie ;
 * - aucune bande, ou aucune bande dont la portion visible ait une largeur — une
 *   jauge sans échelle ne dit rien.
 *
 * Une valeur hors domaine est **posée sur la borne** et signalée par
 * {@link GaugeModel.clamped} : l'aiguille reste dans l'arc, et l'appelant garde
 * la main sur ce qu'il en dit.
 */
export function buildGaugeModel(input: {
  value: number;
  min: number;
  max: number;
  bands: readonly GaugeBand[];
}): GaugeModel | null {
  const { value, min, max, bands } = input;

  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  if (!Number.isFinite(value) || bands.length === 0) return null;

  const bounded = Math.min(max, Math.max(min, value));
  const valueAngle = angleOf(bounded, min, max);

  const arcs: GaugeArc[] = [];
  let activeBand: GaugeBand | null = null;
  let lower = min;

  for (const band of bands) {
    // Une bande peut déborder du domaine (la dernière le fait par contrat) ou
    // rester entièrement dessous : seule sa portion visible est tracée.
    const upper = Math.min(max, Math.max(min, band.upTo));
    if (!(upper > lower)) continue;

    const holdsValue = activeBand === null && bounded <= upper;
    if (holdsValue) activeBand = band;

    // Le vide se prend sur les deux bandes voisines, moitié chacune — les
    // extrémités de l'arc, elles, ne bordent rien et gardent leur angle.
    const from = angleOf(lower, min, max) + (lower > min ? BAND_GAP_DEG / 2 : 0);
    const to = angleOf(upper, min, max) - (upper < max ? BAND_GAP_DEG / 2 : 0);
    if (to > from) {
      arcs.push({
        path: arcPath(from, to, GAUGE_RADIUS),
        className: band.className,
        active: holdsValue,
      });
    }

    lower = upper;
  }

  if (arcs.length === 0) return null;

  // Filet de sécurité si la dernière bande s'arrête avant le maximum (contrat
  // non tenu) : la valeur tombe alors dans la dernière bande tracée plutôt que
  // nulle part.
  const active = activeBand ?? bands[bands.length - 1];
  if (activeBand === null) {
    const last = arcs.length - 1;
    arcs[last] = { ...arcs[last], active: true };
  }

  const tip = pointAt(valueAngle, NEEDLE_TIP_RADIUS);

  return {
    bands: arcs,
    valueAngle,
    needlePath: `M ${GAUGE_CENTER_X} ${GAUGE_CENTER_Y} L ${round(tip.x)} ${round(tip.y)}`,
    clamped: bounded !== value,
    activeBand: active,
  };
}
