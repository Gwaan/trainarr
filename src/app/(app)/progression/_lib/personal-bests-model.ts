/**
 * Tableau des records personnels : le modèle que le panneau affiche —
 * fonctions pures, testées.
 *
 * Rien n'est recalculé ici : le DAL rend déjà le meilleur temps de tous les
 * temps par distance, sa date et la séance qui le porte. Ce module ne fait que
 * mettre ces valeurs en français et fabriquer le lien vers la séance — c'est
 * tout l'intérêt d'avoir gardé l'identifiant.
 */

import type { PersonalBestDto } from "@/data/personal-bests";

import { distanceTargetLabel } from "../../_lib/distance-labels";
import { formatCivilFullDate, formatClock, formatPace } from "../../_lib/format";

export type PersonalBestRow = {
  /** Clé de rendu : une cible n'a qu'un record. */
  key: number;
  /** « 5 km », « 1 mile »… */
  distance: string;
  /** Chrono du record, ex. `20:48`. */
  time: string;
  pace: string;
  /** Jour du record en toutes lettres, `null` si la date stockée n'en est pas une. */
  day: string | null;
  /** La séance qui porte le record. */
  href: string;
};

/**
 * Les lignes du tableau, dans l'ordre du DAL — cible croissante.
 *
 * `today` ne sert qu'au millésime : un record de tous les temps peut dater de
 * deux ans, et « dimanche 17 mai » ne désignerait alors aucun jour en
 * particulier.
 */
export function buildPersonalBestRows(
  bests: readonly PersonalBestDto[],
  today: string,
): PersonalBestRow[] {
  return bests.map((best) => ({
    key: best.targetM,
    distance: distanceTargetLabel(best.targetM),
    time: formatClock(best.timeS),
    pace: formatPace(best.paceSecPerKm),
    day: formatCivilFullDate(best.achievedOn, today),
    href: `/activities/${best.activityId}`,
  }));
}

/**
 * L'avertissement à afficher tant que le rattrapage des meilleurs efforts n'est
 * pas passé, `null` quand tout l'historique a été balayé.
 *
 * Ce n'est pas une note facultative : `activity_best_segments` n'existe que
 * pour les imports postérieurs à la table, et annoncer « record du 10 km » alors
 * que la moitié des séances n'a pas été lue serait faux. La commande est nommée
 * parce que c'est une opération d'administration que l'appli ne déclenche pas
 * elle-même — l'athlète et l'exploitant sont la même personne ici.
 */
export function describePendingBests(pendingActivities: number): string | null {
  if (pendingActivities <= 0) return null;

  const many = pendingActivities > 1;
  return (
    `Records provisoires : ${pendingActivities} séance${many ? "s" : ""} ` +
    `n'${many ? "ont" : "a"} pas encore été balayée${many ? "s" : ""}. ` +
    "Lance la commande pnpm db:backfill:best-segments pour lire tout l'historique."
  );
}
