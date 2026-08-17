import { toCivilDate } from "@/lib/dates/civil";

import { formatRaceTimeSeconds } from "../../../_lib/race-time";

/**
 * Ce que le formulaire « Course officielle » affiche au départ.
 *
 * ## La règle, et c'est tout l'objet de ce module
 *
 * **La déclaration existante l'emporte sur la séance.** Un chrono officiel
 * corrigé à la main (temps de puce, distance homologuée) doit se relire tel
 * qu'il a été saisi ; le reprendre de la montre à chaque affichage effacerait
 * la correction sous les yeux de qui vient la vérifier. La séance ne sert donc
 * qu'à **pré-remplir la première fois**.
 *
 * Le nom fait exception à rien : `name` est facultatif en base, et une course
 * déclarée sans nom se relit avec un champ vide plutôt qu'avec le nom de la
 * séance — sinon « Course à pied dans l'après-midi » deviendrait un nom
 * d'épreuve au premier réenregistrement.
 */

export type RaceFormValues = {
  /** Jour civil `YYYY-MM-DD`, tel qu'un `<input type="date">` l'attend. */
  racedOn: string;
  /** Distance en kilomètres, virgule décimale française. */
  distanceKm: string;
  /** Chrono `mm:ss` ou `h:mm:ss`, la forme du masque de saisie. */
  time: string;
  name: string;
};

/** La séance, réduite à ce qui pré-remplit le formulaire. */
export type RaceSourceActivity = {
  startedAt: Date;
  distanceM: number;
  /**
   * Temps **écoulé** de la séance, en secondes — pas le temps de déplacement.
   *
   * Un chrono officiel est un temps de puce : il court du départ à l'arrivée,
   * pauses comprises. Pré-remplir depuis `movingTimeS` proposerait, sur une
   * séance enregistrée avec auto-pause, un chrono plus court que celui du
   * bulletin — et un pré-remplissage se valide souvent sans être relu, ce qui
   * tirerait le facteur correctif de la VO₂max vers le haut. Le temps écoulé
   * est le pré-remplissage honnête : au pire il est trop long, et l'écart se
   * voit.
   */
  elapsedTimeS: number;
};

/** La course déjà déclarée sur cette séance. */
export type DeclaredRace = {
  racedOn: string;
  distanceM: number;
  timeS: number;
  name: string | null;
};

/**
 * Distance en kilomètres, **au mètre**, virgule décimale — et sans décimales
 * inutiles : une course de 10 km s'affiche « 10 », pas « 10,000 ».
 *
 * Le mètre, et pas le centième de kilomètre, parce que c'est la précision à
 * laquelle la course est **stockée** (`validateRaceResult` arrondit la saisie au
 * mètre) : c'est la seule qui garantisse la promesse de l'en-tête — une valeur
 * saisie se relit telle qu'elle a été saisie. Arrondir à 10 m faisait dériver le
 * semi à chaque aller-retour dans le formulaire (21 097,5 m → « 21,1 » → 21 100
 * au réenregistrement) ; l'effet physio est négligeable, la promesse non.
 *
 * Le pré-remplissage depuis la séance y gagne un chiffre de bruit GPS — 10 432 m
 * s'affiche « 10,432 » et non « 10,43 ». C'est un champ fait pour être corrigé
 * par la mesure de l'organisateur : mieux vaut un chiffre de trop qu'une valeur
 * déclarée qui bouge toute seule.
 */
export function formatRaceDistanceKm(distanceM: number): string {
  const km = Math.round(distanceM) / 1_000;
  return String(km).replace(".", ",");
}

/** Les valeurs de départ du formulaire, cf. l'en-tête pour la règle de priorité. */
export function raceFormValues(
  activity: RaceSourceActivity,
  declared: DeclaredRace | null,
): RaceFormValues {
  if (declared !== null) {
    return {
      racedOn: declared.racedOn,
      distanceKm: formatRaceDistanceKm(declared.distanceM),
      time: formatRaceTimeSeconds(declared.timeS),
      name: declared.name ?? "",
    };
  }

  return {
    // Le jour **vécu** par l'athlète, pas celui de l'instant UTC stocké : une
    // course partie à 8 h du matin ne s'est pas courue la veille.
    racedOn: toCivilDate(activity.startedAt),
    distanceKm: formatRaceDistanceKm(activity.distanceM),
    // Le temps **écoulé** : un chrono officiel court du départ à l'arrivée, cf.
    // {@link RaceSourceActivity.elapsedTimeS}.
    time: formatRaceTimeSeconds(activity.elapsedTimeS),
    // Jamais le nom de la séance : « Course à pied dans l'après-midi » n'est pas
    // un nom d'épreuve, et il se figerait en base au premier enregistrement.
    name: "",
  };
}
