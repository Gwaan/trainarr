import 'server-only';

/**
 * La lecture unique des réglages, partagée par la page `/profile` et par la
 * modale ouverte depuis la navigation.
 *
 * Elle existe pour qu'il n'y ait qu'un seul endroit où l'on décide *ce que* les
 * réglages montrent et *ce qui* franchit la frontière client : deux appelants,
 * une lecture, un DTO.
 *
 * Trois lectures indépendantes, en parallèle : le profil athlète et ses
 * identifiants intervals.icu (nos tables, via le DAL) et le compte connecté (la
 * session, via better-auth).
 */

import { getAthleteProfile, getIntervalsSettings } from '@/data/athlete';
import { canInvite, listPendingInvitations } from '@/data/invitations';
import { getAccountSummary } from '@/lib/auth/session';

import { toProfileFormValues } from './form-values';
import { toIntervalsFormDefaults } from './intervals-values';
import {
  NO_INVITATIONS_SETTINGS,
  toInvitationRows,
  type InvitationsSettings,
} from './invitation-values';
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

export async function loadSettingsData(): Promise<SettingsData> {
  const [profile, intervals, account, invitations] = await Promise.all([
    getAthleteProfile(),
    getIntervalsSettings(),
    getAccountSummary(),
    loadInvitations(),
  ]);

  return {
    mode: profile === null ? 'onboarding' : 'edit',
    invitations,
    // Des chaînes prêtes à afficher : la conversion des mesures reste ici, et
    // les identifiants intervals.icu se réduisent à l'état de la clé.
    profile: toProfileFormValues(profile),
    intervals: toIntervalsFormDefaults(intervals),
    // Reconstruit champ par champ plutôt que passé tel quel : ce qui part au
    // navigateur est ce qui est écrit ici, et rien de ce que la session
    // pourrait porter demain en plus.
    account: account === null ? null : { name: account.name },
  };
}
