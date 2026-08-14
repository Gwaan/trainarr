import { describe, expect, it } from 'vitest';

import { MAX_FIT_FILE_BYTES } from './limits';
import {
  ORPHAN_PART_MAX_AGE_MS,
  decideFileAction,
  fileKey,
  isFitFile,
  planScan,
  type ScannedFile,
} from './watch-plan';

const EMPTY = { previousSizeBytes: undefined, alreadyHandled: false };
const STABLE = (size: number) => ({ previousSizeBytes: size, alreadyHandled: false });

/** Fichier scanné, `mtimeMs` par défaut : la plupart des cas n'en dépendent pas. */
function file(name: string, sizeBytes: number, mtimeMs = 1_000): ScannedFile {
  return { name, sizeBytes, mtimeMs };
}

describe('isFitFile', () => {
  it('accepte l’extension .fit quelle que soit la casse', () => {
    expect(isFitFile('sortie.fit')).toBe(true);
    expect(isFitFile('SORTIE.FIT')).toBe(true);
    expect(isFitFile('Sortie.Fit')).toBe(true);
  });

  it('rejette tout le reste', () => {
    expect(isFitFile('sortie.gpx')).toBe(false);
    expect(isFitFile('sortie.fit.part')).toBe(false);
    expect(isFitFile('fit')).toBe(false);
    expect(isFitFile('.fit')).toBe(true);
  });
});

describe('fileKey', () => {
  it('distingue deux dépôts de même nom (gabarit HealthFit, daté à la journée)', () => {
    const morning = file('2026-08-10-Run.fit', 4_096, 1_000);
    const evening = file('2026-08-10-Run.fit', 5_120, 2_000);

    expect(fileKey(morning)).not.toBe(fileKey(evening));
  });

  it('reste stable d’un scan à l’autre pour un fichier immobile', () => {
    expect(fileKey(file('a.fit', 4_096, 1_000))).toBe(fileKey(file('a.fit', 4_096, 1_000)));
  });
});

describe('decideFileAction', () => {
  it('ignore un fichier qui n’est pas un .fit', () => {
    expect(decideFileAction(file('notes.txt', 10), STABLE(10))).toBe('skip');
  });

  it('attend un tour la première fois qu’il voit un fichier', () => {
    expect(decideFileAction(file('a.fit', 4_096), EMPTY)).toBe('wait');
  });

  it('attend tant que la taille change (dépôt encore en cours)', () => {
    expect(decideFileAction(file('a.fit', 8_192), STABLE(4_096))).toBe('wait');
  });

  it('attend sur un fichier vide, même « stable » : un FIT de 0 octet n’existe pas', () => {
    expect(decideFileAction(file('a.fit', 0), STABLE(0))).toBe('wait');
  });

  it('ingère dès que la taille est identique à celle du scan précédent', () => {
    expect(decideFileAction(file('a.fit', 4_096), STABLE(4_096))).toBe('ingest');
  });

  it('ignore un fichier déjà traité par ce processus (déplacement en échec)', () => {
    expect(
      decideFileAction(file('a.fit', 4_096), { previousSizeBytes: 4_096, alreadyHandled: true }),
    ).toBe('skip');
  });

  it('accepte un fichier pile à la limite de taille', () => {
    expect(decideFileAction(file('a.fit', MAX_FIT_FILE_BYTES), STABLE(MAX_FIT_FILE_BYTES))).toBe(
      'ingest',
    );
  });

  it('refuse un fichier hors gabarit sans attendre qu’il se stabilise', () => {
    // Un .fit de 800 Mo déposé dans la boîte : le lire ferait sauter la mémoire
    // du service, qui redémarrerait en boucle sans jamais archiver le fichier.
    const huge = file('bombe.fit', 800 * 1024 * 1024);

    expect(decideFileAction(huge, EMPTY)).toBe('reject');
    expect(decideFileAction(huge, STABLE(800 * 1024 * 1024))).toBe('reject');
  });
});

describe('planScan', () => {
  const previous = (sizes: Array<[string, number]>, handled: string[] = []) => ({
    sizes: new Map(sizes),
    handled: new Set(handled),
  });

  it('ne retient que les .fit stables, dans l’ordre du scan', () => {
    const files: ScannedFile[] = [
      file('notes.txt', 12),
      file('stable.fit', 4_096),
      file('en-cours.FIT', 9_000),
      file('nouveau.fit', 2_048),
    ];

    const plan = planScan(
      files,
      previous([
        ['stable.fit', 4_096],
        ['en-cours.FIT', 5_000],
      ]),
    );

    expect(plan.toIngest.map((item) => item.name)).toEqual(['stable.fit']);
    expect(plan.toReject).toEqual([]);
  });

  it('mémorise les tailles des seuls .fit encore présents', () => {
    const plan = planScan(
      [file('a.fit', 100), file('notes.txt', 12)],
      previous([
        ['a.fit', 50],
        ['parti.fit', 4_096],
      ]),
    );

    // `parti.fit` a été rangé entre-temps : il sort de la mémoire du watcher.
    expect([...plan.sizes]).toEqual([['a.fit', 100]]);
  });

  it('un fichier stable devient ingérable au tour suivant', () => {
    const files: ScannedFile[] = [file('a.fit', 4_096)];

    const first = planScan(files, previous([]));
    expect(first.toIngest).toEqual([]);

    const second = planScan(files, { sizes: first.sizes, handled: new Set() });
    expect(second.toIngest).toEqual([{ name: 'a.fit', key: fileKey(files[0]) }]);
  });

  it('ne réingère pas un fichier déjà traité resté sur place', () => {
    const stuck = file('a.fit', 4_096);

    const plan = planScan([stuck], previous([['a.fit', 4_096]], [fileKey(stuck)]));

    expect(plan.toIngest).toEqual([]);
    expect(plan.handled).toEqual(new Set([fileKey(stuck)]));
  });

  it('ingère une seconde séance portant le même nom que la première', () => {
    // HealthFit nomme ses fichiers à la journée : deux sorties le même jour
    // arrivent sous le même nom. Indexer la mémoire sur le nom seul faisait
    // ignorer la seconde à jamais.
    const morning = file('2026-08-10-Run.fit', 4_096, 1_000);
    const evening = file('2026-08-10-Run.fit', 5_120, 2_000);

    const plan = planScan([evening], {
      // La première a été traitée puis archivée ; la taille mémorisée est la
      // sienne, mais le fichier présent est la seconde séance.
      sizes: new Map([[evening.name, evening.sizeBytes]]),
      handled: new Set([fileKey(morning)]),
    });

    expect(plan.toIngest).toEqual([{ name: evening.name, key: fileKey(evening) }]);
  });

  it('purge de `handled` les fichiers qui ne sont plus dans l’inbox', () => {
    // Sans cette purge, l'ensemble grossirait indéfiniment sur un service qui
    // tourne des mois.
    const present = file('present.fit', 4_096);

    const plan = planScan([present], {
      sizes: new Map(),
      handled: new Set([fileKey(present), 'archive.fit|1|1', 'supprime.fit|2|2']),
    });

    expect(plan.handled).toEqual(new Set([fileKey(present)]));
  });

  it('désigne les fichiers hors gabarit pour l’archive, sans les ingérer', () => {
    const huge = file('bombe.fit', 800 * 1024 * 1024, 3_000);

    const plan = planScan([huge, file('a.fit', 4_096)], previous([['a.fit', 4_096]]));

    expect(plan.toIngest.map((item) => item.name)).toEqual(['a.fit']);
    expect(plan.toReject).toEqual([
      { name: 'bombe.fit', key: fileKey(huge), reason: expect.stringContaining('800 Mo') },
    ]);
    expect(plan.toReject[0]?.reason).toContain('25 Mo');
  });
});

describe('balayage des .part orphelins', () => {
  /** Horloge fixe : les tests raisonnent en âge relatif, pas en date absolue. */
  const NOW = 1_800_000_000_000;

  const scanAt = (files: ScannedFile[], now: number) =>
    planScan(files, { sizes: new Map(), handled: new Set(), now });

  it('laisse en place un .part récent : un dépôt est peut-être en cours', () => {
    const plan = scanAt([file('run.fit.part', 1_024, NOW - 60_000)], NOW);

    expect(plan.orphanParts).toEqual([]);
  });

  it('laisse en place un .part pile à la limite d’âge', () => {
    const plan = scanAt([file('run.fit.part', 1_024, NOW - ORPHAN_PART_MAX_AGE_MS)], NOW);

    expect(plan.orphanParts).toEqual([]);
  });

  it('désigne pour suppression un .part immobile depuis plus de 15 minutes', () => {
    // Reliquat d'un envoi interrompu : il condamne le nom canonique à jamais,
    // chaque nouveau dépôt homonyme prenant un suffixe jusqu'au 409 permanent.
    const plan = scanAt([file('run.fit.part', 1_024, NOW - ORPHAN_PART_MAX_AGE_MS - 1)], NOW);

    expect(plan.orphanParts).toEqual(['run.fit.part']);
  });

  it('ne compte jamais un .part comme un fichier FIT', () => {
    const stale = file('run.fit.part', 4_096, NOW - 24 * 60 * 60 * 1_000);

    const plan = planScan([stale], {
      sizes: new Map([['run.fit.part', 4_096]]),
      handled: new Set(),
      now: NOW,
    });

    expect(plan.toIngest).toEqual([]);
    expect(plan.toReject).toEqual([]);
    // Ni dans la mémoire des tailles : le `.part` n'est pas un candidat.
    expect([...plan.sizes]).toEqual([]);
  });

  it('ne touche pas aux .fit du même scan', () => {
    const plan = planScan(
      [file('run.fit.part', 1_024, NOW - 60 * 60 * 1_000), file('a.fit', 4_096, NOW)],
      { sizes: new Map([['a.fit', 4_096]]), handled: new Set(), now: NOW },
    );

    expect(plan.orphanParts).toEqual(['run.fit.part']);
    expect(plan.toIngest.map((item) => item.name)).toEqual(['a.fit']);
  });
});
