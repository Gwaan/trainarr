import { describe, expect, it } from 'vitest';

import {
  IntervalsAbortError,
  IntervalsApiError,
  IntervalsAuthError,
  IntervalsRateLimitError,
} from './client';
import { classifyPollError } from './poll-errors';

describe('classifyPollError — le silence ne se déduit pas du type', () => {
  it("journalise un abort survenu alors que l'arrêt n'est PAS demandé", () => {
    // Régression : c'est exactement le cas qui faisait échouer chaque cycle en
    // silence. `timedOut: false` ressemblait à un arrêt propre ; ce n'en était
    // pas un, et l'utilisateur n'a rien vu pendant des minutes.
    const report = classifyPollError(
      new IntervalsAbortError('liste des activités intervals.icu', false),
      { stopping: false },
    );

    expect(report.silent).toBe(false);
    expect(report.message).toContain('IntervalsAbortError');
    expect(report.message).toContain('appel interrompu');
  });

  it("journalise un abort de délai de garde alors que l'arrêt n'est pas demandé", () => {
    const report = classifyPollError(
      new IntervalsAbortError("fichier de l'activité i42", true),
      { stopping: false },
    );

    expect(report.silent).toBe(false);
    expect(report.message).toContain('IntervalsAbortError');
  });

  it("n'absorbe une erreur QUE si le drapeau d'arrêt est levé", () => {
    const error = new IntervalsAbortError('liste des activités intervals.icu', false);

    expect(classifyPollError(error, { stopping: true })).toEqual({
      silent: true,
      message: '',
      abortCycle: true,
      retryAfterS: null,
    });
  });

  it("tait n'importe quelle erreur pendant l'arrêt, quel que soit son type", () => {
    for (const error of [
      new IntervalsApiError('panne réseau'),
      new IntervalsAuthError(401),
      new IntervalsRateLimitError(30),
      new Error('inattendue'),
    ]) {
      expect(classifyPollError(error, { stopping: true }).silent).toBe(true);
    }
  });
});

describe('classifyPollError — contenu du rapport', () => {
  it("nomme le type et le message de l'erreur", () => {
    const report = classifyPollError(new IntervalsAuthError(403), { stopping: false });

    expect(report.message).toContain('IntervalsAuthError');
    expect(report.message).toContain('403');
    expect(report.retryAfterS).toBeNull();
  });

  it('remonte le délai demandé par un quota', () => {
    const report = classifyPollError(new IntervalsRateLimitError(120), { stopping: false });

    expect(report.silent).toBe(false);
    expect(report.message).toContain('IntervalsRateLimitError');
    expect(report.retryAfterS).toBe(120);
  });

  it('accepte un quota sans délai indiqué', () => {
    expect(classifyPollError(new IntervalsRateLimitError(null), { stopping: false }).retryAfterS)
      .toBeNull();
  });

  it("journalise ce qui n'est même pas une erreur", () => {
    const report = classifyPollError('boom', { stopping: false });

    expect(report.silent).toBe(false);
    expect(report.message).toBe('boom');
  });
});
