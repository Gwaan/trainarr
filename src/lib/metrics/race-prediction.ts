/**
 * Chronos prévus — le **sens inverse** du VDOT.
 *
 * Source : Daniels J & Gilbert J, *Oxygen Power: Performance Tables for
 * Distance Runners*, 1979 — les deux mêmes régressions que `./vdot`, prises à
 * l'envers. `estimateVdot` répond « quel VDOT ce chrono implique-t-il ? » ; ce
 * module répond « quel chrono ce VDOT implique-t-il ? ».
 *
 * ## Pourquoi une bissection et pas une formule
 *
 * Le VDOT d'une performance s'écrit, avec D en mètres et t en minutes :
 *
 * ```
 *   VDOT = oxygenCostAtVelocity(D / t) / sustainableFractionOverDuration(t)
 * ```
 *
 * L'inconnue t apparaît **des deux côtés** de la fraction : dans la vitesse
 * (numérateur) et dans la fraction soutenable (dénominateur), celle-ci étant une
 * somme de deux exponentielles. Il n'existe pas de forme close ; on résout donc
 * numériquement.
 *
 * ## Pourquoi la bissection est *correcte* ici : la monotonie
 *
 * Notons `f(t) = N(t) / P(t)` le membre de droite ci-dessus, avec `v = D/t` :
 *
 *  - `N(t) = -4.6 + 0.182258·v + 0.000104·v²` — coût en oxygène ;
 *  - `P(t) = 0.8 + a·e^(−αt) + b·e^(−βt)` — fraction soutenable, avec
 *    `a = 0.1894393`, `α = 0.012778`, `b = 0.2989558`, `β = 0.1932605`.
 *
 * Les deux décroissent avec t (courir plus longtemps, c'est courir moins vite,
 * et tenir un pourcentage plus faible de sa VO2max). **Attention** : un quotient
 * de deux fonctions décroissantes n'est pas décroissant en général — c'est le
 * taux de décroissance *relatif* qui tranche. `f` décroît si et seulement si
 * `|N'/N| > |P'/P|`. Or :
 *
 *  - `|N'/N| = (1/t)·(0.182258·v + 0.000208·v²) / (−4.6 + 0.182258·v + 0.000104·v²)`
 *    et ce quotient est **≥ 1** dès que `N > 0`, puisque son numérateur moins son
 *    dénominateur vaut `0.000104·v² + 4.6 > 0`. Donc `|N'/N| ≥ 1/t` exactement.
 *  - `|P'/P| = (aα·e^(−αt) + bβ·e^(−βt)) / P ≤ (aα + bβ) / 0.8 ≈ 0.0753 min⁻¹`,
 *    puisque `P ≥ 0.8`.
 *
 * Pour `t ≤ 13 min`, `1/t ≥ 0.077 > 0.0753` : c'est réglé. Au-delà, la borne sur
 * `|P'/P|` s'effondre exponentiellement (0,008 min⁻¹ dès 13 min, 5·10⁻⁶ min⁻¹ à
 * 8 h) là où `1/t` ne décroît qu'en `1/t` — l'écart ne fait que se creuser. `f`
 * est donc **strictement décroissante** sur tout l'intervalle de recherche, ce
 * qui garantit l'unicité de la racine et la convergence de la bissection, sans
 * dérivée à calculer et sans risque de divergence (contrairement à Newton, dont
 * rien ne bornerait le pas sur une fonction aussi raide aux temps courts).
 *
 * La condition `N > 0` de la première borne ne restreint rien : `N ≤ 0` demande
 * `v < 25 m/min` (40 min/km), où `f` est négative donc très loin sous la borne
 * basse de VDOT plausible — aucune racine ne s'y cache.
 *
 * ## Ce que ces chronos valent — lire {@link PredictionConfidence}
 *
 * `./vdot` le documente déjà : la régression de Daniels & Gilbert est ajustée
 * sur des efforts de **15 à 50 minutes**. Elle ne connaît ni l'épuisement du
 * glycogène, ni le mur, ni la thermorégulation, ni la casse musculaire d'une
 * course longue. Une prédiction marathon issue d'un VDOT de 5 km est donc
 * **structurellement optimiste** : ce n'est pas une mesure, c'est une
 * extrapolation, et l'écran doit le dire. C'est tout l'objet de
 * {@link predictionConfidence}, qui accompagne chaque chrono prévu du niveau de
 * confiance que sa durée mérite.
 *
 * Ce niveau ne juge que le **côté prédiction**. Le côté ancre — un VDOT tiré
 * d'un marathon mal géré sous-estime le coureur — relève de `vdotFromRace`, qui
 * le documente de son côté.
 */

import {
  MAX_PLAUSIBLE_VO2MAX,
  MIN_EFFORT_DISTANCE_M,
  MIN_EFFORT_DURATION_MIN,
  MIN_PLAUSIBLE_VO2MAX,
  REFERENCE_DISTANCES,
  oxygenCostAtVelocity,
  sustainableFractionOverDuration,
  type ReferenceDistance,
} from './vdot';

/* -------------------------------------------------------------------------- */
/*  Résolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Borne basse de l'intervalle de recherche, en secondes : le plancher de durée
 * du modèle lui-même (`MIN_EFFORT_DURATION_MIN`). Ce n'est pas un choix de
 * commodité — sous 4 minutes, la filière anaérobie domine et `estimateVdot`
 * refuse déjà l'effort. Le sens inverse **doit refuser de produire ce que le
 * sens direct refuserait de lire** : une racine sous ce plancher ressort donc
 * « non encadrée », donc `null`.
 */
const MIN_PREDICTED_TIME_S = MIN_EFFORT_DURATION_MIN * 60;

/**
 * Borne haute, en secondes : 8 heures. Elle ne tronque aucune réponse plausible
 * sur les distances prédites — à 8 h, le VDOT impliqué vaut 15,3 sur marathon et
 * 4,5 sur semi, sous la borne basse de VDOT plausible (20). Autrement dit,
 * toute racine cherchée pour un VDOT admissible tombe strictement à l'intérieur.
 * Sur une distance beaucoup plus longue (un 100 km), la borne mordrait — et la
 * fonction rendrait `null` plutôt qu'un chrono inventé, ce qui est le
 * comportement voulu : ce modèle ne décrit pas l'ultra.
 */
const MAX_PREDICTED_TIME_S = 8 * 3600;

/**
 * Largeur d'intervalle en deçà de laquelle la bissection s'arrête, en secondes.
 *
 * Le milliardième de seconde est très au-delà du besoin (la sortie est un
 * chrono, affiché à la seconde), et c'est délibéré : diviser un intervalle par
 * deux ne coûte rien, et une racine exacte à la précision du double rend le test
 * d'aller-retour VDOT → chrono → VDOT concluant sur le **modèle** plutôt que sur
 * la tolérance du solveur.
 */
const TOLERANCE_S = 1e-9;

/**
 * Garde-fou de terminaison. Partant d'un intervalle de 28 560 s, atteindre
 * {@link TOLERANCE_S} demande ⌈log₂(28560 / 10⁻⁹)⌉ = 45 divisions ; 64 laisse de
 * la marge tout en garantissant que la boucle se termine quoi qu'il arrive
 * (au-delà, l'intervalle stagnerait de toute façon sur l'ulp du double).
 */
const MAX_ITERATIONS = 64;

/**
 * VDOT impliqué par « `distanceM` mètres en `timeS` secondes ». C'est
 * exactement le calcul d'`estimateVdot`, **sans ses garde-fous** : ici il sert
 * de fonction à annuler, on l'évalue donc aussi hors du domaine plausible.
 */
function impliedVdot(distanceM: number, timeS: number): number {
  const durationMin = timeS / 60;

  return (
    oxygenCostAtVelocity(distanceM / durationMin) /
    sustainableFractionOverDuration(durationMin)
  );
}

/**
 * Temps prévu, en secondes, pour `distanceM` à un `vdot` donné. **Non arrondi** :
 * l'arrondi d'affichage appartient à l'écran, et un chrono arrondi ici casserait
 * l'aller-retour avec `estimateVdot`.
 *
 * Renvoie `null` — jamais une approximation — quand :
 *  - `vdot` n'est pas fini ou sort de
 *    [`MIN_PLAUSIBLE_VO2MAX`, `MAX_PLAUSIBLE_VO2MAX`] ;
 *  - `distanceM` n'est pas fini ou est plus court que `MIN_EFFORT_DISTANCE_M`,
 *    sous lequel le modèle ne décrit plus une course à pied aérobie ;
 *  - la racine n'est pas encadrée par
 *    [{@link MIN_PREDICTED_TIME_S}, {@link MAX_PREDICTED_TIME_S}] — chrono qui
 *    tomberait sous les 4 minutes du modèle, ou au-delà de 8 heures.
 */
export function predictedRaceTimeS(vdot: number, distanceM: number): number | null {
  if (!Number.isFinite(vdot)) return null;
  if (vdot < MIN_PLAUSIBLE_VO2MAX || vdot > MAX_PLAUSIBLE_VO2MAX) return null;
  if (!Number.isFinite(distanceM)) return null;
  if (distanceM < MIN_EFFORT_DISTANCE_M) return null;

  let low = MIN_PREDICTED_TIME_S;
  let high = MAX_PREDICTED_TIME_S;

  /*
   * `impliedVdot` décroît strictement en temps (cf. l'en-tête) : la racine est
   * encadrée si et seulement si le VDOT cherché est strictement compris entre
   * les valeurs aux deux bornes. Les tests sont écrits en « non (…) » pour que
   * des bornes non finies retombent aussi sur `null`.
   */
  if (!(impliedVdot(distanceM, low) > vdot)) return null;
  if (!(impliedVdot(distanceM, high) < vdot)) return null;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    if (high - low < TOLERANCE_S) break;

    const middle = (low + high) / 2;
    // Trop rapide pour ce VDOT : la racine est au-delà du milieu.
    if (impliedVdot(distanceM, middle) > vdot) low = middle;
    else high = middle;
  }

  return (low + high) / 2;
}

/* -------------------------------------------------------------------------- */
/*  Domaine de fiabilité                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Fenêtre de durée sur laquelle Daniels donne sa régression pour la plus juste,
 * en minutes (cf. `vdotFromRace`, section « Domaine de fiabilité »). Un 5 km et
 * un 10 km y tombent pour la quasi-totalité des niveaux ; un marathon, jamais.
 */
export const CALIBRATED_WINDOW_MIN = { from: 15, to: 50 } as const;

/**
 * Facteur au-delà duquel une prédiction cesse d'être une extrapolation
 * raisonnable pour devenir une conjecture. Retenu à 2 — un chrono de plus de
 * 1 h 40, soit le double de la borne haute calibrée, dépend davantage du
 * ravitaillement, de la chaleur et de la casse musculaire que de la VO2max, trois
 * facteurs dont le modèle ne sait rien.
 *
 * Le facteur joue symétriquement en durée relative (donc aussi sous 7 min 30),
 * par cohérence plutôt que par nécessité : sur les distances prédites, avec un
 * VDOT plafonné à 90, la prédiction la plus rapide possible est un 5 km en
 * 12 min — le seuil bas est hors d'atteinte. Il ne sert que si un appelant
 * interroge une distance plus courte, et il a alors raison de crier.
 */
export const SPECULATIVE_FACTOR = 2;

/**
 * Ce qu'un chrono prévu vaut, selon que sa durée tombe ou non dans la fenêtre où
 * la régression a été ajustée :
 *
 *  - `calibrated` — durée dans {@link CALIBRATED_WINDOW_MIN}. La prédiction est
 *    du même ordre de fiabilité que la table publiée elle-même ;
 *  - `extrapolated` — hors fenêtre, mais à moins d'un facteur
 *    {@link SPECULATIVE_FACTOR}. Le modèle est prolongé au-delà de ce qu'il a
 *    ajusté : l'ordre de grandeur tient, pas la minute ;
 *  - `speculative` — au-delà. Cas de **toute** prédiction marathon, à tout
 *    niveau : elle ignore le mur et la thermorégulation, et lit donc trop vite.
 *    À présenter comme une projection, jamais comme un objectif.
 */
export type PredictionConfidence = 'calibrated' | 'extrapolated' | 'speculative';

/**
 * Niveau de confiance d'un chrono prévu de `timeS` secondes.
 *
 * Une durée qui n'est pas un chrono (non finie, nulle, négative) rend
 * `speculative` : elle n'est certainement pas dans la fenêtre de calibration, et
 * le niveau le plus prudent est le seul qui ne mente pas.
 */
export function predictionConfidence(timeS: number): PredictionConfidence {
  if (!Number.isFinite(timeS) || timeS <= 0) return 'speculative';

  const durationMin = timeS / 60;

  if (durationMin >= CALIBRATED_WINDOW_MIN.from && durationMin <= CALIBRATED_WINDOW_MIN.to) {
    return 'calibrated';
  }
  if (
    durationMin >= CALIBRATED_WINDOW_MIN.from / SPECULATIVE_FACTOR &&
    durationMin <= CALIBRATED_WINDOW_MIN.to * SPECULATIVE_FACTOR
  ) {
    return 'extrapolated';
  }

  return 'speculative';
}

/* -------------------------------------------------------------------------- */
/*  Table de prédictions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Distances prédites, dans l'ordre d'affichage — les quatre distances de route
 * de `REFERENCE_DISTANCES`, dont les mètres sont repris de là plutôt que
 * recopiés (le semi vaut 21 097,5 m, pas 21 100).
 *
 * **Le 1 500 m et le mile n'y sont pas**, alors que `BEST_SEGMENT_TARGETS_M` les
 * porte. Ce n'est pas un oubli, c'est le verdict de l'échelle de confiance
 * ci-dessus appliquée à ces deux distances :
 *
 *  - dès VDOT 35, le 1 500 m prédit passe sous 7 min 30, donc `speculative` ;
 *  - au-dessus de VDOT 70, il passe sous le plancher de 4 min du modèle et la
 *    prédiction s'effondre en `null` ;
 *  - en dessous de VDOT 35, il ne remonte qu'à `extrapolated`, en annonçant un
 *    1 500 m de plus de sept minutes et demie — ce qui n'est pas meilleur signe.
 *
 * Pour tout coureur entraîné, la colonne serait donc une conjecture ou un tiret.
 * La raison de fond : ces deux distances se courent sur une part anaérobie que
 * Daniels & Gilbert ne modélisent pas. Un meilleur effort *mesuré* sur 1 500 m
 * reste, lui, parfaitement légitime — c'est une mesure, pas une projection.
 */
export const PREDICTED_DISTANCES: readonly ReferenceDistance[] = [
  '5k',
  '10k',
  'half',
  'marathon',
];

export type RacePrediction = {
  distance: ReferenceDistance;
  distanceM: number;
  /** Chrono prévu en secondes, non arrondi. */
  timeS: number;
  confidence: PredictionConfidence;
};

/**
 * Chronos prévus sur les quatre {@link PREDICTED_DISTANCES}, chacun accompagné
 * de ce qu'il vaut. Renvoie `[]` si le `vdot` n'est pas exploitable ; une
 * distance dont la prédiction n'est pas encadrée est simplement absente du
 * tableau — jamais rendue à zéro.
 */
export function predictedRaces(vdot: number): RacePrediction[] {
  const predictions: RacePrediction[] = [];

  for (const distance of PREDICTED_DISTANCES) {
    const distanceM = REFERENCE_DISTANCES[distance];
    const timeS = predictedRaceTimeS(vdot, distanceM);
    if (timeS === null) continue;

    predictions.push({
      distance,
      distanceM,
      timeS,
      confidence: predictionConfidence(timeS),
    });
  }

  return predictions;
}
