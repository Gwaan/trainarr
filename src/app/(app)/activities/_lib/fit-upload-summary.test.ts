import { describe, expect, it } from 'vitest';

import { summarizeFitUpload } from './fit-upload-summary';

const created = (name: string) => ({ name, ok: true, status: 'created' }) as const;
const updated = (name: string) => ({ name, ok: true, status: 'updated' }) as const;
const merged = (name: string) => ({ name, ok: true, status: 'merged' }) as const;
const failed = (name: string, error: string) => ({ name, ok: false, error }) as const;

describe('summarizeFitUpload', () => {
  it('ne récapitule rien quand le rapport est vide', () => {
    expect(summarizeFitUpload([])).toBeNull();
  });

  it('annonce un import unique au singulier', () => {
    expect(summarizeFitUpload([created('a.fit')])).toEqual({
      tone: 'positive',
      title: '1 activité importée',
      failures: [],
    });
  });

  it('accorde le pluriel', () => {
    expect(summarizeFitUpload([created('a.fit'), created('b.fit')])?.title).toBe(
      '2 activités importées',
    );
  });

  it('enchaîne les statuts sans répéter le nom, dans un ordre stable', () => {
    const summary = summarizeFitUpload([
      merged('c.fit'),
      created('a.fit'),
      created('b.fit'),
      created('d.fit'),
    ]);

    expect(summary?.tone).toBe('positive');
    expect(summary?.title).toBe(
      '3 activités importées, 1 fusionnée avec une activité existante',
    );
  });

  it('distingue mise à jour et fusion', () => {
    const summary = summarizeFitUpload([
      updated('a.fit'),
      updated('b.fit'),
      merged('c.fit'),
      merged('d.fit'),
    ]);

    expect(summary?.title).toBe(
      '2 activités mises à jour, 2 fusionnées avec des activités existantes',
    );
  });

  it('reste neutre et compte les échecs quand le lot est partiel', () => {
    const summary = summarizeFitUpload([
      created('a.fit'),
      failed('b.gpx', 'Seuls les fichiers .fit sont acceptés.'),
      failed('c.fit', 'Fichier illisible.'),
    ]);

    expect(summary?.tone).toBe('neutral');
    expect(summary?.title).toBe('1 activité importée — 2 fichiers en échec');
    expect(summary?.failures).toEqual([
      { name: 'b.gpx', error: 'Seuls les fichiers .fit sont acceptés.' },
      { name: 'c.fit', error: 'Fichier illisible.' },
    ]);
  });

  it('passe au négatif quand rien n’a été importé', () => {
    const summary = summarizeFitUpload([failed('b.gpx', 'Seuls les fichiers .fit sont acceptés.')]);

    expect(summary?.tone).toBe('negative');
    expect(summary?.title).toBe('Aucun fichier importé');
    expect(summary?.failures).toHaveLength(1);
  });

  it('conserve chaque échec, même pour deux fichiers de même nom', () => {
    const summary = summarizeFitUpload([
      failed('a.fit', 'Fichier illisible.'),
      failed('a.fit', 'Import impossible — réessaie plus tard.'),
    ]);

    expect(summary?.failures).toHaveLength(2);
  });
});
