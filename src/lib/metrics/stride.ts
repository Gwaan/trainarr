/**
 * Longueur de foulée.
 *
 * Source : définition commune à Garmin (« stride length », Connect / Running
 * Dynamics) et à Runalyze (« longueur de foulée ») — la distance parcourue par
 * **un pas**, soit la distance parcourue en une minute divisée par le nombre de
 * pas effectués dans cette minute :
 *
 * ```
 * longueur (m) = 60 × vitesse (m/s) / cadence (pas/min)
 * ```
 *
 * Ce n'est pas une formule empirique mais une définition : deux grandeurs
 * mesurées, un quotient. Rien n'est estimé ici, d'où l'absence de tout repli sur
 * une valeur « typique » quand une entrée manque.
 *
 * **Attention à l'unité de cadence.** Le calcul attend des **pas** par minute
 * (les deux jambes, ≈ 160-180 en course à pied), pas la cadence par jambe
 * (≈ 80-90) que certains fichiers FIT écrivent dans le champ `cadence`.
 * L'alignement de l'unité appartient au producteur du stream, pas à ce module :
 * il n'a aucun moyen de distinguer une cadence par jambe d'une cadence totale
 * très basse (marche), et deviner reviendrait à doubler une valeur réelle.
 */

const SECONDS_PER_MINUTE = 60;

/**
 * Longueur d'un pas, en mètres.
 *
 * `null` — jamais une approximation — si la vitesse ou la cadence manque, n'est
 * pas finie, ou est nulle/négative : à l'arrêt il n'y a ni pas ni foulée, et une
 * cadence nulle ferait diverger le quotient.
 *
 * Repère : 3,33 m/s (3:00/km) à 170 pas/min ≈ 1,18 m.
 */
export function strideLengthM(speedMps: number | null, cadenceSpm: number | null): number | null {
  if (speedMps === null || !Number.isFinite(speedMps) || speedMps <= 0) return null;
  if (cadenceSpm === null || !Number.isFinite(cadenceSpm) || cadenceSpm <= 0) return null;

  return (SECONDS_PER_MINUTE * speedMps) / cadenceSpm;
}

/**
 * Longueur de foulée point par point, alignée index par index sur les deux
 * canaux d'entrée.
 *
 * Les streams FIT sont **clairsemés** : `velocity` et `cadence` portent `null`
 * là où leur capteur n'a rien dit, et les deux ne parlent pas forcément aux
 * mêmes instants. Un point dont l'un des deux canaux est muet vaut `null` — on
 * ne reporte pas la dernière cadence connue sur une vitesse fraîche, ce qui
 * fabriquerait une foulée que personne n'a mesurée.
 *
 * La série rendue a la longueur du **plus court** des deux canaux, convention
 * déjà retenue par `computeSplits` et `computeHrZones` : au-delà, les index d'un
 * canal n'ont plus de correspondant dans l'autre, et les aligner au hasard
 * serait pire qu'une série tronquée.
 */
export function strideSeries(
  velocity: readonly (number | null)[],
  cadence: readonly (number | null)[],
): (number | null)[] {
  const count = Math.min(velocity.length, cadence.length);

  const strides: (number | null)[] = new Array<number | null>(count);
  for (let index = 0; index < count; index += 1) {
    strides[index] = strideLengthM(velocity[index], cadence[index]);
  }
  return strides;
}
