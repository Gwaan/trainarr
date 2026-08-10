/**
 * Répartition du temps en zones de fréquence cardiaque.
 *
 * ## Convention retenue : 5 zones en % de FC max, bornes 50/60/70/80/90
 *
 * | Zone | % FC max  | Lecture usuelle          |
 * |------|-----------|--------------------------|
 * | Z1   | < 60      | récupération             |
 * | Z2   | 60 – 70   | endurance fondamentale   |
 * | Z3   | 70 – 80   | endurance active         |
 * | Z4   | 80 – 90   | seuil                    |
 * | Z5   | ≥ 90      | VMA / anaérobie          |
 *
 * C'est le modèle à cinq zones en pourcentage de FC max le plus répandu — celui
 * qu'appliquent par défaut les montres grand public (Polar, Garmin) et que
 * retiennent les plateformes d'analyse. Bornes inférieures incluses, supérieures
 * exclues. Les échantillons **sous 50 %** de FC max comptent en Z1 : ils
 * correspondent aux temps d'arrêt et de récupération, qui appartiennent bien à
 * la séance — les exclure ferait que la somme des zones ne vaudrait plus la
 * durée enregistrée, et l'athlète ne comprendrait pas où est passé son temps.
 *
 * Deux limites assumées, à revoir quand le profil portera plus de données :
 *
 * - le modèle est en **% de FC max**, pas en % de réserve cardiaque (Karvonen)
 *   ni en % de FC au seuil : ces variantes déplacent les frontières de plusieurs
 *   points et exigent respectivement la FC de repos et un test de seuil. Le
 *   choix ici est celui qui ne demande que la FC max ;
 * - les zones ne sont pas paramétrables. Elles le deviendront si le besoin
 *   apparaît, mais une valeur par défaut explicite vaut mieux qu'un réglage vide.
 */

import { cappedSampleDurationsS } from './series';

export type HrZoneNumber = 1 | 2 | 3 | 4 | 5;

export type ZoneTime = {
  zone: HrZoneNumber;
  timeS: number;
  /** Part de la durée totale, dans [0, 1]. */
  share: number;
};

const ZONES: readonly HrZoneNumber[] = [1, 2, 3, 4, 5];

/**
 * Zone d'un pourcentage de FC max. Bornes inférieures incluses ; tout ce qui est
 * sous 60 % — plancher de 50 % du modèle classique compris — tombe en Z1.
 */
function zoneOf(percentOfMax: number): HrZoneNumber {
  if (percentOfMax >= 90) return 5;
  if (percentOfMax >= 80) return 4;
  if (percentOfMax >= 70) return 3;
  if (percentOfMax >= 60) return 2;
  return 1;
}

/**
 * Zone d'une fréquence cardiaque, aux mêmes bornes que {@link computeHrZones}.
 *
 * Exportée pour que l'affichage (colorer une tranche d'histogramme dans la rampe
 * des zones) lise les seuils **ici** au lieu de les redéclarer : deux jeux de
 * bornes qui divergent feraient mentir la couleur.
 *
 * `null` quand la zone n'est pas déterminable — FC max absente ou absurde,
 * mesure nulle ou négative : rien n'est deviné.
 */
export function hrZoneOf(bpm: number, maxHrBpm: number | null): HrZoneNumber | null {
  if (maxHrBpm === null || !Number.isFinite(maxHrBpm) || maxHrBpm <= 0) return null;
  if (!Number.isFinite(bpm) || bpm <= 0) return null;

  return zoneOf((bpm / maxHrBpm) * 100);
}

/**
 * Temps passé dans chacune des 5 zones, pondéré par la durée réellement
 * représentée par chaque échantillon (cf. `cappedSampleDurationsS`) — compter
 * les points supposerait un enregistrement à 1 Hz constant, ce que ne fait
 * aucune montre à enregistrement « intelligent ».
 *
 * **Le total des zones est le temps enregistré, pas le temps écoulé.** Les
 * durées sont plafonnées : une auto-pause de 20 min n'est pas du temps passé en
 * zone, elle n'est comptée nulle part. Sans ce plafond, une séance de 20 min
 * mesurées coupée d'une pause de 20 min annonçait 40:00 en en-tête de panneau.
 *
 * **Canal clairsemé.** Le stream de FC porte `null` là où la ceinture n'a rien
 * dit : un fichier FIT n'écrit pas `heart_rate` dans chaque `record`. Ces points
 * sont retirés **avant** le calcul des durées, et non simplement ignorés dans la
 * boucle : les durées se déduisent de l'axe des temps, or l'axe pertinent ici
 * est celui des instants où la FC a parlé. Une FC mesurée un point sur quatre
 * sur un axe à 1 Hz représente 4 s par mesure, pas 1 s — les ignorer dans la
 * boucle n'aurait compté que le quart de la séance. Le plafond de
 * `cappedSampleDurationsS` s'applique alors à ce sous-axe : une ceinture qui
 * décroche dix minutes laisse bien un trou non comptabilisé.
 *
 * Retourne les 5 zones, y compris celles à zéro (le graphe doit montrer une
 * zone vide, pas l'omettre), ou `[]` si rien n'est calculable : FC max absurde,
 * séries vides, ou durée totale nulle (échantillon unique).
 */
export function computeHrZones(
  hr: readonly (number | null)[],
  time: readonly number[],
  maxHrBpm: number,
): ZoneTime[] {
  if (!Number.isFinite(maxHrBpm) || maxHrBpm <= 0) return [];

  const count = Math.min(hr.length, time.length);
  if (count === 0) return [];

  // Sous-série des instants où la FC est réellement mesurée.
  const beatsAt: number[] = [];
  const instants: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const beats = hr[index];
    if (beats === null || !Number.isFinite(beats) || beats <= 0) continue;
    if (!Number.isFinite(time[index])) continue;

    beatsAt.push(beats);
    instants.push(time[index]);
  }
  if (beatsAt.length === 0) return [];

  const durations = cappedSampleDurationsS(instants);

  const timeInZone = new Map<HrZoneNumber, number>(ZONES.map((zone) => [zone, 0]));
  let total = 0;

  for (let index = 0; index < beatsAt.length; index += 1) {
    const duration = durations[index];
    if (duration <= 0) continue;

    const zone = zoneOf((beatsAt[index] / maxHrBpm) * 100);
    timeInZone.set(zone, (timeInZone.get(zone) ?? 0) + duration);
    total += duration;
  }

  if (total <= 0) return [];

  return ZONES.map((zone) => {
    const timeS = timeInZone.get(zone) ?? 0;
    return { zone, timeS, share: timeS / total };
  });
}
