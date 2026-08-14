import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Le jeton d'invitation : sa fabrication, son empreinte, sa forme attendue.
 *
 * Isolé de la base et de better-auth pour être éprouvable seul — c'est la même
 * découpe que `sign-up-guard.ts`. Aucune dépendance nouvelle : `node:crypto`
 * fournit le tirage et l'empreinte.
 *
 * **Le jeton voyage dans l'URL.** Il est donc traité comme un secret de passage :
 * jamais journalisé, jamais recopié dans un message d'erreur, jamais dans un
 * titre de page. Les seuls endroits où il existe sont la barre d'adresse de qui
 * l'a reçu, le champ caché du formulaire de création, et la valeur rendue **une
 * seule fois** à qui l'a émis.
 */

/**
 * 32 octets tirés au sort — 256 bits d'entropie.
 *
 * C'est ce qui autorise l'empreinte SHA-256 plutôt qu'un hachage lent : scrypt
 * et consorts existent pour ralentir l'énumération d'un secret *devinable*
 * (un mot de passe). Un tirage de 256 bits n'a pas d'espace de recherche
 * praticable, et la lenteur ne protégerait rien qu'il n'ait déjà.
 */
const INVITATION_TOKEN_BYTES = 32;

/**
 * Longueur du jeton en base64url : 32 octets → 43 caractères sans remplissage.
 * Écrite ici pour que le schéma de validation la borne exactement.
 */
const INVITATION_TOKEN_LENGTH = 43;

/**
 * Le jeton tel que l'URL le porte.
 *
 * `base64url` : sûr en segment d'URL, sans caractère à échapper — donc sans
 * risque qu'un encodage aller-retour le déforme entre le lien copié et le
 * formulaire soumis.
 */
export function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');
}

/**
 * L'empreinte stockée en base. Déterministe, sans sel : c'est ce qui permet de
 * retrouver la ligne par égalité sur un index — et un sel n'ajouterait rien
 * qu'un secret de 256 bits n'ait déjà (cf. {@link INVITATION_TOKEN_BYTES}).
 */
export function invitationTokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * La forme attendue d'un jeton — segment d'URL comme champ de formulaire, deux
 * entrées non fiables.
 *
 * Le message de refus ne cite évidemment pas la valeur reçue, et il est le même
 * pour toutes les raisons de refus (cf. `INVITATION_UNUSABLE_MESSAGE`) : un lien
 * mal formé, expiré, révoqué ou déjà utilisé sont indistinguables.
 */
export const invitationTokenSchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${INVITATION_TOKEN_LENGTH}}$`));
