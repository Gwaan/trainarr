import 'server-only';

import {
  findActivityIdsWithoutStreams,
  saveActivityStreams,
  upsertActivityFromFit,
} from '@/data/activities';
import { getAthleteProfile } from '@/data/athlete';

import { parseFitActivity } from './parse';

/**
 * Ingestion d'un fichier FIT : parsing → écriture en base → séries temporelles.
 *
 * Seul module de `lib/fit` à toucher la base, et uniquement via le DAL — même
 * découpage que `lib/strava/sync.ts` (le parseur reste une fonction pure).
 */

export type IngestReport = {
  /**
   * - `created` : nouvelle activité ;
   * - `updated` : ce fichier avait déjà été importé (même empreinte) ;
   * - `merged`  : le fichier a été rattaché à une activité déjà importée depuis
   *   Strava, dont il a complété les champs manquants.
   */
  status: 'created' | 'updated' | 'merged';
  activityId: number;
};

/**
 * Importe le contenu d'un fichier FIT.
 *
 * Les streams ne sont écrits que si l'activité n'en a **aucun** — même critère
 * que la sync Strava (`findActivityIdsWithoutStreams`) : sur un rapprochement,
 * les séries déjà importées depuis Strava font foi et ne sont pas réécrites ;
 * sur une activité arrivée sans ses séries, le FIT les fournit.
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

  const profile = await getAthleteProfile();
  if (!profile) {
    throw new Error(
      "Aucun athlète enregistré : impossible d'importer un fichier FIT (onboarding requis).",
    );
  }

  const { activityId, created, merged } = await upsertActivityFromFit(parsed, profile.id);

  const withoutStreams = await findActivityIdsWithoutStreams([activityId]);
  if (withoutStreams.has(activityId)) {
    await saveActivityStreams(activityId, parsed.streams);
  }

  const status = merged ? 'merged' : created ? 'created' : 'updated';
  return { status, activityId };
}
