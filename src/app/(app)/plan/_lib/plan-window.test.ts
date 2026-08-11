import { describe, expect, it, vi } from 'vitest';

import { MAX_PLAN_WEEKS, MIN_RACE_PLAN_WEEKS, planWindow } from '@/lib/ai/plan-service';

import {
  MAX_PLAN_START_LEAD_WEEKS,
  earliestPlanStart,
  earliestRaceDate,
  latestPlanStart,
  latestRaceDate,
} from './plan-window';

// Les modules serveur commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * Les bornes des champs date et la fenêtre que le service calculera sont
 * vérifiées ensemble : c'est leur désaccord qui produirait un formulaire
 * proposant une date aussitôt refusée.
 */

/** Aujourd'hui : mardi 11 août 2026 — le plan démarrerait le lundi 17. */
const TODAY = '2026-08-11';

describe('earliestPlanStart', () => {
  it('propose le prochain lundi', () => {
    expect(earliestPlanStart(TODAY)).toBe('2026-08-17');
  });

  it('propose le jour même quand on est déjà lundi', () => {
    expect(earliestPlanStart('2026-08-17')).toBe('2026-08-17');
    // Et le service accepte bien ce démarrage-là : rien à attendre.
    expect(planWindow({ ...FREE, startsOn: '2026-08-17' }, '2026-08-17').startsOn).toBe(
      '2026-08-17',
    );
  });
});

describe('latestPlanStart', () => {
  it('propose huit lundis, pas un de plus', () => {
    const latest = latestPlanStart(TODAY);

    // Sept semaines après le lundi 17 août, soit huit lundis proposés — et
    // moins de huit semaines après aujourd'hui.
    expect(latest).toBe('2026-10-05');
    expect(MAX_PLAN_START_LEAD_WEEKS).toBe(8);
    // Le service accepte ce démarrage : la borne du champ ne ment pas.
    expect(planWindow({ ...FREE, startsOn: latest }, TODAY).startsOn).toBe(latest);
  });
});

describe('earliestRaceDate', () => {
  it('laisse exactement la place du plan le plus court', () => {
    const startsOn = earliestPlanStart(TODAY);
    const earliest = earliestRaceDate(startsOn);

    expect(earliest).toBe('2026-08-31');
    expect(planWindow({ ...RACE, raceDate: earliest }, TODAY).weeks).toBe(MIN_RACE_PLAN_WEEKS);
  });

  it('refuse la veille de cette date — la borne du champ ne ment pas', () => {
    expect(() => planWindow({ ...RACE, raceDate: '2026-08-30' }, TODAY)).toThrowError(
      /trop court/,
    );
  });

  it('suit la date de démarrage choisie', () => {
    const startsOn = '2026-08-31';
    const earliest = earliestRaceDate(startsOn);

    expect(earliest).toBe('2026-09-14');
    expect(planWindow({ ...RACE, raceDate: earliest, startsOn }, TODAY).weeks).toBe(
      MIN_RACE_PLAN_WEEKS,
    );
  });
});

describe('latestRaceDate', () => {
  it('laisse exactement la place du plan le plus long', () => {
    // Plan démarré le lundi 17 août 2026 : sa 52e semaine s'achève le dimanche
    // 15 août 2027.
    const latest = latestRaceDate(earliestPlanStart(TODAY));

    expect(latest).toBe('2027-08-15');
    expect(planWindow({ ...RACE, raceDate: latest }, TODAY).weeks).toBe(MAX_PLAN_WEEKS);
  });

  it('refuse le lendemain de cette date — le service la rejetterait aussi', () => {
    expect(() => planWindow({ ...RACE, raceDate: '2027-08-16' }, TODAY)).toThrowError(
      /trop lointaine/,
    );
  });

  it('suit la date de démarrage choisie', () => {
    const startsOn = latestPlanStart(TODAY);
    const latest = latestRaceDate(startsOn);

    expect(planWindow({ ...RACE, raceDate: latest, startsOn }, TODAY).weeks).toBe(MAX_PLAN_WEEKS);
    expect(() =>
      planWindow({ ...RACE, raceDate: '2027-10-05', startsOn }, TODAY),
    ).toThrowError(/trop lointaine/);
  });
});

/** Demande de plan minimale : seule la date de course compte ici. */
const RACE = {
  goalType: 'race',
  goalText: '10 km sous 50 min',
  level: 'intermediate',
  sessionsPerWeek: 3,
  longRunDay: 7,
} as const;

/** La même, sans échéance : seule la date de démarrage compte. */
const FREE = { ...RACE, goalType: 'free', weeks: 4 } as const;
