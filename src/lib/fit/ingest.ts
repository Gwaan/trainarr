import 'server-only';

import {
  hasActivityStreams,
  saveActivityStreams,
  upsertActivityFromFit,
  type FitUpsertOutcome,
} from '@/data/activities';
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
   * - `updated` : ce fichier avait déjà été importé (même empreinte) ;
   * - `merged` : cette séance était déjà en base, importée depuis un **autre**
   *   fichier — l'activité existante a été complétée, pas dupliquée.
   */
  status: 'created' | 'updated' | 'merged';
  activityId: number;
};

/**
 * Politique des séries temporelles, selon la façon dont le fichier s'est
 * rattaché à la base.
 *
 * **Création ou même fichier → réécriture intégrale.** C'est l'inverse de la
 * politique des colonnes de `activities`, qui ne comble que ses trous — et la
 * raison est la même dans les deux cas : ne jamais perdre une donnée que seul
 * l'humain pouvait produire, toujours rafraîchir celle que seul le fichier
 * produit. Une série temporelle n'est pas éditable dans l'appli ; sa seule
 * source est le fichier, relu ici par la version courante du parseur. Ne
 * réécrire que les activités dépourvues de séries — le comportement d'avant —
 * rendait toute correction du parseur inopérante sur l'historique : redéposer le
 * fichier ne réparait rien.
 *
 * **Même séance, autre fichier → on ne réécrit que s'il n'y a rien.** Un
 * doublon venu d'une autre source n'est pas une meilleure version de la séance :
 * il n'a aucun titre à écraser des séries saines, et rien ne dit qu'il porte les
 * mêmes canaux (une même sortie exportée deux fois peut avoir perdu sa FC en
 * chemin). En revanche, s'il apporte des séries à une activité qui n'en a
 * aucune, il les apporte.
 */
async function shouldRewriteStreams(
  status: IngestReport['status'],
  activityId: number,
): Promise<boolean> {
  if (status !== 'merged') return true;
  return !(await hasActivityStreams(activityId));
}

/**
 * Issue du DAL → statut du rapport d'import.
 *
 * Table exhaustive par construction : ajouter une issue à `FitUpsertOutcome`
 * sans lui donner de statut ne compile pas.
 */
const REPORT_STATUS = {
  created: 'created',
  'same-file': 'updated',
  'same-session': 'merged',
} as const satisfies Record<FitUpsertOutcome, IngestReport['status']>;

/**
 * Importe le contenu d'un fichier FIT.
 *
 * Les séries temporelles suivent {@link shouldRewriteStreams}.
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

  const { activityId, outcome } = await upsertActivityFromFit(parsed, athleteId);
  const status = REPORT_STATUS[outcome];

  if (await shouldRewriteStreams(status, activityId)) {
    await saveActivityStreams(activityId, parsed.streams);
  }

  return { status, activityId };
}
