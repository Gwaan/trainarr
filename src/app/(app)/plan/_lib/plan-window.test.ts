import { describe, expect, it, vi } from 'vitest';

import { MAX_PLAN_WEEKS, MIN_RACE_PLAN_WEEKS, planWindow } from '@/lib/ai/plan-service';

import { earliestRaceDate, latestRaceDate } from './plan-window';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * La borne du champ « date de course » et la fenêtre que le service calculera
 * sont vérifiées ensemble : c'est leur désaccord qui produirait un formulaire
 * proposant une date aussitôt refusée.
 */

describe('earliestRaceDate', () => {
  it('laisse exactement la place du plan le plus court', () => {
    // 2026-08-11 est un mardi : le plan démarrerait le lundi 17.
    const today = '2026-08-11';
    const earliest = earliestRaceDate(today);

    expect(earliest).toBe('2026-08-31');
    expect(planWindow({ ...RACE, raceDate: earliest }, today).weeks).toBe(
      MIN_RACE_PLAN_WEEKS,
    );
  });

  it('refuse la veille de cette date — la borne du champ ne ment pas', () => {
    const today = '2026-08-11';

    expect(() =>
      planWindow({ ...RACE, raceDate: '2026-08-30' }, today),
    ).toThrowError(/trop court/);
  });

  it('part du jour même quand on est déjà lundi', () => {
    expect(earliestRaceDate('2026-08-17')).toBe('2026-08-31');
  });
});

describe('latestRaceDate', () => {
  it('laisse exactement la place du plan le plus long', () => {
    // Plan démarré le lundi 17 août 2026 : sa 52e semaine s'achève le dimanche
    // 15 août 2027.
    const today = '2026-08-11';
    const latest = latestRaceDate(today);

    expect(latest).toBe('2027-08-15');
    expect(planWindow({ ...RACE, raceDate: latest }, today).weeks).toBe(MAX_PLAN_WEEKS);
  });

  it('refuse le lendemain de cette date — le service la rejetterait aussi', () => {
    expect(() =>
      planWindow({ ...RACE, raceDate: '2027-08-16' }, '2026-08-11'),
    ).toThrowError(/trop lointaine/);
  });
});

/** Demande de plan minimale : seule la date de course compte ici. */
const RACE = {
  goalType: 'race',
  goalText: '10 km sous 50 min',
  sessionsPerWeek: 3,
  longRunDay: 7,
} as const;
