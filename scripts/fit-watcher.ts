/**
 * Service de surveillance du dossier d'import FIT.
 *
 * Boucle longue durée : toutes les `FIT_WATCH_INTERVAL_S` secondes, il liste
 * `FIT_INBOX_DIR`, importe les fichiers `.fit` dont l'upload est terminé, puis
 * les range dans `processed/` ou `failed/`.
 *
 * Une **seconde boucle**, indépendante, tourne dans le même process quand
 * intervals.icu est configuré : elle rapatrie les fichiers d'activité déposés là
 * par HealthFit et les dépose dans la même boîte d'import. La séparation est
 * stricte — le poller parle au réseau et écrit des fichiers, il ne parse ni
 * n'ingère rien ; le watcher parle à la base. Les deux ne se croisent que par le
 * répertoire. Tant qu'aucune séance n'a été rapatriée, cette boucle demande tout
 * l'historique plutôt que la fenêtre glissante — par tranches, sur plusieurs
 * cycles (cf. `planPollWindow` et `MAX_DOWNLOADS_PER_CYCLE`).
 *
 * Scan par intervalle plutôt qu'inotify, volontairement : le dépôt se fait par
 * WebDAV sur un volume Docker (et, à terme, possiblement un partage réseau) où
 * les événements inotify ne sont pas fiables, et cela évite une dépendance de
 * plus pour surveiller un répertoire qui reçoit quelques fichiers par semaine.
 *
 * Point d'entrée exécutable, pas un module applicatif : comme `scripts/seed.ts`
 * il charge lui-même `.env.local` puis `.env` et lit sa configuration dans
 * `process.env`. Il importe en revanche le DAL (via `lib/fit/ingest`), qui est
 * marqué `server-only` — d'où le `--conditions=react-server` du script npm
 * `fit:watch`, sans lequel l'import lèverait.
 *
 * Usage : `pnpm fit:watch`.
 */

import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';

import { ingestFitBuffer, type IngestReport } from '@/lib/fit/ingest';
import { ORPHAN_PART_MAX_AGE_MS, planScan, type ScannedFile } from '@/lib/fit/watch-plan';
import {
  downloadFitFile,
  IntervalsAbortError,
  IntervalsAuthError,
  IntervalsRateLimitError,
  listRecentActivities,
} from '@/lib/intervals/client';
import { depositInInbox } from '@/lib/intervals/inbox';
import {
  downloadSpacingMs,
  MAX_DOWNLOADS_PER_CYCLE,
  MAX_SLEEP_MS,
  missingIntervalsSettings,
  nextPollDelayMs,
  planPoll,
  planPollWindow,
  purgeExpiredWithoutFile,
  shouldLogOnce,
  WITHOUT_FILE_TTL_MS,
  type PollPlan,
  type PollWindow,
} from '@/lib/intervals/poll-plan';

const PROCESSED_DIR = 'processed';
const FAILED_DIR = 'failed';

const configSchema = z.object({
  /** Répertoire surveillé — celui que le service WebDAV expose. */
  FIT_INBOX_DIR: z.string().min(1).default('/data/fit-inbox'),
  /**
   * Intervalle entre deux scans. C'est aussi le délai minimal avant qu'un fichier
   * soit jugé stable : sa taille doit être identique sur deux scans consécutifs.
   */
  FIT_WATCH_INTERVAL_S: z.coerce.number().int().positive().default(30),

  /*
   * Rapatriement intervals.icu. Le poller ne démarre que si l'identifiant
   * d'athlète ET la clé API sont renseignés — sinon le service se comporte
   * exactement comme avant.
   */
  INTERVALS_ATHLETE_ID: z
    .string()
    .regex(/^i\d+$/, "identifiant d'athlète intervals.icu attendu, de la forme i123456")
    .optional(),
  INTERVALS_API_KEY: z.string().min(1).optional(),
  INTERVALS_POLL_INTERVAL_S: z.coerce.number().int().positive().default(60),
  INTERVALS_LOOKBACK_DAYS: z.coerce.number().int().positive().default(30),
});

type Config = z.infer<typeof configSchema>;

function loadEnvFile(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Fichier absent : normal selon l'environnement (dev vs Docker).
  }
}

/** Une variable définie mais vide équivaut à une variable absente (cf. `src/config/env.ts`). */
function readConfig(): Config {
  const source: Record<string, string> = {};
  for (const key of Object.keys(configSchema.shape)) {
    const value = process.env[key];
    if (value !== undefined && value.trim() !== '') source[key] = value;
  }

  const result = configSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(racine)'} : ${issue.message}`,
    );
    throw new Error(['Configuration du watcher FIT invalide :', ...lines].join('\n'));
  }
  return result.data;
}

function log(message: string): void {
  console.log(`[fit-watcher] ${message}`);
}

function logError(message: string): void {
  console.error(`[fit-watcher] ${message}`);
}

/** Journaux du poller, préfixés à part : deux boucles écrivent sur la même sortie. */
function pollLog(message: string): void {
  console.log(`[fit-watcher/intervals] ${message}`);
}

function pollLogError(message: string): void {
  console.error(`[fit-watcher/intervals] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/*
 * Boucle et arrêt propre.
 */

let stopping = false;
/**
 * Réveils des attentes en cours (arrêt immédiat entre deux tours). Un ensemble
 * et non une référence unique : le watcher et le poller dorment chacun de leur
 * côté, réveiller le dernier endormi laisserait l'autre traîner jusqu'à son
 * échéance — jusqu'à cinq minutes pour le poller, soit un SIGKILL de Docker.
 */
const sleepers = new Set<() => void>();
/**
 * Annulation des appels réseau en vol.
 *
 * Le drapeau `stopping` n'est relu qu'entre deux étapes : un appel HTTP
 * suspendu retiendrait le poller jusqu'aux temporisations d'undici (300 s),
 * bien après le délai de grâce de Docker — donc un SIGKILL, au milieu d'un
 * dépôt de fichier.
 */
const inFlight = new AbortController();

function requestStop(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`${signal} reçu : arrêt après le fichier en cours.`);
  inFlight.abort();
  for (const wake of [...sleepers]) wake();
}

/**
 * Attente interruptible, plafonnée à {@link MAX_SLEEP_MS}.
 *
 * Ce plafond est un garde-fou de dernier recours : au-delà de 2³¹−1 ms,
 * `setTimeout` retombe à 1 ms et la boucle se met à tourner à vide. Les appelants
 * bornent déjà leur délai (cf. `nextPollDelayMs`) ; celui-ci garantit qu'aucune
 * configuration ne peut faire déborder le compteur.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      sleepers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, Math.min(ms, MAX_SLEEP_MS));
    sleepers.add(done);
  });
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
      entries = await readdir(join(inboxDir, subdir));
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
 * Traitement.
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

/** Boucle de surveillance du dossier : le comportement historique du service. */
async function watchLoop(config: Config): Promise<void> {
  /** Tailles du scan précédent — la stabilité se juge d'un tour à l'autre. */
  let sizes: ReadonlyMap<string, number> = new Map();
  /**
   * Fichiers déjà traités par ce processus, y compris ceux qu'on n'a pas pu
   * déplacer. Réduit à chaque scan aux fichiers encore présents (cf. `planScan`).
   */
  let handled = new Set<string>();

  while (!stopping) {
    try {
      const plan = planScan(await scanInbox(config.FIT_INBOX_DIR), {
        sizes,
        handled,
        now: Date.now(),
      });
      sizes = plan.sizes;
      handled = plan.handled;

      // Reliquats d'envois interrompus : ils réservent un nom que plus personne
      // ne viendra écrire, et que le dépôt WebDAV refuse donc de réutiliser.
      for (const name of plan.orphanParts) {
        if (stopping) break;
        await removeOrphanPart(config.FIT_INBOX_DIR, name);
      }

      // Hors gabarit : archivés sans jamais être ouverts — c'est tout l'objet du
      // contrôle de taille, un fichier démesuré ne doit pas entrer en mémoire.
      for (const { name, key, reason } of plan.toReject) {
        if (stopping) break;
        handled.add(key);
        logError(`${name} → refusé : ${reason}`);
        await archive(config.FIT_INBOX_DIR, FAILED_DIR, name, reason);
      }

      for (const { name, key } of plan.toIngest) {
        if (stopping) break;
        handled.add(key);
        await handleFile(config.FIT_INBOX_DIR, name);
      }
    } catch (error) {
      // Répertoire momentanément illisible (montage NFS, volume non monté) :
      // on le signale et on retentera au tour suivant plutôt que de sortir.
      logError(`scan impossible : ${errorMessage(error)}`);
    }

    if (stopping) break;
    await sleep(config.FIT_WATCH_INTERVAL_S * 1000);
  }
}

/*
 * Rapatriement intervals.icu.
 */

type IntervalsSettings = {
  athleteId: string;
  apiKey: string;
  pollIntervalS: number;
  lookbackDays: number;
};

/**
 * Le poller est actif, ou bien il nomme précisément ce qui lui manque — dire
 * « les deux » quand une seule variable manque enverrait chercher au mauvais
 * endroit.
 */
type IntervalsSetup =
  | { active: true; settings: IntervalsSettings }
  | { active: false; missing: string[] };

function readIntervalsSettings(config: Config): IntervalsSetup {
  const missing = missingIntervalsSettings({
    athleteId: config.INTERVALS_ATHLETE_ID,
    apiKey: config.INTERVALS_API_KEY,
  });
  if (config.INTERVALS_ATHLETE_ID === undefined || config.INTERVALS_API_KEY === undefined) {
    return { active: false, missing };
  }
  return {
    active: true,
    settings: {
      athleteId: config.INTERVALS_ATHLETE_ID,
      apiKey: config.INTERVALS_API_KEY,
      pollIntervalS: config.INTERVALS_POLL_INTERVAL_S,
      lookbackDays: config.INTERVALS_LOOKBACK_DAYS,
    },
  };
}

/**
 * Journalise l'erreur et retourne le délai d'attente qu'elle impose, en
 * secondes, s'il y en a un. Rien n'est relancé : une API indisponible ne doit
 * pas emporter le service, le cycle suivant réessaiera.
 */
function reportPollError(error: unknown, context: string): number | null {
  if (error instanceof IntervalsAbortError && !error.timedOut) {
    // Le seul signal d'annulation branché sur ces appels est celui de l'arrêt :
    // c'est une sortie propre, pas un incident à journaliser.
    return null;
  }
  if (error instanceof IntervalsRateLimitError) {
    pollLogError(`${context} → ${error.message}`);
    return error.retryAfterS;
  }
  if (error instanceof IntervalsAuthError) {
    // Ce cas-là ne se résoudra pas tout seul, mais rien ne justifie d'arrêter le
    // watcher : les dépôts WebDAV, eux, continuent d'arriver.
    pollLogError(`${context} → ${error.message}`);
    return null;
  }
  pollLogError(`${context} → ${errorMessage(error)}`);
  return null;
}

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
 * Un cycle : choisir la fenêtre, lister les activités, télécharger celles qui
 * manquent, les déposer dans la boîte d'import. Retourne le délai imposé par un
 * quota, en secondes, ou `null`.
 */
async function pollOnce(
  inboxDir: string,
  settings: IntervalsSettings,
  memory: PollMemory,
): Promise<number | null> {
  const now = Date.now();
  purgeExpiredWithoutFile(memory.withoutFile, now);

  let plan: PollPlan;
  let pollWindow: PollWindow;
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
      await writeFile(join(inboxDir, BACKFILL_MARKER), `${new Date(now).toISOString()}\n`);
    }
    const activities = await listRecentActivities({
      athleteId: settings.athleteId,
      apiKey: settings.apiKey,
      oldest: pollWindow.oldest,
      signal: inFlight.signal,
    });
    plan = planPoll(activities, { existingNames, knownWithoutFile: memory.withoutFile });
  } catch (error) {
    return reportPollError(error, 'cycle abandonné');
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

  for (const [index, { activityId, fileName }] of plan.toDownload.entries()) {
    if (stopping) break;
    // Jamais de rafale de téléchargements, même sur un backfill de plusieurs
    // centaines de séances. L'attente est interruptible : un SIGTERM ne l'attend pas.
    const spacingMs = downloadSpacingMs(index);
    if (spacingMs > 0) await sleep(spacingMs);
    if (stopping) break;

    let data: Buffer | null;
    try {
      data = await downloadFitFile({
        apiKey: settings.apiKey,
        activityId,
        signal: inFlight.signal,
      });
    } catch (error) {
      const retryAfterS = reportPollError(error, `activité ${activityId}`);
      // Un quota atteint interrompt le cycle sur-le-champ : enchaîner les
      // téléchargements ne ferait qu'aggraver le dépassement.
      if (error instanceof IntervalsRateLimitError) {
        rememberProgress();
        return retryAfterS;
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
  if (pollWindow.backfill && !memory.unfinished && !stopping) {
    await rm(join(inboxDir, BACKFILL_MARKER), { force: true });
  }

  // Un backfill s'étale sur plusieurs cycles : le dire, sinon le service a l'air
  // de tourner sans fin sur le même travail.
  if (pollWindow.backfill && (plan.toDownload.length > 0 || plan.remaining > 0)) {
    pollLog(
      plan.remaining > 0
        ? `backfill : ${deposited} rapatriés, reste ~${plan.remaining} — suite au prochain cycle.`
        : `backfill : ${deposited} rapatriés, historique complet.`,
    );
  }

  return null;
}

/** Boucle de rapatriement, en parallèle de la surveillance du dossier. */
async function pollLoop(inboxDir: string, settings: IntervalsSettings): Promise<void> {
  const memory: PollMemory = {
    withoutFile: new Map(),
    loggedInvalidIds: new Set(),
    loggedWithoutFile: new Set(),
    unfinished: false,
  };

  pollLog(
    `rapatriement actif pour l'athlète ${settings.athleteId} : un cycle toutes les ${settings.pollIntervalS} s sur ${settings.lookbackDays} jours glissants, par tranches de ${MAX_DOWNLOADS_PER_CYCLE} fichiers. Tant qu'aucune séance n'a été rapatriée, c'est tout l'historique qui est demandé.`,
  );

  while (!stopping) {
    const retryAfterS = await pollOnce(inboxDir, settings, memory);
    if (stopping) break;
    // Jamais de rafale : on attend au minimum l'intervalle de cycle, davantage si
    // l'API a demandé plus par `Retry-After` — et jamais au-delà du plafond, un
    // `Retry-After` daté de 2099 ferait déborder `setTimeout`.
    await sleep(nextPollDelayMs(retryAfterS, settings.pollIntervalS));
  }
}

async function main(): Promise<void> {
  loadEnvFile('.env.local');
  loadEnvFile('.env');

  const config = readConfig();
  await mkdir(config.FIT_INBOX_DIR, { recursive: true });

  process.on('SIGTERM', () => requestStop('SIGTERM'));
  process.on('SIGINT', () => requestStop('SIGINT'));

  log(
    `surveillance de ${config.FIT_INBOX_DIR} toutes les ${config.FIT_WATCH_INTERVAL_S} s (Ctrl+C ou SIGTERM pour arrêter).`,
  );

  const intervals = readIntervalsSettings(config);
  if (!intervals.active) {
    const plural = intervals.missing.length > 1 ? 'non renseignées' : 'non renseignée';
    pollLog(`poller intervals.icu inactif : ${intervals.missing.join(' et ')} ${plural}.`);
  }

  await Promise.all([
    watchLoop(config),
    intervals.active ? pollLoop(config.FIT_INBOX_DIR, intervals.settings) : Promise.resolve(),
  ]);

  log('arrêté.');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[fit-watcher] arrêt sur erreur :', error);
    process.exit(1);
  },
);
