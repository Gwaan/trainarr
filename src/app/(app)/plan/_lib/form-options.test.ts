import { describe, expect, it } from 'vitest';

import { DEFAULT_LEVEL, LEVEL_CHOICES, LEVEL_LABELS } from './form-options';

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
