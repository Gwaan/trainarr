/**
 * Valeurs par défaut du formulaire de profil.
 *
 * Fonction pure, testée : la page traduit le DTO du DAL en chaînes prêtes à être
 * rendues, et le composant client ne reçoit que ces chaînes.
 */

import type { AthleteProfileDto } from '@/data/athlete';

/**
 * Les trois choix de sexe proposés. `''` = « préfère ne pas dire » : le champ
 * est envoyé vide et l'action l'enregistre en `null` — sans cette information,
 * la charge d'entraînement n'est pas calculée (coefficients de Banister).
 */
export const SEX_CHOICES = [
  { value: 'female', label: 'Femme' },
  { value: 'male', label: 'Homme' },
  { value: '', label: 'Préfère ne pas dire' },
] as const;

export type SexChoice = (typeof SEX_CHOICES)[number]['value'];

/**
 * Un champ par entrée du formulaire, toujours une chaîne (vide si non renseigné).
 *
 * `sex` fait exception : `null` signifie « aucun choix affiché » — l'onboarding
 * n'en présélectionne aucun, pour que « préfère ne pas dire » reste une réponse
 * donnée et non un défaut subi. Un profil existant sans sexe enregistré, lui,
 * affiche bien ce choix-là.
 */
export type ProfileFormValues = {
  displayName: string;
  sex: SexChoice | null;
  maxHrBpm: string;
  restingHrBpm: string;
  weightKg: string;
  birthDate: string;
};

/** Formulaire d'onboarding : aucun profil, donc aucun champ pré-rempli. */
export const EMPTY_PROFILE_FORM_VALUES: ProfileFormValues = {
  displayName: '',
  sex: null,
  maxHrBpm: '',
  restingHrBpm: '',
  weightKg: '',
  birthDate: '',
};

/** Une valeur absente donne un champ vide — jamais un `0` qui passerait pour une mesure. */
function toField(value: number | null): string {
  return value === null ? '' : String(value);
}

export function toProfileFormValues(
  profile: AthleteProfileDto | null,
): ProfileFormValues {
  if (profile === null) return EMPTY_PROFILE_FORM_VALUES;

  return {
    displayName: profile.displayName,
    sex: profile.sex ?? '',
    maxHrBpm: toField(profile.maxHrBpm),
    restingHrBpm: toField(profile.restingHrBpm),
    weightKg: toField(profile.weightKg),
    // Date civile `YYYY-MM-DD` : le format attendu par `<input type="date">`.
    birthDate: profile.birthDate ?? '',
  };
}
