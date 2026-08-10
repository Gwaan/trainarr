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
 * Les distances sont comptées **depuis la première distance mesurée** : le
 * stream FIT est un cumul qui ne repart pas forcément de zéro, et « km 1 »
 * désigne le premier kilomètre de la trace enregistrée.
 *
 * **Canaux clairsemés.** `distance`, `hr` et `altitude` portent `null` là où le
 * capteur n'a rien dit — un `record` FIT n'écrit pas tous ses champs à chaque
 * point. Le découpage kilométrique se fait sur la seule sous-série des distances
 * mesurées (interpoler entre deux mesures réelles reste légitime, cf.
 * {@link crossingTimeS}), tandis que les moyennes de FC et le D+ balaient l'axe
 * complet en sautant leurs propres trous. Les bornes de split sont donc
 * exprimées en index de l'axe complet : les canaux ne se décalent pas les uns
 * par rapport aux autres.
 *
 * **La séance commence à la première distance mesurée et s'arrête à la
 * dernière.** Ce qui précède le premier fix GPS (une minute d'attente au départ)
 * et ce qui le suit (GPS perdu à l'arrivée) n'appartient à aucun kilomètre :
 * `edges` ne les couvre pas, les tranches d'index non plus. Sans quoi le km 1
 * affichait 147 bpm pour un kilomètre couru à 160, moyenné avec la FC de repos
 * d'avant le départ.
 *
 * - `timeS` : **temps enregistré**, pas temps écoulé — le temps entre les deux
 *   bornes interpolées, diminué de la part des trous d'enregistrement qui
 *   dépasse le plafond d'échantillonnage (cf. `sampleDurationCapS`). Un
 *   kilomètre couru en 4:10 mais coupé d'une auto-pause de 5 min s'affichait
 *   sinon en 9:09, en contradiction avec la tuile « Durée » de la séance qui,
 *   elle, montre le temps en mouvement. Sur une série sans trou, `timeS` vaut
 *   exactement l'écart des bornes interpolées.
 * - `avgHrBpm` : moyenne des échantillons du split pondérée par leur durée
 *   (cf. `cappedSampleDurationsS`), arrondie au bpm. Les durées sont dérivées de
 *   l'axe des **seuls instants où la FC a parlé**, comme dans `computeHrZones`,
 *   et non de l'axe complet : une FC écrite un point sur cinq représente cinq
 *   secondes par mesure. Pondérer par les durées de l'axe complet ramenait la
 *   moyenne à un comptage de points dès que la cadence de la ceinture changeait
 *   en cours de split. `null` sans stream de FC, ou si aucun point du split n'en
 *   porte une mesure.
 * - `elevationGainM` : gain positif filtré (cf. `ELEVATION_NOISE_THRESHOLD_M`).
 *   Le filtre court d'un bout à l'autre de la partie découpée et attribue chaque
 *   gain au split de l'échantillon courant : découper l'hystérésis par split
 *   perdrait les montées à cheval sur une borne. `null` sans stream d'altitude.
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
  distance: readonly (number | null)[],
  time: readonly number[],
  hr?: readonly (number | null)[],
  altitude?: readonly (number | null)[],
): Split[] {
  const count = Math.min(distance.length, time.length);
  if (count < 2) return [];

  /*
   * Sous-série des points où la distance est mesurée. `at[k]` est l'index de ce
   * point sur l'axe complet : c'est lui qui permet de rendre les bornes de split
   * dans le repère commun à tous les canaux.
   */
  const at: number[] = [];
  const marks: number[] = [];
  const instants: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = distance[index];
    if (value === null || !Number.isFinite(value) || !Number.isFinite(time[index])) continue;
    at.push(index);
    marks.push(value);
    instants.push(time[index]);
  }

  const measured = at.length;
  if (measured < 2) return [];

  const start = marks[0];
  const total = marks[measured - 1] - start;
  if (total <= 0) return [];

  const fullKm = Math.floor(total / METERS_PER_KM);
  const remainder = total - fullKm * METERS_PER_KM;
  const splitCount = fullKm + (remainder >= MIN_PARTIAL_SPLIT_M ? 1 : 0);
  if (splitCount === 0) return [];

  /* Bornes temporelles : `edges[k]` = instant du franchissement du k-ième km. */
  const edges: number[] = [instants[0]];
  let cursor = 1;
  for (let km = 1; km <= fullKm; km += 1) {
    const target = start + km * METERS_PER_KM;
    while (cursor < measured && marks[cursor] < target) cursor += 1;
    if (cursor >= measured) break;

    edges.push(
      crossingTimeS(
        marks[cursor - 1],
        marks[cursor],
        instants[cursor - 1],
        instants[cursor],
        target,
      ),
    );
  }
  if (remainder >= MIN_PARTIAL_SPLIT_M) edges.push(instants[measured - 1]);
  if (edges.length < splitCount + 1) return [];

  /*
   * Index de début de chaque split, **sur l'axe complet** : premier échantillon
   * de distance mesurée qui atteint la borne, ramené par `at` à sa position
   * d'origine. Les splits sont des tranches d'index contiguës, la distance
   * étant croissante.
   *
   * Les deux extrémités sont celles de la sous-série mesurée (`at[0]` et le
   * point qui suit `at[measured - 1]`), jamais celles de l'axe : elles doivent
   * cadrer exactement ce que couvre `edges`.
   *
   * Le pointeur n'est **pas** consommé d'une borne à l'autre, exactement comme
   * le curseur d'`edges` : un même point peut porter plusieurs bornes quand plus
   * d'un kilomètre sépare deux mesures de distance. Sinon le `timeS` d'un split
   * venait d'un segment et sa FC d'un autre.
   */
  const lastMeasuredAt = at[measured - 1];
  const bounds: number[] = new Array<number>(splitCount + 1).fill(lastMeasuredAt + 1);
  bounds[0] = at[0];
  let pointer = 1;
  for (let km = 1; km <= fullKm; km += 1) {
    const target = start + km * METERS_PER_KM;
    while (pointer < measured && marks[pointer] < target) pointer += 1;
    if (pointer >= measured) break;

    bounds[km] = at[pointer];
  }
  // Un split sans échantillon propre (deux bornes franchies entre deux points)
  // hérite d'une tranche vide : ses moyennes seront simplement `null`.
  for (let index = splitCount - 1; index >= 1; index -= 1) {
    if (bounds[index] > bounds[index + 1]) bounds[index] = bounds[index + 1];
  }

  const axis = count === time.length ? time : time.slice(0, count);
  const cap = sampleDurationCapS(axis);
  // Sans stream de FC — ou avec un stream désaligné — la sous-série est vide et
  // toutes les tranches le sont avec elle : `weightedMean` rend `null`.
  const beats = measuredHr(hr, time, count);
  const hrBounds = subSeriesBounds(beats.at, bounds);
  const gains = altitude !== undefined && altitude.length >= count
    ? elevationGainPerSplit(altitude, bounds, splitCount, bounds[0], bounds[splitCount])
    : null;

  const splits: Split[] = [];
  for (let index = 0; index < splitCount; index += 1) {
    const timeS = recordedTimeS(time, count, cap, edges[index], edges[index + 1]);
    const distanceM = index < fullKm ? METERS_PER_KM : remainder;
    if (!Number.isFinite(timeS) || timeS <= 0) continue;

    const avgHr = weightedMean(
      beats.bpm,
      beats.durationsS,
      hrBounds[index],
      hrBounds[index + 1],
    );

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

type MeasuredHr = {
  /** Index, sur l'axe complet, de chaque battement mesuré. */
  at: number[];
  bpm: number[];
  /** Durées plafonnées dérivées du **sous-axe** des instants mesurés. */
  durationsS: number[];
};

/**
 * Sous-série des points où la ceinture a réellement parlé.
 *
 * Les durées se déduisent de ce sous-axe et non de l'axe complet : une FC écrite
 * un point sur cinq à 1 Hz représente 5 s par mesure. Pondérer par les durées de
 * l'axe complet revenait à compter les points dès que la cadence change au sein
 * d'un même split — une première moitié de kilomètre à 1 Hz écrasait alors une
 * seconde moitié plus clairsemée. Même raisonnement, et même plafond de trou,
 * que `computeHrZones`.
 */
function measuredHr(
  hr: readonly (number | null)[] | undefined,
  time: readonly number[],
  count: number,
): MeasuredHr {
  const at: number[] = [];
  const bpm: number[] = [];
  const instants: number[] = [];

  // Un stream plus court que l'axe commun est ignoré, jamais aligné au hasard.
  if (hr !== undefined && hr.length >= count) {
    for (let index = 0; index < count; index += 1) {
      const value = hr[index];
      if (value === null || !Number.isFinite(value) || value <= 0) continue;
      if (!Number.isFinite(time[index])) continue;

      at.push(index);
      bpm.push(value);
      instants.push(time[index]);
    }
  }

  return { at, bpm, durationsS: cappedSampleDurationsS(instants) };
}

/**
 * Bornes de split traduites dans le repère d'une sous-série : pour chaque borne,
 * le premier point de la sous-série qui l'atteint.
 *
 * Les bornes étant croissantes et `at` aussi, un pointeur monotone suffit — la
 * traduction coûte un seul balayage de la sous-série.
 */
function subSeriesBounds(at: readonly number[], bounds: readonly number[]): number[] {
  const translated: number[] = new Array<number>(bounds.length).fill(at.length);

  let pointer = 0;
  for (let index = 0; index < bounds.length; index += 1) {
    while (pointer < at.length && at[pointer] < bounds[index]) pointer += 1;
    translated[index] = pointer;
  }
  return translated;
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
  altitude: readonly (number | null)[],
  bounds: readonly number[],
  splitCount: number,
  /**
   * Début du balayage : la première borne de split, jamais le début de la série.
   * L'altitude d'avant le premier fix GPS n'appartient pas au km 1, et servirait
   * de surcroît de référence d'hystérésis hors trace.
   */
  from: number,
  /** Fin du balayage : la dernière borne de split, jamais la fin de la série. */
  until: number,
): number[] {
  const gains: number[] = new Array<number>(splitCount).fill(0);

  let reference: number | null = null;
  let split = 0;

  for (let index = from; index < until; index += 1) {
    while (split < splitCount - 1 && index >= bounds[split + 1]) split += 1;

    const value = altitude[index];
    if (value === null || !Number.isFinite(value)) continue;

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
