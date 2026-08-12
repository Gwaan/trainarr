import 'server-only';

/**
 * Registre de progression des générations du coach.
 *
 * Une génération de plan dure des minutes sur un modèle local. Le pourcentage
 * qui l'accompagne n'est pas une donnée métier : il ne survit ni au processus,
 * ni à un redémarrage, et personne ne le relira jamais après coup. D'où une
 * `Map` en mémoire plutôt qu'une table ou un Redis — l'appli est mono-instance
 * (un seul container `trainarr`), l'écrivain et le lecteur sont donc dans le
 * même processus.
 *
 * Le producteur est {@link ../ai/plan-service}, qui alimente l'entrée à chaque
 * chunk reçu du modèle ; le consommateur est la route `GET /api/plan-progress`,
 * que le formulaire interroge toutes les deux secondes.
 *
 * ## Pourquoi une éviction
 *
 * Le service efface son entrée en `finally`, donc le cas nominal ne laisse rien
 * derrière lui. Reste l'anormal : un processus tué en plein vol, une exception
 * hors du `finally`. Une entrée pèse quelques octets, mais sans purge la `Map`
 * ne fait que croître sur la durée de vie du container. L'éviction passe sur
 * les entrées de plus de {@link PROGRESS_TTL_MS} — très au-delà du délai de
 * garde d'un appel au coach (5 min), donc jamais sur une génération vivante.
 *
 * ## Pourquoi le registre vit sur `globalThis`
 *
 * Constat de production : les logs du serveur affichaient bien
 * `[plan] progression suivie (id …)`, mais `GET /api/plan-progress` rendait
 * toujours `null` — aucun pourcentage n'atteignait jamais le navigateur.
 *
 * « Même processus » ne veut pas dire « même module ». En build standalone, la
 * Server Action et le route handler sont deux bundles distincts, et chacun
 * embarque **sa propre instance** de ce fichier : deux `Map`, l'une alimentée,
 * l'autre lue. Une variable de module ne franchit pas cette frontière, une clé
 * `Symbol.for()` posée sur `globalThis` si — c'est le singleton habituel des
 * modules serveur sous Next, celui qui survit aussi au rechargement à chaud en
 * développement.
 */

/** L'avancement d'une génération, tel que le formulaire l'affiche. */
export type PlanProgress = {
  /**
   * Part du travail déjà faite, de 0 à 100.
   *
   * Deux producteurs, deux échelles, et c'est assumé (cf. `plan-service.ts`) :
   * une **création** compte ses créneaux de qualité écrits et va jusqu'à 100,
   * puisque rien ne peut plus la faire recommencer ; un **ajustement** ou une
   * **révision** comptent des caractères reçus contre une taille estimée et
   * plafonnent à 99, tant que la validation métier n'a pas parlé.
   */
  percent: number;
  /** Tentative en cours dans la boucle de correction, à partir de 1. */
  attempt: number;
  /**
   * Nombre total de tentatives possibles — `1` quand le chemin n'en rejoue
   * aucune, ce qui est le cas d'une création depuis la bascule sur squelette.
   * Le formulaire n'affiche alors pas le rang.
   */
  maxAttempts: number;
  /** Horodatage (ms epoch) du premier enregistrement — la base de l'éviction. */
  startedAt: number;
};

/** Ce qu'un producteur enregistre : `startedAt` est posé par le registre. */
export type PlanProgressInput = Omit<PlanProgress, 'startedAt'>;

/** Au-delà d'une heure, une entrée ne peut plus correspondre à une génération en cours. */
export const PROGRESS_TTL_MS = 3_600_000;

/**
 * La clé du registre partagé. `Symbol.for` et non `Symbol` : c'est le registre
 * global de symboles qui fait le lien entre deux instances du module, une clé
 * locale en créerait une par bundle et ne réglerait rien.
 */
const REGISTRY_KEY: unique symbol = Symbol.for('trainarr.plan-progress');

/** `globalThis` vu comme le porteur du registre — la seule façon de le typer sans `any`. */
type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, PlanProgress>;
};

/** Le registre partagé, créé au premier accès quel que soit le bundle appelant. */
function registry(): Map<string, PlanProgress> {
  const store = globalThis as GlobalWithRegistry;

  const existing = store[REGISTRY_KEY];
  if (existing !== undefined) return existing;

  const created = new Map<string, PlanProgress>();
  store[REGISTRY_KEY] = created;
  return created;
}

/**
 * Purge les entrées périmées.
 *
 * Balayage complet plutôt que minuteur : la `Map` compte au plus quelques
 * entrées (une utilisatrice, une génération à la fois), et un `setInterval` de
 * module survivrait au rechargement à chaud en développement.
 */
function evictStale(now: number): void {
  const entries = registry();
  for (const [id, entry] of entries) {
    if (now - entry.startedAt > PROGRESS_TTL_MS) entries.delete(id);
  }
}

/**
 * Enregistre l'avancement de la génération `id`.
 *
 * `startedAt` est celui du **premier** enregistrement : les mises à jour
 * suivantes ne repoussent pas l'éviction, sans quoi une entrée alimentée en
 * boucle serait immortelle.
 */
export function setPlanProgress(id: string, progress: PlanProgressInput): void {
  const now = Date.now();
  evictStale(now);
  const entries = registry();
  entries.set(id, { ...progress, startedAt: entries.get(id)?.startedAt ?? now });
}

/** L'avancement de la génération `id`, ou `null` : inconnue, terminée ou périmée. */
export function getPlanProgress(id: string): PlanProgress | null {
  const entries = registry();
  const entry = entries.get(id);
  if (entry === undefined) return null;

  // Une entrée périmée que l'éviction n'a pas encore croisée ne doit pas être
  // servie : elle décrirait une génération abandonnée comme si elle courait.
  if (Date.now() - entry.startedAt > PROGRESS_TTL_MS) {
    entries.delete(id);
    return null;
  }
  return entry;
}

/** Oublie la génération `id` — appelé en `finally`, quelle qu'en soit l'issue. */
export function clearPlanProgress(id: string): void {
  registry().delete(id);
}

/**
 * Vide le registre.
 *
 * Exportée pour les tests : l'état vit maintenant sur `globalThis`, donc il
 * survit au rechargement des modules d'un cas de test à l'autre — une entrée
 * laissée par un scénario en ferait passer un autre pour suivi.
 */
export function resetPlanProgress(): void {
  registry().clear();
}
