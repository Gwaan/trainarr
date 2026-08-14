/**
 * La forme des données de réglages, telle qu'elle franchit la frontière client.
 *
 * Types seuls, sans aucune dépendance serveur : c'est ce qui permet aux
 * composants clients (`settings-tabs.tsx`) de s'y référer sans importer le
 * module `server-only` qui les produit.
 *
 * Rien de plus que ce que les sections affichent. En particulier, la clé API
 * intervals.icu n'a aucune représentation ici : `IntervalsFormDefaults` n'en
 * porte que l'**état** (cf. `intervals-values.ts`), jamais la valeur, même
 * masquée. Et le lieu des prévisions n'y est qu'un nom, jamais un point.
 */

import type { ProfileFormValues } from './form-values';
import type { IntervalsFormDefaults } from './intervals-values';
import type { InvitationsSettings } from './invitation-values';

/** Ce dont les trois sections de réglages ont besoin, et rien d'autre. */
export type SettingsSectionsData = {
  profile: ProfileFormValues;
  intervals: IntervalsFormDefaults;
  /**
   * Le **nom** du lieu fixé pour les prévisions, `null` en mode automatique.
   * Jamais ses coordonnées : le navigateur n'en a aucun usage.
   */
  forecastLocationLabel: string | null;
  /** Le nom du compte connecté, `null` si personne ne l'est. Jamais l'e-mail ni l'identifiant. */
  account: { name: string } | null;
  /**
   * Les invitations en cours — `{ canInvite: false }` pour tout compte qui n'est
   * pas le premier de l'installation, et la section n'est alors pas rendue.
   */
  invitations: InvitationsSettings;
};

export type SettingsData = SettingsSectionsData & {
  /** `onboarding` : aucun profil en base — il n'y a encore rien à régler. */
  mode: 'onboarding' | 'edit';
};
