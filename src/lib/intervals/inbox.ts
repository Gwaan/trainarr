/**
 * Dépôt d'un fichier rapatrié dans la boîte d'import du watcher.
 *
 * Écriture sous un nom temporaire `.part` puis renommage, exactement comme le
 * dépôt WebDAV (`src/lib/fit/dav.ts`) : le watcher ne doit jamais voir un `.fit`
 * en cours d'écriture. Le renommage est atomique sur un même système de
 * fichiers — le fichier apparaît complet du premier coup. Sa règle de stabilité
 * de taille l'en protégeait déjà ; deux verrous valent mieux qu'un quand la
 * conséquence est une donnée d'entraînement fausse.
 *
 * Le poller s'arrête là : il ne parse rien, n'ouvre aucune connexion à la base.
 * La suite (stabilité, ingestion, `processed/` ou `failed/`) est le travail
 * habituel du watcher.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Suffixe des fichiers en cours d'écriture, ignoré par le watcher. */
const PART_SUFFIX = '.part';

/**
 * Les seules opérations disque dont le dépôt a besoin. Interface étroite pour
 * que les tests puissent la simuler — l'implémentation réelle est
 * {@link nodeInboxFileSystem}.
 */
export type InboxFileSystem = {
  ensureDir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
};

export const nodeInboxFileSystem: InboxFileSystem = {
  ensureDir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, data) => {
    await writeFile(path, data);
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
};

export type DepositParams = {
  inboxDir: string;
  /** Nom final, tel que le calcule `inboxFileName`. */
  fileName: string;
  data: Uint8Array;
  fs?: InboxFileSystem;
};

/** Écrit le fichier dans la boîte de dépôt, sous `.part` puis renommé. */
export async function depositInInbox(params: DepositParams): Promise<void> {
  const fs = params.fs ?? nodeInboxFileSystem;
  const finalPath = join(params.inboxDir, params.fileName);
  const partPath = `${finalPath}${PART_SUFFIX}`;

  await fs.ensureDir(params.inboxDir);
  await fs.writeFile(partPath, params.data);

  try {
    await fs.rename(partPath, finalPath);
  } catch (error) {
    // Sans ce nettoyage le temporaire resterait à occuper le nom jusqu'au
    // balayage des `.part` abandonnés par le watcher, un quart d'heure plus tard.
    await fs.remove(partPath);
    throw error;
  }
}
