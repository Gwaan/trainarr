/**
 * Lissage de l'allure instantanée.
 *
 * ## Pourquoi lisser
 *
 * La vitesse point à point d'une montre GPS est bruitée : ±0,3 m/s d'un
 * enregistrement au suivant sur un footing régulier, davantage sous les arbres
 * ou entre les immeubles. Tracée telle quelle, la courbe d'allure est un
 * peigne illisible dans lequel l'œil ne distingue plus la variation réelle
 * (relance, côte, marche) du bruit du capteur.
 *
 * ## Fenêtre : 15 s, centrée, **exprimée en temps**
 *
 * 15 s est le compromis usuel des plateformes d'analyse : assez long pour que
 * le bruit GPS se compense, assez court pour qu'une accélération franche ou une
 * bosse de 100 m reste visible (à 5 min/km, 15 s ≈ 50 m).
 *
 * La fenêtre est **bornée en secondes**, pas en nombre de points, et le nombre
 * de points retenus autour de chaque échantillon se déduit du pas temporel
 * local. C'est la seule forme correcte ici : l'enregistrement « intelligent »
 * d'une Apple Watch n'est pas à 1 Hz — une fenêtre de 15 points y couvrirait
 * plusieurs minutes sur une portion à allure stable (et écraserait la relance
 * suivante), tout en couvrant 15 s à peine sur une portion échantillonnée
 * finement. Chaque échantillon pèse à hauteur de la durée qu'il représente
 * (cf. `cappedSampleDurationsS`), sans quoi une portion densément échantillonnée
 * dominerait la moyenne de sa fenêtre.
 *
 * ## Deux bornes sur le poids d'un échantillon
 *
 * 1. **Le plafond de durée** (`cappedSampleDurationsS`) : sans lui, le point qui
 *    borde une auto-pause de 5 min pèse 150 s. Six secondes de course réelle
 *    autour de lui s'affichaient alors en allure de marche.
 * 2. **La fenêtre elle-même** : un échantillon ne peut contribuer que par la
 *    portion de sa durée qui tombe *dans* la fenêtre de 15 s. Sur un
 *    enregistrement à pas large, un seul point couvrirait sinon plus que la
 *    fenêtre qu'il est censé aider à moyenner.
 *
 * La durée plafonnée est centrée sur l'instant de l'échantillon
 * (`[t - d/2, t + d/2]`) : sur un axe régulier, cet intervalle est exactement
 * celui de la règle du point milieu.
 *
 * ## Seuil d'arrêt : 0,5 m/s
 *
 * Sous 0,5 m/s (≈ 33 min/km), l'athlète est arrêté ou marche : l'allure n'est
 * plus une donnée, c'est une division par un presque-zéro qui enverrait la
 * courbe à l'infini et écraserait toute l'échelle du graphe. Ces points valent
 * `null` — un trou assumé — jamais une valeur de remplissage.
 */

import { cappedSampleDurationsS } from './series';

/** Largeur de la fenêtre de lissage, en secondes. */
const SMOOTHING_WINDOW_S = 15;

const HALF_WINDOW_S = SMOOTHING_WINDOW_S / 2;

/** En dessous, l'athlète ne court pas : l'allure n'est pas définie. */
const MIN_MOVING_SPEED_M_PER_S = 0.5;

const METERS_PER_KM = 1000;

/**
 * Allure lissée en s/km, point par point.
 *
 * Le tableau retourné a la longueur de `velocity` ; toute position sans temps
 * associé (tableaux de longueurs différentes — le parseur FIT ne produit jamais
 * ce cas) vaut `null` plutôt que d'aligner les séries au hasard.
 *
 * @param velocity vitesse instantanée en m/s, telle que stockée dans le stream
 * @param time secondes depuis le départ, croissant, aligné sur `velocity`
 */
export function smoothPace(
  velocity: readonly number[],
  time: readonly number[],
): (number | null)[] {
  const paces: (number | null)[] = new Array<number | null>(velocity.length).fill(null);

  const count = Math.min(velocity.length, time.length);
  if (count === 0) return paces;

  const durations = cappedSampleDurationsS(count === time.length ? time : time.slice(0, count));

  for (let index = 0; index < count; index += 1) {
    const instant = time[index];
    if (!Number.isFinite(instant)) continue;

    // Bornes de la fenêtre par balayage depuis le point courant : O(points dans
    // la fenêtre), et robuste à un axe des temps localement irrégulier.
    let first = index;
    while (first > 0 && instant - time[first - 1] <= HALF_WINDOW_S) first -= 1;
    let last = index;
    while (last + 1 < count && time[last + 1] - instant <= HALF_WINDOW_S) last += 1;

    const speed = windowSpeed(velocity, time, durations, first, last, instant);
    if (speed === null || speed < MIN_MOVING_SPEED_M_PER_S) continue;

    paces[index] = METERS_PER_KM / speed;
  }

  return paces;
}

/**
 * Vitesse moyenne de la fenêtre centrée sur `instant`, chaque échantillon pesant
 * la part de sa durée qui tombe dans la fenêtre.
 *
 * Repli sur la moyenne arithmétique quand aucun échantillon ne porte de durée
 * (horodatages dupliqués) mais que des vitesses existent : mieux vaut une
 * moyenne non pondérée qu'un trou sur une donnée présente. `null` si la fenêtre
 * ne contient aucune vitesse exploitable.
 */
function windowSpeed(
  velocity: readonly number[],
  time: readonly number[],
  durations: readonly number[],
  first: number,
  last: number,
  instant: number,
): number | null {
  const from = instant - HALF_WINDOW_S;
  const to = instant + HALF_WINDOW_S;

  let weightedSum = 0;
  let totalWeight = 0;
  let plainSum = 0;
  let count = 0;

  for (let index = first; index <= last; index += 1) {
    const speed = velocity[index];
    if (!Number.isFinite(speed)) continue;

    plainSum += speed;
    count += 1;

    const half = durations[index] / 2;
    const overlap = Math.min(time[index] + half, to) - Math.max(time[index] - half, from);
    if (overlap > 0) {
      weightedSum += speed * overlap;
      totalWeight += overlap;
    }
  }

  if (totalWeight > 0) return weightedSum / totalWeight;
  return count > 0 ? plainSum / count : null;
}
