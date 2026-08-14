/**
 * L'état que le bloc « Lieu des prévisions météo » échange avec ses deux Server
 * Actions — la recherche et l'enregistrement.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones** : Next refuse tout export de valeur, et pas au build —
 * seulement à l'évaluation du module, c'est-à-dire en production. Les états
 * initiaux de `useActionState` et les types vivent donc ici, comme
 * `intervals-state.ts`.
 */

/**
 * Un lieu proposé par le géocodage, tel qu'il franchit la frontière client.
 *
 * Les coordonnées **en font partie**, et c'est le seul endroit du système où
 * elles le font : ce sont celles d'une ville publique que l'athlète vient de
 * chercher, pas sa position. Elles reviennent avec son choix (`saveForecastLocationAction`),
 * qui les revalide — rien n'est cru sur parole au retour.
 */
export type ForecastPlaceOption = {
  /** Identifiant GeoNames — clé de liste, et rien de plus. */
  id: number;
  name: string;
  /** Région, `null` là où il n'y en a pas. Elle départage les homonymes. */
  region: string | null;
  country: string | null;
  latitudeDeg: number;
  longitudeDeg: number;
};

/**
 * Résultat d'une recherche.
 *
 * `empty` est un statut à part entière : « aucun lieu ne porte ce nom » n'est ni
 * un succès muet ni une panne, et l'écran a une phrase pour chacun.
 */
export type ForecastSearchState = {
  status: 'idle' | 'results' | 'empty' | 'error';
  /** Ce qui a été cherché — l'écran le cite dans sa réponse. */
  query?: string;
  places?: ForecastPlaceOption[];
  message?: string;
};

export const FORECAST_SEARCH_IDLE: ForecastSearchState = { status: 'idle' };

export type ForecastLocationFormState = {
  status: 'idle' | 'success' | 'error';
  message?: string;
};

export const FORECAST_LOCATION_FORM_IDLE: ForecastLocationFormState = { status: 'idle' };

/**
 * Valeur du bouton « revenir au mode automatique ».
 *
 * Elle vit ici parce que le bouton (composant client) et la lecture du
 * `FormData` (serveur) doivent s'accorder sur la même chaîne — même raison que
 * `CLEAR_API_KEY_VALUE`.
 */
export const CLEAR_FORECAST_LOCATION_VALUE = 'clear';
