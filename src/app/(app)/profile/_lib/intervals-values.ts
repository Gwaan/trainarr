/**
 * Valeurs par défaut du bloc « Import automatique » du profil.
 *
 * Fonction pure, testée : la page traduit le DTO du DAL en ce que le composant
 * client a le droit de connaître — l'identifiant d'athlète, et **l'état** de la
 * clé API, jamais sa valeur.
 */

import type { IntervalsApiKeyState, IntervalsSettingsDto } from '@/data/athlete';

export type { IntervalsApiKeyState };

/**
 * Ce que la page passe au client.
 *
 * Il n'y a **pas** de champ « clé » ici, et c'est délibéré : une clé masquée
 * reste une clé transmise au navigateur. Le formulaire n'a besoin que de savoir
 * s'il propose « enregistrer », « remplacer » ou « ressaisir ».
 */
export type IntervalsFormDefaults = {
  intervalsAthleteId: string;
  apiKeyState: IntervalsApiKeyState;
};

/** Onboarding : aucun athlète en base, donc aucun identifiant et aucune clé. */
export const EMPTY_INTERVALS_FORM_DEFAULTS: IntervalsFormDefaults = {
  intervalsAthleteId: '',
  apiKeyState: 'absent',
};

/**
 * Les saisies du bloc, telles que le composant client les tient.
 *
 * `apiKey` part **toujours** vide : un champ de secret ne se pré-remplit pas,
 * et il n'y aurait de toute façon rien à y mettre.
 */
export type IntervalsFormValues = {
  intervalsAthleteId: string;
  apiKey: string;
  /** Case « effacer la clé enregistrée » — sans objet quand il n'y en a pas. */
  clearApiKey: boolean;
};

/** Création du profil : rien n'est enregistré, donc rien n'est pré-rempli. */
export const EMPTY_INTERVALS_FORM_VALUES: IntervalsFormValues = {
  intervalsAthleteId: '',
  apiKey: '',
  clearApiKey: false,
};

export function toIntervalsFormValues(
  defaults: IntervalsFormDefaults,
): IntervalsFormValues {
  return {
    intervalsAthleteId: defaults.intervalsAthleteId,
    apiKey: '',
    clearApiKey: false,
  };
}

export function toIntervalsFormDefaults(
  settings: IntervalsSettingsDto | null,
): IntervalsFormDefaults {
  if (settings === null) return EMPTY_INTERVALS_FORM_DEFAULTS;

  return {
    intervalsAthleteId: settings.intervalsAthleteId ?? '',
    apiKeyState: settings.apiKey,
  };
}
