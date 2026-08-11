import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only` lève hors contexte serveur React : neutralisé pour les tests.
vi.mock('server-only', () => ({}));

import {
  PROGRESS_TTL_MS,
  clearPlanProgress,
  getPlanProgress,
  resetPlanProgress,
  setPlanProgress,
} from './progress';

const ID = '6f1c2b9e-3a4d-4c11-9f2b-8a7d5e0c1234';
const OTHER_ID = 'b2a1c0d9-8e7f-4a6b-9c5d-4e3f2a1b0c9d';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-11T09:00:00.000Z'));
  // Le registre vit sur `globalThis` : il survit au rechargement du module, donc
  // une entrée laissée par un cas en ferait passer un autre pour suivi.
  resetPlanProgress();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registre de progression', () => {
  it('rend ce qui a été enregistré, horodaté', () => {
    setPlanProgress(ID, { percent: 42, attempt: 1, maxAttempts: 3 });

    expect(getPlanProgress(ID)).toEqual({
      percent: 42,
      attempt: 1,
      maxAttempts: 3,
      startedAt: Date.now(),
    });
  });

  it('rend null sur un identifiant inconnu', () => {
    expect(getPlanProgress(ID)).toBeNull();
  });

  it('oublie une génération effacée', () => {
    setPlanProgress(ID, { percent: 42, attempt: 1, maxAttempts: 3 });
    clearPlanProgress(ID);

    expect(getPlanProgress(ID)).toBeNull();
  });

  it('garde la date de départ à travers les mises à jour', () => {
    const startedAt = Date.now();
    setPlanProgress(ID, { percent: 5, attempt: 1, maxAttempts: 3 });

    vi.advanceTimersByTime(30_000);
    setPlanProgress(ID, { percent: 60, attempt: 2, maxAttempts: 3 });

    // Sans quoi une entrée alimentée en continu repousserait indéfiniment son
    // éviction.
    expect(getPlanProgress(ID)).toEqual({
      percent: 60,
      attempt: 2,
      maxAttempts: 3,
      startedAt,
    });
  });

  it('ne sert plus une entrée périmée', () => {
    setPlanProgress(ID, { percent: 42, attempt: 1, maxAttempts: 3 });

    vi.advanceTimersByTime(PROGRESS_TTL_MS + 1);

    expect(getPlanProgress(ID)).toBeNull();
  });

  it("sert encore une entrée à la seconde qui précède l'heure", () => {
    setPlanProgress(ID, { percent: 42, attempt: 1, maxAttempts: 3 });

    vi.advanceTimersByTime(PROGRESS_TTL_MS - 1);

    expect(getPlanProgress(ID)?.percent).toBe(42);
  });

  it("évacue les entrées périmées à l'enregistrement suivant", () => {
    setPlanProgress(ID, { percent: 42, attempt: 1, maxAttempts: 3 });
    vi.advanceTimersByTime(PROGRESS_TTL_MS + 1);

    // L'écriture d'une autre génération balaie la `Map` : l'entrée d'avant en
    // disparaît vraiment, elle n'est pas seulement masquée à la lecture. Preuve
    // observable : réenregistrer le même identifiant repart d'une date neuve.
    setPlanProgress(OTHER_ID, { percent: 1, attempt: 1, maxAttempts: 3 });
    setPlanProgress(ID, { percent: 7, attempt: 1, maxAttempts: 3 });

    expect(getPlanProgress(ID)?.startedAt).toBe(Date.now());
  });

  /**
   * Le bug de production, reproduit : la Server Action écrit, la route lit, et
   * en build standalone les deux n'embarquent pas la même instance du module.
   * Recharger le module ici joue exactement ce dédoublement — avec une `Map` de
   * module, la seconde instance repartait vide et la route rendait `null`.
   */
  it('partage son registre entre deux instances du module', async () => {
    setPlanProgress(ID, { percent: 42, attempt: 2, maxAttempts: 3 });

    vi.resetModules();
    const reloaded = await import('./progress');

    expect(reloaded.getPlanProgress(ID)).toEqual({
      percent: 42,
      attempt: 2,
      maxAttempts: 3,
      startedAt: Date.now(),
    });
    // Et l'effacement porte lui aussi d'une instance à l'autre.
    reloaded.clearPlanProgress(ID);
    expect(getPlanProgress(ID)).toBeNull();
  });

  it('oublie tout ce qu’il portait quand on le remet à zéro', () => {
    setPlanProgress(ID, { percent: 42, attempt: 1, maxAttempts: 3 });
    setPlanProgress(OTHER_ID, { percent: 7, attempt: 1, maxAttempts: 3 });

    resetPlanProgress();

    expect(getPlanProgress(ID)).toBeNull();
    expect(getPlanProgress(OTHER_ID)).toBeNull();
  });
});
