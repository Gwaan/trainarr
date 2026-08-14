/**
 * L'état que les formulaires d'identité échangent avec leurs Server Actions.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que
 * des fonctions asynchrones** : Next refuse à l'exécution — pas au build, le
 * contrôle n'a lieu qu'à l'évaluation du module — tout export de valeur. L'état
 * initial partagé par `useActionState` doit donc vivre en dehors du fichier
 * d'actions, et les types avec lui, pour que les deux se lisent au même endroit.
 */

/** Les champs que portent les deux formulaires d'identité. */
export type AuthField = 'name' | 'email' | 'password' | 'passwordConfirm';

export type AuthFormState = {
  status: 'idle' | 'error';
  fieldErrors?: Partial<Record<AuthField, string>>;
  message?: string;
};

export const AUTH_FORM_IDLE: AuthFormState = { status: 'idle' };
