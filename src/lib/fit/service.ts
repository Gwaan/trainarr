import 'server-only';

/**
 * Service d'import FIT : deux boucles longue durée, dans le process du serveur.
 *
 * ## Ce que fait le service
 *
 * - **Surveillance du dossier** — toutes les `FIT_WATCH_INTERVAL_S` secondes, il
 *   parcourt les dossiers d'athlète de `FIT_INBOX_DIR`, importe les fichiers
 *   `.fit` dont l'upload est terminé, puis les range dans `processed/` ou
 *   `failed/` **du dossier concerné**.
 * - **Rapatriement intervals.icu** — une seconde boucle indépendante fait un
 *   cycle **par compte ayant enregistré une clé API**, avec les identifiants de
 *   ce compte, et dépose ce qu'elle récupère dans le dossier de cet athlète. La
 *   séparation est stricte : le poller parle au réseau et écrit des fichiers, il
 *   ne parse ni n'ingère rien ; le watcher parle à la base. Les deux ne se
 *   croisent que par le répertoire. Tant qu'aucune séance n'a été rapatriée
 *   **pour ce compte**, la boucle demande tout l'historique plutôt que la
 *   fenêtre glissante — par tranches, sur plusieurs cycles (cf. `planPollWindow`
 *   et `MAX_DOWNLOADS_PER_CYCLE`).
 *
 * Scan par intervalle plutôt qu'inotify, volontairement : le dépôt se fait sur un
 * volume Docker (et, à terme, possiblement un partage réseau) où les événements
 * inotify ne sont pas fiables, et cela évite une dépendance de plus pour
 * surveiller un répertoire qui reçoit quelques fichiers par semaine.
 *
 * ## À qui appartient un fichier
 *
 * **Au dossier où il se trouve, et à personne d'autre** (cf. `./inbox-layout`).
 * L'ingestion reçoit son athlète en paramètre : elle ne le déduit plus d'une
 * session, qui n'existe pas ici — c'est ce qui avait cassé le service quand
 * l'athlète est devenu la propriété d'un compte, chaque fichier partant en
 * `failed/` faute de propriétaire.
 *
 * **Les fichiers restés à la racine de la boîte n'ont pas de propriétaire
 * déductible** : dépôts antérieurs à ce cloisonnement, ou fichiers posés à la
 * main dans le volume. Le watcher les signale (une fois chacun) et les laisse strictement où ils
 * sont. Les attribuer « au premier athlète venu » est exactement ce que le
 * cloisonnement par compte interdit ; les réimporter depuis la page « Activités »
 * les rattache au compte connecté, en une manipulation et sans ambiguïté.
 *
 * ## Où il tourne
 *
 * Dans le process du serveur Next, démarré par `src/instrumentation.ts` — il n'y
 * a qu'un seul container applicatif. La configuration vient donc de
 * `src/config/env.ts` comme pour le reste de l'application ; ce module ne lit
 * jamais `process.env` et ne charge aucun fichier `.env`.
 *
 * ## Il ne peut pas emporter le serveur HTTP
 *
 * C'est la propriété la plus importante de ce module : **aucune défaillance de
 * l'import ne doit priver l'athlète de son application**. Trois filets, du plus
 * proche au plus large :
 *
 * 1. chaque fichier fautif est isolé (`handleFile` ne relance jamais) ;
 * 2. chaque tour de boucle attrape ses propres erreurs et retente au tour
 *    suivant ;
 * 3. {@link runForever} enrobe chaque boucle d'un dernier recours : ce qui
 *    aurait dû tuer la boucle est journalisé, et la boucle repart après un
 *    délai.
 *
 * Une configuration illisible ou une inbox inaccessible désactive le service et
 * le dit — le serveur, lui, continue de servir.
 */

import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { env } from '@/config/env';
import { listIntervalsAccounts } from '@/data/athlete';
import { ingestFitBuffer, type IngestReport } from '@/lib/fit/ingest';
import {
  athleteDirName,
  athleteInboxDir,
  FAILED_DIR,
  parseAthleteDirName,
  PROCESSED_DIR,
} from '@/lib/fit/inbox-layout';
import {
  isFitFile,
  ORPHAN_PART_MAX_AGE_MS,
  planScan,
  type ScannedFile,
} from '@/lib/fit/watch-plan';
import { downloadFitFile, listRecentActivities } from '@/lib/intervals/client';
import { depositInInbox } from '@/lib/intervals/inbox';
import { classifyPollError, type PollErrorReport } from '@/lib/intervals/poll-errors';
import {
  downloadSpacingMs,
  MAX_DOWNLOADS_PER_CYCLE,
  MAX_SLEEP_MS,
  mergeRetryAfterS,
  nextPollDelayMs,
  planAccountsToPoll,
  planPoll,
  planPollWindow,
  pollCycleSummary,
  purgeExpiredWithoutFile,
  shouldLogOnce,
  WITHOUT_FILE_TTL_MS,
  type PollableAccount,
  type PollCycleOutcome,
  type PollPlan,
  type PollWindow,
} from '@/lib/intervals/poll-plan';
import { runDailyWellness, wellnessStartupLine } from '@/lib/intervals/wellness-service';
import { createStopControls, type StopControls } from '@/lib/services/stop-controls';

/**
 * Délai avant de relancer une boucle tombée sur une erreur qu'aucun de ses
 * gardes internes n'avait prévue. Assez long pour ne pas transformer une panne
 * durable (disque plein, volume démonté) en boucle chaude, assez court pour que
 * l'import reparte sans intervention dès que la cause disparaît.
 */
const LOOP_RESTART_DELAY_MS = 30_000;

/*
 * Journaux. Deux préfixes : les deux boucles écrivent sur la même sortie, et
 * c'est désormais celle du container `trainarr` (`docker logs trainarr`).
 */

function log(message: string): void {
  console.log(`[fit] ${message}`);
}

function logError(message: string): void {
  console.error(`[fit] ${message}`);
}

function pollLog(message: string): void {
  console.log(`[fit/intervals] ${message}`);
}

function pollLogError(message: string): void {
  console.error(`[fit/intervals] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/*
 * Configuration.
 */

/** Les identifiants d'un compte, tels qu'un cycle de rapatriement les consomme. */
type IntervalsSettings = {
  /** Identifiant côté intervals.icu (`i123456`, ou `0` pour le porteur de la clé). */
  athleteId: string;
  apiKey: string;
  lookbackDays: number;
};

type ServiceConfig = {
  inboxDir: string;
  watchIntervalS: number;
  /** Cadence des cycles de rapatriement — réglage global, commun à tous les comptes. */
  pollIntervalS: number;
  /** Profondeur de la fenêtre glissante — global lui aussi. */
  lookbackDays: number;
};

/**
 * La configuration du service, telle que `src/config/env.ts` la valide.
 *
 * Il n'y a plus d'identifiants intervals.icu ici : ils appartiennent à
 * l'athlète, en base, et sont relus à chaque cycle (cf. {@link pollLoop}).
 * L'environnement ne porte plus que ce qui est commun à toute l'installation —
 * l'emplacement de la boîte de dépôt et les deux cadences.
 *
 * Ce qui peut lever ici, c'est l'accès à `env` lui-même (DATABASE_URL manquante,
 * par exemple) — l'appelant l'attrape.
 */
function readServiceConfig(): ServiceConfig {
  return {
    inboxDir: env.FIT_INBOX_DIR,
    watchIntervalS: env.FIT_WATCH_INTERVAL_S,
    pollIntervalS: env.INTERVALS_POLL_INTERVAL_S,
    lookbackDays: env.INTERVALS_LOOKBACK_DAYS,
  };
}

/*
 * Système de fichiers.
 */

/**
 * Les fichiers réguliers du dossier d'un athlète, avec leur taille et leur date
 * de modification. Les sous-dossiers (`processed/`, `failed/`) sont ignorés.
 */
async function scanAthleteDir(athleteDir: string): Promise<ScannedFile[]> {
  const entries = await readdir(athleteDir, { withFileTypes: true });

  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stats = await stat(join(athleteDir, entry.name));
    files.push({ name: entry.name, sizeBytes: stats.size, mtimeMs: stats.mtimeMs });
  }
  return files;
}

/** Ce que la racine de la boîte de dépôt contient : des dossiers d'athlète, et parfois des orphelins. */
type InboxRoot = {
  /** Dossiers d'athlète, triés par identifiant pour un journal stable d'un tour à l'autre. */
  athletes: { athleteId: number; dir: string }[];
  /**
   * Fichiers `.fit` restés à la racine. Ils n'ont **pas** de propriétaire
   * déductible : ni le nom, ni le contenu d'un FIT ne désignent un compte.
   */
  strays: string[];
};

/**
 * Ce que la racine porte, à ce tour de scan.
 *
 * Tout ce qui n'est ni un dossier d'athlète ni un `.fit` de racine est ignoré
 * sans un mot : les anciens `processed/` et `failed/` de la racine sont des
 * archives d'avant le cloisonnement, elles ne demandent rien à personne.
 */
async function scanInboxRoot(inboxDir: string): Promise<InboxRoot> {
  const entries = await readdir(inboxDir, { withFileTypes: true });

  const athletes: InboxRoot['athletes'] = [];
  const strays: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const athleteId = parseAthleteDirName(entry.name);
      if (athleteId !== null) athletes.push({ athleteId, dir: join(inboxDir, entry.name) });
      continue;
    }
    if (entry.isFile() && isFitFile(entry.name)) strays.push(entry.name);
  }

  athletes.sort((a, b) => a.athleteId - b.athleteId);
  return { athletes, strays };
}

/**
 * Tous les noms de fichiers présents dans le dossier de l'athlète et ses deux
 * archives.
 *
 * C'est la mémoire du rapatriement **de ce compte** : un fichier
 * `intervals-<id>.fit` vu ici, qu'il attende son tour, qu'il ait été ingéré ou
 * qu'il ait échoué, signifie que l'activité a déjà été téléchargée pour lui.
 * Rien à stocker ailleurs, et l'état survit aux redémarrages.
 *
 * Un dossier illisible ou absent (`processed/` n'existe qu'après le premier
 * rangement) est simplement sauté : au pire une activité est retéléchargée, et
 * l'empreinte SHA-256 en base la ramène sur la même ligne.
 */
async function listExistingNames(athleteDir: string): Promise<Set<string>> {
  const names = new Set<string>();

  for (const subdir of ['', PROCESSED_DIR, FAILED_DIR]) {
    let entries: string[];
    try {
      // `turbopackIgnore` : sans lui, l'analyse statique de Turbopack voit un
      // chemin calculé, en déduit qu'il faut tracer *tout* le projet, et recopie
      // les sources (src/, scripts/, README…) dans `.next/standalone` — vérifié.
      // Le chemin est un répertoire de données à l'exécution, il n'a rien à voir
      // avec les modules à embarquer.
      entries = await readdir(join(/* turbopackIgnore: true */ athleteDir, subdir));
    } catch {
      continue;
    }
    for (const entry of entries) names.add(entry);
  }

  return names;
}

/**
 * Le fichier tel qu'il apparaît dans les journaux : `athlete-3/sortie.fit`. Le
 * dossier fait partie de l'identité du fichier — c'est lui qui porte son
 * propriétaire.
 */
function fileLabel(athleteDir: string, name: string): string {
  return `${basename(athleteDir)}/${name}`;
}

/**
 * Range le fichier dans `processed/` ou `failed/` **du dossier de l'athlète**,
 * avec le motif de l'échec dans un `.err.txt` à côté le cas échéant.
 *
 * Ne propage rien : le sort du fichier est secondaire, l'import a déjà eu lieu (ou
 * non) et l'appelant l'a déjà journalisé. `rename` écrase une éventuelle homonyme,
 * ces deux dossiers étant des archives de service — l'activité, elle, vit en base.
 */
async function archive(
  athleteDir: string,
  subdir: string,
  name: string,
  failure: string | null,
): Promise<void> {
  const destination = join(athleteDir, subdir);
  try {
    await mkdir(destination, { recursive: true });
    await rename(join(athleteDir, name), join(destination, name));
    if (failure !== null) {
      await writeFile(
        join(destination, `${basename(name)}.err.txt`),
        `${new Date().toISOString()}\n${failure}\n`,
        'utf8',
      );
    }
  } catch (error) {
    logError(
      `${fileLabel(athleteDir, name)} → impossible de le ranger dans ${subdir}/ : ${errorMessage(error)}`,
    );
  }
}

/**
 * Supprime un temporaire de réception abandonné par un dépôt interrompu.
 *
 * Ne propage rien : un `.part` récalcitrant ne doit pas empêcher le scan
 * d'ingérer les fichiers du même tour. Il sera reproposé au tour suivant.
 */
async function removeOrphanPart(athleteDir: string, name: string): Promise<void> {
  try {
    await rm(join(athleteDir, name), { force: true });
    log(
      `${fileLabel(athleteDir, name)} → temporaire abandonné supprimé (immobile depuis plus de ${ORPHAN_PART_MAX_AGE_MS / 60_000} minutes).`,
    );
  } catch (error) {
    logError(
      `${fileLabel(athleteDir, name)} → suppression du temporaire abandonné impossible : ${errorMessage(error)}`,
    );
  }
}

/*
 * Surveillance du dossier.
 */

/**
 * Ce qu'annonce le journal pour chaque issue d'ingestion. Table exhaustive :
 * un nouveau statut d'`IngestReport` ne compile pas tant qu'il n'a pas sa ligne.
 *
 * `merged` mérite son libellé propre — c'est la seule issue où le fichier
 * ingéré n'est *pas* celui qui a créé l'activité, et donc la seule qui signale
 * un doublon amont.
 */
const INGEST_STATUS_LABELS = {
  created: 'importée',
  updated: 'déjà importée, complétée',
  merged: 'même séance qu’une activité existante, complétée',
} as const satisfies Record<IngestReport['status'], string>;

/**
 * Importe un fichier **pour l'athlète de son dossier**, puis le range. Ne relance
 * jamais : un fichier fautif ne doit pas tuer le service.
 */
async function handleFile(athleteDir: string, athleteId: number, name: string): Promise<void> {
  const label = fileLabel(athleteDir, name);

  let report: IngestReport;
  try {
    report = await ingestFitBuffer(await readFile(join(athleteDir, name)), athleteId);
  } catch (error) {
    // Parsing impossible, base injoignable, athlète supprimé : dans tous les cas
    // le fichier part dans failed/ avec son motif, à charge d'un humain d'y revenir.
    const message = errorMessage(error);
    logError(`${label} → échec : ${message}`);
    await archive(athleteDir, FAILED_DIR, name, message);
    return;
  }

  log(`${label} → ${INGEST_STATUS_LABELS[report.status]} (activité ${report.activityId})`);
  await archive(athleteDir, PROCESSED_DIR, name, null);
}

/** Ce qu'un scan retient d'un tour à l'autre, pour un dossier d'athlète. */
type WatchMemory = {
  /** Tailles du scan précédent — la stabilité se juge d'un tour à l'autre. */
  sizes: ReadonlyMap<string, number>;
  /**
   * Fichiers déjà traités par ce processus, y compris ceux qu'on n'a pas pu
   * déplacer. Réduit à chaque scan aux fichiers encore présents (cf. `planScan`).
   */
  handled: Set<string>;
};

/** Un tour de scan sur le dossier d'un athlète : ingestions, refus, temporaires abandonnés. */
async function scanAthleteInbox(
  athlete: { athleteId: number; dir: string },
  memory: WatchMemory,
  controls: StopControls,
): Promise<void> {
  const plan = planScan(await scanAthleteDir(athlete.dir), {
    sizes: memory.sizes,
    handled: memory.handled,
    now: Date.now(),
  });
  memory.sizes = plan.sizes;
  memory.handled = plan.handled;

  // Reliquats de dépôts interrompus : ils réservent un nom que plus personne ne
  // viendra écrire.
  for (const name of plan.orphanParts) {
    if (controls.stopping) return;
    await removeOrphanPart(athlete.dir, name);
  }

  // Hors gabarit : archivés sans jamais être ouverts — c'est tout l'objet du
  // contrôle de taille, un fichier démesuré ne doit pas entrer en mémoire.
  for (const { name, key, reason } of plan.toReject) {
    if (controls.stopping) return;
    memory.handled.add(key);
    logError(`${fileLabel(athlete.dir, name)} → refusé : ${reason}`);
    await archive(athlete.dir, FAILED_DIR, name, reason);
  }

  for (const [index, { name, key }] of plan.toIngest.entries()) {
    if (controls.stopping) return;
    // Le parsing FIT est synchrone (hash + décodage) et tourne dans la boucle
    // d'événements du serveur HTTP : entre deux fichiers, on rend la main un
    // tour pour que les requêtes en attente soient servies. Sans ça, un backfill
    // de 50 fichiers gèlerait l'interface plusieurs secondes.
    if (index > 0) await controls.sleep(0);
    memory.handled.add(key);
    await handleFile(athlete.dir, athlete.athleteId, name);
  }
}

/**
 * Signale les fichiers restés à la racine, **une fois chacun**.
 *
 * Ils n'ont pas de propriétaire : rien dans un FIT ne désigne un compte, et les
 * façons d'en déposer un à la racine (dépôt antérieur au cloisonnement, fichier
 * posé à la main dans le volume) sont anonymes par construction. Ils ne sont donc ni importés,
 * ni déplacés, ni supprimés — mais le silence en ferait des séances perdues sans
 * trace, ce qui serait pire que tout.
 */
function reportStrayFiles(strays: readonly string[], reported: Set<string>): void {
  const fresh = strays.filter((name) => shouldLogOnce(reported, name));
  if (fresh.length === 0) return;

  logError(
    `${fresh.length} fichier(s) à la racine de l'inbox sans propriétaire (${fresh.slice(0, 5).join(', ')}${fresh.length > 5 ? ', …' : ''}) : ils ne sont pas importés — un fichier appartient au compte dont il porte le dossier. Les réimporter depuis la page « Activités ».`,
  );
}

async function watchLoop(config: ServiceConfig, controls: StopControls): Promise<void> {
  /** Mémoire de scan, par athlète : deux dossiers ne partagent ni tailles ni fichiers traités. */
  const memories = new Map<number, WatchMemory>();
  /** Fichiers de racine déjà signalés — une ligne par fichier, pas une par scan. */
  const reportedStrays = new Set<string>();

  while (!controls.stopping) {
    try {
      const root = await scanInboxRoot(config.inboxDir);
      reportStrayFiles(root.strays, reportedStrays);

      // Un dossier disparu emporte sa mémoire : sur un service qui tourne des
      // mois, la garder ne servirait qu'à la faire grossir.
      const present = new Set(root.athletes.map((athlete) => athlete.athleteId));
      for (const athleteId of memories.keys()) {
        if (!present.has(athleteId)) memories.delete(athleteId);
      }

      for (const athlete of root.athletes) {
        if (controls.stopping) break;
        let memory = memories.get(athlete.athleteId);
        if (memory === undefined) {
          memory = { sizes: new Map(), handled: new Set() };
          memories.set(athlete.athleteId, memory);
        }
        try {
          await scanAthleteInbox(athlete, memory, controls);
        } catch (error) {
          // Le dossier d'un athlète illisible n'empêche pas de servir les
          // autres : chacun est indépendant, et le tour suivant réessaiera.
          if (!controls.stopping) {
            logError(`${basename(athlete.dir)} : scan impossible — ${errorMessage(error)}`);
          }
        }
      }
    } catch (error) {
      // Racine momentanément illisible (montage NFS, volume non monté) : on le
      // signale et on retentera au tour suivant plutôt que de sortir.
      if (!controls.stopping) logError(`scan impossible : ${errorMessage(error)}`);
    }

    if (controls.stopping) break;
    await controls.sleep(config.watchIntervalS * 1000);
  }
}

/*
 * Rapatriement intervals.icu.
 */

/**
 * Ce que le poller retient d'un cycle à l'autre. Rien n'est persisté : le
 * système de fichiers porte déjà l'état qui compte (cf. `listExistingNames`).
 */
type PollMemory = {
  /**
   * Activités dont l'API a répondu « pas de fichier », avec l'instant de la
   * réponse. Purgée au TTL : un 404 peut être transitoire.
   */
  withoutFile: Map<string, number>;
  /** Identifiants illisibles déjà signalés — un id ne redevient pas valide. */
  loggedInvalidIds: Set<string>;
  /** Activités « sans fichier » déjà signalées : une ligne, pas une par tentative. */
  loggedWithoutFile: Set<string>;
  /**
   * Le cycle précédent n'a pas rapatrié tout ce qu'il avait identifié (plafond
   * du cycle, quota, panne). Maintient la fenêtre historique jusqu'à ce qu'un
   * cycle se termine à vide — cf. {@link planPollWindow}.
   *
   * Doublé par le marqueur {@link BACKFILL_MARKER} sur disque : un redémarrage
   * en plein backfill (un simple déploiement suffit) perdrait sinon le reliquat
   * d'historique — des fichiers existent déjà, la fenêtre glissante prendrait
   * le dessus, et les séances les plus anciennes ne seraient plus jamais
   * demandées.
   */
  unfinished: boolean;
};

/**
 * Marqueur « backfill en cours », posé dans le dossier de l'athlète : créé quand
 * une fenêtre historique s'ouvre, supprimé quand un cycle se termine sans
 * reliquat. L'état vit dans le système de fichiers, comme la déduplication — il
 * survit aux redémarrages. Sans extension `.fit` ni suffixe `.part`, le watcher
 * l'ignore. Par athlète, comme tout le reste de cet état : le backfill d'un
 * compte ne dit rien de celui d'un autre.
 */
export const BACKFILL_MARKER = '.backfill-pending';

async function backfillMarkerExists(athleteDir: string): Promise<boolean> {
  try {
    await access(join(athleteDir, BACKFILL_MARKER));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pose ou retire le marqueur, et dit si l'opération a abouti. Ne propage rien :
 * ce marqueur est un confort de reprise, pas une condition du rapatriement. Le
 * faire échouer un cycle entier (droits du volume, disque plein) reviendrait à
 * ne plus rien importer du tout pour une raison secondaire.
 *
 * Exportée pour la reprise après onboarding (`recoverPendingImports`), qui
 * rouvre une fenêtre historique : le marqueur y est le seul moyen de redemander
 * tout l'historique alors que des fichiers ont déjà été rapatriés.
 */
export async function setBackfillMarker(
  athleteDir: string,
  present: boolean,
  now: number,
): Promise<boolean> {
  try {
    if (present) {
      await writeFile(join(athleteDir, BACKFILL_MARKER), `${new Date(now).toISOString()}\n`);
    } else {
      await rm(join(athleteDir, BACKFILL_MARKER), { force: true });
    }
    return true;
  } catch (error) {
    pollLogError(`marqueur de backfill non ${present ? 'posé' : 'retiré'} : ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Journalise l'erreur si elle mérite de l'être, et rend le verdict du module de
 * classification (arrêter le cycle ? attendre combien ?).
 *
 * Le silence ne se déduit **jamais** du type de l'erreur, seulement du drapeau
 * d'arrêt — cf. l'en-tête de `@/lib/intervals/poll-errors`.
 */
function reportPollError(
  error: unknown,
  context: string,
  controls: StopControls,
): PollErrorReport {
  const report = classifyPollError(error, { stopping: controls.stopping });
  if (!report.silent) pollLogError(`${context} → ${report.message}`);
  return report;
}

/**
 * Un cycle **pour un compte** : choisir la fenêtre, lister les activités,
 * télécharger celles qui manquent, les déposer dans le dossier de cet athlète.
 *
 * `athleteDir` n'est pas un détail de rangement : c'est lui qui dit au watcher à
 * qui appartiennent les fichiers déposés ici, longtemps après, et à travers un
 * éventuel redémarrage.
 */
async function pollOnce(
  athleteDir: string,
  settings: IntervalsSettings,
  memory: PollMemory,
  controls: StopControls,
): Promise<PollCycleOutcome> {
  const now = Date.now();
  purgeExpiredWithoutFile(memory.withoutFile, now);

  let plan: PollPlan;
  let pollWindow: PollWindow;
  let listed: number;
  try {
    // Les fichiers déjà là servent deux fois : ils décident de la fenêtre (aucun
    // rapatriement encore fait = on demande tout l'historique) puis de ce qu'il
    // reste à télécharger.
    const existingNames = await listExistingNames(athleteDir);
    pollWindow = planPollWindow({
      existingNames,
      // Le marqueur sur disque prolonge la mémoire du process : un backfill
      // interrompu par un redémarrage reprend au lieu d'abandonner son reliquat.
      unfinished: memory.unfinished || (await backfillMarkerExists(athleteDir)),
      lookbackDays: settings.lookbackDays,
      now,
    });
    if (pollWindow.backfill) {
      // Posé avant les téléchargements : un crash en plein cycle le laisse en
      // place, c'est exactement son rôle. Contenu = date, purement informatif.
      await setBackfillMarker(athleteDir, true, now);
    }
    const activities = await listRecentActivities({
      athleteId: settings.athleteId,
      apiKey: settings.apiKey,
      oldest: pollWindow.oldest,
      signal: controls.signal,
    });
    listed = activities.length;
    plan = planPoll(activities, { existingNames, knownWithoutFile: memory.withoutFile });
  } catch (error) {
    return {
      retryAfterS: reportPollError(error, 'cycle abandonné', controls).retryAfterS,
      listed: null,
      planned: 0,
      deposited: 0,
      remaining: 0,
      backfill: false,
    };
  }

  for (const id of plan.invalidIds) {
    // `JSON.stringify` échappe les caractères de contrôle : cette chaîne vient
    // du réseau et part dans les journaux.
    if (!shouldLogOnce(memory.loggedInvalidIds, id)) continue;
    pollLogError(`activité ignorée : identifiant inattendu ${JSON.stringify(id)}.`);
  }

  /**
   * Activités réglées : fichier déposé, ou constat qu'il n'y en a pas. Une
   * activité que le réseau a fait échouer n'en fait pas partie — c'est du
   * travail en attente, pas du travail fait.
   */
  let settled = 0;
  let deposited = 0;

  /**
   * Ce que le cycle suivant doit savoir : reste-t-il des activités identifiées
   * mais non rapatriées ? Tant que oui, la fenêtre historique est maintenue —
   * sinon une séance ancienne qu'une panne a fait manquer sortirait de la
   * fenêtre glissante avant d'avoir jamais été retentée.
   */
  const rememberProgress = (): void => {
    memory.unfinished = plan.remaining > 0 || settled < plan.toDownload.length;
  };

  const outcome = (retryAfterS: number | null): PollCycleOutcome => ({
    retryAfterS,
    listed,
    planned: plan.toDownload.length,
    deposited,
    remaining: plan.remaining,
    backfill: pollWindow.backfill,
  });

  for (const [index, { activityId, fileName }] of plan.toDownload.entries()) {
    if (controls.stopping) break;
    // Jamais de rafale de téléchargements, même sur un backfill de plusieurs
    // centaines de séances. L'attente est interruptible : un SIGTERM ne l'attend pas.
    const spacingMs = downloadSpacingMs(index);
    if (spacingMs > 0) await controls.sleep(spacingMs);
    if (controls.stopping) break;

    let data: Buffer | null;
    try {
      data = await downloadFitFile({
        apiKey: settings.apiKey,
        activityId,
        signal: controls.signal,
      });
    } catch (error) {
      const report = reportPollError(error, `activité ${activityId}`, controls);
      // Un quota atteint interrompt le cycle sur-le-champ : enchaîner les
      // téléchargements ne ferait qu'aggraver le dépassement. Un 429 sans
      // `Retry-After` interrompt tout autant — c'est `abortCycle` qui décide,
      // pas la présence d'un délai.
      if (report.abortCycle) {
        rememberProgress();
        return outcome(report.retryAfterS);
      }
      continue;
    }

    if (data === null) {
      // Séance saisie à la main : mémorisée pour la journée, on ne la redemandera
      // pas à chaque cycle. Passé le TTL une tentative est refaite — un fichier
      // peut avoir été ajouté depuis, et l'oubli définitif perdrait la séance.
      memory.withoutFile.set(activityId, Date.now());
      settled += 1;
      if (shouldLogOnce(memory.loggedWithoutFile, activityId)) {
        pollLog(
          `activité ${activityId} : aucun fichier original, nouvelle tentative dans ${WITHOUT_FILE_TTL_MS / 3_600_000} h.`,
        );
      }
      continue;
    }

    try {
      await depositInInbox({ inboxDir: athleteDir, fileName, data });
      deposited += 1;
      settled += 1;
      pollLog(`activité ${activityId} → ${fileName} déposé (${data.byteLength} octets).`);
    } catch (error) {
      pollLogError(`activité ${activityId} → dépôt impossible : ${errorMessage(error)}`);
    }
  }

  rememberProgress();

  // Fin de backfill : cycle historique terminé sans reliquat (et sans arrêt en
  // cours, qui laisserait du travail identifié non fait) → le marqueur tombe.
  if (pollWindow.backfill && !memory.unfinished && !controls.stopping) {
    await setBackfillMarker(athleteDir, false, now);
  }

  return outcome(null);
}

/** État du poller entre deux cycles ET entre deux relances de la boucle. */
type PollLoopState = {
  /**
   * Mémoire par athlète. Un compte neuf part avec la sienne, vierge — c'est ce
   * qui lui vaut son propre backfill complet, sans rien devoir à l'historique
   * déjà rapatrié par un autre.
   */
  memories: Map<number, PollMemory>;
  /** Numéro du dernier cycle de chaque compte : le premier parle toujours. */
  cycleNumbers: Map<number, number>;
  /** Comptes sautés déjà signalés (`<athlète>|<motif>`) — une ligne, pas une par cycle. */
  loggedSkips: Set<string>;
  /**
   * Échecs du relevé bien-être déjà signalés (`<athlète>|<jour>`).
   *
   * Le relevé ne pose son marqueur qu'en cas de succès : un échec est donc redû
   * au cycle suivant, toutes les minutes jusqu'au bout de la journée. Une ligne
   * par compte et par journée suffit à le dire — les suivantes ne diraient rien
   * de plus et noieraient les journaux du rapatriement.
   */
  loggedWellnessFailures: Set<string>;
  /** « Aucun compte configuré » a déjà été dit ; il se redira si ça change. */
  announcedNoAccounts: boolean;
};

/**
 * L'état initial vit chez l'appelant (`run()`), pas dans la boucle : `runForever`
 * relance `pollLoop` après une exception imprévue, et une boucle qui recréerait
 * sa mémoire retéléchargerait les séances « sans fichier » (TTL perdu) et
 * rejouerait la ligne « premier cycle » en plein fonctionnement.
 */
function initialPollLoopState(): PollLoopState {
  return {
    memories: new Map(),
    cycleNumbers: new Map(),
    loggedSkips: new Set(),
    loggedWellnessFailures: new Set(),
    announcedNoAccounts: false,
  };
}

function initialPollMemory(): PollMemory {
  return {
    withoutFile: new Map(),
    loggedInvalidIds: new Set(),
    loggedWithoutFile: new Set(),
    unfinished: false,
  };
}

/**
 * Le relevé bien-être d'un compte, journalisé.
 *
 * Rien n'est écrit dans le journal quand il n'y avait rien à faire : le
 * rendez-vous est quotidien, mais la question est posée à chaque cycle. Un échec
 * ne se dit qu'**une fois par journée** — le relevé ne pose son marqueur qu'en
 * cas de succès, il serait donc redemandé (et raté) à chaque minute.
 *
 * Ses erreurs sont attrapées ici : un bien-être qui ne se relève pas ne doit pas
 * coûter le rapatriement des séances du même cycle, qui n'a rien à voir avec lui.
 * Rend le délai que l'API aurait demandé (429), pour que la boucle le respecte.
 */
async function readWellness(
  account: PollableAccount,
  controls: StopControls,
  state: PollLoopState,
): Promise<number | null> {
  try {
    const report = await runDailyWellness(
      account.athleteId,
      { intervalsAthleteId: account.intervalsAthleteId, apiKey: account.apiKey },
      { signal: controls.signal },
    );
    if (report === null) return null;

    const label = athleteDirName(account.athleteId);
    if (report.status === 'saved') {
      pollLog(`${label} : bien-être du ${report.readingDay} — ${report.days} jour(s) relevé(s).`);
      return null;
    }

    if (shouldLogOnce(state.loggedWellnessFailures, `${account.athleteId}|${report.readingDay}`)) {
      pollLogError(
        `${label} : bien-être du ${report.readingDay} — ${report.reason ?? 'échec sans motif'}`,
      );
    }
    return report.retryAfterS;
  } catch (error) {
    // `runDailyWellness` ne lève pas ; ce filet est là pour ce qu'elle n'a pas su
    // nommer, et il ne coûte rien.
    if (!controls.stopping) {
      pollLogError(
        `${athleteDirName(account.athleteId)} : relevé bien-être impossible — ${errorMessage(error)}`,
      );
    }
    return null;
  }
}

/**
 * Un cycle pour un compte, journal compris. Rend le délai que l'API a demandé,
 * s'il en a demandé un.
 *
 * Le dossier de l'athlète est créé au besoin : c'est ici, et nulle part
 * ailleurs, qu'un compte fraîchement configuré obtient sa boîte.
 */
async function pollAccount(
  config: ServiceConfig,
  account: PollableAccount,
  controls: StopControls,
  state: PollLoopState,
): Promise<number | null> {
  const athleteDir = athleteInboxDir(config.inboxDir, account.athleteId);
  try {
    await mkdir(athleteDir, { recursive: true });
  } catch (error) {
    pollLogError(
      `${athleteDirName(account.athleteId)} : dossier inaccessible — ${errorMessage(error)}`,
    );
    return null;
  }

  let memory = state.memories.get(account.athleteId);
  if (memory === undefined) {
    memory = initialPollMemory();
    state.memories.set(account.athleteId, memory);
  }

  const cycleNumber = (state.cycleNumbers.get(account.athleteId) ?? 0) + 1;
  state.cycleNumbers.set(account.athleteId, cycleNumber);

  /*
   * Le rendez-vous quotidien d'abord : il ne coûte qu'une lecture d'état les
   * 1 439 minutes où il n'est pas dû, et il n'a aucune raison d'attendre la fin
   * d'un backfill de plusieurs centaines de fichiers pour avoir lieu.
   */
  const wellnessRetryAfterS = await readWellness(account, controls, state);
  if (controls.stopping) return null;

  const outcome = await pollOnce(
    athleteDir,
    {
      athleteId: account.intervalsAthleteId,
      apiKey: account.apiKey,
      lookbackDays: config.lookbackDays,
    },
    memory,
    controls,
  );
  if (controls.stopping) return null;

  // Un cycle qui trouve du travail ou échoue laisse toujours une trace ; un
  // cycle vide se tait, sauf le premier de ce compte — c'est lui qui répond à
  // « est-ce que ça marche ? » après un démarrage ou après une première clé.
  const summary = pollCycleSummary(cycleNumber, outcome);
  if (summary !== null) pollLog(`${athleteDirName(account.athleteId)} : ${summary}`);

  // Les deux appels parlent au même hôte : un quota atteint sur l'un vaut pour
  // l'autre, et c'est le délai le plus long qui s'applique.
  return mergeRetryAfterS([wellnessRetryAfterS, outcome.retryAfterS]);
}

/**
 * La boucle de rapatriement : un tour = un cycle **par compte configuré**.
 *
 * Les identifiants sont relus à chaque tour, en base : une clé saisie dans les
 * réglages est prise en compte au tour suivant, sans redémarrage. Aucun compte
 * n'en fait échouer un autre — ni une clé illisible, ni un dossier
 * inaccessible, ni une API qui refuse.
 */
async function pollLoop(
  config: ServiceConfig,
  controls: StopControls,
  state: PollLoopState,
): Promise<void> {
  while (!controls.stopping) {
    let accounts: PollableAccount[] = [];
    /**
     * La liste a bien été lue. Distinct de « elle est vide » : une base
     * injoignable ne dit **rien** des comptes configurés, et l'annoncer comme
     * une absence ferait passer une panne pour un service au repos.
     */
    let listed = false;

    try {
      const plan = planAccountsToPoll(await listIntervalsAccounts());
      accounts = plan.accounts;
      listed = true;

      // Une clé devenue illisible (secret d'installation changé) saute ce compte
      // et lui seul, en le disant — jamais en silence, jamais avec sa valeur.
      for (const skipped of plan.skipped) {
        if (!shouldLogOnce(state.loggedSkips, `${skipped.athleteId}|${skipped.reason}`)) continue;
        pollLogError(`${athleteDirName(skipped.athleteId)} : compte sauté — ${skipped.reason}.`);
      }
    } catch (error) {
      // Base injoignable : on ne sait pas quels comptes rapatrier, on le dit et
      // on réessaiera. Ce n'est pas une raison d'arrêter la boucle.
      if (!controls.stopping) pollLogError(`comptes illisibles — ${errorMessage(error)}`);
    }

    if (listed && accounts.length === 0) {
      // Pas une panne : une installation neuve n'a encore rien configuré. Une
      // ligne, une seule, et le service attend.
      if (!state.announcedNoAccounts) {
        state.announcedNoAccounts = true;
        pollLog(
          'aucun compte n’a de clé API intervals.icu enregistrée — rien à rapatrier pour l’instant (Profil → intervals.icu).',
        );
      }
    } else if (accounts.length > 0) {
      state.announcedNoAccounts = false;
    }

    const retryAfters: (number | null)[] = [];
    for (const account of accounts) {
      if (controls.stopping) break;
      retryAfters.push(await pollAccount(config, account, controls, state));
    }

    if (controls.stopping) break;
    // Jamais de rafale : on attend au minimum l'intervalle de cycle, davantage si
    // l'API a demandé plus par `Retry-After` — et jamais au-delà du plafond, un
    // `Retry-After` daté de 2099 ferait déborder `setTimeout`. Le délai le plus
    // long demandé vaut pour tous : les comptes partagent le même hôte.
    await controls.sleep(nextPollDelayMs(mergeRetryAfterS(retryAfters), config.pollIntervalS));
  }
}

/*
 * Démarrage.
 */

/**
 * Dernier recours : ce qui aurait dû tuer la boucle la relance à la place.
 *
 * Les boucles attrapent déjà leurs erreurs attendues. Celles qui arrivent ici
 * sont, par définition, celles qu'on n'avait pas prévues — et c'est précisément
 * pour celles-là que le filet existe : rien de ce que fait l'import ne doit
 * pouvoir faire tomber le serveur HTTP.
 */
async function runForever(
  name: string,
  loop: () => Promise<void>,
  controls: StopControls,
): Promise<void> {
  while (!controls.stopping) {
    try {
      await loop();
      // Sortie normale : la boucle n'en sort que sur demande d'arrêt.
      return;
    } catch (error) {
      if (controls.stopping) return;
      logError(
        `${name} : erreur inattendue (${errorMessage(error)}) — reprise dans ${LOOP_RESTART_DELAY_MS / 1_000} s.`,
      );
      await controls.sleep(LOOP_RESTART_DELAY_MS);
    }
  }
}

/**
 * Une ligne, au démarrage, qui répond à « est-ce que ça tourne ? ».
 *
 * Elle ne dit plus si le poller est actif : ça ne dépend plus de la
 * configuration du serveur mais des comptes, relus à chaque cycle. C'est le
 * premier tour de {@link pollLoop} qui l'annonce — « aucun compte configuré » ou
 * le compte rendu de son premier cycle.
 */
function startupLine(config: ServiceConfig): string {
  return `service FIT démarré — inbox: ${config.inboxDir} (un dossier par athlète, scan toutes les ${config.watchIntervalS} s), poll intervals.icu: toutes les ${config.pollIntervalS} s par compte configuré, fenêtre ${config.lookbackDays} j, par tranches de ${MAX_DOWNLOADS_PER_CYCLE}`;
}

async function run(controls: StopControls): Promise<void> {
  let config: ServiceConfig;
  try {
    config = readServiceConfig();
  } catch (error) {
    logError(
      `service FIT inactif — configuration illisible : ${errorMessage(error)}. L'application continue de servir.`,
    );
    return;
  }

  try {
    await mkdir(config.inboxDir, { recursive: true });
  } catch (error) {
    logError(
      `service FIT inactif — inbox ${config.inboxDir} inaccessible : ${errorMessage(error)}. L'application continue de servir.`,
    );
    return;
  }

  log(startupLine(config));
  pollLog(wellnessStartupLine());

  // L'état du poller survit aux relances de `runForever` — cf. `initialPollLoopState`.
  const pollState = initialPollLoopState();
  await Promise.all([
    runForever('surveillance du dossier', () => watchLoop(config, controls), controls),
    runForever(
      'rapatriement intervals.icu',
      () => pollLoop(config, controls, pollState),
      controls,
    ),
  ]);

  log('service FIT arrêté.');
}

export type FitService = {
  /**
   * Demande l'arrêt : le drapeau est levé et les appels en vol annulés
   * **immédiatement**, de façon synchrone. La promesse retournée se résout quand
   * les deux boucles ont rendu la main.
   *
   * Ne pas compter sur cette promesse pour du travail critique : Next installe
   * son propre gestionnaire de SIGTERM qui appelle `process.exit` dès sa propre
   * fermeture terminée — vérifié, une continuation asynchrone de 5 ms n'a déjà
   * plus la main. C'est sans conséquence : le dépôt de fichier passe par
   * `.part` + renommage, et l'idempotence de l'ingestion tient à l'empreinte
   * SHA-256, pas à une fermeture propre.
   */
  stop(): Promise<void>;
};

/**
 * Démarre les deux boucles d'import et rend la main aussitôt.
 *
 * Ne lève jamais : tout ce qui peut mal se passer (configuration, inbox,
 * exception imprévue) est journalisé et laisse le serveur HTTP intact.
 */
export function startFitService(): FitService {
  /*
   * Le plafond d'attente est plus serré que celui du module partagé : un
   * `Retry-After` abusif d'intervals.icu ne doit pas endormir le poller plus
   * d'une heure (cf. `nextPollDelayMs`, qui borne déjà le délai demandé — ceci
   * en est le garde-fou de dernier recours).
   */
  const controls = createStopControls({ maxSleepMs: MAX_SLEEP_MS });

  const running = run(controls).catch((error: unknown) => {
    // Filet ultime : `run` attrape déjà tout ce qu'il sait nommer.
    logError(`service FIT arrêté sur une erreur imprévue : ${errorMessage(error)}`);
  });

  return {
    stop(): Promise<void> {
      controls.requestStop();
      return running;
    },
  };
}
