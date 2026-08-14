import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Le service de fond, éprouvé **sur un vrai répertoire** et avec ses vraies
 * boucles — seuls l'environnement, la base et le réseau sont simulés.
 *
 * Ce niveau-là mérite un test parce que rien d'autre ne le couvre : les
 * décisions sont pures et testées ailleurs (`watch-plan`, `poll-plan`,
 * `inbox-layout`), mais leur **câblage** ne l'était pas. C'est exactement là
 * qu'un démarrage réel a trouvé un service annonçant « aucun compte configuré »
 * alors que la base était injoignable — un mensonge qu'aucun test unitaire
 * n'aurait vu.
 */

vi.mock('server-only', () => ({}));

const { mocks, envState } = vi.hoisted(() => ({
  mocks: {
    ingestFitBuffer: vi.fn(),
    listIntervalsAccounts: vi.fn(),
    listRecentActivities: vi.fn(),
    downloadFitFile: vi.fn(),
  },
  // Cadences très courtes : les boucles tournent en vrai, on ne veut pas
  // attendre. `inboxDir` change à chaque cas (répertoire temporaire).
  envState: { inboxDir: '', watchIntervalS: 0.02, pollIntervalS: 0.02, lookbackDays: 30 },
}));

vi.mock('@/config/env', () => ({
  env: {
    get FIT_INBOX_DIR() {
      return envState.inboxDir;
    },
    get FIT_WATCH_INTERVAL_S() {
      return envState.watchIntervalS;
    },
    get INTERVALS_POLL_INTERVAL_S() {
      return envState.pollIntervalS;
    },
    get INTERVALS_LOOKBACK_DAYS() {
      return envState.lookbackDays;
    },
  },
}));

vi.mock('@/data/athlete', () => ({ listIntervalsAccounts: mocks.listIntervalsAccounts }));
vi.mock('@/lib/fit/ingest', () => ({ ingestFitBuffer: mocks.ingestFitBuffer }));
vi.mock('@/lib/intervals/client', () => ({
  listRecentActivities: mocks.listRecentActivities,
  downloadFitFile: mocks.downloadFitFile,
}));

const { startFitService } = await import('./service');

let inbox: string;
let service: { stop(): Promise<void> } | null = null;
let logs: string[] = [];
let errors: string[] = [];

/** Attend qu'une condition se réalise, sans dormir plus que nécessaire. */
async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition jamais atteinte');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function logged(lines: readonly string[], fragment: string): boolean {
  return lines.some((line) => line.includes(fragment));
}

beforeEach(async () => {
  vi.clearAllMocks();
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });

  inbox = await mkdtemp(join(tmpdir(), 'trainarr-inbox-'));
  envState.inboxDir = inbox;

  mocks.ingestFitBuffer.mockResolvedValue({ status: 'created', activityId: 42 });
  mocks.listIntervalsAccounts.mockResolvedValue([]);
  mocks.listRecentActivities.mockResolvedValue([]);
  mocks.downloadFitFile.mockResolvedValue(null);
});

afterEach(async () => {
  await service?.stop();
  service = null;
  vi.restoreAllMocks();
  await rm(inbox, { recursive: true, force: true });
});

describe('watcher — un dossier par athlète', () => {
  it('importe le fichier pour l’athlète de son dossier, puis le range chez lui', async () => {
    await mkdir(join(inbox, 'athlete-3'), { recursive: true });
    await writeFile(join(inbox, 'athlete-3', 'sortie.fit'), 'octets');

    service = startFitService();
    await until(() => mocks.ingestFitBuffer.mock.calls.length > 0);

    // Le propriétaire vient du chemin, jamais d'une session : c'est toute la
    // correction du service multi-utilisateur.
    expect(mocks.ingestFitBuffer).toHaveBeenCalledWith(expect.any(Buffer), 3);

    // Rangé dans le `processed/` de son dossier, pas dans celui de la racine.
    await until(() => logged(logs, 'athlete-3/sortie.fit → importée'));
    await until(async () =>
      (await readdir(join(inbox, 'athlete-3', 'processed'))).includes('sortie.fit'),
    );
  });

  it('n’attribue jamais à un compte un fichier resté à la racine — il le signale', async () => {
    await writeFile(join(inbox, 'depot-anonyme.fit'), 'octets');

    service = startFitService();
    await until(() => logged(errors, 'sans propriétaire'));

    // Deux scans au moins ont eu lieu ; le fichier n'a été ni lu, ni déplacé.
    expect(mocks.ingestFitBuffer).not.toHaveBeenCalled();
    expect(await readdir(inbox)).toContain('depot-anonyme.fit');
    // Une ligne, pas une par scan.
    expect(errors.filter((line) => line.includes('sans propriétaire'))).toHaveLength(1);
  });

  it('ignore les dossiers qui ne nomment pas un athlète', async () => {
    // `processed/` et `failed/` de l'ancienne racine : des archives, pas des
    // dossiers d'athlète.
    await mkdir(join(inbox, 'failed'), { recursive: true });
    await writeFile(join(inbox, 'failed', 'vieux.fit'), 'octets');
    // `athlete-007` n'est pas canonique : deux dossiers pour un même athlète,
    // ce serait un backfill sans fin et une déduplication aveugle à son jumeau.
    await mkdir(join(inbox, 'athlete-007'), { recursive: true });
    await writeFile(join(inbox, 'athlete-007', 'sortie.fit'), 'octets');
    // Témoin : un dossier valide, scanné au même tour — quand lui est ingéré,
    // les autres ont été vus et écartés.
    await mkdir(join(inbox, 'athlete-5'), { recursive: true });
    await writeFile(join(inbox, 'athlete-5', 'sortie.fit'), 'octets');

    service = startFitService();
    await until(() => mocks.ingestFitBuffer.mock.calls.length > 0);

    expect(mocks.ingestFitBuffer).toHaveBeenCalledTimes(1);
    expect(mocks.ingestFitBuffer).toHaveBeenCalledWith(expect.any(Buffer), 5);
  });
});

describe('poller — un cycle par compte', () => {
  it('dit une fois qu’aucun compte n’a de clé, et n’en fait pas une erreur', async () => {
    service = startFitService();
    await until(() => logged(logs, 'aucun compte'));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(logs.filter((line) => line.includes('aucun compte'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('ne fait pas passer une base injoignable pour une absence de compte', async () => {
    // Le bug trouvé au démarrage réel : ne rien savoir n'est pas « rien ».
    mocks.listIntervalsAccounts.mockRejectedValue(new Error('connexion refusée'));

    service = startFitService();
    await until(() => logged(errors, 'comptes illisibles'));

    expect(logs.some((line) => line.includes('aucun compte'))).toBe(false);
  });

  it('rapatrie avec les identifiants de chaque compte, dans son dossier', async () => {
    mocks.listIntervalsAccounts.mockResolvedValue([
      { athleteId: 1, status: 'ready', intervalsAthleteId: 'i111', apiKey: 'cle-de-un' },
      { athleteId: 2, status: 'ready', intervalsAthleteId: null, apiKey: 'cle-de-deux' },
    ]);
    mocks.listRecentActivities.mockImplementation(({ apiKey }: { apiKey: string }) =>
      Promise.resolve([{ id: apiKey === 'cle-de-un' ? 'i900' : 'i901', source: 'UPLOAD' }]),
    );
    mocks.downloadFitFile.mockResolvedValue(Buffer.from('octets'));

    service = startFitService();
    await until(() => mocks.downloadFitFile.mock.calls.length >= 2);
    await until(() => logged(logs, 'intervals-i901.fit déposé'));

    // Chaque compte est interrogé avec SES identifiants…
    expect(mocks.listRecentActivities).toHaveBeenCalledWith(
      expect.objectContaining({ athleteId: 'i111', apiKey: 'cle-de-un' }),
    );
    expect(mocks.listRecentActivities).toHaveBeenCalledWith(
      expect.objectContaining({ athleteId: '0', apiKey: 'cle-de-deux' }),
    );
    // …et ce qu'il rapatrie atterrit chez lui, jamais chez le voisin.
    expect(await readdir(join(inbox, 'athlete-1'))).toEqual(
      expect.arrayContaining(['intervals-i900.fit']),
    );
    expect(await readdir(join(inbox, 'athlete-2'))).toEqual(
      expect.arrayContaining(['intervals-i901.fit']),
    );
  });

  it('saute le compte dont la clé est illisible et poursuit avec les autres', async () => {
    mocks.listIntervalsAccounts.mockResolvedValue([
      { athleteId: 1, status: 'unreadable', reason: 'clé API intervals.icu illisible' },
      { athleteId: 2, status: 'ready', intervalsAthleteId: null, apiKey: 'cle-de-deux' },
    ]);

    service = startFitService();
    await until(() => mocks.listRecentActivities.mock.calls.length > 0);
    await until(() => logged(errors, 'athlete-1 : compte sauté'));

    expect(mocks.listRecentActivities).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'cle-de-deux' }),
    );
    // Un motif, jamais une clé.
    expect(errors.join('\n')).not.toContain('cle-de-deux');
  });
});
