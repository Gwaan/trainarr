import 'server-only';

import { env } from '@/config/env';

/**
 * Activation de l'authentification, décidée à partir du seul secret.
 *
 * Même parti pris que le poller intervals.icu (`planPollerActivation`) et que le
 * dépôt WebDAV : une variable absente ou inexploitable désactive **sa** fonction
 * en disant pourquoi, elle n'empêche jamais l'application de démarrer. Le
 * déploiement est automatique au push — un `getEnv()` qui lèverait au démarrage
 * couperait l'appli entière, y compris les pages qui n'ont rien à voir.
 */

/**
 * Longueur minimale du secret.
 *
 * better-auth se contente d'un avertissement en dessous de 32 caractères ; on
 * refuse. Un secret court est une signature de session devinable, et le silence
 * d'un simple `console.warn` dans les journaux d'un container est exactement ce
 * qui ne se voit pas. `openssl rand -base64 32` en produit 44.
 */
export const AUTH_SECRET_MIN_LENGTH = 32;

/** Pourquoi l'authentification est hors service. */
export type AuthDisabledReason = 'missing-secret' | 'weak-secret';

export type AuthConfig =
  | { status: 'ready'; secret: string }
  | { status: 'disabled'; reason: AuthDisabledReason };

/**
 * Diagnostic affichable tel quel : c'est le texte que voit l'utilisatrice sur
 * l'écran de connexion, et celui que journalise la route d'API. Il nomme la
 * variable à renseigner — sans jamais rien dire de sa valeur.
 */
export const AUTH_DISABLED_MESSAGES: Record<AuthDisabledReason, string> = {
  'missing-secret':
    "Authentification non configurée : renseigner BETTER_AUTH_SECRET dans l'environnement du serveur.",
  'weak-secret': `Authentification non configurée : BETTER_AUTH_SECRET doit faire au moins ${AUTH_SECRET_MIN_LENGTH} caractères (openssl rand -base64 32).`,
} as const;

/**
 * Décide de l'activation à partir d'une valeur brute. Fonction pure, exportée
 * pour les tests ; le code applicatif appelle {@link resolveAuthConfig}.
 */
export function planAuthActivation(secret: string | undefined): AuthConfig {
  if (secret === undefined) return { status: 'disabled', reason: 'missing-secret' };
  if (secret.length < AUTH_SECRET_MIN_LENGTH) {
    return { status: 'disabled', reason: 'weak-secret' };
  }
  return { status: 'ready', secret };
}

/** Le même verdict, appliqué à l'environnement réel. */
export function resolveAuthConfig(): AuthConfig {
  return planAuthActivation(env.BETTER_AUTH_SECRET);
}
