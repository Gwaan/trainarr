/**
 * Erreurs typées de l'intégration Strava.
 *
 * Aucune de ces erreurs ne transporte de jeton : le message décrit la panne, pas
 * le secret qui l'a provoquée (les tokens ne doivent jamais atteindre les logs).
 */

/**
 * Authentification refusée : jetons absents, expirés, révoqués (HTTP 401) ou
 * identifiants client manquants. Pour un appel API, c'est le signal de
 * rafraîchir le jeton puis de retenter.
 */
export class StravaAuthError extends Error {
  readonly name = 'StravaAuthError';
  /** Statut HTTP à l'origine de l'erreur, absent si la panne est locale. */
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.status = options?.status;
  }
}

/**
 * Quota Strava épuisé (HTTP 429, ou quota court terme atteint d'après les
 * en-têtes). Les fenêtres court terme durent 15 minutes et sont alignées sur
 * l'horloge : `retryAt` est le début de la fenêtre suivante.
 */
export class StravaRateLimitError extends Error {
  readonly name = 'StravaRateLimitError';
  /** Attente estimée avant la fenêtre suivante, en secondes. */
  readonly retryAfterS: number;
  readonly retryAt: Date;

  constructor(message: string, options: { retryAt: Date; now?: Date }) {
    super(message);
    this.retryAt = options.retryAt;
    const now = options.now ?? new Date();
    this.retryAfterS = Math.max(0, Math.ceil((options.retryAt.getTime() - now.getTime()) / 1000));
  }
}

/** Toute autre réponse inexploitable de l'API Strava (statut inattendu, corps invalide). */
export class StravaApiError extends Error {
  readonly name = 'StravaApiError';
  readonly status: number;

  constructor(message: string, options: { status: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.status = options.status;
  }
}
