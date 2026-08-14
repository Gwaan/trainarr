import 'server-only';

/**
 * Reprise des imports en attente, au moment de l'onboarding.
 *
 * Tant que le compte n'a pas d'athlète, l'ingestion refuse chaque fichier de son
 * dossier (une activité appartient à un athlète) : le watcher les range dans
 * `failed/` avec leur motif. Ils sont intacts, et seule la cause de l'échec a
 * disparu — les remettre dans le dossier de dépôt les fait ré-ingérer au scan
 * suivant, sans rien retélécharger — à deux conditions, toutes deux traitées
 * ici : que la remise en file n'écrase pas un homonyme déjà en attente, et que
 * la date de modification du fichier change (le watcher identifie ce qu'il a
 * déjà traité par `nom|taille|mtime`).
 *
 * **Tout se passe dans le dossier de cet athlète** (`athlete-<id>/`), jamais à
 * la racine de la boîte : un fichier de la racine n'a pas de propriétaire
 * déductible, et l'onboarding d'un compte n'est pas une raison de lui attribuer
 * ce que quelqu'un d'autre a peut-être déposé.
 *
 * Le marqueur de backfill est reposé dans la foulée : des fichiers
 * `intervals-*.fit` existent déjà (dans `failed/`), ce qui referme la fenêtre
 * historique du poller ; sans le marqueur, l'historique antérieur à
 * `INTERVALS_LOOKBACK_DAYS` ne serait plus jamais demandé.
 *
 * **Rien ici ne peut faire échouer l'onboarding** : la création du profil a déjà
 * eu lieu quand cette fonction est appelée, et le watcher comme le poller
 * finiront de toute façon par rattraper ce que la reprise n'a pas su faire. Toute
 * erreur est donc journalisée, jamais propagée.
 */

import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { env } from '@/config/env';

import { nameWithSuffix } from './dav';
import { athleteInboxDir, FAILED_DIR } from './inbox-layout';
import { setBackfillMarker } from './service';
import { isFitFile } from './watch-plan';

/**
 * Nombre de variantes de nom essayées avant d'abandonner un fichier dans
 * `failed/` (même borne que le dépôt WebDAV). Cent séances homonymes le même
 * jour ne se produisent pas ; la borne existe pour que la boucle finisse.
 */
const MAX_NAME_ATTEMPTS = 100;

export type RecoveryReport = {
  /** Fichiers sortis de `failed/` et remis dans la boîte de dépôt. */
  requeued: number;
  /** `true` si le marqueur `.backfill-pending` a bien été posé. */
  backfillReopened: boolean;
};

const NOTHING_RECOVERED: RecoveryReport = { requeued: 0, backfillReopened: false };

function log(message: string): void {
  console.log(`[fit] ${message}`);
}

function logError(message: string): void {
  console.error(`[fit] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** `true` pour un répertoire absent — `failed/` n'existe pas tant que rien n'a échoué. */
function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Un nom libre dans la boîte de dépôt pour le fichier repris, `null` si toutes
 * les variantes sont prises.
 *
 * Les noms produits par HealthFit sont datés au jour : deux séances du même jour
 * portent le même nom. Une reprise qui renommerait aveuglément écraserait donc
 * un fichier fraîchement déposé et encore en attente d'ingestion — une séance
 * perdue sans la moindre trace.
 *
 * Reste une fenêtre de course entre ce contrôle et le `rename` : un dépôt WebDAV
 * qui réserverait le nom dans cet intervalle serait écrasé. Elle est étroite (la
 * reprise est un événement unique de l'onboarding) et le dépôt, lui, se protège
 * déjà en créant son `.part` en exclusif ; la fermer demanderait un `link` +
 * `unlink` dont le gain ne vaut pas la complication ici.
 */
async function freeTargetName(inboxDir: string, name: string): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? name : nameWithSuffix(name, attempt);
    if (!(await exists(join(inboxDir, candidate)))) return candidate;
  }
  return null;
}

/**
 * Renvoie les `.fit` de `failed/` dans le dossier de dépôt de l'athlète, avec
 * leur `.err.txt`.
 *
 * Un fichier récalcitrant (droits, disque plein) n'interrompt pas les autres :
 * il reste dans `failed/`, où il est visible, et l'échec est journalisé.
 */
async function requeueFailedFiles(inboxDir: string): Promise<number> {
  const failedDir = join(inboxDir, FAILED_DIR);

  let entries: string[];
  try {
    // `turbopackIgnore` : sans lui, l'analyse statique voit un chemin calculé et
    // recopie les sources du projet dans `.next/standalone` — cf. `service.ts`.
    entries = await readdir(/* turbopackIgnore: true */ failedDir);
  } catch (error) {
    if (!isMissingDirectory(error)) {
      logError(`reprise : ${FAILED_DIR}/ illisible (${errorMessage(error)}).`);
    }
    return 0;
  }

  let requeued = 0;
  for (const name of entries) {
    // Les `.err.txt` des fichiers non repris restent où ils sont : ils décrivent
    // encore l'état de leur archive.
    if (!isFitFile(name)) continue;

    let target: string;
    try {
      const free = await freeTargetName(inboxDir, name);
      if (free === null) {
        logError(`reprise : ${name} laissé dans ${FAILED_DIR}/ (trop d'homonymes dans la boîte).`);
        continue;
      }
      // `turbopackIgnore` : même raison qu'au `readdir` ci-dessus — sans lui,
      // ce chemin calculé fait tracer tout le projet dans `.next/standalone`.
      target = join(/* turbopackIgnore: true */ inboxDir, free);
      await rename(join(failedDir, name), target);
      if (free !== name) {
        log(`reprise : ${name} remis en file sous ${free} (le nom d'origine était pris).`);
      }
    } catch (error) {
      logError(`reprise : ${name} non remis en file (${errorMessage(error)}).`);
      continue;
    }
    requeued += 1;

    try {
      // `rename` conserve la mtime : sans ce coup de neuf, le fichier retrouve
      // exactement la clé `nom|taille|mtime` que le watcher garde en mémoire
      // depuis son échec, qui le tient donc pour « déjà traité » et l'ignore
      // jusqu'au prochain redémarrage. Une mtime neuve, c'est une clé neuve.
      const now = new Date();
      await utimes(target, now, now);
    } catch (error) {
      // Le fichier est au pire dans l'ancien cas : ignoré jusqu'au redémarrage,
      // jamais perdu. Ça ne justifie pas d'annuler la reprise.
      logError(`reprise : ${name} remis en file sans rafraîchir sa date (${errorMessage(error)}).`);
    }

    try {
      // Le motif décrivait un échec qui n'a plus lieu d'être ; le laisser ferait
      // croire à un import encore en défaut.
      await rm(join(failedDir, `${name}.err.txt`), { force: true });
    } catch (error) {
      logError(`reprise : ${name}.err.txt non supprimé (${errorMessage(error)}).`);
    }
  }

  return requeued;
}

/**
 * Remet en file tout ce qui attendait l'onboarding **de cet athlète**, et rouvre
 * son rapatriement d'historique.
 *
 * L'athlète est un paramètre, jamais une déduction : l'appelant (la Server
 * Action d'onboarding) vient de le créer, il sait lequel c'est.
 *
 * Ne lève jamais : un dossier inaccessible rend un rapport à zéro et le
 * journalise.
 */
export async function recoverPendingImports(athleteId: number): Promise<RecoveryReport> {
  let athleteDir: string;
  try {
    athleteDir = athleteInboxDir(env.FIT_INBOX_DIR, athleteId);
  } catch (error) {
    logError(`reprise impossible — configuration illisible : ${errorMessage(error)}.`);
    return NOTHING_RECOVERED;
  }

  try {
    // Le dossier de l'athlète n'existe pas encore si rien n'a jamais été déposé
    // pour lui : sans ce `mkdir`, le marqueur n'aurait nulle part où s'écrire.
    await mkdir(athleteDir, { recursive: true });

    const requeued = await requeueFailedFiles(athleteDir);
    const backfillReopened = await setBackfillMarker(athleteDir, true, Date.now());

    log(
      `reprise après onboarding : ${requeued} fichier(s) remis en file, rapatriement de l'historique ${backfillReopened ? 'rouvert' : 'non rouvert (marqueur non posé)'}.`,
    );
    return { requeued, backfillReopened };
  } catch (error) {
    // Filet ultime : les étapes attrapent déjà ce qu'elles savent nommer.
    logError(`reprise interrompue : ${errorMessage(error)}.`);
    return NOTHING_RECOVERED;
  }
}
