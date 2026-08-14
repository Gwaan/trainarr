/**
 * Disposition de la boîte de dépôt FIT — décisions pures, sans I/O.
 *
 * ## Un dossier par athlète
 *
 * ```
 * FIT_INBOX_DIR/
 * ├── athlete-1/            ← fichiers en attente d'ingestion
 * │   ├── processed/
 * │   └── failed/
 * └── athlete-2/…
 * ```
 *
 * **L'appartenance d'un fichier est portée par son chemin**, et par rien
 * d'autre. Le poller dépose dans le dossier du compte dont il vient d'utiliser
 * les identifiants ; le watcher, qui ingère plus tard — éventuellement après un
 * redémarrage —, lit l'athlète dans le nom du dossier. Aucune mémoire de process
 * ne survit à un `docker restart` ; un chemin, si.
 *
 * Deux conséquences voulues :
 *
 * - un fichier ne peut pas changer de propriétaire, puisqu'il n'en a jamais eu
 *   d'autre que le dossier où il a été écrit ;
 * - un fichier resté à la **racine** n'a pas de propriétaire déductible. Il n'en
 *   reçoit pas un au hasard : le watcher le signale et le laisse où il est
 *   (cf. l'en-tête de `service.ts`).
 *
 * L'état du rapatriement (`intervals-*.fit` déjà présents, marqueur de backfill)
 * devient lui aussi propre à chaque dossier : un compte neuf déclenche son
 * backfill complet sans que celui du voisin ne compte pour lui.
 */

import { join } from 'node:path';

/** Archive des fichiers importés avec succès, dans le dossier de l'athlète. */
export const PROCESSED_DIR = 'processed';

/** Archive des fichiers dont l'import a échoué — cf. `recoverPendingImports`. */
export const FAILED_DIR = 'failed';

/** Préfixe des dossiers d'athlète, sous la racine de la boîte de dépôt. */
export const ATHLETE_DIR_PREFIX = 'athlete-';

/**
 * Forme canonique d'un dossier d'athlète : le préfixe, puis l'identifiant en
 * base 10 sans zéro de tête. Neuf chiffres au plus — un `serial` Postgres ne va
 * pas au-delà, et la borne évite qu'un nom délirant produise un `Number`
 * approché.
 */
const ATHLETE_DIR_PATTERN = new RegExp(`^${ATHLETE_DIR_PREFIX}([1-9]\\d{0,8})$`);

/**
 * Nom du dossier de cet athlète.
 *
 * @throws {RangeError} si l'identifiant n'est pas un entier strictement positif.
 * Le contrôle n'est pas décoratif : cette valeur compose un chemin, et un
 * identifiant qui n'en est pas un ne doit jamais y arriver — même si le typage
 * dit déjà `number`.
 */
export function athleteDirName(athleteId: number): string {
  if (!Number.isSafeInteger(athleteId) || athleteId <= 0) {
    throw new RangeError(`Identifiant d'athlète inattendu : ${JSON.stringify(athleteId)}.`);
  }
  return `${ATHLETE_DIR_PREFIX}${athleteId}`;
}

/**
 * L'athlète que désigne un nom de dossier, `null` si ce n'en est pas un.
 *
 * Strictement canonique : `athlete-007` est refusé plutôt que ramené à 7. Deux
 * noms différents qui désigneraient le même athlète, ce sont deux dossiers dont
 * l'un se croirait vide — donc un backfill relancé sans fin et une
 * déduplication qui ne voit pas les fichiers de son jumeau.
 */
export function parseAthleteDirName(name: string): number | null {
  const digits = ATHLETE_DIR_PATTERN.exec(name)?.[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits, 10);
}

/**
 * Dossier de dépôt de cet athlète, sous la racine de la boîte.
 *
 * `turbopackIgnore` : sans lui, l'analyse statique voit un chemin partiellement
 * connu (`athlete-…`), le prend pour un spécificateur de module et **recopie des
 * sources du projet dans `.next/standalone`** — vérifié : `src/components/nav/
 * athlete-link.tsx` s'y retrouvait, résolu par simple proximité de nom. C'est un
 * répertoire de données à l'exécution, il n'a rien à voir avec les modules à
 * embarquer. Même précaution que les `readdir` de `service.ts`.
 */
export function athleteInboxDir(inboxDir: string, athleteId: number): string {
  return join(/* turbopackIgnore: true */ inboxDir, athleteDirName(athleteId));
}

/**
 * `run.fit` + 2 → `run-2.fit`. Le suffixe se glisse **avant** l'extension, pas
 * après : un `run.fit-2` ne serait plus un `.fit`, et le watcher l'ignorerait à
 * jamais (cf. `isFitFile`).
 *
 * Sert à trouver un nom libre quand un homonyme occupe déjà la place — les noms
 * produits par HealthFit sont datés au jour, deux séances du même jour portent
 * donc le même nom (cf. `recoverPendingImports`).
 */
export function nameWithSuffix(name: string, suffix: number): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? `${name}-${suffix}` : `${name.slice(0, dot)}-${suffix}${name.slice(dot)}`;
}
