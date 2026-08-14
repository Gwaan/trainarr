import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';

import { getAuth } from '@/lib/auth';

/**
 * Lecture de la session courante — l'unique porte d'entrée de l'identité dans
 * l'application.
 *
 * `.claude/rules/security.md` la veut mémoïsée plutôt que passée de composant
 * en composant : chaque bout de page qui a besoin de savoir qui est connecté
 * appelle `getSession()` lui-même, sans que la question ne coûte une requête de
 * plus. Faire descendre la session en props, c'est ouvrir la porte à un appelant
 * qui « oublie » de la vérifier.
 */

/**
 * Ce qu'une session laisse voir — et rien d'autre.
 *
 * Ni le jeton de session, ni le hachage du mot de passe, ni la date
 * d'expiration, ni l'IP : aucune de ces valeurs n'a d'usage à l'affichage, et
 * un DTO explicite (jamais `typeof row`) garantit qu'ajouter une colonne à
 * `auth_users` ne l'élargira pas en silence.
 *
 * `userId` est l'identifiant opaque de better-auth. Il reste dans le DTO parce
 * que le serveur en aura besoin pour l'autorisation sur les ressources — mais
 * comme `getAthleteId`, il n'a rien à faire dans une prop de composant client.
 */
export type SessionDto = {
  userId: string;
  name: string;
  email: string;
};

/**
 * La session de la requête en cours, ou `null` s'il n'y en a pas.
 *
 * Ne lève jamais, dans aucun des trois cas où elle pourrait :
 *
 * - **authentification non configurée** (pas de `BETTER_AUTH_SECRET`) : elle
 *   rend « pas de session », comme `getAiAvailability` rend « indisponible ».
 *   L'application reste debout et l'écran de connexion explique le manque ;
 * - **cookie absent, expiré ou falsifié** : better-auth rend `null`, on aussi ;
 * - **panne de lecture** (base injoignable) : journalisée côté serveur, puis
 *   traitée comme une absence de session. C'est le sens prudent — une session
 *   qu'on ne sait pas lire n'est pas une session valide.
 *
 * Mémoïsée par `cache()` de React : l'appeler dix fois dans un rendu ne fait
 * qu'une lecture. La mémoïsation est bornée à la requête, une session n'est
 * donc jamais partagée entre deux visiteurs.
 */
export const getSession = cache(async (): Promise<SessionDto | null> => {
  const auth = getAuth();
  if (auth === null) return null;

  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (session === null) return null;

    return {
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
    };
  } catch (error) {
    console.error('[auth] lecture de la session impossible', error);
    return null;
  }
});
