/**
 * Logique de décision du dossier surveillé — fonctions pures, sans I/O.
 *
 * Le service qui les utilise (`scripts/fit-watcher.ts`) se contente de lister le
 * répertoire, d'appeler `planScan`, puis d'ingérer, de refuser et de déplacer les
 * fichiers qu'on lui désigne. Tout ce qui se raisonne (extension, upload en
 * cours, fichier déjà traité, fichier hors gabarit) vit ici pour rester testable
 * sans système de fichiers.
 */

import { MAX_FIT_FILE_BYTES, toMegabytes } from './limits';

/** Une entrée du dossier surveillé, telle que `readdir` + `stat` la voient. */
export type ScannedFile = {
  name: string;
  sizeBytes: number;
  /** Date de dernière modification (`stat.mtimeMs`), en millisecondes. */
  mtimeMs: number;
};

/**
 * - `ingest` : fichier FIT complet, prêt à être importé ;
 * - `wait`   : fichier FIT dont la taille n'est pas encore stable (upload en
 *   cours) — on le reverra au scan suivant ;
 * - `reject` : fichier FIT hors gabarit — à archiver sans jamais être lu ;
 * - `skip`   : rien à faire (mauvaise extension, fichier déjà traité).
 */
export type FileAction = 'ingest' | 'wait' | 'reject' | 'skip';

export type ScanContext = {
  /** Taille observée au scan précédent, `undefined` si le fichier est nouveau. */
  previousSizeBytes: number | undefined;
  /** `true` si ce processus a déjà traité ce fichier (cf. {@link fileKey}). */
  alreadyHandled: boolean;
};

/** `true` pour un fichier `.fit`, quelle que soit la casse de l'extension. */
export function isFitFile(name: string): boolean {
  return name.toLowerCase().endsWith('.fit');
}

/**
 * Identité d'un fichier pour la mémoire du watcher.
 *
 * Le nom seul ne suffit pas : le gabarit de nommage de HealthFit est daté à la
 * journée (`2026-08-10-Run.fit`), deux séances le même jour partagent donc le
 * même nom. Indexer `handled` dessus faisait ignorer la seconde à jamais. Le
 * triplet nom + taille + date de modification distingue deux dépôts successifs
 * tout en restant stable d'un scan à l'autre pour un fichier immobile.
 */
export function fileKey(file: ScannedFile): string {
  return `${file.name}|${file.sizeBytes}|${file.mtimeMs}`;
}

/** Motif du refus d'un fichier hors gabarit, écrit tel quel dans son `.err.txt`. */
export function tooLargeReason(sizeBytes: number): string {
  const size = Math.round(toMegabytes(sizeBytes));
  return `Fichier trop volumineux : ${size} Mo pour un maximum de ${toMegabytes(MAX_FIT_FILE_BYTES)} Mo. Il n'a pas été lu.`;
}

/**
 * Que faire d'un fichier à ce scan.
 *
 * Le dépôt se fait par WebDAV : le fichier apparaît dans le répertoire dès le
 * premier octet écrit. On n'ouvre donc un fichier que lorsque sa taille est
 * **identique à celle du scan précédent** — deux observations séparées par
 * l'intervalle de scan. Un fichier vu pour la première fois attend toujours un
 * tour, et un fichier vide attend aussi (un FIT de 0 octet n'existe pas ; c'est
 * l'état initial d'un upload).
 *
 * La borne de taille est contrôlée **avant** toute attente et, surtout, avant
 * toute lecture : un fichier qui a déjà dépassé la limite ne peut que grossir, le
 * lire saturerait la mémoire du service (redémarrage en boucle, plus aucun import
 * ne passe). Il part directement en archive avec son motif.
 *
 * `alreadyHandled` protège le cas où le déplacement post-import a échoué (droits,
 * disque plein) : sans lui le fichier resterait dans le dossier et serait
 * réimporté à chaque tour, indéfiniment.
 */
export function decideFileAction(file: ScannedFile, context: ScanContext): FileAction {
  if (!isFitFile(file.name)) return 'skip';
  if (context.alreadyHandled) return 'skip';
  if (file.sizeBytes > MAX_FIT_FILE_BYTES) return 'reject';
  if (file.sizeBytes === 0) return 'wait';
  if (context.previousSizeBytes !== file.sizeBytes) return 'wait';
  return 'ingest';
}

/** Un fichier retenu par le plan : son nom sur le disque et sa clé d'identité. */
export type PlannedFile = { name: string; key: string };

export type ScanPlan = {
  /** Fichiers à ingérer, dans l'ordre de la liste fournie. */
  toIngest: PlannedFile[];
  /** Fichiers à archiver en `failed/` sans être lus, avec leur motif. */
  toReject: Array<PlannedFile & { reason: string }>;
  /**
   * Tailles à mémoriser pour le scan suivant. Reconstruite à chaque tour à partir
   * des seuls fichiers encore présents : les fichiers déplacés ou supprimés
   * disparaissent de la mémoire du watcher au lieu de s'y accumuler.
   */
  sizes: Map<string, number>;
  /**
   * Clés (cf. {@link fileKey}) déjà traitées **et dont le fichier est encore
   * là** : purge du même ordre que `sizes`, sans quoi l'ensemble grossirait
   * indéfiniment sur un service qui tourne des mois.
   */
  handled: Set<string>;
};

/** Applique `decideFileAction` à un scan complet. */
export function planScan(
  files: readonly ScannedFile[],
  previous: { sizes: ReadonlyMap<string, number>; handled: ReadonlySet<string> },
): ScanPlan {
  const plan: ScanPlan = {
    toIngest: [],
    toReject: [],
    sizes: new Map(),
    handled: new Set(),
  };

  for (const file of files) {
    if (!isFitFile(file.name)) continue;

    plan.sizes.set(file.name, file.sizeBytes);

    const key = fileKey(file);
    const alreadyHandled = previous.handled.has(key);
    if (alreadyHandled) plan.handled.add(key);

    const action = decideFileAction(file, {
      previousSizeBytes: previous.sizes.get(file.name),
      alreadyHandled,
    });

    if (action === 'ingest') plan.toIngest.push({ name: file.name, key });
    if (action === 'reject') {
      plan.toReject.push({ name: file.name, key, reason: tooLargeReason(file.sizeBytes) });
    }
  }

  return plan;
}
