/**
 * Vitesse dérivée de la distance cumulée.
 *
 * ## Pourquoi elle existe
 *
 * Tous les appareils n'écrivent pas de champ `speed` dans leurs messages
 * `record` : les fichiers FIT produits depuis une Apple Watch, par exemple,
 * portent `distance` et `timestamp` mais aucune vitesse. Sans ce module, la
 * page de séance n'affichait aucune courbe d'allure alors que la donnée est là,
 * à un quotient près.
 *
 * ## Ce n'est pas une invention, c'est une définition
 *
 * `v = Δd / Δt` entre deux mesures réelles de distance et deux horodatages
 * réels. Aucune valeur n'est supposée, aucun trou n'est comblé : là où la
 * distance n'est pas mesurée, la vitesse dérivée reste `null`. La règle du
 * projet — ne jamais approximer une métrique physio — vise les grandeurs qu'on
 * ne peut pas calculer (VO₂max sans FC, TRIMP sans FC de repos) ; elle
 * n'interdit pas une division dont les deux termes sont mesurés.
 *
 * ## Où elle s'applique
 *
 * **Jamais dans le parseur** : le fichier ne contient pas ce canal, la table
 * `activity_streams` ne doit donc pas prétendre le contenir. La dérivation est
 * un calcul d'affichage, fait à la lecture par le DAL — ce qui la rend aussi
 * rétroactive sur tout l'historique déjà importé.
 *
 * Le résultat entre ensuite dans le lissage habituel (`smoothPace`), qui absorbe
 * le bruit du quotient.
 *
 * ## Un trou n'est pas un intervalle
 *
 * Chaque valeur est la vitesse **moyenne** de l'intervalle qui précède le point.
 * Sur une auto-pause de 5 min pendant laquelle le GPS a dérivé de 5 m, cette
 * moyenne vaut 0,017 m/s — du temps que personne n'a couru, présenté comme une
 * allure. Elle entre alors dans la fenêtre de lissage et fausse une quinzaine de
 * secondes d'allure autour de chaque reprise (le plancher de `smoothPace`
 * s'applique à la moyenne de la fenêtre, pas à l'échantillon : il ne protège
 * de rien ici).
 *
 * D'où le plafond, même philosophie que `cappedSampleDurationsS` : au-delà de
 * {@link sampleDurationCapS}, l'intervalle n'est plus un échantillonnage
 * clairsemé mais un trou, et un trou ne porte pas de vitesse.
 */

import { sampleDurationCapS } from './series';

/**
 * Vitesse instantanée en m/s dérivée d'un cumul de distance, alignée index par
 * index sur `distance`.
 *
 * - le **premier** point mesuré vaut `null` : il n'a pas de prédécesseur, donc
 *   pas d'intervalle sur lequel calculer une vitesse ;
 * - les points sans distance mesurée valent `null` ;
 * - un intervalle non strictement croissant en temps, ou dont la distance
 *   recule (remise à zéro, saut GPS), vaut `null` plutôt qu'une vitesse nulle ou
 *   négative qui se lirait comme un arrêt ;
 * - un intervalle plus long que le plafond de trou vaut `null` : le point de
 *   reprise après une auto-pause n'hérite pas de la pause.
 *
 * Le plafond est calculé sur les seuls instants où la **distance** est mesurée,
 * pas sur l'axe complet : c'est la cadence de ce canal qui définit son trou. Une
 * distance écrite un point sur cinq sur un axe à 1 Hz est clairsemée, pas trouée.
 */
export function deriveVelocity(
  distance: readonly (number | null)[],
  time: readonly number[],
): (number | null)[] {
  const count = Math.min(distance.length, time.length);
  const velocity: (number | null)[] = new Array<number | null>(distance.length).fill(null);

  const measuredInstants: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (isMeasured(distance[index], time[index])) measuredInstants.push(time[index]);
  }
  const gapCapS = sampleDurationCapS(measuredInstants);

  let previous: { mark: number; instant: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const mark = distance[index];
    const instant = time[index];
    if (!isMeasured(mark, instant)) continue;

    if (previous !== null) {
      const elapsed = instant - previous.instant;
      const covered = mark - previous.mark;
      if (elapsed > 0 && elapsed <= gapCapS && covered >= 0) velocity[index] = covered / elapsed;
    }
    // `previous` avance même sur un trou : l'intervalle suivant part bien de la
    // dernière mesure connue.
    previous = { mark, instant };
  }

  return velocity;
}

/** Une mesure de distance n'existe que si son instant est lui aussi exploitable. */
function isMeasured(mark: number | null, instant: number): mark is number {
  return mark !== null && Number.isFinite(mark) && Number.isFinite(instant);
}
