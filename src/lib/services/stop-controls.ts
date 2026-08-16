/**
 * Le drapeau d'arrêt des services de fond, et rien d'autre.
 *
 * Trois boucles longue durée tournent dans le process du serveur Next (import
 * FIT, météo, notifications). Toutes ont besoin des trois mêmes primitives, et
 * elles les écrivaient chacune de leur côté :
 *
 * - un **drapeau** relu entre deux étapes — c'est lui, et lui seul, qui autorise
 *   une boucle à se taire au lieu de journaliser une panne ;
 * - une **attente interruptible**, sans quoi un `stop()` demandé juste après le
 *   début d'un cycle de 60 s attendrait ces 60 s — bien au-delà du délai de
 *   grâce de Docker, donc un SIGKILL ;
 * - un **`AbortController`** pour les appels réseau en vol : le drapeau n'est
 *   relu qu'entre deux étapes, un appel HTTP suspendu retiendrait la boucle
 *   jusqu'aux temporisations d'undici (300 s).
 *
 * ## Une portée fermée, jamais des variables de module
 *
 * Chaque appel crée son propre état. En développement, Turbopack recharge les
 * modules à chaud et un service peut démarrer deux fois : avec un état de
 * module, le premier arrêt couperait les boucles du second.
 *
 * ## `requestStop()` est **synchrone**
 *
 * Next installe son propre gestionnaire de SIGTERM/SIGINT qui termine par
 * `process.exit(143)` dès sa fermeture faite : mesuré, une continuation
 * asynchrone de 5 ms n'a déjà plus la main. Lever le drapeau, annuler les appels
 * et réveiller les dormeurs se font donc sans le moindre `await`.
 */

export type StopControls = {
  /** État réel du drapeau d'arrêt — c'est lui, et lui seul, qui autorise le silence. */
  readonly stopping: boolean;
  /** Annulation des appels réseau en vol. */
  readonly signal: AbortSignal;
  /** Attente interruptible, plafonnée à `maxSleepMs`. */
  sleep(ms: number): Promise<void>;
  /** Lève le drapeau, annule les appels en vol, réveille les dormeurs. Synchrone. */
  requestStop(): void;
};

/**
 * Plafond par défaut d'une attente : la plus grande valeur que `setTimeout`
 * sache tenir.
 *
 * Au-delà de 2³¹−1 ms le délai déborde et `setTimeout` retombe à **1 ms** — la
 * boucle censée dormir un mois se met alors à tourner à vide. Aucun appelant ne
 * demande de tels délais aujourd'hui ; ce plafond est le garde-fou qui garantit
 * qu'aucune configuration future ne pourra provoquer ce retournement.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export type StopControlsOptions = {
  /**
   * Plafond d'une attente, quand l'appelant en veut un plus serré que
   * {@link MAX_TIMEOUT_MS} — le rapatriement intervals.icu borne le sien à une
   * heure pour ne pas dormir tout un `Retry-After` abusif.
   */
  maxSleepMs?: number;
};

export function createStopControls(options: StopControlsOptions = {}): StopControls {
  const maxSleepMs = options.maxSleepMs ?? MAX_TIMEOUT_MS;

  let stopping = false;
  /**
   * Réveils des attentes en cours. Un ensemble et non une référence unique : un
   * service peut porter plusieurs boucles qui dorment chacune de leur côté
   * (watcher et poller), et réveiller le dernier endormi laisserait l'autre
   * traîner jusqu'à son échéance.
   */
  const sleepers = new Set<() => void>();
  const inFlight = new AbortController();

  return {
    get stopping() {
      return stopping;
    },
    get signal() {
      return inFlight.signal;
    },
    sleep(ms: number): Promise<void> {
      if (stopping) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          sleepers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(ms, maxSleepMs));
        sleepers.add(done);
      });
    },
    requestStop(): void {
      if (stopping) return;
      stopping = true;
      inFlight.abort();
      for (const wake of [...sleepers]) wake();
    },
  };
}
