import { NextResponse, connection, type NextRequest } from 'next/server';

import { env } from '@/config/env';
import { buildAuthorizeUrl } from '@/lib/strava/oauth';

import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_S,
  redirectToActivities,
} from '../_lib/oauth-flow';

/**
 * Point d'entrée du flux OAuth Strava : pose un `state` anti-CSRF puis envoie
 * l'utilisateur sur l'écran d'autorisation Strava.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Route par nature dynamique : `connection()` empêche tout prérendu au build,
  // où `env` n'est pas disponible.
  await connection();

  const clientId = env.STRAVA_CLIENT_ID;
  const baseUrl = env.APP_BASE_URL;

  if (!clientId || !baseUrl) {
    console.error(
      '[strava] Connexion impossible : STRAVA_CLIENT_ID ou APP_BASE_URL absente de la configuration.',
    );
    return redirectToActivities(request, 'unconfigured');
  }

  const state = crypto.randomUUID();
  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    // `APP_BASE_URL` peut être renseignée avec un slash final.
    redirectUri: `${baseUrl.replace(/\/+$/, '')}/api/strava/callback`,
    state,
  });

  const response = NextResponse.redirect(authorizeUrl, 307);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: OAUTH_STATE_MAX_AGE_S,
  });

  return response;
}
