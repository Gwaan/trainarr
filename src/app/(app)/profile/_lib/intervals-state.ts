/**
 * L'état que le formulaire « Import automatique » échange avec sa Server Action.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones** : Next refuse tout export de valeur, et pas au build —
 * seulement à l'évaluation du module, c'est-à-dire en production. L'état initial
 * de `useActionState` et les types vivent donc ici, comme `account-state.ts`.
 */

/** Les deux champs du bloc. `apiKey` désigne la saisie, jamais une valeur rendue. */
export type IntervalsField = 'intervalsAthleteId' | 'apiKey';

export type IntervalsFormState = {
  status: 'idle' | 'success' | 'error';
  fieldErrors?: Partial<Record<IntervalsField, string>>;
  message?: string;
};

export const INTERVALS_FORM_IDLE: IntervalsFormState = { status: 'idle' };

/**
 * Valeur envoyée par la case « effacer la clé enregistrée » quand elle est
 * cochée. Elle vit ici parce que la case (composant client) et la lecture du
 * `FormData` (serveur) doivent s'accorder sur la même chaîne.
 */
export const CLEAR_API_KEY_VALUE = 'clear';
