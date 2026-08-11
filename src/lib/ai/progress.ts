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
 */

/** L'avancement d'une génération, tel que le formulaire l'affiche. */
export type PlanProgress = {
  /** Part de la sortie attendue déjà reçue, de 0 à 99 (cf. `plan-service.ts`). */
  percent: number;
  /** Tentative en cours dans la boucle de correction, à partir de 1. */
  attempt: number;
  /** Nombre total de tentatives possibles. */
  maxAttempts: number;
  /** Horodatage (ms epoch) du premier enregistrement — la base de l'éviction. */
  startedAt: number;
};

/** Ce qu'un producteur enregistre : `startedAt` est posé par le registre. */
export type PlanProgressInput = Omit<PlanProgress, 'startedAt'>;

/** Au-delà d'une heure, une entrée ne peut plus correspondre à une génération en cours. */
export const PROGRESS_TTL_MS = 3_600_000;

const registry = new Map<string, PlanProgress>();

/**
 * Purge les entrées périmées.
 *
 * Balayage complet plutôt que minuteur : la `Map` compte au plus quelques
 * entrées (une utilisatrice, une génération à la fois), et un `setInterval` de
 * module survivrait au rechargement à chaud en développement.
 */
function evictStale(now: number): void {
  for (const [id, entry] of registry) {
    if (now - entry.startedAt > PROGRESS_TTL_MS) registry.delete(id);
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
  registry.set(id, { ...progress, startedAt: registry.get(id)?.startedAt ?? now });
}

/** L'avancement de la génération `id`, ou `null` : inconnue, terminée ou périmée. */
export function getPlanProgress(id: string): PlanProgress | null {
  const entry = registry.get(id);
  if (entry === undefined) return null;

  // Une entrée périmée que l'éviction n'a pas encore croisée ne doit pas être
  // servie : elle décrirait une génération abandonnée comme si elle courait.
  if (Date.now() - entry.startedAt > PROGRESS_TTL_MS) {
    registry.delete(id);
    return null;
  }
  return entry;
}

/** Oublie la génération `id` — appelé en `finally`, quelle qu'en soit l'issue. */
export function clearPlanProgress(id: string): void {
  registry.delete(id);
}
