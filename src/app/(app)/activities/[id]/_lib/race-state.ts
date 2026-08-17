/**
 * L'état que le bloc « Course officielle » échange avec ses Server Actions.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones** : Next refuse tout export de valeur, et pas au build —
 * seulement à l'évaluation du module, c'est-à-dire en production. Les états
 * initiaux de `useActionState` et les types vivent donc ici, comme
 * `profile/_lib/elevation-correction-state.ts`.
 */

/** Les quatre champs du formulaire — de quoi placer une erreur sous le bon. */
export type RaceFormField = "racedOn" | "distanceKm" | "time" | "name";

export type RaceFormState = {
  status: "idle" | "success" | "error";
  message?: string;
  /** Erreurs par champ, quand la saisie est en cause plutôt que l'écriture. */
  fieldErrors?: Partial<Record<RaceFormField, string>>;
};

export const RACE_FORM_IDLE: RaceFormState = { status: "idle" };

/**
 * Le retrait n'a pas de champ à fauter : son état se réduit à un statut et un
 * message. Il reste distinct de celui du formulaire pour que retirer une course
 * n'efface pas le bandeau d'un enregistrement, ni l'inverse.
 */
export type RaceRemovalState = { status: "idle" | "success" | "error"; message?: string };

export const RACE_REMOVAL_IDLE: RaceRemovalState = { status: "idle" };
