import 'server-only';

import { hasAnyUser } from '@/data/users';

/**
 * La porte d'amorçage est-elle ouverte ?
 *
 * Elle l'est tant qu'aucun compte n'existe : c'est ce qui permet de créer le
 * sien au premier lancement, sans script manuel. Deux écrans s'en servent —
 * « premier compte » pour s'autoriser à s'afficher, la connexion pour proposer
 * le lien qui y mène (sans quoi cet écran serait introuvable).
 *
 * **En cas de panne de lecture, la réponse est « fermée ».** Une base
 * injoignable ne doit pas faire apparaître une porte d'inscription : dans le
 * doute, l'écran de connexion reste seul, et l'erreur est journalisée. C'est
 * aussi ce qui garde la connexion utilisable pendant qu'on répare — elle,
 * n'interroge pas la base avant d'être soumise.
 */
export async function isBootstrapOpen(): Promise<boolean> {
  try {
    return !(await hasAnyUser());
  } catch (error) {
    console.error("[auth] impossible de savoir si un compte existe déjà", error);
    return false;
  }
}
