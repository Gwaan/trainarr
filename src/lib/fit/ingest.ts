import 'server-only';

import { saveActivityStreams, upsertActivityFromFit } from '@/data/activities';
import { getAthleteId } from '@/data/athlete';

import { parseFitActivity } from './parse';

/**
 * Ingestion d'un fichier FIT : parsing → écriture en base → séries temporelles.
 *
 * Seul module de `lib/fit` à toucher la base, et uniquement via le DAL (le
 * parseur, lui, reste une fonction pure).
 */

export type IngestReport = {
  /**
   * - `created` : nouvelle activité ;
   * - `updated` : ce fichier avait déjà été importé (même empreinte).
   */
  status: 'created' | 'updated';
  activityId: number;
};

/**
 * Importe le contenu d'un fichier FIT.
 *
 * **Les séries sont systématiquement réécrites**, y compris quand le fichier
 * avait déjà été importé (`status: 'updated'`). C'est l'inverse de la politique
 * des colonnes de `activities`, qui ne comble que ses trous — et la raison est
 * la même dans les deux cas : ne jamais perdre une donnée que seul l'humain
 * pouvait produire, toujours rafraîchir celle que seul le fichier produit. Une
 * série temporelle n'est pas éditable dans l'appli ; sa seule source est le
 * fichier, relu ici par la version courante du parseur. Ne réécrire que les
 * activités dépourvues de séries — le comportement précédent — rendait toute
 * correction du parseur inopérante sur l'historique : redéposer le fichier ne
 * réparait rien.
 *
 * @throws {FitParseError} si le fichier est illisible — l'erreur remonte telle
 * quelle à l'appelant (le watcher), qui décide du sort du fichier.
 * @throws {Error} si aucun athlète n'est enregistré (onboarding non fait).
 */
export async function ingestFitBuffer(buffer: Buffer): Promise<IngestReport> {
  const parsed = parseFitActivity(buffer);

  // Le parseur ne masque jamais une perte de données : ce qu'il a dû écarter est
  // tracé ici, sinon le rapport d'import laisserait croire à une lecture parfaite.
  for (const warning of parsed.warnings) {
    console.error(`[fit] ${parsed.fileHash.slice(0, 12)} : ${warning}`);
  }

  const athleteId = await getAthleteId();
  if (athleteId === null) {
    throw new Error(
      "Aucun athlète enregistré : impossible d'importer un fichier FIT (onboarding requis).",
    );
  }

  const { activityId, created } = await upsertActivityFromFit(parsed, athleteId);

  await saveActivityStreams(activityId, parsed.streams);

  return { status: created ? 'created' : 'updated', activityId };
}
