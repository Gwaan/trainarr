import 'server-only';

/**
 * Garde de charge du chat coach.
 *
 * Le modèle tourne sur **un seul GPU**, avec 6 Go de VRAM. Deux générations
 * concurrentes ne vont pas deux fois moins vite : elles se disputent la mémoire
 * du contexte, et llama-server met la seconde en file — la fenêtre du chat
 * resterait vide pendant toute la première. La règle est donc simple et
 * assumée : **une génération à la fois**, la seconde est refusée tout de suite
 * plutôt que d'être acceptée pour attendre.
 *
 * S'y ajoute un plafond de {@link COACH_CHAT_MAX_PER_MINUTE} générations par
 * minute glissante, exigé par `.claude/rules/security.md` (« rate-limiter les
 * endpoints coûteux, chat IA notamment ») : le verrou seul empêche la
 * concurrence, pas l'acharnement — une boucle qui repose sa question dès la
 * réponse rendue occuperait le GPU sans discontinuer.
 *
 * En mémoire, comme `progress.ts`, et pour les mêmes raisons : l'appli est
 * mono-instance (un seul container `trainarr`), le compteur ne survit pas au
 * processus et personne ne le relira jamais. L'état vit sur `globalThis` sous
 * une clé `Symbol.for()` — en build standalone, deux bundles peuvent embarquer
 * chacun leur instance du module, et ce seraient alors deux verrous, donc deux
 * générations concurrentes.
 */

/** Générations acceptées par minute glissante. */
export const COACH_CHAT_MAX_PER_MINUTE = 10;

/** Largeur de la fenêtre du plafond. */
export const COACH_CHAT_WINDOW_MS = 60_000;

/**
 * Pourquoi une génération est refusée.
 *
 * - `busy` : une génération est déjà en cours ;
 * - `too-many` : le plafond de la minute écoulée est atteint.
 *
 * Les deux appellent des réponses HTTP différentes, cf. le route handler.
 */
export type CoachChatRefusal = 'busy' | 'too-many';

/**
 * Un droit à générer. `release` est **idempotent** : l'appelant le pose en
 * `finally`, et une même génération ne rend jamais son droit deux fois — sans
 * quoi elle libérerait celui de la suivante.
 */
export type CoachChatSlot =
  | { granted: true; release: () => void }
  | { granted: false; reason: CoachChatRefusal };

type GuardState = {
  /** Vrai tant qu'une génération n'a pas rendu son droit. */
  busy: boolean;
  /** Horodatages (ms epoch) des générations acceptées, les plus vieilles d'abord. */
  starts: number[];
};

const STATE_KEY: unique symbol = Symbol.for('trainarr.coach-chat-guard');

/** `globalThis` vu comme le porteur de l'état — la seule façon de le typer sans `any`. */
type GlobalWithGuard = typeof globalThis & { [STATE_KEY]?: GuardState };

function state(): GuardState {
  const store = globalThis as GlobalWithGuard;

  const existing = store[STATE_KEY];
  if (existing !== undefined) return existing;

  const created: GuardState = { busy: false, starts: [] };
  store[STATE_KEY] = created;
  return created;
}

/**
 * Demande le droit de lancer une génération.
 *
 * L'ordre des deux refus n'est pas arbitraire : un appel concurrent est refusé
 * **sans** être compté dans la minute. Le compter reviendrait à punir l'athlète
 * d'un double-clic — le second appel n'a rien coûté au GPU.
 */
export function acquireCoachChatSlot(): CoachChatSlot {
  const guard = state();
  if (guard.busy) return { granted: false, reason: 'busy' };

  const now = Date.now();
  guard.starts = guard.starts.filter((at) => now - at < COACH_CHAT_WINDOW_MS);
  if (guard.starts.length >= COACH_CHAT_MAX_PER_MINUTE) {
    return { granted: false, reason: 'too-many' };
  }

  guard.starts.push(now);
  guard.busy = true;

  let released = false;
  return {
    granted: true,
    release: () => {
      if (released) return;
      released = true;
      // L'état capturé, et non `state()` : après une remise à zéro (tests), ce
      // droit-là appartient à un état abandonné et ne doit plus rien libérer.
      guard.busy = false;
    },
  };
}

/**
 * Remet la garde à zéro.
 *
 * Exportée pour les tests : l'état vit sur `globalThis`, donc il survit au
 * rechargement des modules d'un cas à l'autre — un verrou laissé pris ferait
 * refuser tous les scénarios suivants.
 */
export function resetCoachChatGuard(): void {
  const store = globalThis as GlobalWithGuard;
  store[STATE_KEY] = { busy: false, starts: [] };
}
