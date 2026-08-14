import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';

import { getAuth } from './index';

/**
 * Lecture de la session pour l'affichage.
 *
 * Ce module ne protège rien : il répond seulement « qui est connecté, s'il y a
 * quelqu'un », pour qu'un écran sache s'il doit présenter les réglages du compte
 * ou une invitation à se connecter. Le contrôle d'accès, lui, viendra au plus
 * près des données et dans chaque Server Action.
 *
 * Il vit dans `src/lib/auth/` et non dans le DAL parce que la session n'est pas
 * une de nos tables : elle se lit à travers better-auth, qui seul sait vérifier
 * la signature du cookie et l'expiration. Le DAL reste la porte de nos données.
 */

/**
 * Ce que les écrans ont le droit de savoir du compte connecté.
 *
 * Un nom, et rien d'autre : cette valeur franchit la frontière client. Ni
 * identifiant, ni jeton de session, ni date d'expiration, ni hachage — un
 * composant qui en aurait besoin poserait d'abord la question de savoir
 * pourquoi.
 */
export type AccountSummary = {
  name: string;
};

/**
 * Le compte connecté, ou `null` si personne ne l'est.
 *
 * Mémoïsé par requête (`cache()` de React) : plusieurs blocs d'une même page
 * peuvent le demander sans multiplier les lectures.
 *
 * **Une panne répond `null`**, comme `isBootstrapOpen()` répond « fermée » :
 * dans le doute, l'écran propose de se connecter plutôt que d'exposer des
 * réglages de compte dont on ne sait pas à qui ils appartiennent.
 */
export const getAccountSummary = cache(
  async (): Promise<AccountSummary | null> => {
    const auth = getAuth();
    if (auth === null) return null;

    try {
      const session = await auth.api.getSession({ headers: await headers() });
      if (session === null) return null;
      return { name: session.user.name };
    } catch (error) {
      console.error('[auth] lecture de la session impossible', error);
      return null;
    }
  },
);
