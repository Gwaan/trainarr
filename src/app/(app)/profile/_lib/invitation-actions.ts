'use server';

/**
 * Server Actions de la section « Inviter quelqu'un » : émettre un lien, en
 * révoquer un.
 *
 * Minces par construction : valider (Zod) → déléguer au DAL → revalider. C'est
 * `src/data/invitations.ts` qui vérifie que l'appelante est bien le premier
 * compte, et qui refuse sinon — ces actions sont des endpoints publics
 * appelables par POST direct, un contrôle posé ici seulement ne protégerait
 * rien.
 *
 * **Le jeton en clair ne sort qu'ici, une fois.** Il part au client dans l'état
 * du formulaire, sous forme de chemin — c'est tout l'objet de l'écran. Il n'est
 * jamais journalisé et ne se relit nulle part ensuite.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  InvitationAdminRequiredError,
  createInvitation,
  revokeInvitation,
} from '@/data/invitations';

import { formatInvitationDeadline } from './invitation-values';
import type { InvitationFormState, RevokeFormState } from './invitation-state';

/** Le refus opposé à qui n'a pas le droit d'inviter — le même dans les deux actions. */
const NOT_ALLOWED_MESSAGE =
  "Seul le premier compte de l'installation peut gérer les invitations.";

const CREATE_FAILED_MESSAGE = "Le lien n'a pas pu être créé. Réessaie.";
const REVOKE_FAILED_MESSAGE = "Le lien n'a pas pu être révoqué. Réessaie.";

/**
 * Un lien déjà consommé, déjà révoqué ou inexistant : le même message pour les
 * trois, et il ne dit surtout pas lequel.
 */
const NOTHING_TO_REVOKE_MESSAGE = "Ce lien n'est plus en cours.";

/** L'identifiant vient d'un champ caché : entrée client, donc validée. */
const revokeSchema = z.object({
  invitationId: z.coerce.number().int().positive(),
});

/**
 * Émet un lien d'invitation et le rend **une seule fois**.
 *
 * Le chemin renvoyé porte le jeton ; le navigateur le complète avec son propre
 * `origin` (cf. `invitation-state.ts`).
 *
 * Sans paramètre, alors que `useActionState` l'appelle avec l'état précédent et
 * un `FormData` : émettre un lien ne demande aucune saisie, et déclarer deux
 * arguments jamais lus serait deux occasions de croire qu'ils comptent.
 */
export async function createInvitationAction(): Promise<InvitationFormState> {
  try {
    const invitation = await createInvitation();
    revalidatePath('/', 'layout');
    return {
      status: 'created',
      path: `/invitation/${invitation.token}`,
      expiresLabel: formatInvitationDeadline(invitation.expiresAt),
    };
  } catch (error) {
    if (error instanceof InvitationAdminRequiredError) {
      return { status: 'error', message: NOT_ALLOWED_MESSAGE };
    }
    // La trace ne porte que l'erreur : le jeton, s'il a été tiré, n'y figure pas.
    console.error("[profile] émission d'une invitation impossible", error);
    return { status: 'error', message: CREATE_FAILED_MESSAGE };
  }
}

/** Révoque un lien encore en cours. */
export async function revokeInvitationAction(
  _previous: RevokeFormState,
  formData: FormData,
): Promise<RevokeFormState> {
  const raw = formData.get('invitationId');
  const parsed = revokeSchema.safeParse({
    invitationId: typeof raw === 'string' ? raw : '',
  });
  if (!parsed.success) return { status: 'error', message: NOTHING_TO_REVOKE_MESSAGE };

  try {
    const revoked = await revokeInvitation(parsed.data.invitationId);
    if (!revoked) return { status: 'error', message: NOTHING_TO_REVOKE_MESSAGE };
  } catch (error) {
    if (error instanceof InvitationAdminRequiredError) {
      return { status: 'error', message: NOT_ALLOWED_MESSAGE };
    }
    console.error("[profile] révocation d'une invitation impossible", error);
    return { status: 'error', message: REVOKE_FAILED_MESSAGE };
  }

  revalidatePath('/', 'layout');
  return { status: 'idle' };
}
