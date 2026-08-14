import 'server-only';

import { redirect } from 'next/navigation';

import { getSession, type SessionDto } from '@/data/session';

/**
 * La session de la requête, ou un renvoi vers l'écran de connexion.
 *
 * Second étage du contrôle d'accès, celui qui **fait autorité** : le proxy ne
 * regarde que la présence du cookie, ici better-auth en vérifie la signature et
 * l'expiration contre la base. Un cookie présent mais invalide n'ouvre donc
 * rien — il mène à `/login` comme l'absence de cookie.
 *
 * **À appeler dans le composant suspendu qui porte déjà `connection()`**, jamais
 * dans le layout du groupe ni dans le corps d'une page. Une lecture de session
 * hors `Suspense` est un signal dynamique de plus dans la coquille : elle
 * ferait perdre le Partial Prerender (`◐`) à toutes les pages de `(app)` d'un
 * coup, pour un contrôle que le proxy a déjà rendu, lui, avant tout rendu.
 *
 * Ne rend jamais `null` : `redirect()` lève, son type de retour est `never`.
 */
export async function requireSession(): Promise<SessionDto> {
  const session = await getSession();
  if (session === null) redirect('/login');
  return session;
}
