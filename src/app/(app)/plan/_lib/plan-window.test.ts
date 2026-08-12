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

/** Aujourd'hui : mardi 11 août 2026 — le plan peut démarrer ce jour-là. */
const TODAY = '2026-08-11';

describe('earliestPlanStart', () => {
  it("propose aujourd'hui, quel que soit le jour de la semaine", () => {
    expect(earliestPlanStart(TODAY)).toBe(TODAY);
    // Et le service accepte bien ce démarrage-là : rien à attendre.
    expect(planWindow({ ...FREE, startsOn: TODAY }, TODAY).startsOn).toBe(TODAY);
    // Un lundi ne change rien à la règle.
    expect(earliestPlanStart('2026-08-17')).toBe('2026-08-17');
  });

  it('refuse la veille — le service ne démarre pas dans le passé', () => {
    expect(() => planWindow({ ...FREE, startsOn: '2026-08-10' }, TODAY)).toThrowError(
      /dans le passé/,
    );
  });
});

describe('latestPlanStart', () => {
  it('propose huit semaines à l’avance, pas un jour de plus', () => {
    const latest = latestPlanStart(TODAY);

    expect(latest).toBe('2026-10-06');
    expect(MAX_PLAN_START_LEAD_WEEKS).toBe(8);
    // Le service accepte ce démarrage : la borne du champ ne ment pas.
    expect(planWindow({ ...FREE, startsOn: latest }, TODAY).startsOn).toBe(latest);
  });
});

describe('earliestRaceDate', () => {
  it('laisse exactement la place du plan le plus court', () => {
    const startsOn = earliestPlanStart(TODAY);
    const earliest = earliestRaceDate(startsOn);

    // Départ le mardi 11 : la grille s'ancre au lundi 10, et trois semaines
    // depuis cette ancre s'achèvent le dimanche 30 — le lundi 24 est donc la
    // première course qui laisse trois semaines entamées ou pleines.
    expect(earliest).toBe('2026-08-24');
    expect(planWindow({ ...RACE, raceDate: earliest }, TODAY).weeks).toBe(MIN_RACE_PLAN_WEEKS);
  });

  it('refuse la veille de cette date — la borne du champ ne ment pas', () => {
    expect(() => planWindow({ ...RACE, raceDate: '2026-08-23' }, TODAY)).toThrowError(
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

  it("repousse d'une semaine quand la semaine du départ ne compte pas", () => {
    // Dimanche 16 août : la semaine entamée n'a qu'un jour, elle ne prépare
    // rien. Le lundi 24 afficherait « trois semaines » pour huit jours de
    // préparation — le champ ne le propose pas, et le service le refuse.
    const startsOn = '2026-08-16';
    const earliest = earliestRaceDate(startsOn);

    expect(earliest).toBe('2026-08-31');
    expect(planWindow({ ...RACE, raceDate: earliest, startsOn }, TODAY).weeks).toBe(
      MIN_RACE_PLAN_WEEKS + 1,
    );
    expect(() =>
      planWindow({ ...RACE, raceDate: '2026-08-24', startsOn }, TODAY),
    ).toThrowError(/trop court/);
    expect(() =>
      planWindow({ ...RACE, raceDate: '2026-08-30', startsOn }, TODAY),
    ).toThrowError(/trop court/);
  });

  it('suit aussi un démarrage en milieu de semaine, sur son ancre', () => {
    const startsOn = '2026-09-03';
    const earliest = earliestRaceDate(startsOn);

    // Jeudi 3 septembre : ancre au lundi 31 août, donc course au plus tôt le
    // lundi 14 septembre.
    expect(earliest).toBe('2026-09-14');
    expect(planWindow({ ...RACE, raceDate: earliest, startsOn }, TODAY).weeks).toBe(
      MIN_RACE_PLAN_WEEKS,
    );
    expect(() =>
      planWindow({ ...RACE, raceDate: '2026-09-13', startsOn }, TODAY),
    ).toThrowError(/trop court/);
  });
});

describe('latestRaceDate', () => {
  it('laisse exactement la place du plan le plus long', () => {
    // Plan démarré le mardi 11 août 2026, ancré au lundi 10 : sa 52e semaine
    // s'achève le dimanche 8 août 2027.
    const latest = latestRaceDate(earliestPlanStart(TODAY));

    expect(latest).toBe('2027-08-08');
    expect(planWindow({ ...RACE, raceDate: latest }, TODAY).weeks).toBe(MAX_PLAN_WEEKS);
  });

  it('refuse le lendemain de cette date — le service la rejetterait aussi', () => {
    expect(() => planWindow({ ...RACE, raceDate: '2027-08-09' }, TODAY)).toThrowError(
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
  intent: 'race',
  goalText: '10 km sous 50 min',
  level: 'intermediate',
  sessionsPerWeek: 3,
  longRunDay: 7,
} as const;

/** La même, sans échéance : seule la date de démarrage compte. */
const FREE = { ...RACE, intent: 'faster', weeks: 4 } as const;
