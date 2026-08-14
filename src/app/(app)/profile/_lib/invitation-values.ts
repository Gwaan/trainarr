/**
 * Ce que la section « Inviter quelqu'un » a le droit de connaître.
 *
 * Fonction pure, testée : la page traduit les DTOs du DAL en chaînes prêtes à
 * être rendues, et le composant client ne reçoit que ces chaînes — jamais une
 * empreinte, jamais un jeton, jamais un identifiant de compte.
 */

import { APP_TIME_ZONE } from '@/config/time';
import type { InvitationDto } from '@/data/invitations';

/** Une invitation en cours, telle que la liste l'affiche. */
export type InvitationRow = {
  /** Poignée de révocation. Rien ne s'en déduit : ce n'est pas le lien. */
  id: number;
  /** Échéance déjà formatée, ex. `15 août 2026 à 18:42`. */
  expiresLabel: string;
};

/**
 * L'état de la section.
 *
 * Union discriminée plutôt qu'un booléen à côté d'une liste : pour un compte
 * invité, il n'y a pas de liste vide à passer — il n'y a **rien**, et la section
 * n'est pas rendue du tout.
 */
export type InvitationsSettings =
  | { canInvite: false }
  | { canInvite: true; invitations: InvitationRow[] };

/** Un compte qui n'invite pas : aucune donnée d'invitation ne franchit la frontière. */
export const NO_INVITATIONS_SETTINGS: InvitationsSettings = { canInvite: false };

const deadlineFormatter = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: APP_TIME_ZONE,
});

/**
 * Échéance affichable, dans le fuseau de l'athlète (`APP_TIME_ZONE`) : la date
 * est stockée en UTC, la lire « à 16:42 » quand le lien meurt à 18:42 heure
 * locale serait faux de deux heures.
 */
export function formatInvitationDeadline(expiresAt: Date): string {
  return deadlineFormatter.format(expiresAt);
}

export function toInvitationRows(invitations: InvitationDto[]): InvitationRow[] {
  return invitations.map((invitation) => ({
    id: invitation.id,
    expiresLabel: formatInvitationDeadline(invitation.expiresAt),
  }));
}
