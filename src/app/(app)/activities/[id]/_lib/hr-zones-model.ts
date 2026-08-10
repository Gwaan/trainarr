/**
 * Géométrie des barres de zones cardio — fonctions pures, testées.
 *
 * Les zones sont une **magnitude ordonnée** (Z1 → Z5) : le design system leur
 * réserve une rampe séquentielle d'une seule teinte (cf. `.claude/rules/design.md`).
 * La couleur ne porte jamais l'information seule — chaque barre est étiquetée
 * de sa zone, de sa durée et de sa part.
 *
 * La part de chaque zone est calculée par le DAL : elle n'est pas recalculée
 * ici, on ne fait que la mettre en géométrie.
 */

/** Une zone dont le temps est non nul garde une amorce visible. */
export const MIN_ZONE_BAR_PCT = 1.5;

/** Durée totale passée en zones — l'en-tête du panneau l'affiche. */
export function totalZoneSeconds(seconds: readonly number[]): number {
  return seconds.reduce(
    (total, value) => (Number.isFinite(value) && value > 0 ? total + value : total),
    0,
  );
}

/**
 * Largeur de la barre, en pourcentage, à partir de la part rendue par le DAL
 * (dans [0, 1]). Une zone à zéro n'a pas de barre ; une zone marginale garde
 * {@link MIN_ZONE_BAR_PCT} pour rester perceptible.
 */
export function zoneBarWidthPct(share: number): number {
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.min(100, Math.max(MIN_ZONE_BAR_PCT, share * 100));
}

/** Classe de remplissage de la zone `n` (1 à 5) dans la rampe séquentielle. */
export function zoneBarClass(zone: number): string {
  switch (zone) {
    case 1:
      return "bg-zone-1";
    case 2:
      return "bg-zone-2";
    case 3:
      return "bg-zone-3";
    case 4:
      return "bg-zone-4";
    default:
      return "bg-zone-5";
  }
}
