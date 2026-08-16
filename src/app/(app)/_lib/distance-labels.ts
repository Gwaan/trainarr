/**
 * Libellés français des distances de référence — données pures.
 *
 * Deux entrées vers la **même** table, parce que deux écrans désignent une
 * distance de deux façons : par sa clé (`'half'`, celle d'un plan et d'une
 * prédiction) ou par ses mètres (21 097,5, ceux d'un meilleur effort persisté).
 * Les deux vivent ici plutôt que dans une route parce que trois routes les
 * lisent désormais — le formulaire de plan, le détail d'une séance et la page
 * « Progression » — et qu'un « Semi » écrit trois fois finirait par ne plus être
 * le même mot.
 */

import { REFERENCE_DISTANCES, type ReferenceDistance } from "@/lib/metrics/vdot";

import { formatNumber } from "./format";

/** Libellé d'une distance de référence, par sa clé. */
export const REFERENCE_DISTANCE_LABELS: Record<ReferenceDistance, string> = {
  "5k": "5 km",
  "10k": "10 km",
  half: "Semi",
  marathon: "Marathon",
};

/**
 * Libellés par distance en mètres. Les quatre distances de route viennent de
 * {@link REFERENCE_DISTANCES} plutôt que d'être recopiées (le semi vaut
 * 21 097,5 m, pas 21 100) ; les trois autres sont les cibles de meilleur effort
 * qu'aucun plan ne prend pour ancre.
 */
const LABELS_BY_METERS = new Map<number, string>([
  [400, "400 m"],
  [1_000, "1 km"],
  [1_609.34, "1 mile"],
  ...(Object.keys(REFERENCE_DISTANCE_LABELS) as ReferenceDistance[]).map(
    (distance): [number, string] => [
      REFERENCE_DISTANCES[distance],
      REFERENCE_DISTANCE_LABELS[distance],
    ],
  ),
]);

/**
 * Libellé d'une cible en mètres.
 *
 * Une cible inconnue de la table retombe sur ses kilomètres plutôt que de
 * disparaître : ajouter une distance à `BEST_SEGMENT_TARGETS_M` ne doit pas
 * escamoter une ligne en silence.
 */
export function distanceTargetLabel(targetM: number): string {
  return LABELS_BY_METERS.get(targetM) ?? `${formatNumber(targetM / 1000, 1)} km`;
}
