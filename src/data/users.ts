import 'server-only';

import { db } from './db/client';
import { authUsers } from './db/schema';

/**
 * Les comptes qui peuvent se connecter (table `auth_users`, écrite par
 * better-auth). Ce module ne fait que **lire** : la création d'un compte passe
 * par better-auth, jamais par un `INSERT` d'ici.
 */

/**
 * Existe-t-il au moins un compte ?
 *
 * Cette seule question décide de l'ouverture de la porte d'amorçage : tant
 * qu'elle répond `false`, l'écran « premier compte » est accessible et
 * l'inscription est permise. Dès qu'elle répond `true`, les deux se ferment
 * (les invitations viendront plus tard).
 *
 * Ce n'est pas elle qui garantit l'unicité du premier compte — deux requêtes
 * simultanées la verraient toutes deux à `false`. La garantie est dans la base
 * (`auth_users_first_account_unique`, cf. `schema.ts`) ; cette lecture ne fait
 * qu'éviter d'ouvrir un écran ou de tenter une insertion vouée à l'échec.
 */
export async function hasAnyUser(): Promise<boolean> {
  const rows = await db.select({ id: authUsers.id }).from(authUsers).limit(1);
  return rows.length > 0;
}
