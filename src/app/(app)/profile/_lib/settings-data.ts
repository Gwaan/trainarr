import 'server-only';

/**
 * La lecture unique des réglages, partagée par la page `/profile` et par la
 * modale ouverte depuis la navigation.
 *
 * Elle existe pour qu'il n'y ait qu'un seul endroit où l'on décide *ce que* les
 * réglages montrent et *ce qui* franchit la frontière client : deux appelants,
 * une lecture, un DTO.
 *
 * Des lectures indépendantes, en parallèle : le profil athlète, ses identifiants
 * intervals.icu et son lieu de prévisions (nos tables, via le DAL), le compte
 * connecté (la session, via better-auth) et ses invitations.
 */

import { getAthleteProfile, getIntervalsSettings } from '@/data/athlete';
import { getElevationCorrectionSettings } from '@/data/elevation-correction';
import { canInvite, listPendingInvitations } from '@/data/invitations';
import { getLthrSuggestion } from '@/data/lthr-suggestion';
import { getMaxHrSuggestion } from '@/data/max-hr-suggestion';
import { countSubscriptions, getPushPreferences } from '@/data/push';
import { getRestingHrSuggestion } from '@/data/resting-hr-suggestion';
import { getCurrentVo2maxCorrection } from '@/data/vo2max-correction';
import { getForecastLocationLabel } from '@/data/weather-forecast';
import { getAccountSummary } from '@/lib/auth/session';
import { toCivilDate } from '@/lib/dates/civil';
import { PUSH_DISABLED_MESSAGES, resolvePushConfig, type PushConfig } from '@/lib/push/config';

import { toLthrSuggestionView } from '../../_lib/lthr-suggestion';
import { toMaxHrSuggestionView } from '../../_lib/max-hr-suggestion';
import { toRestingHrSuggestionView } from '../../_lib/resting-hr-suggestion';

import { toCorrectionFactorSettings } from './correction-factor-values';
import { toProfileFormValues } from './form-values';
import { toIntervalsFormDefaults } from './intervals-values';
import {
  NO_INVITATIONS_SETTINGS,
  toInvitationRows,
  type InvitationsSettings,
} from './invitation-values';
import type { PushSettings } from './push-state';
import type { SettingsData } from './settings-values';

/**
 * Les invitations en cours, ou rien du tout.
 *
 * Deux lectures en séquence, et non en parallèle : la seconde n'a de sens que si
 * la première autorise (`listPendingInvitations` refuserait de toute façon). Une
 * panne rend « ne peut pas inviter » plutôt que de faire tomber tous les
 * réglages — la section disparaît, le reste s'affiche.
 */
async function loadInvitations(): Promise<InvitationsSettings> {
  try {
    if (!(await canInvite())) return NO_INVITATIONS_SETTINGS;
    return { canInvite: true, invitations: toInvitationRows(await listPendingInvitations()) };
  } catch (error) {
    console.error('[profile] lecture des invitations impossible', error);
    return NO_INVITATIONS_SETTINGS;
  }
}

/**
 * L'état des notifications, tel que le panneau le reçoit.
 *
 * Le verdict d'activation vient de l'environnement (`resolvePushConfig`) et le
 * reste de la base. Seule la clé **publique** franchit la frontière : elle est
 * faite pour ça — c'est elle qui signe l'abonnement côté navigateur — et elle
 * passe par une prop plutôt que par un `NEXT_PUBLIC_*`, la règle du projet
 * voulant que l'environnement ne soit lu que dans `src/config/` et le DAL.
 *
 * Une panne de lecture rend « pas d'appareil, préférences par défaut » plutôt
 * que de faire tomber tous les réglages — même parti pris que
 * {@link loadInvitations}. **Y compris une panne de l'environnement** :
 * `resolvePushConfig` lit `env`, qui valide paresseusement et lève si une
 * variable sans rapport avec les notifications est mal écrite. Laisser cet
 * appel hors du `try` aurait fait tomber toute la page de réglages — dont le
 * formulaire de profil, qui n'a rien à voir.
 */
async function loadPushSettings(): Promise<PushSettings> {
  const disabled: PushSettings = {
    publicKey: null,
    disabledMessage: null,
    deviceCount: 0,
    preferences: { dailySession: true, activityAnalyzed: true, suggestions: true },
  };

  let config: PushConfig;
  try {
    config = resolvePushConfig();
  } catch (error) {
    console.error('[profile] configuration des notifications illisible', error);
    // Un diagnostic, jamais la trace : elle part vers le navigateur.
    return {
      ...disabled,
      disabledMessage:
        'Notifications indisponibles : l’environnement du serveur n’a pas pu être lu. Le détail est dans les journaux du serveur.',
    };
  }

  if (config.status === 'disabled') {
    return { ...disabled, disabledMessage: PUSH_DISABLED_MESSAGES[config.reason] };
  }

  try {
    const [deviceCount, preferences] = await Promise.all([
      countSubscriptions(),
      getPushPreferences(),
    ]);
    return { publicKey: config.publicKey, disabledMessage: null, deviceCount, preferences };
  } catch (error) {
    console.error('[profile] lecture des notifications impossible', error);
    return { ...disabled, publicKey: config.publicKey };
  }
}

export async function loadSettingsData(): Promise<SettingsData> {
  const [
    profile,
    maxHrSuggestion,
    restingHrSuggestion,
    lthrSuggestion,
    elevationCorrection,
    vo2maxCorrection,
    intervals,
    forecastLocationLabel,
    account,
    invitations,
    push,
  ] =
    await Promise.all([
      getAthleteProfile(),
      getMaxHrSuggestion(),
      getRestingHrSuggestion(),
      getLthrSuggestion(),
      getElevationCorrectionSettings(),
      getCurrentVo2maxCorrection(),
      getIntervalsSettings(),
      getForecastLocationLabel(),
      getAccountSummary(),
      loadInvitations(),
      loadPushSettings(),
    ]);

  return {
    mode: profile === null ? 'onboarding' : 'edit',
    invitations,
    // Le nom du lieu fixé, ou `null` : le mode automatique se dit à l'écran,
    // il ne se devine pas d'un champ vide.
    forecastLocationLabel,
    // Des chaînes prêtes à afficher : la conversion des mesures reste ici, et
    // les identifiants intervals.icu se réduisent à l'état de la clé.
    profile: toProfileFormValues(profile),
    // Une date lisible, un nom, un lien : de quoi expliquer la proposition. La
    // même que celle du tableau de bord — même lecture, même composant.
    maxHrSuggestion: toMaxHrSuggestionView(maxHrSuggestion),
    // Son pendant pour la FC de repos, au même endroit et pour la même raison :
    // l'encart se pose contre le champ qu'il propose de changer. Les deux
    // peuvent être là en même temps ; aucun des deux ne porte l'accent ici,
    // « Enregistrer » l'a déjà.
    restingHrSuggestion: toRestingHrSuggestionView(restingHrSuggestion),
    // La troisième, au même endroit : c'est la seule qui ne se pose contre aucun
    // champ — sa valeur ne se saisit pas —, mais c'est bien la section
    // physiologique qu'elle change.
    lthrSuggestion: toLthrSuggestionView(lthrSuggestion),
    // La FC seuil en vigueur, lue seule : sans elle, l'athlète n'aurait aucun
    // endroit où voir ce qui ancre ses zones.
    lthrBpm: profile?.lthrBpm ?? null,
    // Un réglage de calcul, pas une mesure : il n'a pas de proposition à
    // accepter, et sa place est sous les données physiologiques qu'il pondère.
    elevationCorrection,
    // Le second réglage de calcul, sous le premier : le facteur correctif
    // pondère la même chose que la correction d'altitude — ce que l'appli lit
    // d'une séance. Le millésime de la course qui le calibre se lit contre le
    // jour courant, d'où le `toCivilDate` : une course de l'an dernier ne se
    // date pas comme une course de la semaine.
    correctionFactor: toCorrectionFactorSettings(vo2maxCorrection, toCivilDate(new Date())),
    intervals: toIntervalsFormDefaults(intervals),
    // Reconstruit champ par champ plutôt que passé tel quel : ce qui part au
    // navigateur est ce qui est écrit ici, et rien de ce que la session
    // pourrait porter demain en plus.
    account: account === null ? null : { name: account.name },
    // Les notifications sont un réglage de **compte** (les appareils sont ceux
    // du compte, les catégories aussi) : elles voyagent avec lui, sous le même
    // onglet.
    push,
  };
}
