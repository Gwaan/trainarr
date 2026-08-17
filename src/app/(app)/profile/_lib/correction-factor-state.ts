/**
 * L'état que le bloc « Facteur correctif de la VO₂max » échange avec sa Server
 * Action.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones** : Next refuse tout export de valeur, et pas au build —
 * seulement à l'évaluation du module, c'est-à-dire en production. L'état initial
 * de `useActionState` vit donc ici, comme `elevation-correction-state.ts`.
 */

export type CorrectionFactorFormState = {
  status: 'idle' | 'success' | 'error';
  message?: string;
};

export const CORRECTION_FACTOR_FORM_IDLE: CorrectionFactorFormState = { status: 'idle' };
