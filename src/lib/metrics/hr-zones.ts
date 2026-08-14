/**
 * Répartition du temps en zones de fréquence cardiaque.
 *
 * ## Deux ancrages, un seul jeu de rangs
 *
 * Les cinq zones se définissent en pourcentage d'une **référence**, et cette
 * référence dépend de ce que le profil porte ({@link HrZoneAnchor}) :
 *
 * | Zone | % de FC max | % de FC seuil (LTHR) | Lecture usuelle        |
 * |------|-------------|----------------------|------------------------|
 * | Z1   | < 60        | < 85                 | récupération           |
 * | Z2   | 60 – 70     | 85 – 90              | endurance fondamentale |
 * | Z3   | 70 – 80     | 90 – 95              | endurance active       |
 * | Z4   | 80 – 90     | 95 – 100             | seuil                  |
 * | Z5   | ≥ 90        | ≥ 100                | VMA / anaérobie        |
 *
 * Bornes inférieures incluses, supérieures exclues, dans les deux ancrages —
 * Friel publie la colonne de droite en entiers (« 85-89 », « 90-94 »… ), ce qui
 * désigne exactement les mêmes frontières.
 *
 * **Sans FC seuil, rien ne change** : l'ancrage en % de FC max reste exactement
 * celui d'avant — le modèle à cinq zones qu'appliquent par défaut les montres
 * grand public (Polar, Garmin) et que retiennent les plateformes d'analyse. Les
 * échantillons **sous 50 %** de FC max comptent en Z1 : ils correspondent aux
 * temps d'arrêt et de récupération, qui appartiennent bien à la séance — les
 * exclure ferait que la somme des zones ne vaudrait plus la durée enregistrée,
 * et l'athlète ne comprendrait pas où est passé son temps.
 *
 * ## L'échelle du seuil : Friel, ses sept zones ramenées à cinq
 *
 * Les bornes 85 / 90 / 95 / 100 % de LTHR sont celles de l'échelle course à pied
 * de Joe Friel (*Total Heart Rate Training*), le standard de praticien pour des
 * zones ancrées au seuil. Friel découpe le haut en trois sous-zones (5a
 * 100-102 %, 5b 103-106 %, 5c au-delà) ; elles sont ici **réunies en une seule
 * Z5**, parce que le projet ne manipule que cinq rangs — c'est le domaine de
 * `PlanStep.hrZone` (1 à 5) et le nombre de couleurs de la rampe du design
 * system. Aucune borne n'est déplacée : les quatre frontières basses sont celles
 * de Friel, au point de pourcentage près.
 *
 * ## Pourquoi le seuil est un meilleur ancrage que la FC max
 *
 * À pourcentage de FC max identique, la réponse métabolique varie fortement d'un
 * individu à l'autre (Scharhag-Rosenberger et al. 2010) : deux coureurs à 190 de
 * FC max dont les seuils sont à 165 et 178 ne courent pas le même effort à
 * 85 % de leur FC max. Le seuil, lui, est un repère métabolique individuel dont
 * la validité comme prédicteur de performance d'endurance est documentée (revue
 * Faude, Kindermann & Meyer 2009, *Sports Med*). Cf. `./lthr` pour la détection
 * et les niveaux de preuve.
 *
 * **Rien n'est stocké** : les zones se recalculent à chaque lecture depuis le
 * profil. Adopter une FC seuil relit donc tout l'historique dans le nouveau
 * cadre, sans qu'aucune ligne ne soit réécrite.
 */

import { cappedSampleDurationsS } from './series';

export type HrZoneNumber = 1 | 2 | 3 | 4 | 5;

export type ZoneTime = {
  zone: HrZoneNumber;
  timeS: number;
  /** Part de la durée totale, dans [0, 1]. */
  share: number;
};

/**
 * La référence sur laquelle les zones sont ancrées, et sa valeur en battements.
 *
 * Un objet, et pas deux nombres nus, parce que la question « sur quoi ces zones
 * sont-elles calées ? » se pose partout où elles s'affichent : la fiche ⓘ le
 * dit, la légende d'un histogramme le dit, et deux paramètres `maxHrBpm` /
 * `lthrBpm` traînés côte à côte auraient laissé chaque appelant redécider lequel
 * l'emporte. Ici, la décision est prise une fois — dans {@link hrZoneAnchor} —
 * et voyage avec la valeur.
 *
 * Sérialisable : il franchit la frontière client tel quel.
 */
export type HrZoneAnchor =
  | { readonly kind: 'lthr'; readonly bpm: number }
  | { readonly kind: 'max-hr'; readonly bpm: number };

/**
 * L'ancrage à utiliser pour ce profil, `null` quand aucune zone n'est
 * calculable.
 *
 * **La FC seuil l'emporte dès qu'elle existe** : c'est tout l'objet de son
 * adoption, et c'est la référence la plus individuelle des deux. Sans elle,
 * l'ancrage en % de FC max — le comportement d'avant, à la ligne près.
 *
 * Une valeur non finie ou négative n'est pas une référence : elle est ignorée
 * plutôt que propagée en frontières absurdes.
 */
export function hrZoneAnchor(
  maxHrBpm: number | null,
  lthrBpm: number | null,
): HrZoneAnchor | null {
  if (lthrBpm !== null && Number.isFinite(lthrBpm) && lthrBpm > 0) {
    return { kind: 'lthr', bpm: lthrBpm };
  }
  if (maxHrBpm !== null && Number.isFinite(maxHrBpm) && maxHrBpm > 0) {
    return { kind: 'max-hr', bpm: maxHrBpm };
  }
  return null;
}

const ZONES: readonly HrZoneNumber[] = [1, 2, 3, 4, 5];

/**
 * Les frontières basses de Z2, Z3, Z4 et Z5, en pourcentage de la référence.
 *
 * Exportées parce que l'affichage les cite (la fiche ⓘ, la légende des
 * histogrammes) : deux jeux de bornes qui divergeraient feraient mentir le
 * texte, exactement comme deux jeux de bornes feraient mentir la couleur.
 */
export const HR_ZONE_FLOORS_PERCENT = {
  'max-hr': [60, 70, 80, 90],
  lthr: [85, 90, 95, 100],
} as const satisfies Record<HrZoneAnchor['kind'], readonly [number, number, number, number]>;

/**
 * Zone d'un pourcentage de la référence. Bornes inférieures incluses ; tout ce
 * qui est sous la frontière de Z2 — plancher de 50 % du modèle classique en
 * % de FC max compris — tombe en Z1.
 */
function zoneOf(percentOfAnchor: number, kind: HrZoneAnchor['kind']): HrZoneNumber {
  const [z2, z3, z4, z5] = HR_ZONE_FLOORS_PERCENT[kind];
  if (percentOfAnchor >= z5) return 5;
  if (percentOfAnchor >= z4) return 4;
  if (percentOfAnchor >= z3) return 3;
  if (percentOfAnchor >= z2) return 2;
  return 1;
}

/**
 * Zone d'une fréquence cardiaque, aux mêmes bornes que {@link computeHrZones}.
 *
 * Exportée pour que l'affichage (colorer une tranche d'histogramme dans la rampe
 * des zones) lise les seuils **ici** au lieu de les redéclarer : deux jeux de
 * bornes qui divergent feraient mentir la couleur.
 *
 * `null` quand la zone n'est pas déterminable — aucun ancrage au profil, ancrage
 * absurde, mesure nulle ou négative : rien n'est deviné.
 */
export function hrZoneOf(bpm: number, anchor: HrZoneAnchor | null): HrZoneNumber | null {
  if (anchor === null || !Number.isFinite(anchor.bpm) || anchor.bpm <= 0) return null;
  if (!Number.isFinite(bpm) || bpm <= 0) return null;

  return zoneOf((bpm / anchor.bpm) * 100, anchor.kind);
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
 * zone vide, pas l'omettre), ou `[]` si rien n'est calculable : ancrage absurde,
 * séries vides, ou durée totale nulle (échantillon unique).
 */
export function computeHrZones(
  hr: readonly (number | null)[],
  time: readonly number[],
  anchor: HrZoneAnchor,
): ZoneTime[] {
  if (!Number.isFinite(anchor.bpm) || anchor.bpm <= 0) return [];

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

    const zone = zoneOf((beatsAt[index] / anchor.bpm) * 100, anchor.kind);
    timeInZone.set(zone, (timeInZone.get(zone) ?? 0) + duration);
    total += duration;
  }

  if (total <= 0) return [];

  return ZONES.map((zone) => {
    const timeS = timeInZone.get(zone) ?? 0;
    return { zone, timeS, share: timeS / total };
  });
}
