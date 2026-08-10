import { describe, expect, it } from 'vitest';

import {
  MAX_FIT_FILE_BYTES,
  MAX_FIT_UPLOAD_BYTES,
  checkFitFile,
  displayFileName,
  exceedsUploadLimit,
  fitUploadResponseSchema,
} from './upload-contract';

describe('checkFitFile', () => {
  it('accepte un .fit de taille raisonnable', () => {
    expect(checkFitFile({ name: 'sortie-longue.fit', size: 1_200_000 })).toEqual({
      ok: true,
    });
  });

  it("accepte l'extension quelle que soit la casse", () => {
    expect(checkFitFile({ name: '2026-08-10.FIT', size: 42 }).ok).toBe(true);
    expect(checkFitFile({ name: 'seance.Fit', size: 42 }).ok).toBe(true);
  });

  it('refuse une autre extension', () => {
    expect(checkFitFile({ name: 'sortie.gpx', size: 42 })).toEqual({
      ok: false,
      error: 'Seuls les fichiers .fit sont acceptés.',
    });
  });

  it('refuse un nom où « fit » n’est pas l’extension finale', () => {
    expect(checkFitFile({ name: 'sortie.fit.zip', size: 42 }).ok).toBe(false);
    expect(checkFitFile({ name: 'fit', size: 42 }).ok).toBe(false);
  });

  it('accepte un fichier pile à la limite', () => {
    expect(checkFitFile({ name: 'gros.fit', size: MAX_FIT_FILE_BYTES }).ok).toBe(true);
  });

  it('refuse un fichier au-delà de la limite, en annonçant celle-ci', () => {
    expect(checkFitFile({ name: 'gros.fit', size: MAX_FIT_FILE_BYTES + 1 })).toEqual({
      ok: false,
      error: 'Fichier trop volumineux : 25 Mo maximum.',
    });
  });

  it("contrôle l'extension avant la taille", () => {
    const check = checkFitFile({ name: 'video.mov', size: MAX_FIT_FILE_BYTES * 4 });

    expect(check).toEqual({
      ok: false,
      error: 'Seuls les fichiers .fit sont acceptés.',
    });
  });
});

describe('exceedsUploadLimit', () => {
  it('laisse passer un envoi de taille plausible', () => {
    expect(exceedsUploadLimit('1200000')).toBe(false);
  });

  it('laisse passer un envoi pile à la limite', () => {
    expect(exceedsUploadLimit(String(MAX_FIT_UPLOAD_BYTES))).toBe(false);
  });

  it('refuse un envoi démesuré avant même qu’il soit lu', () => {
    // 2 Go : `request.formData()` les aurait intégralement bufferisés en mémoire
    // avant que le contrôle par fichier ne les refuse un à un.
    expect(exceedsUploadLimit(String(2 * 1024 * 1024 * 1024))).toBe(true);
    expect(exceedsUploadLimit(String(MAX_FIT_UPLOAD_BYTES + 1))).toBe(true);
  });

  it('couvre un lot raisonnable de fichiers à la limite unitaire', () => {
    expect(exceedsUploadLimit(String(4 * MAX_FIT_FILE_BYTES))).toBe(false);
  });

  it('ne bloque pas un envoi sans en-tête exploitable (le contrôle par fichier reste)', () => {
    expect(exceedsUploadLimit(null)).toBe(false);
    expect(exceedsUploadLimit('énorme')).toBe(false);
  });
});

describe('displayFileName', () => {
  it('laisse un nom normal intact', () => {
    expect(displayFileName('sortie-longue.fit')).toBe('sortie-longue.fit');
  });

  it('remplace un nom vide par une mention neutre', () => {
    expect(displayFileName('   ')).toBe('Fichier sans nom');
  });

  it('tronque un nom démesuré', () => {
    const name = `${'a'.repeat(300)}.fit`;
    const displayed = displayFileName(name);

    expect(displayed).toHaveLength(120);
    expect(displayed.endsWith('…')).toBe(true);
  });
});

describe('fitUploadResponseSchema', () => {
  it('valide une réponse mêlant succès et échecs', () => {
    const parsed = fitUploadResponseSchema.safeParse({
      results: [
        { name: 'a.fit', ok: true, status: 'created' },
        { name: 'b.fit', ok: false, error: 'Fichier illisible.' },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejette un succès sans statut', () => {
    const parsed = fitUploadResponseSchema.safeParse({
      results: [{ name: 'a.fit', ok: true }],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejette un statut inconnu', () => {
    const parsed = fitUploadResponseSchema.safeParse({
      results: [{ name: 'a.fit', ok: true, status: 'skipped' }],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejette une charge utile qui n’est pas une réponse d’import', () => {
    expect(fitUploadResponseSchema.safeParse(null).success).toBe(false);
    expect(fitUploadResponseSchema.safeParse({ results: 'ok' }).success).toBe(false);
  });
});
