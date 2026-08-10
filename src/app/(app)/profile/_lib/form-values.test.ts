import { describe, expect, it } from 'vitest';

import type { AthleteProfileDto } from '@/data/athlete';

import {
  EMPTY_PROFILE_FORM_VALUES,
  SEX_CHOICES,
  toProfileFormValues,
} from './form-values';

const FULL_PROFILE: AthleteProfileDto = {
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 188,
  restingHrBpm: 48,
  weightKg: 62.5,
  birthDate: '1990-04-17',
};

describe('toProfileFormValues', () => {
  it("rend tous les champs vides quand aucun profil n'existe (onboarding)", () => {
    expect(toProfileFormValues(null)).toEqual(EMPTY_PROFILE_FORM_VALUES);
  });

  it('pré-remplit chaque champ depuis le profil', () => {
    expect(toProfileFormValues(FULL_PROFILE)).toEqual({
      displayName: 'Gwen',
      sex: 'female',
      maxHrBpm: '188',
      restingHrBpm: '48',
      weightKg: '62.5',
      birthDate: '1990-04-17',
    });
  });

  it("laisse vides les mesures absentes plutôt que d'afficher un zéro", () => {
    expect(
      toProfileFormValues({
        displayName: 'Gwen',
        sex: null,
        maxHrBpm: null,
        restingHrBpm: null,
        weightKg: null,
        birthDate: null,
      }),
    ).toEqual({
      ...EMPTY_PROFILE_FORM_VALUES,
      displayName: 'Gwen',
      sex: '',
    });
  });

  it('traduit un sexe non renseigné par le choix « préfère ne pas dire »', () => {
    const values = toProfileFormValues({ ...FULL_PROFILE, sex: null });
    const choice = SEX_CHOICES.find((option) => option.value === values.sex);

    expect(values.sex).toBe('');
    expect(choice?.label).toBe('Préfère ne pas dire');
  });

  it("ne présélectionne aucun choix de sexe à l'onboarding", () => {
    // `null` ≠ `''` : rien n'est coché tant que la question n'a pas été posée.
    expect(toProfileFormValues(null).sex).toBeNull();
  });
});
