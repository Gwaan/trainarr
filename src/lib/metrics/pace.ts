/** Conversions d'allure. Aucune formule empirique ici : arithmétique exacte. */

const METERS_PER_KM = 1000;

/**
 * Allure en secondes par kilomètre. Renvoie `null` si la distance ou la durée
 * est nulle, négative ou non finie — une allure ne s'extrapole pas.
 */
export function paceSecPerKm(distanceM: number, movingTimeS: number): number | null {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return null;
  if (!Number.isFinite(movingTimeS) || movingTimeS <= 0) return null;

  return movingTimeS / (distanceM / METERS_PER_KM);
}
