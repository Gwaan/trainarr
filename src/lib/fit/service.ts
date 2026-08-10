import 'server-only';

/**
 * Service d'import FIT : deux boucles longue durée, dans le process du serveur.
 *
 * ## Ce que fait le service
 *
 * - **Surveillance du dossier** — toutes les `FIT_WATCH_INTERVAL_S` secondes, il
 *   liste `FIT_INBOX_DIR`, importe les fichiers `.fit` dont l'upload est
 *   terminé, puis les range dans `processed/` ou `failed/`.
 * - **Rapatriement intervals.icu** — quand une clé API est configurée, une
 *   seconde boucle indépendante récupère les fichiers d'activité déposés là par
 *   HealthFit et les dépose dans la même boîte d'import. La séparation est
 *   stricte : le poller parle au réseau et écrit des fichiers, il ne parse ni
 *   n'ingère rien ; le watcher parle à la base. Les deux ne se croisent que par
 *   le répertoire. Tant qu'aucune séance n'a été rapatriée, cette boucle demande
 *   tout l'historique plutôt que la fenêtre glissante — par tranches, sur
 *   plusieurs cycles (cf. `planPollWindow` et `MAX_DOWNLOADS_PER_CYCLE`).
 *
 * Scan par intervalle plutôt qu'inotify, volontairement : le dépôt se fait par
 * WebDAV sur un volume Docker (et, à terme, possiblement un partage réseau) où
 * les événements inotify ne sont pas fiables, et cela évite une dépendance de
 * plus pour surveiller un répertoire qui reçoit quelques fichiers par semaine.
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
import { ingestFitBuffer, type IngestReport } from '@/lib/fit/ingest';
import { ORPHAN_PART_MAX_AGE_MS, planScan, type ScannedFile } from '@/lib/fit/watch-plan';
import { downloadFitFile, listRecentActivities } from '@/lib/intervals/client';
import { depositInInbox } from '@/lib/intervals/inbox';
import { classifyPollError, type PollErrorReport } from '@/lib/intervals/poll-errors';
import {
  downloadSpacingMs,
  MAX_DOWNLOADS_PER_CYCLE,
  MAX_SLEEP_MS,
  nextPollDelayMs,
  planPoll,
  planPollerActivation,
  planPollWindow,
  pollCycleSummary,
  purgeExpiredWithoutFile,
  shouldLogOnce,
  WITHOUT_FILE_TTL_MS,
  type PollCycleOutcome,
  type PollPlan,
  type PollWindow,
} from '@/lib/intervals/poll-plan';

const PROCESSED_DIR = 'processed';
const FAILED_DIR = 'failed';

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
 * Arrêt.
 */

type StopControls = {
  /** État réel du drapeau d'arrêt — c'est lui, et lui seul, qui autorise le silence. */
  readonly stopping: boolean;
  /** Annulation des appels réseau en vol. */
  readonly signal: AbortSignal;
  /** Attente interruptible, plafonnée à {@link MAX_SLEEP_MS}. */
  sleep(ms: number): Promise<void>;
  requestStop(): void;
};

/**
 * Le drapeau d'arrêt, les réveils et l'annulation réseau, dans une portée fermée
 * plutôt qu'en variables de module : deux démarrages du service (rechargement à
 * chaud en développement) partageraient sinon le même état, et le premier arrêt
 * couperait les boucles du second.
 */
function createStopControls(): StopControls {
  let stopping = false;
  /**
   * Réveils des attentes en cours. Un ensemble et non une référence unique : le
   * watcher et le poller dorment chacun de leur côté, réveiller le dernier
   * endormi laisserait l'autre traîner jusqu'à son échéance — jusqu'à une heure
   * pour le poller, soit un SIGKILL de Docker.
   */
  const sleepers = new Set<() => void>();
  /**
   * Le drapeau `stopping` n'est relu qu'entre deux étapes : un appel HTTP
   * suspendu retiendrait le poller jusqu'aux temporisations d'undici (300 s),
   * bien après le délai de grâce de Docker — donc un SIGKILL, au milieu d'un
   * dépôt de fichier.
   */
  const inFlight = new AbortController();

  return {
    get stopping() {
      return stopping;
    },
    get signal() {
      return inFlight.signal;
    },
    /**
     * Le plafond est un garde-fou de dernier recours : au-delà de 2³¹−1 ms,
     * `setTimeout` retombe à 1 ms et la boucle se met à tourner à vide. Les
     * appelants bornent déjà leur délai (cf. `nextPollDelayMs`) ; celui-ci
     * garantit qu'aucune configuration ne peut faire déborder le compteur.
     */
    sleep(ms: number): Promise<void> {
      if (stopping) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          sleepers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(ms, MAX_SLEEP_MS));
        sleepers.add(done);
      });
    },
    requestStop(): void {
      if (stopping) return;
      stopping = true;
      inFlight.abort();
      for (const wake of [...sleepers]) wake();
    },
  };
}

/*
 * Configuration.
 */

type IntervalsSettings = {
  athleteId: string;
  apiKey: string;
  pollIntervalS: number;
  lookbackDays: number;
};

type ServiceConfig = {
  inboxDir: string;
  watchIntervalS: number;
  /** `null` quand le poller ne démarre pas — {@link pollerInactiveReason} dit pourquoi. */
  intervals: IntervalsSettings | null;
  pollerInactiveReason: string | null;
};

/**
 * La configuration du service, telle que `src/config/env.ts` la valide.
 *
 * Une clé absente ou un identifiant d'athlète illisible ne lève pas : le poller
 * seul est désactivé, avec son motif. Ce qui peut lever ici, c'est l'accès à
 * `env` lui-même (DATABASE_URL manquante, par exemple) — l'appelant l'attrape.
 */
function readServiceConfig(): ServiceConfig {
  const activation = planPollerActivation({
    athleteId: env.INTERVALS_ATHLETE_ID,
    apiKey: env.INTERVALS_API_KEY,
  });

  return {
    inboxDir: env.FIT_INBOX_DIR,
    watchIntervalS: env.FIT_WATCH_INTERVAL_S,
    intervals: activation.active
      ? {
          athleteId: activation.athleteId,
          apiKey: activation.apiKey,
          pollIntervalS: env.INTERVALS_POLL_INTERVAL_S,
          lookbackDays: env.INTERVALS_LOOKBACK_DAYS,
        }
      : null,
    pollerInactiveReason: activation.active ? null : activation.reason,
  };
}

/*
 * Système de fichiers.
 */

/**
 * Les fichiers réguliers du dossier, avec leur taille et leur date de
 * modification. Les sous-dossiers (`processed/`, `failed/`) sont ignorés.
 */
async function scanInbox(inboxDir: string): Promise<ScannedFile[]> {
  const entries = await readdir(inboxDir, { withFileTypes: true });

  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stats = await stat(join(inboxDir, entry.name));
    files.push({ name: entry.name, sizeBytes: stats.size, mtimeMs: stats.mtimeMs });
  }
  return files;
}

/**
 * Tous les noms de fichiers présents dans la boîte de dépôt et ses deux
 * archives.
 *
 * C'est la mémoire du rapatriement : un fichier `intervals-<id>.fit` vu ici,
 * qu'il attende son tour, qu'il ait été ingéré ou qu'il ait échoué, signifie que
 * l'activité a déjà été téléchargée. Rien à stocker ailleurs, et l'état survit
 * aux redémarrages.
 *
 * Un dossier illisible ou absent (`processed/` n'existe qu'après le premier
 * rangement) est simplement sauté : au pire une activité est retéléchargée, et
 * l'empreinte SHA-256 en base la ramène sur la même ligne.
 */
async function listExistingNames(inboxDir: string): Promise<Set<string>> {
  const names = new Set<string>();

  for (const subdir of ['', PROCESSED_DIR, FAILED_DIR]) {
    let entries: string[];
    try {
      // `turbopackIgnore` : sans lui, l'analyse statique de Turbopack voit un
      // chemin calculé, en déduit qu'il faut tracer *tout* le projet, et recopie
      // les sources (src/, scripts/, README…) dans `.next/standalone` — vérifié.
      // Le chemin est un répertoire de données à l'exécution, il n'a rien à voir
      // avec les modules à embarquer.
      entries = await readdir(join(/* turbopackIgnore: true */ inboxDir, subdir));
    } catch {
      continue;
    }
    for (const entry of entries) names.add(entry);
  }

  return names;
}

/**
 * Range le fichier dans `processed/` ou `failed/`, avec le motif de l'échec dans
 * un `.err.txt` à côté le cas échéant.
 *
 * Ne propage rien : le sort du fichier est secondaire, l'import a déjà eu lieu (ou
 * non) et l'appelant l'a déjà journalisé. `rename` écrase une éventuelle homonyme,
 * ces deux dossiers étant des archives de service — l'activité, elle, vit en base.
 */
async function archive(
  inboxDir: string,
  subdir: string,
  name: string,
  failure: string | null,
): Promise<void> {
  const destination = join(inboxDir, subdir);
  try {
    await mkdir(destination, { recursive: true });
    await rename(join(inboxDir, name), join(destination, name));
    if (failure !== null) {
      await writeFile(
        join(destination, `${basename(name)}.err.txt`),
        `${new Date().toISOString()}\n${failure}\n`,
        'utf8',
      );
    }
  } catch (error) {
    logError(`${name} → impossible de le ranger dans ${subdir}/ : ${errorMessage(error)}`);
  }
}

/**
 * Supprime un temporaire de réception abandonné par un envoi WebDAV interrompu.
 *
 * Ne propage rien : un `.part` récalcitrant ne doit pas empêcher le scan
 * d'ingérer les fichiers du même tour. Il sera reproposé au tour suivant.
 */
async function removeOrphanPart(inboxDir: string, name: string): Promise<void> {
  try {
    await rm(join(inboxDir, name), { force: true });
    log(
      `${name} → temporaire abandonné supprimé (immobile depuis plus de ${ORPHAN_PART_MAX_AGE_MS / 60_000} minutes).`,
    );
  } catch (error) {
    logError(`${name} → suppression du temporaire abandonné impossible : ${errorMessage(error)}`);
  }
}

/*
 * Surveillance du dossier.
 */

/** Importe un fichier puis le range. Ne relance jamais : un fichier fautif ne doit pas tuer le service. */
async function handleFile(inboxDir: string, name: string): Promise<void> {
  let report: IngestReport;
  try {
    report = await ingestFitBuffer(await readFile(join(inboxDir, name)));
  } catch (error) {
    // Parsing impossible, base injoignable, athlète absent : dans tous les cas le
    // fichier part dans failed/ avec son motif, à charge d'un humain d'y revenir.
    const message = errorMessage(error);
    logError(`${name} → échec : ${message}`);
    await archive(inboxDir, FAILED_DIR, name, message);
    return;
  }

  log(`${name} → ${report.status} (activité ${report.activityId})`);
  await archive(inboxDir, PROCESSED_DIR, name, null);
}

async function watchLoop(config: ServiceConfig, controls: StopControls): Promise<void> {
  /** Tailles du scan précédent — la stabilité se juge d'un tour à l'autre. */
  let sizes: ReadonlyMap<string, number> = new Map();
  /**
   * Fichiers déjà traités par ce processus, y compris ceux qu'on n'a pas pu
   * déplacer. Réduit à chaque scan aux fichiers encore présents (cf. `planScan`).
   */
  let handled = new Set<string>();

  while (!controls.stopping) {
    try {
      const plan = planScan(await scanInbox(config.inboxDir), {
        sizes,
        handled,
        now: Date.now(),
      });
      sizes = plan.sizes;
      handled = plan.handled;

      // Reliquats d'envois interrompus : ils réservent un nom que plus personne
      // ne viendra écrire, et que le dépôt WebDAV refuse donc de réutiliser.
      for (const name of plan.orphanParts) {
        if (controls.stopping) break;
        await removeOrphanPart(config.inboxDir, name);
      }

      // Hors gabarit : archivés sans jamais être ouverts — c'est tout l'objet du
      // contrôle de taille, un fichier démesuré ne doit pas entrer en mémoire.
      for (const { name, key, reason } of plan.toReject) {
        if (controls.stopping) break;
        handled.add(key);
        logError(`${name} → refusé : ${reason}`);
        await archive(config.inboxDir, FAILED_DIR, name, reason);
      }

      for (const [index, { name, key }] of plan.toIngest.entries()) {
        if (controls.stopping) break;
        // Le parsing FIT est synchrone (hash + décodage) et tourne dans la
        // boucle d'événements du serveur HTTP : entre deux fichiers, on rend la
        // main un tour pour que les requêtes en attente soient servies. Sans ça,
        // un backfill de 50 fichiers gèlerait l'interface plusieurs secondes.
        if (index > 0) await controls.sleep(0);
        handled.add(key);
        await handleFile(config.inboxDir, name);
      }
    } catch (error) {
      // Répertoire momentanément illisible (montage NFS, volume non monté) :
      // on le signale et on retentera au tour suivant plutôt que de sortir.
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
 * Marqueur « backfill en cours », posé dans l'inbox : créé quand une fenêtre
 * historique s'ouvre, supprimé quand un cycle se termine sans reliquat. L'état
 * vit dans le système de fichiers, comme la déduplication — il survit aux
 * redémarrages. Sans extension `.fit` ni suffixe `.part`, le watcher l'ignore.
 */
const BACKFILL_MARKER = '.backfill-pending';

async function backfillMarkerExists(inboxDir: string): Promise<boolean> {
  try {
    await access(join(inboxDir, BACKFILL_MARKER));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pose ou retire le marqueur. Ne propage rien : ce marqueur est un confort de
 * reprise, pas une condition du rapatriement. Le faire échouer un cycle entier
 * (droits du volume, disque plein) reviendrait à ne plus rien importer du tout
 * pour une raison secondaire.
 */
async function setBackfillMarker(inboxDir: string, present: boolean, now: number): Promise<void> {
  try {
    if (present) {
      await writeFile(join(inboxDir, BACKFILL_MARKER), `${new Date(now).toISOString()}\n`);
    } else {
      await rm(join(inboxDir, BACKFILL_MARKER), { force: true });
    }
  } catch (error) {
    pollLogError(`marqueur de backfill non ${present ? 'posé' : 'retiré'} : ${errorMessage(error)}`);
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
 * Un cycle : choisir la fenêtre, lister les activités, télécharger celles qui
 * manquent, les déposer dans la boîte d'import.
 */
async function pollOnce(
  inboxDir: string,
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
    const existingNames = await listExistingNames(inboxDir);
    pollWindow = planPollWindow({
      existingNames,
      // Le marqueur sur disque prolonge la mémoire du process : un backfill
      // interrompu par un redémarrage reprend au lieu d'abandonner son reliquat.
      unfinished: memory.unfinished || (await backfillMarkerExists(inboxDir)),
      lookbackDays: settings.lookbackDays,
      now,
    });
    if (pollWindow.backfill) {
      // Posé avant les téléchargements : un crash en plein cycle le laisse en
      // place, c'est exactement son rôle. Contenu = date, purement informatif.
      await setBackfillMarker(inboxDir, true, now);
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
      await depositInInbox({ inboxDir, fileName, data });
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
    await setBackfillMarker(inboxDir, false, now);
  }

  return outcome(null);
}

/** État du poller entre deux cycles ET entre deux relances de la boucle. */
type PollLoopState = {
  memory: PollMemory;
  cycleNumber: number;
};

/**
 * L'état initial vit chez l'appelant (`run()`), pas dans la boucle : `runForever`
 * relance `pollLoop` après une exception imprévue, et une boucle qui recréerait
 * sa mémoire retéléchargerait les séances « sans fichier » (TTL perdu) et
 * rejouerait la ligne « premier cycle » en plein fonctionnement.
 */
function initialPollLoopState(): PollLoopState {
  return {
    memory: {
      withoutFile: new Map(),
      loggedInvalidIds: new Set(),
      loggedWithoutFile: new Set(),
      unfinished: false,
    },
    cycleNumber: 0,
  };
}

async function pollLoop(
  inboxDir: string,
  settings: IntervalsSettings,
  controls: StopControls,
  state: PollLoopState,
): Promise<void> {
  const { memory } = state;

  while (!controls.stopping) {
    state.cycleNumber += 1;
    const cycleNumber = state.cycleNumber;
    const outcome = await pollOnce(inboxDir, settings, memory, controls);
    if (controls.stopping) break;

    // Un cycle qui trouve du travail ou échoue laisse toujours une trace ; un
    // cycle vide se tait, sauf le premier — c'est lui qui répond à « est-ce que
    // ça marche ? » après un démarrage.
    const summary = pollCycleSummary(cycleNumber, outcome);
    if (summary !== null) pollLog(summary);

    // Jamais de rafale : on attend au minimum l'intervalle de cycle, davantage si
    // l'API a demandé plus par `Retry-After` — et jamais au-delà du plafond, un
    // `Retry-After` daté de 2099 ferait déborder `setTimeout`.
    await controls.sleep(nextPollDelayMs(outcome.retryAfterS, settings.pollIntervalS));
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

/** Une ligne, au démarrage, qui répond à « est-ce que ça tourne ? ». */
function startupLine(config: ServiceConfig): string {
  const poller =
    config.intervals === null
      ? `inactif (${config.pollerInactiveReason ?? 'raison inconnue'})`
      : `actif (${config.intervals.pollIntervalS} s, athlète ${config.intervals.athleteId}, fenêtre ${config.intervals.lookbackDays} j, par tranches de ${MAX_DOWNLOADS_PER_CYCLE})`;

  return `service FIT démarré — inbox: ${config.inboxDir} (scan toutes les ${config.watchIntervalS} s), poll intervals.icu: ${poller}`;
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

  const intervals = config.intervals;
  // L'état du poller survit aux relances de `runForever` — cf. `initialPollLoopState`.
  const pollState = initialPollLoopState();
  await Promise.all([
    runForever('surveillance du dossier', () => watchLoop(config, controls), controls),
    intervals === null
      ? Promise.resolve()
      : runForever(
          'rapatriement intervals.icu',
          () => pollLoop(config.inboxDir, intervals, controls, pollState),
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
  const controls = createStopControls();

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
