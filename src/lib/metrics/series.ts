/**
 * Outils communs aux calculs qui parcourent une série temporelle échantillonnée.
 *
 * Aucune formule physiologique ici : uniquement la mécanique d'un axe des temps
 * **irrégulier**. C'est le cas nominal, pas une exception : l'enregistrement
 * « intelligent » d'une Apple Watch espace ses points selon l'activité, et un
 * fichier FIT peut sauter plusieurs secondes (tunnel, pause, perte de capteur).
 * Tout ce qui est « moyenne sur la séance » doit donc pondérer par le temps
 * réellement représenté par chaque échantillon, jamais compter les points.
 *
 * Corollaire, appris à nos dépens : un axe irrégulier n'est pas seulement
 * irrégulier, il est parfois **troué** (auto-pause). Un trou n'est pas un
 * échantillon très long — c'est du temps que personne n'a mesuré. D'où le
 * plafond de {@link cappedSampleDurationsS}, socle commun du lissage d'allure,
 * des zones cardio et des splits.
 */

/**
 * Multiple du pas médian au-delà duquel un intervalle n'est plus un
 * échantillonnage irrégulier mais un **trou**.
 *
 * Trois pas laisse passer les irrégularités normales d'un enregistrement
 * « intelligent » (une montre qui espace ses points en allure stable double ou
 * triple son pas) et coupe net sur une pause : un trou de 5 min dans une série
 * à 1 Hz n'est pas un échantillon de 5 min, c'est du temps que personne n'a
 * mesuré.
 */
const GAP_FACTOR = 3;

/**
 * Plancher du plafond : une seconde. En deçà, le plafond serait plus fin que la
 * résolution d'un fichier FIT et rognerait des durées légitimes.
 */
const MIN_CAP_S = 1;

/** Pas médian des intervalles strictement positifs. 0 s'il n'y en a aucun. */
function medianStepS(time: readonly number[]): number {
  const steps: number[] = [];
  for (let index = 1; index < time.length; index += 1) {
    const step = time[index] - time[index - 1];
    if (Number.isFinite(step) && step > 0) steps.push(step);
  }
  if (steps.length === 0) return 0;

  steps.sort((a, b) => a - b);
  const middle = steps.length >> 1;
  return steps.length % 2 === 1 ? steps[middle] : (steps[middle - 1] + steps[middle]) / 2;
}

/**
 * Durée maximale (s) qu'un échantillon peut représenter : `3 × pas médian`,
 * jamais moins d'une seconde.
 *
 * Le plafond est **relatif à la série** et non absolu : un enregistrement à
 * 1 Hz et un enregistrement à 10 s n'ont pas la même notion de « trou ».
 */
export function sampleDurationCapS(time: readonly number[]): number {
  return Math.max(MIN_CAP_S, GAP_FACTOR * medianStepS(time));
}

/**
 * Durée (s) représentée par chaque échantillon — règle du point milieu,
 * **plafonnée** par {@link sampleDurationCapS}.
 *
 * Chaque point porte la moitié de l'intervalle qui le sépare de son voisin de
 * gauche et la moitié de celui qui le sépare de son voisin de droite ; les deux
 * extrémités ne portent que leur demi-intervalle intérieur.
 *
 * **Pourquoi plafonner.** La règle du point milieu seule fait somme exacte du
 * temps *écoulé* : un trou de 5 min (auto-pause, tunnel, montre arrêtée) est
 * réparti par moitié sur les deux échantillons qui l'encadrent, qui pèsent alors
 * 150 s chacun. C'est faux dans les trois usages : une fenêtre de lissage de
 * 15 s se retrouve dominée par un point unique, 20 min de pause s'affichent
 * comme du temps en zone, et un kilomètre couru en 4:10 s'annonce en 9:09.
 * Au-delà du plafond, le temps du trou **n'est attribué à personne** — la somme
 * des durées approche donc le temps *enregistré*, pas le temps écoulé. C'est
 * exactement ce que les tuiles de la séance appellent « durée » (moving time).
 *
 * Un intervalle négatif ou non fini (axe des temps non monotone — anomalie de
 * fichier) donne une durée de 0 : l'échantillon ne pèse rien plutôt que de
 * retrancher du temps. Une série d'un seul point vaut 0 : un instant n'a pas de
 * durée.
 *
 * Précondition : `time` est croissant. Le parseur FIT le garantit.
 */
export function cappedSampleDurationsS(time: readonly number[]): number[] {
  const count = time.length;
  if (count === 0) return [];
  if (count === 1) return [0];

  const cap = sampleDurationCapS(time);

  const durations: number[] = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    const previous = time[index === 0 ? 0 : index - 1];
    const next = time[index === count - 1 ? count - 1 : index + 1];
    const span = (next - previous) / 2;
    durations[index] = Number.isFinite(span) && span > 0 ? Math.min(span, cap) : 0;
  }
  return durations;
}

/**
 * Moyenne pondérée par la durée des échantillons, `null` si rien d'exploitable.
 *
 * Repli sur la moyenne arithmétique quand le poids total est nul (horodatages
 * dupliqués) mais que des valeurs existent : mieux vaut une moyenne non pondérée
 * qu'un « non calculable » sur une donnée présente. Les valeurs non finies, et
 * les `null` des canaux clairsemés (le capteur n'a rien dit à cet index), sont
 * ignorées — la moyenne porte sur les seuls points mesurés.
 */
export function weightedMean(
  values: readonly (number | null)[],
  durations: readonly number[],
  from: number,
  to: number,
): number | null {
  let weightedSum = 0;
  let totalWeight = 0;
  let plainSum = 0;
  let count = 0;

  for (let index = from; index < to; index += 1) {
    const value = values[index];
    if (value === null || !Number.isFinite(value)) continue;

    plainSum += value;
    count += 1;

    const weight = durations[index];
    if (weight > 0) {
      weightedSum += value * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight > 0) return weightedSum / totalWeight;
  return count > 0 ? plainSum / count : null;
}
