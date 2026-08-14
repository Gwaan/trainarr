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

import type { MaxHrSuggestionView } from '../../_lib/max-hr-suggestion';
import type { RestingHrSuggestionView } from '../../_lib/resting-hr-suggestion';

import type { ProfileFormValues } from './form-values';
import type { IntervalsFormDefaults } from './intervals-values';
import type { InvitationsSettings } from './invitation-values';

/** Ce dont les trois sections de réglages ont besoin, et rien d'autre. */
export type SettingsSectionsData = {
  profile: ProfileFormValues;
  /**
   * La FC max soutenue observée sur une séance, quand elle dépasse celle du
   * profil et n'a pas été écartée. `null` le reste du temps — l'encart n'existe
   * alors pas. La même valeur que celle du tableau de bord : une seule lecture
   * du DAL, un seul composant (`(app)/_components/max-hr-suggestion-card.tsx`).
   */
  maxHrSuggestion: MaxHrSuggestionView | null;
  /**
   * La médiane de FC de repos des quatorze derniers jours, quand elle s'écarte
   * de celle du profil et n'a pas été écartée. `null` le reste du temps.
   * Indépendante de la précédente : les deux encarts peuvent se montrer
   * ensemble, sous le même champ « Fréquence cardiaque ».
   */
  restingHrSuggestion: RestingHrSuggestionView | null;
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
