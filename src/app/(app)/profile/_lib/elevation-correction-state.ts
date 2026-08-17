/**
 * L'état que le bloc « Correction d'altitude » échange avec sa Server Action.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones** : Next refuse tout export de valeur, et pas au build —
 * seulement à l'évaluation du module, c'est-à-dire en production. L'état initial
 * de `useActionState` et les types vivent donc ici, comme
 * `forecast-location-state.ts` et `intervals-state.ts`.
 */

/** Les deux champs numériques du formulaire — de quoi placer une erreur sous le bon. */
export type ElevationCorrectionField = 'ascentCoefM' | 'descentCoefM';

export type ElevationCorrectionFormState = {
  status: 'idle' | 'success' | 'error';
  message?: string;
  /** Erreurs par champ, quand la saisie est en cause plutôt que l'écriture. */
  fieldErrors?: Partial<Record<ElevationCorrectionField, string>>;
};

export const ELEVATION_CORRECTION_FORM_IDLE: ElevationCorrectionFormState = { status: 'idle' };

/**
 * Nom du champ de la case « appliquer la correction ».
 *
 * Il vit ici parce que la case (composant client) et la lecture du `FormData`
 * (serveur) doivent s'accorder sur la même chaîne — même raison que
 * `CLEAR_FORECAST_LOCATION_VALUE`. Une case décochée **n'apparaît pas** dans le
 * `FormData` : c'est sa présence qui vaut « oui », jamais sa valeur.
 */
export const ELEVATION_CORRECTION_ENABLED_FIELD = 'enabled';
