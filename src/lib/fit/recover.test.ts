import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Aucun disque : les opérations de fichiers sont simulées, ce qui permet
 * d'éprouver aussi les cas de panne (répertoire absent, droits insuffisants).
 * Le marqueur de backfill, lui, passe par le vrai `service.ts` — c'est tout
 * l'objet de la réutilisation : le nom du marqueur ne doit exister qu'une fois.
 */
const { fs } = vi.hoisted(() => ({
  fs: {
    access: vi.fn(),
    mkdir: vi.fn(),
    // `open` n'est utilisé par aucun chemin exercé ici : il n'est présent que
    // parce que `service.ts`, importé pour le marqueur de backfill, le déclare.
    open: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    utimes: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('node:fs/promises', () => fs);

const { recoverPendingImports } = await import('./recover');

/** L'athlète repris : la reprise ne touche que *son* dossier. */
const ATHLETE_ID = 7;
/** Valeur par défaut de `FIT_INBOX_DIR` (aucune variable d'env n'est posée en test). */
const INBOX = join('/data/fit-inbox', `athlete-${ATHLETE_ID}`);
const FAILED = join(INBOX, 'failed');
const MARKER = join(INBOX, '.backfill-pending');

function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: 'ENOENT' });
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdir.mockResolvedValue(undefined);
  fs.readdir.mockResolvedValue([]);
  fs.rename.mockResolvedValue(undefined);
  fs.rm.mockResolvedValue(undefined);
  // Boîte de dépôt vide par défaut : aucun nom n'est pris.
  fs.stat.mockRejectedValue(enoent());
  fs.utimes.mockResolvedValue(undefined);
  fs.writeFile.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recoverPendingImports', () => {
  it('remet les fichiers de failed/ dans la boîte de dépôt et supprime leurs motifs', async () => {
    fs.readdir.mockResolvedValue(['a.fit', 'a.fit.err.txt', 'b.FIT', 'b.FIT.err.txt']);

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toEqual({
      requeued: 2,
      backfillReopened: true,
    });

    expect(fs.readdir).toHaveBeenCalledWith(FAILED);
    expect(fs.rename).toHaveBeenCalledWith(join(FAILED, 'a.fit'), join(INBOX, 'a.fit'));
    expect(fs.rename).toHaveBeenCalledWith(join(FAILED, 'b.FIT'), join(INBOX, 'b.FIT'));
    expect(fs.rm).toHaveBeenCalledWith(join(FAILED, 'a.fit.err.txt'), { force: true });
    expect(fs.rm).toHaveBeenCalledWith(join(FAILED, 'b.FIT.err.txt'), { force: true });
  });

  it('rafraîchit la date du fichier remis en file, sinon le watcher le tiendrait pour déjà traité', async () => {
    fs.readdir.mockResolvedValue(['a.fit']);

    await recoverPendingImports(ATHLETE_ID);

    // Le watcher indexe ce qu'il a traité par `nom|taille|mtime`, et `rename`
    // préserve la mtime : sans ce rafraîchissement, le fichier retrouve sa clé
    // et se fait ignorer jusqu'au prochain redémarrage.
    expect(fs.utimes).toHaveBeenCalledWith(
      join(INBOX, 'a.fit'),
      expect.any(Date),
      expect.any(Date),
    );
    // Après le rename : sur la cible, pas sur la source.
    expect(fs.rename.mock.invocationCallOrder[0]).toBeLessThan(
      fs.utimes.mock.invocationCallOrder[0],
    );
  });

  it('compte le fichier repris même si sa date résiste au rafraîchissement', async () => {
    fs.readdir.mockResolvedValue(['a.fit']);
    fs.utimes.mockRejectedValue(new Error('EPERM'));

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toMatchObject({ requeued: 1 });
    expect(console.error).toHaveBeenCalled();
  });

  it("n'écrase jamais un homonyme déjà déposé : le fichier repris prend un nom libre", async () => {
    // Les noms HealthFit sont datés au jour : deux séances le même jour portent
    // le même nom, et celui de la boîte peut n'être pas encore ingéré.
    fs.readdir.mockResolvedValue(['run-2026-08-10.fit', 'run-2026-08-10.fit.err.txt']);
    fs.stat.mockImplementation((path: string) =>
      path === join(INBOX, 'run-2026-08-10.fit') ? Promise.resolve({}) : Promise.reject(enoent()),
    );

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toMatchObject({ requeued: 1 });

    expect(fs.rename).toHaveBeenCalledWith(
      join(FAILED, 'run-2026-08-10.fit'),
      join(INBOX, 'run-2026-08-10-1.fit'),
    );
    expect(fs.rename).not.toHaveBeenCalledWith(
      expect.anything(),
      join(INBOX, 'run-2026-08-10.fit'),
    );
    expect(fs.utimes).toHaveBeenCalledWith(
      join(INBOX, 'run-2026-08-10-1.fit'),
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('laisse dans failed/ un fichier dont toutes les variantes de nom sont prises', async () => {
    fs.readdir.mockResolvedValue(['a.fit']);
    fs.stat.mockResolvedValue({});

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toMatchObject({ requeued: 0 });

    expect(fs.rename).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('ne touche pas aux fichiers qui ne sont pas des FIT', async () => {
    fs.readdir.mockResolvedValue(['notes.txt', 'orphelin.fit.err.txt', '.backfill-pending']);

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toMatchObject({ requeued: 0 });

    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('pose le marqueur de backfill pour rouvrir le rapatriement de l’historique', async () => {
    const report = await recoverPendingImports(ATHLETE_ID);

    expect(report.backfillReopened).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledWith(MARKER, expect.any(String));
  });

  it('poursuit malgré un fichier récalcitrant, et lui laisse son motif', async () => {
    fs.readdir.mockResolvedValue(['a.fit', 'a.fit.err.txt', 'b.fit', 'b.fit.err.txt']);
    fs.rename.mockImplementation((from: string) =>
      from.endsWith('a.fit') ? Promise.reject(new Error('EACCES')) : Promise.resolve(undefined),
    );

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toMatchObject({ requeued: 1 });

    expect(fs.rm).not.toHaveBeenCalledWith(join(FAILED, 'a.fit.err.txt'), { force: true });
    expect(fs.rm).toHaveBeenCalledWith(join(FAILED, 'b.fit.err.txt'), { force: true });
  });

  it('compte le fichier repris même si son motif résiste à la suppression', async () => {
    fs.readdir.mockResolvedValue(['a.fit', 'a.fit.err.txt']);
    fs.rm.mockRejectedValue(new Error('EACCES'));

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toMatchObject({ requeued: 1 });
  });

  it('traite failed/ absent comme « rien à reprendre », sans bruit', async () => {
    fs.readdir.mockRejectedValue(enoent());

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toEqual({
      requeued: 0,
      backfillReopened: true,
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('ne sort jamais du dossier de l’athlète repris', async () => {
    // Un fichier de la racine n'a pas de propriétaire déductible : l'onboarding
    // d'un compte n'est pas une raison de lui attribuer ce qu'un autre a déposé.
    fs.readdir.mockResolvedValue(['a.fit', 'a.fit.err.txt']);

    await recoverPendingImports(ATHLETE_ID);

    // Tous les chemins que la reprise a touchés — source *et* destination des
    // renommages, qui sont les seuls appels à deux chemins.
    const touched = [
      ...[...fs.readdir.mock.calls, ...fs.rm.mock.calls, ...fs.utimes.mock.calls, ...fs.writeFile.mock.calls].map(
        (call) => call[0],
      ),
      ...fs.rename.mock.calls.flatMap((call) => [call[0], call[1]]),
    ].filter((path) => typeof path === 'string');

    expect(touched.length).toBeGreaterThan(0);
    for (const path of touched) {
      expect(path.startsWith(`${INBOX}/`)).toBe(true);
    }
  });

  it('crée le dossier de l’athlète : sans lui, le marqueur n’aurait où s’écrire', async () => {
    await recoverPendingImports(ATHLETE_ID);

    expect(fs.mkdir).toHaveBeenCalledWith(INBOX, { recursive: true });
  });

  it('rend un rapport à zéro quand la boîte de dépôt est inaccessible, sans jamais lever', async () => {
    fs.readdir.mockRejectedValue(new Error('EACCES: permission denied'));
    fs.writeFile.mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(recoverPendingImports(ATHLETE_ID)).resolves.toEqual({
      requeued: 0,
      backfillReopened: false,
    });
    expect(console.error).toHaveBeenCalled();
  });
});
