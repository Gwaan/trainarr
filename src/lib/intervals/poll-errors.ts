/**
 * Classification des erreurs d'un cycle de rapatriement — fonction pure, testée.
 *
 * ## Pourquoi ce module existe
 *
 * Ce code corrige un incident : le poller tournait, la configuration était
 * valide, 237 activités attendaient côté intervals.icu — et pendant des minutes
 * il n'a **rien journalisé et rien rapatrié**. La cause tenait à une règle en
 * apparence raisonnable : « une `IntervalsAbortError` dont `timedOut` vaut
 * `false` signifie que l'arrêt du service est en cours, donc sortie propre,
 * donc pas de log ». Qu'une erreur réseau se fasse classer ainsi, et chaque
 * cycle échouait en silence, indéfiniment.
 *
 * La règle retenue à la place, et c'est tout l'objet de ce module :
 *
 * > **Le silence ne se déduit jamais du type de l'erreur.** Une erreur n'est
 * > absorbée sans journal que si le drapeau d'arrêt est effectivement levé au
 * > moment où on l'attrape. Tout le reste — abort compris — se journalise, avec
 * > son type et son message.
 *
 * Un arrêt demandé produit bien quelques rejets ; ils sont tus parce qu'on
 * *sait* qu'on s'arrête, pas parce qu'ils *ressemblent* à un arrêt.
 */

import { IntervalsRateLimitError } from './client';

export type PollErrorReport = {
  /** `true` : conséquence de l'arrêt demandé, rien à journaliser. */
  silent: boolean;
  /** Ligne à journaliser. Chaîne vide si {@link silent}. */
  message: string;
  /**
   * `true` si le cycle doit s'arrêter net plutôt que d'enchaîner les
   * téléchargements suivants — un quota atteint ne s'améliore pas en insistant.
   * Indépendant de {@link retryAfterS}, qui peut être `null` sur un 429 dépourvu
   * d'en-tête `Retry-After`.
   */
  abortCycle: boolean;
  /** Délai imposé par l'API avant tout nouvel appel, en secondes. `null` sinon. */
  retryAfterS: number | null;
};

/** `Nom: message` — le type fait partie du diagnostic, pas seulement le texte. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Que faire de cette erreur : la taire, ou la journaliser et attendre.
 *
 * Rien n'est relancé : une API indisponible ne doit pas emporter le service, le
 * cycle suivant réessaiera.
 *
 * @param context.stopping état **réel** du drapeau d'arrêt à l'instant du catch.
 */
export function classifyPollError(
  error: unknown,
  context: { stopping: boolean },
): PollErrorReport {
  if (context.stopping) {
    return { silent: true, message: '', abortCycle: true, retryAfterS: null };
  }

  if (error instanceof IntervalsRateLimitError) {
    return {
      silent: false,
      message: describeError(error),
      abortCycle: true,
      retryAfterS: error.retryAfterS,
    };
  }

  // Une panne isolée (un fichier introuvable, une coupure passagère) ne
  // condamne pas le reste du cycle : les autres activités sont tentées.
  return { silent: false, message: describeError(error), abortCycle: false, retryAfterS: null };
}
