/**
 * Ce que le bloc « Notifications » échange avec ses Server Actions.
 *
 * Ce module existe **parce qu'un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones** : Next refuse tout export de valeur, et pas au build —
 * seulement à l'évaluation du module, c'est-à-dire en production. Les types et
 * les constantes partagées vivent donc ici, comme `forecast-location-state.ts`.
 */

/**
 * Le retour d'une action du panneau — un statut, un message, rien d'autre.
 *
 * Le même type pour l'abonnement, le désabonnement, les préférences et le test :
 * l'écran n'affiche qu'un bandeau, et quatre formes distinctes lui auraient
 * demandé quatre chemins de rendu pour un seul résultat visible.
 */
export type PushActionState = {
  status: 'idle' | 'success' | 'error';
  message?: string;
};

export const PUSH_ACTION_IDLE: PushActionState = { status: 'idle' };

/**
 * Les trois catégories, nommées côté client comme côté serveur.
 *
 * C'est la valeur qu'un interrupteur envoie : l'action la revalide contre cette
 * liste (Zod), et rien d'autre ne peut atteindre le DAL.
 */
export const PUSH_PREFERENCE_KEYS = [
  'dailySession',
  'activityAnalyzed',
  'suggestions',
] as const;

export type PushPreferenceKey = (typeof PUSH_PREFERENCE_KEYS)[number];

/**
 * Les réglages de notifications, tels qu'ils franchissent la frontière client.
 *
 * `publicKey` en fait partie et **c'est normal** : la clé publique VAPID est
 * faite pour être remise au navigateur, c'est elle qui signe l'abonnement. Elle
 * arrive en prop plutôt qu'en `NEXT_PUBLIC_*` parce que la règle du projet veut
 * que l'environnement ne soit lu que dans `src/config/` et le DAL.
 *
 * La clé **privée** et le sujet, eux, ne sortent jamais du serveur.
 */
export type PushSettings = {
  /** La clé publique VAPID, `null` quand les notifications sont hors service. */
  publicKey: string | null;
  /**
   * Pourquoi le serveur ne peut pas envoyer, en toutes lettres — `null` quand
   * il le peut. C'est un diagnostic de configuration, pas une trace
   * d'exécution : il nomme les variables et la commande qui les fabrique, et
   * jamais aucune valeur (cf. `PUSH_DISABLED_MESSAGES`).
   */
  disabledMessage: string | null;
  /** Combien d'appareils sont abonnés, tous navigateurs confondus. */
  deviceCount: number;
  /** L'état des trois interrupteurs. */
  preferences: Record<PushPreferenceKey, boolean>;
};
