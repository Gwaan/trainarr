import { describe, expect, it } from 'vitest';

import { REFERENCE_DISTANCES } from '@/lib/metrics/vdot';

import {
  DEFAULT_LEVEL,
  DEFAULT_REFERENCE_DISTANCE,
  LEVEL_CHOICES,
  LEVEL_LABELS,
  REFERENCE_DISTANCE_CHOICES,
  asReferenceDistance,
  formatRaceTimeSeconds,
  parseRaceTimeSeconds,
} from './form-options';

/**
 * Les choix du formulaire ne sont pas la source d'autorité (c'est la Server
 * Action qui valide), mais ils doivent rester alignés sur elle : un choix
 * proposé puis refusé serait un formulaire qui ment.
 */
describe('LEVEL_CHOICES', () => {
  it('propose les trois niveaux du plus accessible au plus engagé', () => {
    expect(LEVEL_CHOICES.map((choice) => choice.value)).toEqual([
      'beginner',
      'intermediate',
      'advanced',
    ]);
  });

  it('porte le libellé français et une aide qui situe la pratique', () => {
    expect(LEVEL_CHOICES.map((choice) => choice.label)).toEqual([
      'Débutant',
      'Intermédiaire',
      'Confirmé',
    ]);
    for (const choice of LEVEL_CHOICES) {
      expect(choice.hint.length).toBeGreaterThan(0);
      expect(choice.label).toBe(LEVEL_LABELS[choice.value]);
    }
  });

  it('propose Intermédiaire par défaut, et ce défaut est bien un des choix', () => {
    expect(DEFAULT_LEVEL).toBe('intermediate');
    expect(LEVEL_CHOICES.map((choice) => choice.value)).toContain(DEFAULT_LEVEL);
  });
});

describe('REFERENCE_DISTANCE_CHOICES', () => {
  it('propose exactement les distances que le calcul VDOT sait ancrer', () => {
    // Une distance proposée mais inconnue du calcul serait refusée après coup.
    expect(REFERENCE_DISTANCE_CHOICES.map((choice) => choice.value)).toEqual(
      Object.keys(REFERENCE_DISTANCES),
    );
  });

  it('propose le 10 km par défaut, et ce défaut est bien un des choix', () => {
    expect(DEFAULT_REFERENCE_DISTANCE).toBe('10k');
    expect(asReferenceDistance(DEFAULT_REFERENCE_DISTANCE)).toBe(DEFAULT_REFERENCE_DISTANCE);
  });

  it('donne à chaque distance un exemple de saisie dans son format', () => {
    for (const choice of REFERENCE_DISTANCE_CHOICES) {
      expect(parseRaceTimeSeconds(choice.placeholder)).not.toBeNull();
    }
  });

  it('écarte ce qui ne désigne aucune distance connue', () => {
    expect(asReferenceDistance('3k')).toBeNull();
    expect(asReferenceDistance('')).toBeNull();
  });
});

describe('parseRaceTimeSeconds', () => {
  it('lit un chrono en mm:ss comme en hh:mm:ss', () => {
    expect(parseRaceTimeSeconds('48:30')).toBe(2_910);
    expect(parseRaceTimeSeconds('4:30')).toBe(270);
    expect(parseRaceTimeSeconds('1:52:00')).toBe(6_720);
    expect(parseRaceTimeSeconds('  3:55:12  ')).toBe(14_112);
  });

  it("rend null sur tout ce qui n'est pas un chrono", () => {
    // « 90:00 » est ambigu (90 minutes ? 90 secondes ?) : on ne devine pas.
    for (const input of ['', '48', '48,30', '90:00', '1:2:3:4', '48:75', 'quarante']) {
      expect(parseRaceTimeSeconds(input)).toBeNull();
    }
  });
});

describe('formatRaceTimeSeconds', () => {
  it('refait le chemin inverse, à la seconde près', () => {
    expect(formatRaceTimeSeconds(2_910)).toBe('48:30');
    expect(formatRaceTimeSeconds(270)).toBe('4:30');
    expect(formatRaceTimeSeconds(6_720)).toBe('1:52:00');
    expect(formatRaceTimeSeconds(14_112)).toBe('3:55:12');
  });
});
