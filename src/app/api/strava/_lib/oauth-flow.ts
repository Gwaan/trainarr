import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';

/**
 * Détails partagés par `/api/strava/connect` et `/api/strava/callback`.
 * Colocalisé sous la route (`_lib` = hors routing).
 */

/** Cookie anti-CSRF du flux OAuth : posé par `/connect`, vérifié par `/callback`. */
export const OAUTH_STATE_COOKIE = 'strava_oauth_state';

/** Le flux d'autorisation Strava tient très largement en 10 minutes. */
export const OAUTH_STATE_MAX_AGE_S = 600;

/** Issue du flux, communiquée à l'UI via `?strava=` (aucun détail d'erreur). */
export type StravaFlowStatus =
  | 'connected'
  | 'denied'
  | 'error'
  | 'unconfigured'
  /** Autorisation obtenue mais sans `activity:read_all` : rien n'a été enregistré. */
  | 'scope'
  /** Un autre compte Strava est déjà connecté : rien n'a été enregistré. */
  | 'foreign';

/**
 * `true` si le compte Strava qui vient d'autoriser n'est pas celui déjà connecté.
 *
 * TODO(auth) : mitigation provisoire. `/api/strava/connect` est anonyme sur une
 * URL publique — faute d'authentification, n'importe qui peut dérouler le flux
 * OAuth avec son propre compte Strava. Ce garde-fou empêche au moins d'écraser la
 * connexion existante de Gwen ; la première connexion, elle, reste ouverte. À
 * remplacer par une vraie session au sprint « auth ».
 */
export function isForeignConnection(
  connectedAthleteId: number | null,
  incomingAthleteId: number | null,
): boolean {
  if (connectedAthleteId === null) return false;
  return incomingAthleteId !== connectedAthleteId;
}

/**
 * Retour à la page des activités avec l'issue du flux.
 *
 * L'origine vient de la requête et non de `APP_BASE_URL` : la redirection doit
 * fonctionner même quand la configuration est incomplète (cas `unconfigured`).
 */
export function redirectToActivities(
  request: NextRequest,
  status: StravaFlowStatus,
): NextResponse {
  const target = new URL('/activities', request.nextUrl.origin);
  target.searchParams.set('strava', status);
  return NextResponse.redirect(target, 307);
}
