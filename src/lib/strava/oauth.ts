import { z } from 'zod';

import { env } from '@/config/env';

import { StravaAuthError } from './errors';

/**
 * OAuth Strava — module pur : aucune base de données, aucun état.
 *
 * La persistance des jetons vit dans le DAL (`src/data/strava-tokens.ts`), qui
 * est le seul à les stocker et à les servir au code serveur.
 *
 * Référence : https://developers.strava.com/docs/authentication/
 */

const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';

/**
 * Périmètre demandé : lecture de toutes les activités (y compris privées) et du
 * profil détaillé (FC max, poids). Aucune permission d'écriture.
 */
export const STRAVA_SCOPE = 'activity:read_all,profile:read_all';

/**
 * Permission sans laquelle Trainarr ne sert à rien : l'athlète peut décocher
 * « activités privées » sur l'écran d'autorisation, et Strava accorde alors un
 * `activity:read` qui masque une partie des sorties.
 */
export const REQUIRED_STRAVA_SCOPE = 'activity:read_all';

/** Jeu de jetons normalisé, seule forme échangée avec le DAL. */
export type StravaTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  /** Identifiant Strava de l'athlète — absent des réponses de refresh. */
  athleteStravaId: number | null;
  /**
   * Périmètre réellement accordé, liste séparée par des virgules. `null` quand
   * il est inconnu (réponse de refresh : Strava ne le renvoie pas).
   */
  scope: string | null;
};

/**
 * `true` si le périmètre accordé contient `activity:read_all`.
 *
 * Comparaison sur les éléments de la liste, pas sur la chaîne entière : Strava
 * ne garantit pas l'ordre, et une inclusion de sous-chaîne accepterait à tort un
 * hypothétique `activity:read_all_public`.
 */
export function hasRequiredScope(scope: string | null): boolean {
  if (scope === null) return false;
  return scope.split(',').some((granted) => granted.trim() === REQUIRED_STRAVA_SCOPE);
}

/**
 * Réponse du endpoint `/oauth/token`, pour l'échange comme pour le refresh.
 * Les champs surnuméraires (`token_type`, `expires_in`, profil complet…) sont
 * ignorés par Zod.
 */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  /** Epoch en secondes. */
  expires_at: z.number().int().positive(),
  athlete: z.object({ id: z.number().int() }).nullish(),
  /** Absent des réponses Strava en pratique — accepté au cas où il apparaîtrait. */
  scope: z.string().nullish(),
});

/** Corps d'erreur Strava : `{ message: 'Bad Request', errors: [...] }`. */
const errorResponseSchema = z.object({ message: z.string() }).nullish();

export { StravaAuthError } from './errors';

/**
 * URL d'autorisation à ouvrir dans le navigateur de l'athlète.
 *
 * `state` est le jeton anti-CSRF : l'appelant le génère, le stocke (cookie) et
 * le revérifie au retour du callback.
 */
export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope', STRAVA_SCOPE);
  url.searchParams.set('state', params.state);
  return url.toString();
}

/** Identifiants applicatifs, lus via la config validée. */
function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = env.STRAVA_CLIENT_ID;
  const clientSecret = env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new StravaAuthError(
      'STRAVA_CLIENT_ID et STRAVA_CLIENT_SECRET doivent être renseignés dans .env.local.',
    );
  }
  return { clientId, clientSecret };
}

/** Message d'erreur renvoyé par Strava, si le corps est exploitable. */
async function readErrorMessage(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data?.message ?? null) : null;
}

/**
 * Appelle `/oauth/token`. Les secrets voyagent dans le corps de la requête,
 * jamais dans l'URL (qui finirait dans les logs d'accès).
 */
async function requestTokens(body: Record<string, string>): Promise<StravaTokenSet> {
  const { clientId, clientSecret } = clientCredentials();

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new StravaAuthError(
      `Strava a refusé la demande de jetons (HTTP ${response.status}${detail ? ` : ${detail}` : ''}).`,
      { status: response.status },
    );
  }

  const payload: unknown = await response.json().catch((cause: unknown) => {
    throw new StravaAuthError('Réponse de jetons Strava illisible (JSON invalide).', { cause });
  });

  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    // Volontairement sans le corps reçu : il contient les jetons.
    throw new StravaAuthError('Réponse de jetons Strava inattendue (champs manquants).', {
      cause: parsed.error,
    });
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: new Date(parsed.data.expires_at * 1000),
    athleteStravaId: parsed.data.athlete?.id ?? null,
    scope: parsed.data.scope ?? null,
  };
}

/**
 * Échange le code d'autorisation reçu sur le callback contre un jeu de jetons.
 *
 * `grantedScope` est le query param `scope` du callback : chez Strava, c'est lui
 * qui fait foi (la réponse `/oauth/token` ne renvoie pas le périmètre accordé).
 * L'appelant doit donc le transmettre pour que le jeu de jetons le porte —
 * l'ignorer revient à croire qu'on a obtenu le périmètre demandé.
 */
export async function exchangeCode(
  code: string,
  grantedScope: string | null,
): Promise<StravaTokenSet> {
  const tokens = await requestTokens({ code, grant_type: 'authorization_code' });
  return { ...tokens, scope: grantedScope ?? tokens.scope };
}

/**
 * Rafraîchit les jetons. Strava fait tourner le refresh token : le jeu retourné
 * remplace intégralement l'ancien.
 */
export function refreshTokens(refreshToken: string): Promise<StravaTokenSet> {
  return requestTokens({ refresh_token: refreshToken, grant_type: 'refresh_token' });
}
