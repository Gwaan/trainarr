import 'server-only';

/**
 * Disponibilité du coach IA — la seule source de vérité du « les fonctions IA
 * sont suspendues » affiché par l'UI.
 *
 * Règle produit : sans `AI_BASE_URL`, ou si l'API ne répond pas, les fonctions
 * IA sont **suspendues** et le disent. Elles n'échouent pas au moment où
 * l'utilisatrice clique.
 *
 * ## Le ping, par provider
 *
 * - `llamacpp` → `GET {base}/health`, endpoint natif de `llama-server` : `200`
 *   quand le modèle est chargé et prêt, `503` tant qu'il charge. Un 503 vaut donc
 *   « pas encore disponible », pas « en panne » — et il se résoudra tout seul,
 *   d'où un simple statut indisponible sans erreur. Cet endpoint est exempté de
 *   l'authentification par clé : aucun en-tête n'est nécessaire.
 * - `openai` / `anthropic` (via une passerelle compatible OpenAI) →
 *   `GET {base}/v1/models`, avec `Authorization: Bearer` si `AI_API_KEY` est
 *   renseignée : c'est l'appel non facturé le plus proche d'un ping.
 *
 * ## Deux garde-fous
 *
 * - **Le ping ne retarde pas un rendu** : délai de garde de
 *   {@link AI_PING_TIMEOUT_MS} — bien plus court que celui d'une génération
 *   ({@link AI_REQUEST_TIMEOUT_MS}), parce qu'ici on ne demande qu'un statut.
 * - **Le ping ne martèle pas l'API** : le résultat est mémorisé
 *   {@link AI_AVAILABILITY_TTL_MS}. Les pages consultent le statut à chaque
 *   rendu ; sans ce cache, chaque affichage ouvrirait une connexion.
 */

import { env } from '@/config/env';

import { aiAuthHeaders, aiEndpointUrl } from './client';
import { AiUnavailableError, type AiUnavailableReason } from './errors';

/** Délai de garde du ping : un statut, pas une génération. */
export const AI_PING_TIMEOUT_MS = 2_000;

/** Durée de validité du statut mémorisé. */
export const AI_AVAILABILITY_TTL_MS = 30_000;

export type AiAvailability = { available: true } | { available: false; reason: AiUnavailableReason };

let cached: { at: number; value: AiAvailability } | null = null;

/** Oublie le statut mémorisé — réservé aux tests (cf. `resetEnvCache`). */
export function resetAiAvailabilityCache(): void {
  cached = null;
}

/**
 * Interroge réellement l'API. Ne lève jamais : toute panne (DNS, connexion
 * refusée, délai dépassé, statut non-2xx) se traduit par `unreachable`.
 *
 * Le `catch` est volontairement large et **n'est pas silencieux** : il convertit
 * l'échec en la valeur de retour du module, qui est précisément ce que
 * l'appelant attend. Rien n'est journalisé ici — la fonction est appelée à
 * chaque rendu de page, une API éteinte remplirait les journaux.
 */
async function probe(): Promise<AiAvailability> {
  const baseUrl = env.AI_BASE_URL;
  if (baseUrl === undefined) return { available: false, reason: 'unconfigured' };

  const isLlamaCpp = env.AI_PROVIDER === 'llamacpp';
  const url = aiEndpointUrl(baseUrl, isLlamaCpp ? '/health' : '/v1/models');

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: isLlamaCpp ? {} : aiAuthHeaders(),
      signal: AbortSignal.timeout(AI_PING_TIMEOUT_MS),
      cache: 'no-store',
    });
    return response.ok ? { available: true } : { available: false, reason: 'unreachable' };
  } catch {
    return { available: false, reason: 'unreachable' };
  }
}

/**
 * Statut du coach IA, mémorisé {@link AI_AVAILABILITY_TTL_MS}.
 *
 * Sans `AI_BASE_URL`, la réponse est rendue **sans aucune requête réseau** : une
 * installation qui n'utilise pas le coach ne doit rien tenter.
 */
export async function getAiAvailability(): Promise<AiAvailability> {
  const now = Date.now();
  if (cached !== null && now - cached.at < AI_AVAILABILITY_TTL_MS) {
    return cached.value;
  }

  const value = await probe();
  cached = { at: now, value };
  return value;
}

/**
 * Garde à placer en tête de toute Server Action IA.
 *
 * @throws {AiUnavailableError} portant le motif, pour que l'action réponde
 * « coach suspendu » plutôt que de laisser filer un échec réseau.
 */
export async function requireAi(): Promise<void> {
  const availability = await getAiAvailability();
  if (!availability.available) {
    throw new AiUnavailableError(availability.reason);
  }
}
