/**
 * Histogrammes « temps passé par tranche » sur une série temporelle.
 *
 * Méthode : celle des distributions de Runalyze (répartition du temps par
 * tranche d'allure et de fréquence cardiaque). Aucune formule physiologique ici,
 * mais deux règles de mesure qui font toute la différence entre un histogramme
 * juste et un comptage de points :
 *
 * 1. **On somme du temps, pas des échantillons.** La durée représentée par un
 *    point vient de {@link cappedSampleDurationsS} ; compter les points
 *    supposerait un enregistrement à 1 Hz constant, ce qu'aucune montre à
 *    enregistrement « intelligent » ne fait. Corollaire du plafond : une
 *    auto-pause n'est du temps passé dans aucune tranche — la somme des bins
 *    vaut le temps *enregistré*, pas le temps écoulé.
 * 2. **Un point muet est exclu, jamais comblé.** Les streams FIT sont
 *    clairsemés : `null` veut dire « pas de mesure à cet instant ». Les durées
 *    sont donc calculées sur le **sous-axe des instants réellement mesurés**,
 *    comme dans `computeHrZones` : une FC écrite un point sur quatre à 1 Hz
 *    représente 4 s par mesure, et un décrochage de dix minutes reste un trou.
 *
 * ## Forme des bins
 *
 * Les tranches sont semi-ouvertes `[from, to)` et alignées sur `min` quand il
 * est fourni, sinon sur le multiple de `binWidth` immédiatement sous la plus
 * petite valeur mesurée. Les bins vides **intermédiaires** sont émis avec
 * `seconds: 0` : un histogramme a un axe continu, et un creux entre deux
 * tranches occupées est une information (« il n'a jamais couru à cette
 * allure »).
 *
 * Les valeurs hors de `[min, max]` ne sont pas jetées — elles seraient du temps
 * disparu — mais regroupées dans deux **bins de bord ouverts**, reconnaissables
 * à leur borne infinie :
 *
 * - bin de bord bas : `{ from: -Infinity, to: min }` ;
 * - bin de bord haut : `{ from: max, to: Infinity }`.
 *
 * Ces deux bins ne sont émis que s'ils contiennent du temps : l'argument de
 * l'axe continu vaut pour l'intervalle borné, pas pour un bord ouvert vide, qui
 * n'apprendrait rien et n'a pas de largeur à dessiner.
 */

import { cappedSampleDurationsS } from './series';

export type DistributionBin = {
  /** Borne basse incluse. `-Infinity` pour le bin de bord bas. */
  from: number;
  /** Borne haute exclue. `Infinity` pour le bin de bord haut. */
  to: number;
  /** Temps enregistré dans la tranche, en secondes. */
  seconds: number;
};

export type DistributionOptions = {
  /** Largeur d'une tranche, dans l'unité des valeurs. Doit être > 0. */
  binWidth: number;
  /** Sous cette valeur, le temps part dans le bin de bord bas. */
  min?: number;
  /** À partir de cette valeur, le temps part dans le bin de bord haut. */
  max?: number;
};

/**
 * Temps passé par tranche de valeur.
 *
 * Retourne `null` — jamais un histogramme vide qui se lirait comme « aucun temps
 * passé » — si les options sont incohérentes (`binWidth` non fini ou ≤ 0,
 * `max` ≤ `min`), si aucun échantillon n'est exploitable, ou si le temps total
 * représenté est nul (série d'un seul point : un instant n'a pas de durée).
 *
 * Quand `max` n'est pas aligné sur la grille des tranches, la frontière du bin
 * de bord haut est remontée au multiple de `binWidth` supérieur : un histogramme
 * ne se termine pas sur une tranche tronquée.
 */
export function computeTimeDistribution(
  values: readonly (number | null)[],
  time: readonly (number | null)[],
  opts: DistributionOptions,
): DistributionBin[] | null {
  const { binWidth, min, max } = opts;
  if (!Number.isFinite(binWidth) || binWidth <= 0) return null;
  if (min !== undefined && !Number.isFinite(min)) return null;
  if (max !== undefined && !Number.isFinite(max)) return null;
  if (min !== undefined && max !== undefined && max <= min) return null;

  // Sous-axe des points où la valeur *et* l'instant sont mesurés.
  const measured: number[] = [];
  const instants: number[] = [];
  const count = Math.min(values.length, time.length);
  for (let index = 0; index < count; index += 1) {
    const value = values[index];
    const instant = time[index];
    if (value === null || !Number.isFinite(value)) continue;
    if (instant === null || !Number.isFinite(instant)) continue;

    measured.push(value);
    instants.push(instant);
  }
  if (measured.length === 0) return null;

  const durations = cappedSampleDurationsS(instants);

  // Origine de la grille : `min` s'il est imposé, sinon le multiple de
  // `binWidth` immédiatement sous la plus petite valeur mesurée.
  const origin = min ?? Math.floor(smallest(measured) / binWidth) * binWidth;
  const limit =
    max === undefined ? null : origin + Math.ceil((max - origin) / binWidth) * binWidth;

  const seconds = new Map<number, number>();
  let lowSeconds = 0;
  let highSeconds = 0;
  let total = 0;
  let lowestBin = Number.POSITIVE_INFINITY;
  let highestBin = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < measured.length; index += 1) {
    const duration = durations[index];
    if (duration <= 0) continue;
    total += duration;

    const value = measured[index];
    if (value < origin) {
      lowSeconds += duration;
      continue;
    }
    if (limit !== null && value >= limit) {
      highSeconds += duration;
      continue;
    }

    const bin = Math.floor((value - origin) / binWidth);
    seconds.set(bin, (seconds.get(bin) ?? 0) + duration);
    if (bin < lowestBin) lowestBin = bin;
    if (bin > highestBin) highestBin = bin;
  }

  if (total <= 0) return null;

  const bins: DistributionBin[] = [];
  if (lowSeconds > 0) {
    bins.push({ from: Number.NEGATIVE_INFINITY, to: origin, seconds: lowSeconds });
  }
  for (let bin = lowestBin; bin <= highestBin; bin += 1) {
    bins.push({
      from: origin + bin * binWidth,
      to: origin + (bin + 1) * binWidth,
      seconds: seconds.get(bin) ?? 0,
    });
  }
  if (highSeconds > 0 && limit !== null) {
    bins.push({ from: limit, to: Number.POSITIVE_INFINITY, seconds: highSeconds });
  }

  return bins;
}

/**
 * Plus petite valeur d'un tableau non vide. Une boucle plutôt que
 * `Math.min(...values)` : l'étalement d'une série d'une séance longue dépasse la
 * taille de pile autorisée pour les arguments d'un appel.
 */
function smallest(values: readonly number[]): number {
  let min = values[0];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < min) min = values[index];
  }
  return min;
}

const METERS_PER_KM = 1000;

/**
 * Sous cette vitesse, on ne court plus : on marche vers le départ, on attend à
 * un feu, la montre dérive à l'arrêt. 0,5 m/s vaut 33:20/km — aucune allure de
 * course, et l'inclure écraserait tout l'histogramme dans le bin de bord haut.
 */
const MIN_RUNNING_SPEED_MPS = 0.5;

/** Tranches d'allure de 15 s/km : assez fin pour lire une séance à seuil. */
const PACE_BIN_WIDTH_S = 15;

/** Bornes de l'axe d'allure : 3:00/km à 12:00/km, au-delà bins de bord. */
const PACE_MIN_S = 180;
const PACE_MAX_S = 720;

/**
 * Temps passé par tranche d'allure, en secondes par kilomètre.
 *
 * Les points sous {@link MIN_RUNNING_SPEED_MPS} sont écartés : c'est de l'arrêt,
 * pas une allure. Ils ne sont donc pas non plus rangés dans le bin de bord haut
 * — le temps à l'arrêt n'est pas du temps couru très lentement.
 */
export function paceDistribution(
  velocity: readonly (number | null)[],
  time: readonly (number | null)[],
): DistributionBin[] | null {
  const paces: (number | null)[] = velocity.map((speed) =>
    speed === null || !Number.isFinite(speed) || speed <= MIN_RUNNING_SPEED_MPS
      ? null
      : METERS_PER_KM / speed,
  );

  return computeTimeDistribution(paces, time, {
    binWidth: PACE_BIN_WIDTH_S,
    min: PACE_MIN_S,
    max: PACE_MAX_S,
  });
}

/** Tranches de FC de 5 bpm : la granularité usuelle des courbes de répartition. */
const HR_BIN_WIDTH_BPM = 5;

/**
 * Temps passé par tranche de fréquence cardiaque, en bpm.
 *
 * Aucune borne imposée, contrairement à l'allure : l'axe est déduit des données
 * (arrondi au multiple de 5 englobant), donc sans bin de bord. Une FC max n'est
 * pas nécessaire — c'est une répartition brute, pas un découpage en zones
 * (cf. `computeHrZones`).
 *
 * Les valeurs nulles ou négatives sont écartées comme des artefacts de capteur :
 * un cœur à 0 bpm n'est pas une mesure.
 */
export function hrDistribution(
  heartrate: readonly (number | null)[],
  time: readonly (number | null)[],
): DistributionBin[] | null {
  const beats: (number | null)[] = heartrate.map((value) =>
    value === null || !Number.isFinite(value) || value <= 0 ? null : value,
  );

  return computeTimeDistribution(beats, time, { binWidth: HR_BIN_WIDTH_BPM });
}
