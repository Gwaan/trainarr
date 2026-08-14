/**
 * L'état que la section « Inviter quelqu'un » échange avec ses Server Actions.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones** : Next refuse tout export de valeur, et pas au build —
 * seulement à l'évaluation du module, c'est-à-dire en production. Les états
 * initiaux de `useActionState` et les types vivent donc ici, comme
 * `intervals-state.ts`.
 */

/**
 * Le résultat d'une émission.
 *
 * `created` porte le **chemin** du lien (`/invitation/<jeton>`), et non son URL
 * absolue : c'est le navigateur qui préfixe son propre `origin`. Le serveur
 * n'a alors pas à deviner sous quel nom de domaine il est joint — ni à faire
 * confiance à un en-tête `Host` pour le savoir.
 *
 * **C'est l'unique passage du jeton en clair après sa création.** Il vit dans
 * l'état d'un composant client, le temps de la vue ; rien ne le réécrit ni ne le
 * relit ensuite.
 */
export type InvitationFormState =
  | { status: 'idle' }
  | { status: 'created'; path: string; expiresLabel: string }
  | { status: 'error'; message: string };

export const INVITATION_FORM_IDLE: InvitationFormState = { status: 'idle' };

/** Le résultat d'une révocation — un refus s'affiche, un succès fait disparaître la ligne. */
export type RevokeFormState = {
  status: 'idle' | 'error';
  message?: string;
};

export const REVOKE_FORM_IDLE: RevokeFormState = { status: 'idle' };
