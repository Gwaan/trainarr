/**
 * La FC de repos observée : ce qu'on en retient, et quand ça vaut la peine d'en
 * proposer une au profil.
 *
 * Fonctions pures — ni base, ni réseau. Les mesures viennent de la montre
 * (`wellness_days`), l'application ne les produit pas ; ce module décide
 * seulement ce qu'on peut honnêtement en conclure.
 *
 * ## Pourquoi une médiane, et jamais une valeur isolée
 *
 * Une FC de repos change d'une nuit à l'autre pour des raisons qui n'ont rien à
 * voir avec la forme : un dîner tardif, un verre de vin, une chambre trop
 * chaude, une ceinture mal placée. Prendre la plus basse valeur observée — ce
 * que fait la proposition de FC **max**, où seul un dépassement est une
 * information — donnerait ici une valeur de nuit exceptionnelle, et le TRIMP de
 * Karvonen se calerait dessus pour toujours.
 *
 * La médiane des {@link RESTING_HR_WINDOW_DAYS} derniers jours est **résistante**
 * par construction : il faut que la moitié des nuits bougent pour qu'elle bouge.
 * C'est exactement la propriété qu'on veut d'une valeur qui va servir de
 * référence pendant des mois.
 *
 * ## Pourquoi elle se propose dans les deux sens
 *
 * Contrairement à la FC max, la FC de repos **baisse quand la forme monte** et
 * remonte quand elle redescend (ou avec l'âge). Une proposition qui n'irait que
 * dans un sens laisserait la moitié des dérives s'installer sans rien dire.
 */

/**
 * Fenêtre de la médiane : quatorze jours, aujourd'hui compris.
 *
 * Deux semaines, parce que c'est la plus courte fenêtre qui absorbe une mauvaise
 * nuit sans lisser une vraie évolution : une adaptation à l'entraînement se voit
 * en quelques semaines, pas en quelques jours. C'est aussi la fenêtre que le
 * relevé quotidien maintient à jour (`WELLNESS_WINDOW_DAYS`) — proposer sur une
 * période plus large que celle qu'on rafraîchit n'aurait pas de sens.
 */
export const RESTING_HR_WINDOW_DAYS = 14;

/**
 * Nombre minimal de nuits mesurées dans la fenêtre pour qu'une médiane vaille
 * quelque chose : cinq.
 *
 * Assez pour qu'une nuit aberrante soit minoritaire — la médiane de cinq valeurs
 * en écarte deux de chaque côté — et assez peu pour qu'un port irrégulier de la
 * montre (trois ou quatre nuits par semaine) ne prive jamais de proposition.
 */
export const RESTING_HR_MIN_SAMPLE = 5;

/**
 * Écart minimal avec la FC de repos du profil pour qu'une proposition ait lieu :
 * cinq battements.
 *
 * En dessous, on parle du bruit d'une mesure de montre, pas d'une évolution : la
 * réserve cardiaque bouge de quelques pour cent, et faire cliquer l'athlète pour
 * ça reviendrait à lui demander d'entretenir une valeur qu'elle n'a pas mesurée.
 * Cinq bpm sur une réserve typique (~130 bpm), c'est ~4 % de TRIMP — un écart qui
 * se voit sur une courbe de charge.
 */
export const RESTING_HR_SUGGESTION_DELTA_BPM = 5;

/**
 * Écart minimal avec la **dernière valeur refusée** pour reproposer : deux
 * battements.
 *
 * Le refus d'une FC de repos ne peut pas être un seuil directionnel comme celui
 * de la FC max : la valeur bouge dans les deux sens, et « tout ce qui est
 * au-dessous de 52 est écarté » enterrerait toutes les vraies baisses à venir.
 * On mémorise donc la valeur refusée, et la même — ou presque — ne revient plus.
 * Deux battements suffisent : c'est la plus petite variation qu'une médiane sur
 * deux semaines produit sans qu'il se soit rien passé.
 */
export const RESTING_HR_REPROPOSE_DELTA_BPM = 2;

/**
 * La médiane, arrondie au battement, d'une série de FC de repos.
 *
 * `null` sous {@link RESTING_HR_MIN_SAMPLE} valeurs : une médiane sur deux nuits
 * n'est pas une médiane, c'est une moyenne de deux nuits.
 *
 * L'arrondi ne concerne que le cas d'un nombre pair de mesures (moyenne des deux
 * valeurs centrales) : une FC de repos s'exprime en battements entiers, et le
 * champ du profil ne reçoit que des entiers.
 */
export function medianRestingHrBpm(values: readonly number[]): number | null {
  if (values.length < RESTING_HR_MIN_SAMPLE) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;

  return Math.round(median);
}

export type RestingHrSuggestionInput = {
  /** FC de repos mesurées dans la fenêtre, dans n'importe quel ordre. */
  values: readonly number[];
  /** FC de repos du profil, `null` si elle n'a jamais été renseignée. */
  profileBpm: number | null;
  /** FC max du profil, `null` si absente — plafond d'une valeur acceptable. */
  maxHrBpm: number | null;
  /** Dernière valeur écartée par l'athlète, `null` si aucune ne l'a été. */
  dismissedBpm: number | null;
  /** Bornes de saisie du profil : proposer hors bornes serait proposer un clic sans effet. */
  bounds: { min: number; max: number };
};

/**
 * La FC de repos à proposer, `null` quand il n'y a rien à proposer.
 *
 * Cinq conditions, toutes nécessaires :
 *
 * 1. la fenêtre porte assez de nuits mesurées (cf. {@link medianRestingHrBpm}) ;
 * 2. la médiane tient dans les bornes du profil ;
 * 3. elle reste **sous** la FC max du profil, s'il y en a une : une FC de repos
 *    supérieure ou égale rendrait la réserve cardiaque nulle ou négative, et le
 *    TRIMP de Karvonen sortirait des valeurs de signe inversé ;
 * 4. elle s'écarte d'au moins {@link RESTING_HR_SUGGESTION_DELTA_BPM} de la FC de
 *    repos du profil — **dans un sens ou dans l'autre** — ou le profil n'en porte
 *    pas encore, auquel cas la première médiane fiable est exactement ce que ce
 *    champ attend ;
 * 5. elle s'écarte d'au moins {@link RESTING_HR_REPROPOSE_DELTA_BPM} de la
 *    dernière valeur refusée, s'il y en a une.
 */
export function restingHrSuggestionBpm(input: RestingHrSuggestionInput): number | null {
  const median = medianRestingHrBpm(input.values);
  if (median === null) return null;

  if (median < input.bounds.min || median > input.bounds.max) return null;
  if (input.maxHrBpm !== null && median >= input.maxHrBpm) return null;

  if (
    input.profileBpm !== null &&
    Math.abs(median - input.profileBpm) < RESTING_HR_SUGGESTION_DELTA_BPM
  ) {
    return null;
  }

  if (
    input.dismissedBpm !== null &&
    Math.abs(median - input.dismissedBpm) < RESTING_HR_REPROPOSE_DELTA_BPM
  ) {
    return null;
  }

  return median;
}
