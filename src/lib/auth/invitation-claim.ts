import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * L'autorisation d'inscrire **un** compte, portée par le contexte d'exécution.
 *
 * ## Le problème
 *
 * `guardSignUp` refuse toute inscription dès qu'un compte existe, et c'est ce
 * refus qui tient l'application fermée — y compris contre un appel direct à
 * `/api/auth/sign-up/email`, qui ne passe par aucun de nos écrans. Une création
 * par invitation doit pourtant traverser ce même crochet.
 *
 * ## Pourquoi pas un drapeau global
 *
 * Un booléen de module (« l'inscription est ouverte le temps de cet appel »)
 * serait visible de **toutes** les requêtes en vol : le serveur Next sert ses
 * requêtes en concurrence dans un seul processus, et il suffirait de poster une
 * inscription pendant qu'une invitation légitime s'exécute pour passer. La
 * fenêtre est étroite, elle est déclenchable à volonté (il suffit de marteler
 * l'endpoint), donc elle est exploitable.
 *
 * ## Le mécanisme
 *
 * Un `AsyncLocalStorage` : la marque n'existe que dans l'arbre d'exécution
 * asynchrone ouvert par {@link withInvitationClaim}. Une autre requête, servie
 * par le même processus au même instant, a son propre contexte — `getStore()`
 * y rend `undefined`, le garde-fou retombe sur sa règle habituelle et refuse.
 * Il n'y a pas d'état partagé à exploiter : ce n'est pas une fenêtre temporelle,
 * c'est une portée.
 *
 * Et la marque n'est posée **qu'après** qu'une invitation valide a été consommée
 * en base par une mise à jour conditionnelle (cf. `consumeInvitation`) : elle
 * n'est donc pas la permission elle-même, elle est la preuve qu'un jeton à usage
 * unique vient d'être dépensé.
 */

type InvitationClaim = {
  invitationId: number;
  /** Passe à `true` dès qu'une création de compte s'en est servie. */
  spent: boolean;
};

const storage = new AsyncLocalStorage<InvitationClaim>();

/**
 * Exécute `run` avec l'autorisation d'inscrire un compte, et un seul.
 *
 * **À n'appeler qu'après consommation effective de l'invitation en base**, et
 * en enveloppant le strict nécessaire : plus la portée est courte, moins il y a
 * de code susceptible d'inscrire un compte sous ce couvert.
 */
export function withInvitationClaim<T>(
  invitationId: number,
  run: () => Promise<T>,
): Promise<T> {
  return storage.run({ invitationId, spent: false }, run);
}

/**
 * Prélève l'autorisation du contexte courant, ou `null` s'il n'y en a pas.
 *
 * **Prélève**, et non « lit » : la marque est à usage unique dans sa propre
 * portée aussi. Si un chemin inattendu tentait une seconde inscription sous la
 * même invitation, il retomberait sur le refus ordinaire.
 */
export function takeInvitationClaim(): number | null {
  const claim = storage.getStore();
  if (claim === undefined || claim.spent) return null;
  claim.spent = true;
  return claim.invitationId;
}
