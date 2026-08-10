/**
 * Décimation d'une série de points pour l'affichage.
 *
 * Une séance d'une heure enregistrée à 1 Hz fait 3 600 points ; une sortie
 * longue en fait 10 000. Les envoyer tels quels au navigateur coûte des
 * centaines de kilo-octets de payload RSC pour un graphe large de 800 pixels :
 * il faut réduire. Comment on réduit n'est pas neutre.
 *
 * ## Choix : min/max par bucket, sur l'allure et la FC
 *
 * Deux familles d'algorithmes étaient candidates :
 *
 * - **LTTB** (Largest Triangle Three Buckets, Steinarsson 2013) : excellent
 *   rendu visuel, mais il choisit **un** point par bucket en fonction d'**une**
 *   série. Nos points portent cinq canaux alignés (allure, FC, altitude,
 *   cadence, distance) : le point idéal pour l'allure ne l'est pas pour la FC,
 *   et faire tourner LTTB par canal donnerait des axes X différents — donc plus
 *   de curseur commun ni de tooltip unique entre les graphes.
 * - **Min/max par bucket** : on découpe la série en buckets d'index, et on
 *   conserve les points **réellement enregistrés** qui portent le minimum et le
 *   maximum du bucket. Retenu ici.
 *
 * Min/max garantit ce qui compte pour une appli de données : un pic de FC ou une
 * accélération d'une poignée de secondes ne peut pas disparaître du graphe — le
 * point extrême est, par construction, toujours sélectionné. C'est la propriété
 * qu'une simple prise d'un point sur N (décimation uniforme) n'a pas : elle
 * gomme précisément les extrema, qui sont les instants intéressants d'une
 * séance.
 *
 * Les extrema sont cherchés sur **l'allure et la FC** — les deux canaux que la
 * page lit pour juger la séance, et les deux que la consigne impose de
 * préserver. Altitude et cadence voyagent sur les points ainsi retenus : leur
 * profil reste juste (ces séries varient lentement), sans dépenser du budget de
 * points pour leurs extrema propres.
 *
 * ## Ce que la fonction ne fait pas
 *
 * Elle n'interpole **jamais**. Chaque point de sortie est un point d'entrée, tel
 * qu'il a été enregistré, avec ses `null` là où le capteur n'a rien donné. Un
 * rééchantillonnage à pas fixe fabriquerait des valeurs entre deux mesures et
 * comblerait les trous de capteur avec des données inventées — exclu.
 */

/** Un instant de la séance, tous canaux alignés. `null` = capteur muet. */
export type SeriesSample = {
  /** Secondes depuis le départ. */
  timeS: number;
  /** Mètres depuis le départ. */
  distanceM: number | null;
  paceSecPerKm: number | null;
  hrBpm: number | null;
  altitudeM: number | null;
  cadenceSpm: number | null;
};

/** Budget de points envoyés au client pour les graphes d'une activité. */
export const MAX_CHART_POINTS = 600;

/**
 * Au plus 4 index retenus par bucket : min et max de l'allure, min et max de la
 * FC. Le budget de buckets s'en déduit, moins les deux points forcés (premier et
 * dernier de la séance), pour que la sortie tienne dans `maxPoints`.
 */
const CANDIDATES_PER_BUCKET = 4;

/** Index du minimum et du maximum d'un canal sur `[from, to)`, s'il en a un. */
function extremaIndexes(
  samples: readonly SeriesSample[],
  channel: 'paceSecPerKm' | 'hrBpm',
  from: number,
  to: number,
): number[] {
  let minIndex = -1;
  let maxIndex = -1;
  let minValue = 0;
  let maxValue = 0;

  for (let index = from; index < to; index += 1) {
    const value = samples[index][channel];
    if (value === null || !Number.isFinite(value)) continue;

    if (minIndex === -1 || value < minValue) {
      minIndex = index;
      minValue = value;
    }
    if (maxIndex === -1 || value > maxValue) {
      maxIndex = index;
      maxValue = value;
    }
  }

  if (minIndex === -1) return [];
  return minIndex === maxIndex ? [minIndex] : [minIndex, maxIndex];
}

/**
 * Réduit `samples` à au plus `maxPoints` points, extrema d'allure et de FC
 * préservés. Une série déjà sous le budget est renvoyée telle quelle.
 *
 * Le premier et le dernier point de la séance sont toujours conservés : le
 * graphe doit couvrir toute la durée, pas s'arrêter au dernier extremum.
 *
 * Précondition : `maxPoints >= 6` (2 points forcés + un bucket de 4).
 */
export function resamplePoints(
  samples: readonly SeriesSample[],
  maxPoints: number = MAX_CHART_POINTS,
): SeriesSample[] {
  const count = samples.length;
  if (count === 0) return [];
  if (count <= maxPoints) return [...samples];

  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / CANDIDATES_PER_BUCKET));

  // `Set` : min et max d'un même canal peuvent coïncider avec ceux de l'autre,
  // et le point est alors retenu une seule fois.
  const kept = new Set<number>([0, count - 1]);

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const from = Math.floor((bucket * count) / bucketCount);
    const to = Math.floor(((bucket + 1) * count) / bucketCount);
    if (to <= from) continue;

    const candidates = [
      ...extremaIndexes(samples, 'paceSecPerKm', from, to),
      ...extremaIndexes(samples, 'hrBpm', from, to),
    ];

    // Bucket sans allure ni FC (GPS et ceinture muets, ou séance sans capteur) :
    // on garde son premier point, pour que l'axe des temps reste couvert.
    if (candidates.length === 0) candidates.push(from);

    for (const index of candidates) kept.add(index);
  }

  return [...kept].sort((a, b) => a - b).map((index) => samples[index]);
}
