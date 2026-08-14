import { describe, expect, it } from 'vitest';

import {
  isWellnessReadingDue,
  WELLNESS_READING_HOUR,
  WELLNESS_WINDOW_DAYS,
  wellnessReadingMarker,
  wellnessWindow,
} from './wellness-plan';

/**
 * Le fuseau de l'application est `Europe/Paris` (cf. `src/config/time.ts`) : en
 * août, UTC+2. Les instants ci-dessous sont donc écrits en UTC et commentés en
 * heure locale, comme dans les tests du relevé météo.
 */
const AT_0700_LOCAL = new Date('2026-08-13T05:00:00Z');
const AT_0900_LOCAL = new Date('2026-08-13T07:00:00Z');
const AT_2300_LOCAL = new Date('2026-08-13T21:00:00Z');

describe('wellnessReadingMarker', () => {
  it('rend la veille avant l’heure du relevé', () => {
    expect(wellnessReadingMarker(AT_0700_LOCAL)).toBe('2026-08-12');
  });

  it('rend le jour même à l’heure pile', () => {
    expect(wellnessReadingMarker(AT_0900_LOCAL)).toBe('2026-08-13');
  });

  it('rend le jour même le reste de la journée', () => {
    expect(wellnessReadingMarker(AT_2300_LOCAL)).toBe('2026-08-13');
  });

  it('bascule sur l’heure **locale**, pas sur l’heure UTC', () => {
    // 07 h 30 UTC = 09 h 30 à Paris : le relevé du jour est dû, alors qu'un
    // calcul en UTC le croirait encore à la veille.
    expect(wellnessReadingMarker(new Date('2026-08-13T07:30:00Z'))).toBe('2026-08-13');
    // 06 h 30 UTC = 08 h 30 à Paris : pas encore.
    expect(wellnessReadingMarker(new Date('2026-08-13T06:30:00Z'))).toBe('2026-08-12');
  });

  it('bascule à l’heure annoncée par la constante', () => {
    expect(WELLNESS_READING_HOUR).toBe(9);
  });
});

describe('isWellnessReadingDue', () => {
  it('est dû quand aucun relevé n’a jamais eu lieu', () => {
    expect(isWellnessReadingDue(null, AT_0900_LOCAL)).toBe(true);
  });

  it('est dû quand le marqueur mémorisé est dépassé', () => {
    expect(isWellnessReadingDue('2026-08-12', AT_0900_LOCAL)).toBe(true);
  });

  it('n’est pas dû quand le marqueur est celui de l’instant', () => {
    expect(isWellnessReadingDue('2026-08-13', AT_0900_LOCAL)).toBe(false);
  });

  it('n’est pas dû au petit matin quand la veille a été relevée', () => {
    // 07 h locales : le marqueur courant est encore celui d'hier, déjà relevé.
    expect(isWellnessReadingDue('2026-08-12', AT_0700_LOCAL)).toBe(false);
  });

  it('rattrape sans code de rattrapage : une reprise à 23 h relève encore le jour', () => {
    expect(isWellnessReadingDue('2026-08-12', AT_2300_LOCAL)).toBe(true);
  });

  it('ne déclenche rien sur un marqueur postérieur (horloge reculée)', () => {
    expect(isWellnessReadingDue('2026-08-20', AT_0900_LOCAL)).toBe(false);
  });
});

describe('wellnessWindow', () => {
  it('redemande les quatorze derniers jours, aujourd’hui compris', () => {
    expect(wellnessWindow(AT_0900_LOCAL)).toEqual({
      oldest: '2026-07-31',
      newest: '2026-08-13',
    });
  });

  it('ne demande jamais un jour futur', () => {
    expect(wellnessWindow(AT_2300_LOCAL).newest).toBe('2026-08-13');
  });

  it('couvre exactement le nombre de jours annoncé', () => {
    const { oldest, newest } = wellnessWindow(AT_0900_LOCAL);
    const span = (Date.parse(`${newest}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000;
    expect(span + 1).toBe(WELLNESS_WINDOW_DAYS);
  });

  it('reste en heure locale : la fenêtre du petit matin est celle du jour civil local', () => {
    // 00 h 30 locales le 13 (22 h 30 UTC le 12) : la fenêtre se termine le 13.
    expect(wellnessWindow(new Date('2026-08-12T22:30:00Z')).newest).toBe('2026-08-13');
  });
});
