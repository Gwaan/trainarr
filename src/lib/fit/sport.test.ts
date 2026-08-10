import { describe, expect, it } from 'vitest';

import {
  defaultActivityName,
  mapFitSportType,
  usesFootCadence,
  usesFootCadenceSportType,
} from './sport';

describe('mapFitSportType', () => {
  it.each([
    ['running', undefined, 'Run'],
    ['running', 'street', 'Run'],
    ['running', 'track', 'Run'],
    ['running', 'trail', 'TrailRun'],
    ['running', 'treadmill', 'VirtualRun'],
    ['running', 'indoorRunning', 'VirtualRun'],
    ['cycling', 'road', 'Ride'],
    ['cycling', 'mountain', 'MountainBikeRide'],
    ['cycling', 'gravelCycling', 'GravelRide'],
    ['cycling', 'indoorCycling', 'VirtualRide'],
    ['eBiking', undefined, 'EBikeRide'],
    ['walking', 'casualWalking', 'Walk'],
    ['hiking', undefined, 'Hike'],
    ['swimming', 'lapSwimming', 'Swim'],
    ['rowing', undefined, 'Rowing'],
    ['crossCountrySkiing', 'skateSkiing', 'NordicSki'],
    ['training', 'strengthTraining', 'WeightTraining'],
    ['training', 'yoga', 'Yoga'],
    ['training', 'cardioTraining', 'Workout'],
    ['generic', 'generic', 'Workout'],
  ])('traduit (%s, %s) en %s', (sport, subSport, expected) => {
    expect(mapFitSportType(sport, subSport)).toEqual({ sportType: expected, warning: null });
  });

  it('capitalise les sports FIT sans libellé dédié', () => {
    expect(mapFitSportType('windsurfing', 'generic')).toEqual({
      sportType: 'Windsurfing',
      warning: null,
    });
  });

  it('conserve un code de sport inconnu du SDK au lieu d’en inventer un', () => {
    const { sportType, warning } = mapFitSportType(250, undefined);

    expect(sportType).toBe('FitSport250');
    expect(warning).toMatch(/inconnu/);
  });

  it('signale une session sans sport', () => {
    const { sportType, warning } = mapFitSportType(undefined, undefined);

    expect(sportType).toBe('Workout');
    expect(warning).toMatch(/absent/);
  });
});

describe('usesFootCadence', () => {
  it('vaut vrai pour les sports à pied', () => {
    expect(usesFootCadence('running')).toBe(true);
    expect(usesFootCadence('walking')).toBe(true);
    expect(usesFootCadence('hiking')).toBe(true);
  });

  it('vaut faux pour le vélo et les sports sans cadence de pas', () => {
    expect(usesFootCadence('cycling')).toBe(false);
    expect(usesFootCadence('swimming')).toBe(false);
    expect(usesFootCadence(250)).toBe(false);
    expect(usesFootCadence(undefined)).toBe(false);
  });
});

describe('usesFootCadenceSportType', () => {
  it('vaut vrai pour les sports à pied du vocabulaire `sport_type`', () => {
    // La colonne `avg_cadence_spm` ne doit jamais mélanger les pas par minute
    // et les cycles d'une seule jambe.
    for (const sportType of ['Run', 'TrailRun', 'VirtualRun', 'Walk', 'Hike']) {
      expect(usesFootCadenceSportType(sportType)).toBe(true);
    }
  });

  it('vaut faux pour le vélo et les autres disciplines', () => {
    for (const sportType of ['Ride', 'VirtualRide', 'GravelRide', 'Swim', 'Workout']) {
      expect(usesFootCadenceSportType(sportType)).toBe(false);
    }
  });
});

describe('defaultActivityName', () => {
  it.each([
    ['Run', 'Course à pied'],
    ['TrailRun', 'Trail'],
    ['Ride', 'Vélo'],
    ['Walk', 'Marche'],
    ['Hike', 'Randonnée'],
    ['Swim', 'Natation'],
  ])('nomme %s « %s »', (sportType, expected) => {
    expect(defaultActivityName(sportType)).toBe(expected);
  });

  it('garde le libellé technique d’un sport sans traduction plutôt que d’en inventer une', () => {
    expect(defaultActivityName('GravelRide')).toBe('GravelRide');
    expect(defaultActivityName('FitSport250')).toBe('FitSport250');
  });
});
