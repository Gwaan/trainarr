/**
 * Service de surveillance du dossier d'import FIT.
 *
 * Boucle longue durée : toutes les `FIT_WATCH_INTERVAL_S` secondes, il liste
 * `FIT_INBOX_DIR`, importe les fichiers `.fit` dont l'upload est terminé, puis
 * les range dans `processed/` ou `failed/`.
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

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';

import { ingestFitBuffer, type IngestReport } from '@/lib/fit/ingest';
import { ORPHAN_PART_MAX_AGE_MS, planScan, type ScannedFile } from '@/lib/fit/watch-plan';

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
  for (const key of ['FIT_INBOX_DIR', 'FIT_WATCH_INTERVAL_S']) {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/*
 * Boucle et arrêt propre.
 */

let stopping = false;
/** Réveille l'attente en cours, s'il y en a une (arrêt immédiat entre deux scans). */
let wakeUp: (() => void) | null = null;

function requestStop(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`${signal} reçu : arrêt après le fichier en cours.`);
  wakeUp?.();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeUp = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeUp = done;
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

  log('arrêté.');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[fit-watcher] arrêt sur erreur :', error);
    process.exit(1);
  },
);
