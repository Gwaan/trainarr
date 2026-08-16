import 'server-only';

import { env } from '@/config/env';

/**
 * Activation des notifications Web Push, décidée à partir des seules variables
 * d'environnement.
 *
 * Même parti pris que `planAuthActivation` (src/lib/auth/config.ts) et que le
 * poller intervals.icu : une variable absente ou inexploitable désactive **sa**
 * fonction en disant pourquoi, elle n'empêche jamais l'application de démarrer.
 * Le déploiement est automatique au push — un `getEnv()` qui lèverait au
 * chargement couperait l'appli entière, y compris les pages qui n'ont rien à
 * voir avec les notifications.
 *
 * **Pourquoi valider le sujet ici et pas dans le schéma Zod de l'env** :
 * `web-push` lève à l'envoi si le sujet n'est ni un `mailto:` ni une URL
 * `https:` (c'est le protocole qui l'exige, RFC 8292 § 2.1). Une exception au
 * moment d'envoyer une notification serait découverte des semaines plus tard,
 * dans les journaux d'un container ; refusée ici, la faute s'affiche dans les
 * réglages, en toutes lettres, dès le premier coup d'œil.
 */

/** Pourquoi les notifications sont hors service. */
export type PushDisabledReason = 'missing-keys' | 'invalid-subject';

export type PushConfig =
  | { status: 'enabled'; publicKey: string; privateKey: string; subject: string }
  | { status: 'disabled'; reason: PushDisabledReason };

/**
 * Les deux préfixes que le protocole accepte pour identifier l'expéditeur.
 *
 * `mailto:` est le cas courant d'une installation personnelle ; `https://`
 * couvre celles qui préfèrent pointer une page de contact.
 */
const SUBJECT_PREFIXES = ['mailto:', 'https://'] as const;

/**
 * Diagnostic affichable tel quel : c'est le texte que voit l'utilisatrice dans
 * ses réglages, et celui que journalise le démarrage. Il nomme les variables à
 * renseigner et la commande qui les fabrique — sans jamais rien dire de leur
 * valeur.
 */
export const PUSH_DISABLED_MESSAGES: Record<PushDisabledReason, string> = {
  'missing-keys':
    'Notifications non configurées : renseigner VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY et VAPID_SUBJECT dans l’environnement du serveur (pnpm exec web-push generate-vapid-keys).',
  'invalid-subject':
    'Notifications non configurées : VAPID_SUBJECT doit être une adresse « mailto:… » ou une URL « https://… » — c’est par là qu’un service de push joint le responsable de l’installation.',
} as const;

/**
 * `true` si le sujet a l'une des deux formes admises **et** porte quelque chose
 * après son préfixe : un `mailto:` seul passerait le test du préfixe et serait
 * refusé par le service de push, plus tard, sans explication.
 */
function isUsableSubject(subject: string): boolean {
  return SUBJECT_PREFIXES.some(
    (prefix) => subject.startsWith(prefix) && subject.length > prefix.length,
  );
}

/**
 * Décide de l'activation à partir de valeurs brutes. Fonction pure, exportée
 * pour les tests ; le code applicatif appelle {@link resolvePushConfig}.
 *
 * Les trois valeurs sont **indissociables** : une clé publique sans privée ne
 * signe rien, une paire sans sujet est refusée par les services de push. Il n'y
 * a donc qu'un seul motif « il manque quelque chose », et pas trois.
 */
export function planPushActivation(
  publicKey: string | undefined,
  privateKey: string | undefined,
  subject: string | undefined,
): PushConfig {
  if (publicKey === undefined || privateKey === undefined || subject === undefined) {
    return { status: 'disabled', reason: 'missing-keys' };
  }
  if (!isUsableSubject(subject)) {
    return { status: 'disabled', reason: 'invalid-subject' };
  }

  return { status: 'enabled', publicKey, privateKey, subject };
}

/** Le même verdict, appliqué à l'environnement réel. */
export function resolvePushConfig(): PushConfig {
  return planPushActivation(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT);
}

/**
 * Annonce l'état des notifications au démarrage du serveur.
 *
 * Une ligne, comme le service FIT : une installation qui n'a pas ses clés doit
 * l'apprendre au boot plutôt qu'au premier envoi silencieusement raté. Ne lève
 * jamais — une variable d'environnement illisible ne doit pas empêcher les
 * autres services de démarrer.
 */
export function logPushActivation(): void {
  let config: PushConfig;
  try {
    config = resolvePushConfig();
  } catch (error) {
    console.error(
      `[push] notifications inactives — environnement illisible : ${
        error instanceof Error ? error.message : String(error)
      }. L'application continue de servir.`,
    );
    return;
  }

  if (config.status === 'disabled') {
    console.error(
      `[push] notifications inactives — ${PUSH_DISABLED_MESSAGES[config.reason]} L'application continue de servir.`,
    );
    return;
  }

  console.log('[push] notifications actives — clés VAPID en place.');
}
