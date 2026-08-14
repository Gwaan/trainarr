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
import { getAccountSummary } from '@/lib/auth/session';

import { toProfileFormValues } from './form-values';
import { toIntervalsFormDefaults } from './intervals-values';
import type { SettingsData } from './settings-values';

export async function loadSettingsData(): Promise<SettingsData> {
  const [profile, intervals, account] = await Promise.all([
    getAthleteProfile(),
    getIntervalsSettings(),
    getAccountSummary(),
  ]);

  return {
    mode: profile === null ? 'onboarding' : 'edit',
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
