/**
 * Meilleurs efforts de la séance (« best efforts »).
 *
 * Méthode : celle des *best efforts* de Strava, reprise par Runalyze — pour une
 * liste de distances de référence, le **temps le plus court** mis à couvrir
 * cette distance sur n'importe quelle portion continue de la séance. Ce n'est
 * pas un découpage en tours : le meilleur 1 000 m d'une séance de fractionné
 * peut chevaucher deux répétitions.
 *
 * ## Le temps d'un record est du temps écoulé
 *
 * Contrairement aux splits et aux zones, qui comptent le temps *enregistré*
 * (auto-pauses neutralisées), le temps d'un meilleur effort est le temps **brut**
 * qui sépare ses deux bornes : c'est la convention Strava, et c'est la seule
 * honnête — s'arrêter trente secondes au milieu de son 1 000 m ne donne pas
 * droit à un record de 1 000 m. Si l'athlète s'est arrêté, la fenêtre glissante
 * trouvera de toute façon un meilleur candidat ailleurs.
 *
 * ## Interpolation aux bornes
 *
 * La borne de départ est interpolée linéairement entre les deux échantillons qui
 * l'encadrent : sans cela, on mesurerait le temps mis pour 1 012 m et non pour
 * 1 000 m, pénalité qui grandit avec l'espacement des points. C'est la même
 * interpolation, et la même justification, que le franchissement des bornes
 * kilométriques dans `computeSplits` : on ne fabrique pas une mesure, on lit une
 * grandeur dérivée de deux axes croissants et mesurés. La borne d'arrivée reste
 * posée sur un échantillon — l'erreur résiduelle est d'un pas d'échantillonnage,
 * contre plusieurs secondes sans interpolation du tout.
 *
 * ## Pourquoi la fenêtre ne balaie que les distances *mesurées*
 *
 * Reporter la dernière distance connue sur les points où le capteur est muet
 * (`null`) semble inoffensif — c'est ce que fait l'affichage — mais fausse un
 * record dans le sens le plus dangereux, celui du **trop rapide**. Un point
 * reporté annonce une distance qui est en réalité un minorant : à 4 m/s, un
 * canal `distance` écrit une fois toutes les 5 s produit un palier de cinq
 * points portant tous « 400 m », alors que le dernier vaut déjà 416 m. La
 * fenêtre glissante, qui cherche le départ le plus tardif possible, choisit le
 * dernier point du palier et annonce 400 m en 96 s pour une allure réellement
 * tenue à 100 s.
 *
 * Les points sans distance mesurée sont donc écartés du balayage : l'interpolation
 * entre deux mesures réelles fait déjà, et mieux, le travail qu'on attendait du
 * report. Un palier de distances **mesurées** identiques, lui, est conservé
 * intégralement — c'est un arrêt réel, et le point où l'athlète repart est une
 * borne de départ parfaitement légitime.
 *
 * Un cumul qui **recule** (saut GPS) est écarté pour la même raison, et non
 * ramené au maximum vu : le clamp fabriquerait précisément le palier menteur
 * décrit plus haut, et un 400 m couru en 100 s ressortait en 99 s. Un
 * échantillon aberrant se jette, il ne se rattrape pas.
 */

import { paceSecPerKm } from './pace';

export type BestSegment = {
  /** Distance de référence, en mètres (exactement, grâce à l'interpolation). */
  targetM: number;
  /** Temps écoulé, pauses comprises, entre les deux bornes du segment. */
  timeS: number;
  paceSecPerKm: number;
};

/**
 * Distances de référence : 400 m, 1 km, le mile (1 609,34 m), 5 km, 10 km et le
 * semi-marathon (21 097,5 m). Le marathon n'y figure pas — il ne se court pas à
 * l'entraînement, et le lire comme un « meilleur effort » d'une sortie longue
 * n'aurait pas de sens.
 */
export const BEST_SEGMENT_TARGETS_M: readonly number[] = [
  400, 1000, 1609.34, 5000, 10000, 21097.5,
];

/**
 * Meilleur temps sur chacune des distances de référence couvertes par la séance.
 *
 * - les cibles plus longues que la distance totale sont absentes du résultat,
 *   pas rendues à zéro : un 10 km n'existe pas dans une séance de 8 km ;
 * - la distance cumulée balayée est **non décroissante** : un recul du cumul est
 *   un saut GPS, pas un retour en arrière de l'athlète, et le laisser passer
 *   fabriquerait des fenêtres plus rapides que la réalité ;
 * - un point sans distance mesurée, ou sans instant exploitable, est écarté du
 *   balayage (cf. l'en-tête du module) ;
 * - ce qui précède la première mesure de distance n'appartient à aucun segment.
 *
 * Retourne `[]` si rien n'est calculable (moins de deux points, distance totale
 * plus courte que la plus petite cible).
 */
export function computeBestSegments(
  distance: readonly (number | null)[],
  time: readonly (number | null)[],
): BestSegment[] {
  const { marks, instants } = usableSamples(distance, time);
  const count = marks.length;
  if (count < 2) return [];

  const total = marks[count - 1] - marks[0];
  if (!(total > 0)) return [];

  const segments: BestSegment[] = [];
  for (const targetM of BEST_SEGMENT_TARGETS_M) {
    if (targetM > total) continue;

    const window = fastestWindow(marks, instants, targetM);
    if (window === null) continue;

    const timeS = window.toS - window.fromS;
    const pace = paceSecPerKm(targetM, timeS);
    if (pace === null) continue;

    segments.push({ targetM, timeS, paceSecPerKm: pace });
  }

  return segments;
}

/**
 * Sous-série des points où la distance **et** l'instant sont mesurés, cumul rendu
 * non décroissant.
 */
function usableSamples(
  distance: readonly (number | null)[],
  time: readonly (number | null)[],
): { marks: number[]; instants: number[] } {
  const marks: number[] = [];
  const instants: number[] = [];

  const count = Math.min(distance.length, time.length);

  for (let index = 0; index < count; index += 1) {
    const instant = time[index];
    const mark = distance[index];
    if (instant === null || !Number.isFinite(instant)) continue;
    if (mark === null || !Number.isFinite(mark)) continue;
    // Axe des temps non monotone : anomalie de fichier. L'échantillon qui
    // recule est ignoré plutôt que de produire une fenêtre de durée négative.
    if (instants.length > 0 && instant < instants[instants.length - 1]) continue;
    // Cumul de distance qui recule : saut GPS. L'échantillon est écarté, pas
    // ramené au maximum vu — cf. l'en-tête du module.
    if (marks.length > 0 && mark < marks[marks.length - 1]) continue;

    marks.push(mark);
    instants.push(instant);
  }

  return { marks, instants };
}

/**
 * La fenêtre la plus rapide couvrant `targetM` — ses deux instants —, ou `null`
 * s'il n'en existe aucune.
 *
 * C'est aussi l'**emplacement** d'un effort dans la séance, et c'est à ce titre
 * que {@link fastestSegmentWindow} l'expose : un fichier FIT ne porte aucun
 * marqueur « ici commence le bloc », et la portion la plus rapide de la longueur
 * prescrite est le seul repère honnête dont on dispose.
 *
 * Fenêtre glissante à deux pointeurs : pour chaque point d'arrivée, on avance le
 * point de départ tant que la fenêtre reste assez longue. Les deux pointeurs
 * étant monotones (la distance cumulée est non décroissante), un seul balayage
 * suffit par distance de référence.
 */
function fastestWindow(
  marks: readonly number[],
  instants: readonly number[],
  targetM: number,
): { fromS: number; toS: number } | null {
  let best: { fromS: number; toS: number } | null = null;
  let start = 0;

  for (let end = 1; end < marks.length; end += 1) {
    while (start + 1 < end && marks[end] - marks[start + 1] >= targetM) start += 1;
    if (marks[end] - marks[start] < targetM) continue;

    /*
     * Le départ exact du segment est au cumul `marks[end] - targetM`, qui tombe
     * entre `start` et `start + 1` : par maximalité de `start`, la distance en
     * `start + 1` dépasse déjà ce cumul.
     */
    const wanted = marks[end] - targetM;
    const span = marks[start + 1] - marks[start];
    const startTimeS =
      span > 0
        ? instants[start] +
          ((wanted - marks[start]) / span) * (instants[start + 1] - instants[start])
        : instants[start];

    const timeS = instants[end] - startTimeS;
    if (timeS > 0 && (best === null || timeS < best.toS - best.fromS)) {
      best = { fromS: startTimeS, toS: instants[end] };
    }
  }

  return best;
}

/**
 * L'emplacement, dans la séance, de la portion la plus rapide de `targetM`
 * mètres — `null` quand la séance n'en contient pas.
 *
 * Même balayage et mêmes règles de propreté que {@link computeBestSegments}
 * (points sans distance ou sans instant écartés, cumul non décroissant, borne de
 * départ interpolée) : c'est littéralement la même fenêtre, rendue en instants
 * au lieu d'un chrono.
 *
 * Ce que cette fenêtre **n'est pas** : la preuve que l'athlète y a couru le bloc
 * prescrit. Rien dans un fichier FIT ne le dit. Sur une séance de seuil courue
 * comme prescrit, la portion la plus rapide de la longueur du bloc **est** une
 * répétition — toute fenêtre décalée mordrait sur l'échauffement ou sur une
 * récupération, donc serait plus lente. Sur une séance courue autrement, ce
 * n'est qu'une portion rapide, et c'est l'appelant qui doit dire ce qu'il en
 * accepte.
 */
export function fastestSegmentWindow(
  distance: readonly (number | null)[],
  time: readonly (number | null)[],
  targetM: number,
): { fromS: number; toS: number } | null {
  if (!Number.isFinite(targetM) || targetM <= 0) return null;

  const { marks, instants } = usableSamples(distance, time);
  if (marks.length < 2) return null;

  return fastestWindow(marks, instants, targetM);
}
