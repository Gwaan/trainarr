/**
 * Splits kilométriques calculés depuis les séries temporelles.
 *
 * Le tableau des temps au kilomètre est la lecture la plus immédiate d'une
 * séance : c'est lui qui montre la dérive, la négative split, la côte du 4e km.
 * Il se calcule depuis les streams `distance` et `time`, jamais depuis les
 * `lap` du fichier FIT — les tours sont ceux que la montre a découpés (auto-lap
 * mal réglé, appuis manuels), pas des kilomètres.
 */

import { cappedSampleDurationsS, sampleDurationCapS, weightedMean } from './series';

export type Split = {
  /** Numéro du km, 1-indexé ; le dernier peut être partiel. */
  km: number;
  /** 1000, sauf pour le dernier split s'il est partiel. */
  distanceM: number;
  timeS: number;
  paceSecPerKm: number;
  avgHrBpm: number | null;
  elevationGainM: number | null;
};

const METERS_PER_KM = 1000;

/**
 * En deçà, le reliquat n'est pas affiché : un « km 11 » de 40 m tenus en 12 s
 * donne une allure sans signification, dominée par l'imprécision GPS.
 */
const MIN_PARTIAL_SPLIT_M = 100;

/**
 * Tolérance de comparaison au kilomètre plein, en mètres.
 *
 * Un demi-mètre : en deçà, l'écart n'est ni mesurable au GPS ni distinguable
 * d'un arrondi flottant sur une distance interpolée. **Valeur unique**, partagée
 * avec l'affichage via {@link isPartialSplit} — le seuil d'affichage et le seuil
 * de calcul ne doivent jamais diverger (un split de 995 m s'annonçait
 * « kilomètre complet » côté tableau).
 */
export const FULL_SPLIT_TOLERANCE_M = 0.5;

/**
 * `true` si le split n'atteint pas le kilomètre plein — le tableau affiche alors
 * sa distance réelle à côté de son numéro.
 */
export function isPartialSplit(distanceM: number): boolean {
  return distanceM < METERS_PER_KM - FULL_SPLIT_TOLERANCE_M;
}

/**
 * Seuil d'hystérésis du dénivelé positif, en mètres.
 *
 * L'altimètre barométrique d'une montre oscille de quelques dizaines de
 * centimètres au repos. Sommer naïvement toutes les variations positives d'un
 * 10 km parfaitement plat produit plusieurs dizaines de mètres de D+ fantôme.
 * On ne comptabilise donc une montée que lorsque l'altitude dépasse d'au moins
 * 1 m le dernier repère retenu, et on ne redescend le repère que sur une baisse
 * d'au moins 1 m : le bruit de faible amplitude est filtré, une vraie bosse de
 * 3 m est conservée.
 */
const ELEVATION_NOISE_THRESHOLD_M = 1;

/**
 * Temps au franchissement d'une borne, par interpolation linéaire entre les deux
 * points qui l'encadrent.
 *
 * **Pourquoi l'interpolation est légitime ici**, alors qu'elle est proscrite
 * ailleurs (cf. `resamplePoints`) : on ne fabrique pas une mesure de capteur, on
 * lit une grandeur dérivée de deux axes strictement croissants et mesurés. La
 * borne des 1 000 m tombe presque toujours *entre* deux enregistrements ;
 * supposer la vitesse constante sur l'intervalle qui les sépare (≈ 1 s) fausse
 * l'instant de franchissement de bien moins d'une seconde. Retenir à la place le
 * temps du premier point au-delà de la borne décalerait chaque split vers le
 * haut, et surtout accumulerait les erreurs de borne en borne.
 */
function crossingTimeS(
  distanceFrom: number,
  distanceTo: number,
  timeFrom: number,
  timeTo: number,
  target: number,
): number {
  const span = distanceTo - distanceFrom;
  if (!(span > 0)) return timeTo;
  return timeFrom + ((target - distanceFrom) / span) * (timeTo - timeFrom);
}

/**
 * Splits au kilomètre.
 *
 * Les distances sont comptées **depuis le premier point de la série** : le
 * stream FIT est un cumul qui ne repart pas forcément de zéro (le parseur rogne
 * les points de tête sans mesure), et « km 1 » désigne le premier kilomètre de
 * la trace enregistrée.
 *
 * - `timeS` : **temps enregistré**, pas temps écoulé — le temps entre les deux
 *   bornes interpolées, diminué de la part des trous d'enregistrement qui
 *   dépasse le plafond d'échantillonnage (cf. `sampleDurationCapS`). Un
 *   kilomètre couru en 4:10 mais coupé d'une auto-pause de 5 min s'affichait
 *   sinon en 9:09, en contradiction avec la tuile « Durée » de la séance qui,
 *   elle, montre le temps en mouvement. Sur une série sans trou, `timeS` vaut
 *   exactement l'écart des bornes interpolées.
 * - `avgHrBpm` : moyenne des échantillons du split pondérée par leur durée
 *   (cf. `cappedSampleDurationsS`), arrondie au bpm. `null` sans stream de FC.
 * - `elevationGainM` : gain positif filtré (cf. `ELEVATION_NOISE_THRESHOLD_M`).
 *   Le filtre court sur toute la séance et attribue chaque gain au split de
 *   l'échantillon courant : découper l'hystérésis par split perdrait les
 *   montées à cheval sur une borne. `null` sans stream d'altitude.
 * - Dernier split partiel émis si le reliquat atteint 100 m. **Sinon le reliquat
 *   n'appartient à aucun split** : le balayage s'arrête à la dernière borne
 *   kilométrique. Un sprint final de 88 m écarté de l'affichage ne doit pas
 *   remonter la FC ni le D+ du kilomètre précédent.
 *
 * Retourne `[]` si les séries sont inexploitables (moins de deux points,
 * distance totale nulle). Les streams `hr` et `altitude` plus courts que l'axe
 * commun sont ignorés plutôt qu'alignés au hasard.
 */
export function computeSplits(
  distance: readonly number[],
  time: readonly number[],
  hr?: readonly number[],
  altitude?: readonly number[],
): Split[] {
  const count = Math.min(distance.length, time.length);
  if (count < 2) return [];

  const start = distance[0];
  const total = distance[count - 1] - start;
  if (!Number.isFinite(start) || !Number.isFinite(total) || total <= 0) return [];
  if (!Number.isFinite(time[0]) || !Number.isFinite(time[count - 1])) return [];

  const fullKm = Math.floor(total / METERS_PER_KM);
  const remainder = total - fullKm * METERS_PER_KM;
  const splitCount = fullKm + (remainder >= MIN_PARTIAL_SPLIT_M ? 1 : 0);
  if (splitCount === 0) return [];

  /* Bornes temporelles : `edges[k]` = instant du franchissement du k-ième km. */
  const edges: number[] = [time[0]];
  let cursor = 1;
  for (let km = 1; km <= fullKm; km += 1) {
    const target = start + km * METERS_PER_KM;
    while (cursor < count && distance[cursor] < target) cursor += 1;
    if (cursor >= count) break;

    edges.push(
      crossingTimeS(distance[cursor - 1], distance[cursor], time[cursor - 1], time[cursor], target),
    );
  }
  if (remainder >= MIN_PARTIAL_SPLIT_M) edges.push(time[count - 1]);
  if (edges.length < splitCount + 1) return [];

  /*
   * Index de début de chaque split : premier échantillon dont la distance
   * parcourue atteint la borne. Les splits sont des tranches d'index contiguës,
   * la distance étant croissante.
   */
  const bounds: number[] = new Array<number>(splitCount + 1).fill(count);
  bounds[0] = 0;
  let split = 1;
  for (let index = 1; index < count && split <= fullKm; index += 1) {
    if (distance[index] - start >= split * METERS_PER_KM) {
      bounds[split] = index;
      split += 1;
    }
  }
  // La tranche du dernier split s'arrête à sa borne de distance, comme les
  // autres — sauf s'il est lui-même le reliquat partiel, qui court jusqu'au
  // dernier point.
  if (splitCount > fullKm) bounds[splitCount] = count;
  // Un split sans échantillon propre (deux bornes franchies entre deux points)
  // hérite d'une tranche vide : ses moyennes seront simplement `null`.
  for (let index = splitCount - 1; index >= 1; index -= 1) {
    if (bounds[index] > bounds[index + 1]) bounds[index] = bounds[index + 1];
  }

  const axis = count === time.length ? time : time.slice(0, count);
  const durations = cappedSampleDurationsS(axis);
  const cap = sampleDurationCapS(axis);
  const useHr = hr !== undefined && hr.length >= count;
  const gains = altitude !== undefined && altitude.length >= count
    ? elevationGainPerSplit(altitude, bounds, splitCount, bounds[splitCount])
    : null;

  const splits: Split[] = [];
  for (let index = 0; index < splitCount; index += 1) {
    const timeS = recordedTimeS(time, count, cap, edges[index], edges[index + 1]);
    const distanceM = index < fullKm ? METERS_PER_KM : remainder;
    if (!Number.isFinite(timeS) || timeS <= 0) continue;

    const avgHr = useHr ? weightedMean(hr, durations, bounds[index], bounds[index + 1]) : null;

    splits.push({
      km: index + 1,
      distanceM,
      timeS,
      paceSecPerKm: (timeS * METERS_PER_KM) / distanceM,
      avgHrBpm: avgHr === null ? null : Math.round(avgHr),
      elevationGainM: gains === null ? null : gains[index],
    });
  }

  return splits;
}

/**
 * Temps **enregistré** entre deux instants : le temps écoulé, diminué de la part
 * des trous d'enregistrement qui dépasse le plafond d'échantillonnage.
 *
 * Chaque intervalle `[t[i-1], t[i]]` de la série est intersecté avec la tranche
 * demandée, puis pondéré par `min(1, cap / pas)` : un intervalle normal compte
 * pour sa durée entière, un trou de 300 s ne compte que pour `cap`. Sur une
 * série sans trou, la somme vaut donc **exactement** `to - from`, bornes
 * interpolées comprises — la précision du découpage au kilomètre est intacte.
 *
 * C'est la version continue de la somme des durées plafonnées des échantillons
 * du split ; la forme continue est préférée parce qu'elle épouse les bornes
 * interpolées au lieu de s'arrêter aux index, et ne perd donc pas la
 * demi-seconde de bord que la somme discrète laisserait de côté.
 */
function recordedTimeS(
  time: readonly number[],
  count: number,
  cap: number,
  from: number,
  to: number,
): number {
  if (!(to > from)) return 0;

  let total = 0;
  for (let index = 1; index < count; index += 1) {
    const step = time[index] - time[index - 1];
    if (!(step > 0)) continue;

    const overlap = Math.min(time[index], to) - Math.max(time[index - 1], from);
    if (!(overlap > 0)) continue;

    total += overlap * Math.min(1, cap / step);
  }
  return total;
}

/** D+ filtré, attribué au split de l'échantillon où la montée est constatée. */
function elevationGainPerSplit(
  altitude: readonly number[],
  bounds: readonly number[],
  splitCount: number,
  /** Fin du balayage : la dernière borne de split, jamais la fin de la série. */
  until: number,
): number[] {
  const gains: number[] = new Array<number>(splitCount).fill(0);

  let reference: number | null = null;
  let split = 0;

  for (let index = 0; index < until; index += 1) {
    while (split < splitCount - 1 && index >= bounds[split + 1]) split += 1;

    const value = altitude[index];
    if (!Number.isFinite(value)) continue;

    if (reference === null) {
      reference = value;
      continue;
    }

    if (value - reference >= ELEVATION_NOISE_THRESHOLD_M) {
      gains[split] += value - reference;
      reference = value;
    } else if (reference - value >= ELEVATION_NOISE_THRESHOLD_M) {
      reference = value;
    }
  }

  return gains;
}
