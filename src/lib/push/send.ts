import 'server-only';

import { sendNotification, setVapidDetails, WebPushError } from 'web-push';

import {
  dropSubscription,
  listSubscriptions,
  touchSubscription,
  type StoredPushSubscription,
} from '@/data/push';

import { PUSH_DISABLED_MESSAGES, resolvePushConfig, type PushConfig } from './config';
import { DEFAULT_PUSH_TTL_S } from './ttl';

/**
 * L'envoi d'une notification à tous les appareils d'un athlète.
 *
 * ## Ce module ne lève jamais
 *
 * Ses appelants sont des déclencheurs métier (fin d'analyse d'une séance,
 * séance du jour) qui font par ailleurs un vrai travail : une notification qui
 * n'est pas partie ne doit pas faire échouer l'ingestion qui l'a demandée. Tout
 * ce qui rate est journalisé et rendu dans le compte rendu ({@link
 * PushSendReport}), jamais propagé.
 *
 * **Y compris une configuration fautive** : `setVapidDetails` valide ses clés
 * *synchroniquement* et lève sur ce qui n'est pas du base64url strict — un `=`
 * de remplissage, une espace ou un retour à la ligne recopié dans le `.env`
 * suffit, et le schéma Zod de l'environnement ne vérifie qu'une longueur non
 * nulle. Cette exception-là est rattrapée comme les autres et rendue en
 * `skipped: 'disabled'` : une clé mal recopiée ne doit pas faire échouer
 * l'ingestion FIT qui demandait une bannière.
 *
 * ## Ce qu'il nettoie
 *
 * Un service de push répond **404** ou **410** quand l'endpoint n'existe plus :
 * application désinstallée, permission révoquée dans les réglages du système,
 * abonnement expiré. Ces deux codes-là sont définitifs — la ligne est effacée
 * sur-le-champ. Tout le reste (429, 5xx, panne réseau) est passager : la ligne
 * reste, et la prochaine notification réessaiera.
 */

export type PushPayload = {
  title: string;
  body: string;
  /**
   * Chemin **interne** ouvert au clic, ex. `/activities/42`. Jamais une URL
   * absolue : c'est le service worker qui l'ouvre, sur l'origine de
   * l'application, et une URL absolue y enverrait l'utilisatrice ailleurs.
   */
  url: string;
  /**
   * Regroupement : sur l'appareil, une notification de même `tag` **remplace**
   * la précédente au lieu de s'empiler. C'est ce qui évite qu'une semaine
   * d'absence produise sept bannières « ta séance du jour ».
   */
  tag: string;
  /**
   * Combien de temps le service de push a le droit de garder ce message en file
   * avant de le jeter, en secondes. Optionnel : à défaut,
   * {@link DEFAULT_PUSH_TTL_S}.
   *
   * Le `tag` ne fait rien pour ça — il regroupe les bannières **sur
   * l'appareil**, il n'efface pas ce qui attend chez Apple ou Google. Sans TTL,
   * `web-push` demande quatre semaines de conservation : un téléphone éteint
   * mardi recevrait le rappel de mardi en le rallumant samedi. Les durées par
   * catégorie et leurs raisons vivent dans `./ttl.ts`.
   */
  ttlSeconds?: number;
};

export type PushSendReport = {
  /** Appareils qui ont accepté le message. */
  delivered: number;
  /** Abonnements morts effacés au passage (404 / 410). */
  removed: number;
  /**
   * Pourquoi rien n'a été tenté, `null` quand l'envoi a bien eu lieu. Deux
   * situations qu'un `delivered: 0` ne distinguerait pas : le serveur n'a pas
   * ses clés, ou l'athlète n'a aucun appareil abonné.
   */
  skipped: 'disabled' | 'no-subscription' | null;
};

/**
 * Combien d'appareils sont servis en même temps.
 *
 * Une installation personnelle en compte une poignée ; la borne existe pour que
 * cent abonnements morts ne se transforment pas en cent connexions sortantes
 * simultanées le jour où une endpoint se met à pendre.
 */
const MAX_PARALLEL_SENDS = 6;

/**
 * Ce que `web-push` a en mémoire — il conserve les détails VAPID dans une
 * variable de module, il n'y a donc rien à reconfigurer à chaque envoi.
 *
 * Configuré au **premier usage** et non au chargement du module : la validation
 * de l'environnement est paresseuse par choix du projet (cf. `src/config/env.ts`),
 * et lire les clés à l'import ferait échouer `next build`, qui n'en a aucune.
 *
 * On mémorise la clé publique plutôt qu'un simple booléen : en développement,
 * Turbopack recharge les modules à chaud et l'environnement peut avoir changé
 * entre deux envois.
 */
let configuredPublicKey: string | null = null;

function configure(config: Extract<PushConfig, { status: 'enabled' }>): void {
  if (configuredPublicKey === config.publicKey) return;

  setVapidDetails(config.subject, config.publicKey, config.privateKey);
  configuredPublicKey = config.publicKey;
}

/** Le résultat d'un envoi à **un** appareil, tel que le compte rendu l'agrège. */
type DeviceOutcome = 'delivered' | 'removed' | 'failed';

/**
 * Envoie à un appareil, et ne laisse échapper aucune erreur.
 *
 * Le corps est le JSON de ce que `public/sw.js` s'attend à lire dans son
 * écouteur `push` — les quatre champs d'affichage, **recomposés** et non le
 * payload tel quel : `ttlSeconds` est une consigne pour le service de push
 * (un en-tête), elle n'a rien à faire dans le chiffré que reçoit l'appareil.
 */
async function sendToDevice(
  subscription: StoredPushSubscription,
  payload: PushPayload,
): Promise<DeviceOutcome> {
  try {
    await sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify({
        title: payload.title,
        body: payload.body,
        url: payload.url,
        tag: payload.tag,
      }),
      { TTL: payload.ttlSeconds ?? DEFAULT_PUSH_TTL_S },
    );
  } catch (error) {
    // 404 / 410 : l'endpoint n'existe plus. Définitif — on efface plutôt que de
    // réessayer à chaque notification pour le reste de la vie de l'installation.
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      try {
        await dropSubscription(subscription.id);
      } catch (dropError) {
        console.error('[push] suppression d’un abonnement mort impossible :', dropError);
        return 'failed';
      }
      return 'removed';
    }

    // Tout le reste est passager : la ligne reste, la prochaine notification
    // réessaiera. On le journalise sans le remonter — l'appelant a mieux à
    // faire que de tomber pour une bannière.
    console.error('[push] envoi impossible :', error);
    return 'failed';
  }

  try {
    await touchSubscription(subscription.id);
  } catch (error) {
    // Le message *est* parti : le datage manqué ne change rien à ce compte
    // rendu, il ne sert qu'à l'affichage.
    console.error('[push] datage d’un abonnement impossible :', error);
  }

  return 'delivered';
}

/**
 * Envoie `payload` à **tous** les appareils de l'athlète. Ne lève jamais.
 *
 * L'athlète est un **paramètre** : les appelants sont des services de fond, hors
 * requête, sans session à interroger (cf. l'en-tête de `src/data/push.ts`).
 */
export async function sendToAthlete(
  athleteId: number,
  payload: PushPayload,
): Promise<PushSendReport> {
  let config: PushConfig;
  try {
    config = resolvePushConfig();
  } catch (error) {
    console.error('[push] configuration illisible :', error);
    return { delivered: 0, removed: 0, skipped: 'disabled' };
  }

  if (config.status === 'disabled') {
    console.error(`[push] envoi abandonné — ${PUSH_DISABLED_MESSAGES[config.reason]}`);
    return { delivered: 0, removed: 0, skipped: 'disabled' };
  }

  // Avant toute lecture en base : `setVapidDetails` valide ses clés
  // synchroniquement et lève sur une clé qui n'est pas du base64url strict. Le
  // journal doit nommer la cause — c'est une faute de configuration, elle se
  // corrige dans le `.env` du serveur, et rien d'autre ne la signalera.
  try {
    configure(config);
  } catch (error) {
    console.error(
      '[push] envoi abandonné — clés VAPID refusées par web-push (base64url attendu, sans remplissage ni espace) :',
      error,
    );
    return { delivered: 0, removed: 0, skipped: 'disabled' };
  }

  let subscriptions: StoredPushSubscription[];
  try {
    subscriptions = await listSubscriptions(athleteId);
  } catch (error) {
    console.error('[push] lecture des abonnements impossible :', error);
    return { delivered: 0, removed: 0, skipped: 'no-subscription' };
  }

  if (subscriptions.length === 0) {
    return { delivered: 0, removed: 0, skipped: 'no-subscription' };
  }

  // Parallélisme borné : autant de coureurs que la borne le permet, chacun
  // piochant l'abonnement suivant. Plus simple qu'un découpage en tranches, et
  // sans le temps mort d'une tranche qui attend son traînard.
  let nextIndex = 0;
  let delivered = 0;
  let removed = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const subscription = subscriptions[nextIndex];
      nextIndex += 1;
      if (subscription === undefined) return;

      const outcome = await sendToDevice(subscription, payload);
      if (outcome === 'delivered') delivered += 1;
      if (outcome === 'removed') removed += 1;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_SENDS, subscriptions.length) }, worker),
  );

  return { delivered, removed, skipped: null };
}
