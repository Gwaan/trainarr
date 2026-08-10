/**
 * Bornes de taille des imports FIT.
 *
 * Module volontairement isolé et sans dépendance : les trois entrées d'import
 * s'y réfèrent — la route `POST /api/fit/upload`, l'écran d'import (composant
 * client) et le service d'import `src/lib/fit/service.ts`, qui ne doit rien
 * importer de `src/app/`.
 */

/**
 * Garde-fou mémoire d'un fichier : il est chargé entier avant d'être analysé.
 * Une sortie de plusieurs heures enregistrée à la seconde pèse quelques Mo,
 * 25 Mo laissent une marge confortable sans exposer le serveur.
 */
export const MAX_FIT_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Garde-fou mémoire d'un envoi multipart entier, contrôlé sur `Content-Length`
 * avant que le corps ne soit matérialisé. Il couvre un lot confortable de
 * fichiers à la limite ci-dessus, plus la surcharge de l'enveloppe multipart —
 * au-delà, l'envoi est refusé sans être lu.
 */
export const MAX_FIT_UPLOAD_BYTES = 130 * 1024 * 1024;

/** Taille en Mo, telle qu'affichée dans les messages d'erreur. */
export function toMegabytes(bytes: number): number {
  return bytes / 1024 / 1024;
}
