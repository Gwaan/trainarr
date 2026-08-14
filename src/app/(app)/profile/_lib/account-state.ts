/**
 * L'état que les formulaires de la section « Ton compte » échangent avec leurs
 * Server Actions.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones** : Next refuse tout export de valeur, et pas au build —
 * seulement à l'évaluation du module, c'est-à-dire en production. L'état initial
 * de `useActionState` et les types vivent donc ici, comme
 * `src/app/(auth)/_lib/form-state.ts`.
 */

/** Les champs que portent les trois formulaires du compte. */
export type AccountField =
  | 'name'
  | 'currentPassword'
  | 'newPassword'
  | 'newPasswordConfirm';

export type AccountFormState = {
  status: 'idle' | 'success' | 'error';
  fieldErrors?: Partial<Record<AccountField, string>>;
  message?: string;
};

export const ACCOUNT_FORM_IDLE: AccountFormState = { status: 'idle' };
