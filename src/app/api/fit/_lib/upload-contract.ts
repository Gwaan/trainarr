/**
 * Contrat de l'endpoint `POST /api/fit/upload` : validation d'un fichier reçu
 * et forme de la réponse JSON.
 *
 * Contrairement aux autres `_lib` de `src/app/api/`, ce module n'est
 * volontairement **pas** `server-only` : l'écran d'import
 * (`(app)/activities/_components/activities-header.tsx`) revalide la réponse
 * avec les mêmes schémas. Il ne doit donc jamais toucher à la base, à `env` ni
 * à quoi que ce soit de secret — seulement décrire l'échange.
 */

import { z } from 'zod';

import { MAX_FIT_FILE_BYTES, MAX_FIT_UPLOAD_BYTES, toMegabytes } from '@/lib/fit/limits';

/** Champ du formulaire portant les fichiers (répété autant de fois qu'il y en a). */
export const FIT_UPLOAD_FIELD = 'files';

// Les bornes vivent dans `@/lib/fit/limits` — le watcher les partage sans
// dépendre de `src/app/`. Réexportées pour les consommateurs du contrat.
export { MAX_FIT_FILE_BYTES, MAX_FIT_UPLOAD_BYTES };

/** Au-delà, un nom de fichier casserait la mise en page du récapitulatif. */
const MAX_FILE_NAME_LENGTH = 120;

/**
 * Issue d'un import réussi, alignée sur `IngestReport['status']` de
 * `@/lib/fit/ingest` (le route handler ne compilerait pas si elle divergeait).
 */
export const fitUploadStatusSchema = z.enum(['created', 'updated', 'merged']);
export type FitUploadStatus = z.infer<typeof fitUploadStatusSchema>;

/**
 * Résultat par fichier. Union discriminée : un succès porte toujours un statut,
 * un échec toujours une raison — les états impossibles ne sont pas
 * représentables.
 */
export const fitUploadResultSchema = z.discriminatedUnion('ok', [
  z.object({
    name: z.string(),
    ok: z.literal(true),
    status: fitUploadStatusSchema,
  }),
  z.object({
    name: z.string(),
    ok: z.literal(false),
    error: z.string(),
  }),
]);
export type FitUploadResult = z.infer<typeof fitUploadResultSchema>;

export const fitUploadResponseSchema = z.object({
  results: z.array(fitUploadResultSchema),
});
export type FitUploadResponse = z.infer<typeof fitUploadResponseSchema>;

/**
 * Message affiché quand la cause n'est pas exploitable par l'utilisateur (base
 * indisponible, bug…). Le détail part dans les logs serveur, jamais dans la
 * réponse : une trace d'exécution renseignerait un attaquant sur nos entrailles.
 */
export const UNEXPECTED_ERROR_MESSAGE = 'Import impossible — réessaie plus tard.';

export type FitFileCheck = { ok: true } | { ok: false; error: string };

/**
 * Recevabilité d'un fichier, avant tout décodage.
 *
 * Un fichier refusé n'interrompt pas le lot : l'appelant enregistre la raison
 * et passe au suivant.
 */
export function checkFitFile(file: { name: string; size: number }): FitFileCheck {
  if (!/\.fit$/i.test(file.name)) {
    return { ok: false, error: 'Seuls les fichiers .fit sont acceptés.' };
  }

  if (file.size > MAX_FIT_FILE_BYTES) {
    return {
      ok: false,
      error: `Fichier trop volumineux : ${toMegabytes(MAX_FIT_FILE_BYTES)} Mo maximum.`,
    };
  }

  return { ok: true };
}

/**
 * `true` si l'envoi annonce un corps plus gros que {@link MAX_FIT_UPLOAD_BYTES}.
 *
 * Contrôlé sur l'en-tête `Content-Length` **avant** `request.formData()`, qui
 * matérialise tout le multipart en mémoire : sans ce garde, un POST de 2 Go
 * était intégralement bufferisé avant d'être poliment refusé.
 *
 * Limite assumée : l'en-tête peut mentir (ou manquer, en `Transfer-Encoding:
 * chunked`). Il ne s'agit donc pas d'une protection contre un attaquant
 * déterminé — seul un décodage multipart en flux le serait, hors périmètre —
 * mais d'un rejet immédiat du cas réel : un gros fichier envoyé par erreur. Le
 * contrôle par fichier reste la garantie de ce qui est effectivement lu.
 */
export function exceedsUploadLimit(contentLength: string | null): boolean {
  if (contentLength === null) return false;

  const announced = Number.parseInt(contentLength, 10);
  if (!Number.isFinite(announced)) return false;

  return announced > MAX_FIT_UPLOAD_BYTES;
}

/** Message d'un envoi refusé en bloc, avant même d'être lu. */
export const UPLOAD_TOO_LARGE_MESSAGE = `Envoi trop volumineux : ${toMegabytes(MAX_FIT_UPLOAD_BYTES)} Mo maximum, ${toMegabytes(MAX_FIT_FILE_BYTES)} Mo par fichier.`;

/**
 * Nom réaffiché dans le récapitulatif. Il vient du client : on le tronque pour
 * qu'il reste lisible (React se charge de l'échappement).
 */
export function displayFileName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Fichier sans nom';
  if (trimmed.length <= MAX_FILE_NAME_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_FILE_NAME_LENGTH - 1)}…`;
}
