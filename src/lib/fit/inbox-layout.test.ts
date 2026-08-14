import { describe, expect, it } from 'vitest';

import {
  ATHLETE_DIR_PREFIX,
  athleteDirName,
  athleteInboxDir,
  nameWithSuffix,
  parseAthleteDirName,
} from './inbox-layout';

describe('athleteDirName', () => {
  it('nomme le dossier d’un athlète', () => {
    expect(athleteDirName(1)).toBe('athlete-1');
    expect(athleteDirName(42)).toBe(`${ATHLETE_DIR_PREFIX}42`);
  });

  it('refuse tout ce qui ne compose pas un chemin sûr', () => {
    // Le typage dit « number » ; il ne dit pas « entier positif ». Cette valeur
    // sert à construire un chemin : elle ne passe pas sans preuve.
    expect(() => athleteDirName(0)).toThrow(RangeError);
    expect(() => athleteDirName(-3)).toThrow(RangeError);
    expect(() => athleteDirName(1.5)).toThrow(RangeError);
    expect(() => athleteDirName(Number.NaN)).toThrow(RangeError);
  });
});

describe('parseAthleteDirName', () => {
  it('reconnaît un dossier d’athlète', () => {
    expect(parseAthleteDirName('athlete-1')).toBe(1);
    expect(parseAthleteDirName('athlete-123456789')).toBe(123456789);
  });

  it('ignore ce qui n’en est pas un', () => {
    expect(parseAthleteDirName('processed')).toBeNull();
    expect(parseAthleteDirName('failed')).toBeNull();
    expect(parseAthleteDirName('athlete-')).toBeNull();
    expect(parseAthleteDirName('athlete-abc')).toBeNull();
    expect(parseAthleteDirName('athlete-1/processed')).toBeNull();
    expect(parseAthleteDirName('athlete-1.fit')).toBeNull();
    expect(parseAthleteDirName('Athlete-1')).toBeNull();
  });

  it('refuse les formes non canoniques, qui dédoubleraient un athlète', () => {
    // `athlete-007` et `athlete-7` désigneraient le même athlète : deux
    // dossiers, dont l'un se croirait vide — donc un backfill sans fin et une
    // déduplication aveugle aux fichiers de son jumeau.
    expect(parseAthleteDirName('athlete-007')).toBeNull();
    expect(parseAthleteDirName('athlete-0')).toBeNull();
    expect(parseAthleteDirName('athlete-+1')).toBeNull();
    expect(parseAthleteDirName('athlete-1 ')).toBeNull();
  });

  it('fait l’aller-retour avec `athleteDirName`', () => {
    for (const id of [1, 7, 99, 123456789]) {
      expect(parseAthleteDirName(athleteDirName(id))).toBe(id);
    }
  });
});

describe('athleteInboxDir', () => {
  it('range le dossier de l’athlète sous la racine de la boîte', () => {
    expect(athleteInboxDir('/data/fit-inbox', 3)).toBe('/data/fit-inbox/athlete-3');
  });
});

describe('nameWithSuffix', () => {
  it('insère le suffixe avant l’extension', () => {
    expect(nameWithSuffix('run.fit', 2)).toBe('run-2.fit');
    expect(nameWithSuffix('a.b.fit', 1)).toBe('a.b-1.fit');
  });

  it('verrouille la forme du nom suffixé : « radical-N.fit », jamais « nom.fit-N »', () => {
    // Un `x.fit-1` porterait la bonne donnée sous une extension que le watcher
    // ignore : le fichier serait perdu sans le moindre message d'erreur.
    expect(nameWithSuffix('x.fit', 1)).toBe('x-1.fit');
    expect(nameWithSuffix('x.fit', 2)).toBe('x-2.fit');
  });
});
