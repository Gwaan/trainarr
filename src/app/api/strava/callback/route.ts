import { after, connection, type NextRequest, type NextResponse } from 'next/server';

import { getStravaAthleteId } from '@/data/athlete';
import { saveStravaTokens } from '@/data/strava-tokens';
import { exchangeCode, hasRequiredScope, REQUIRED_STRAVA_SCOPE } from '@/lib/strava/oauth';
import { syncRecentActivities } from '@/lib/strava/sync';

import {
  isForeignConnection,
  OAUTH_STATE_COOKIE,
  redirectToActivities,
  type StravaFlowStatus,
} from '../_lib/oauth-flow';

/**
 * Retour de l'écran d'autorisation Strava : valide le `state`, échange le code
 * contre des jetons, puis lance le backfill en tâche de fond.
 *
 * Aucune erreur n'est détaillée au client : l'issue tient dans `?strava=`,
 * le diagnostic reste dans les logs serveur.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Route par nature dynamique : `connection()` empêche tout prérendu au build.
  await connection();

  const params = request.nextUrl.searchParams;
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  // Le `state` est à usage unique : le cookie disparaît quelle que soit l'issue.
  const finish = (status: StravaFlowStatus): NextResponse => {
    const response = redirectToActivities(request, status);
    response.cookies.delete(OAUTH_STATE_COOKIE);
    return response;
  };

  // Refus explicite de l'utilisateur sur l'écran Strava. Traité avant le
  // `state` : Strava renvoie ce cas avec un `state` vide.
  if (params.get('error') === 'access_denied') {
    return finish('denied');
  }

  const state = params.get('state');
  if (!expectedState || !state || state !== expectedState) {
    console.error('[strava] Callback rejeté : state OAuth absent ou non concordant.');
    return finish('error');
  }

  const code = params.get('code');
  if (!code) {
    console.error("[strava] Callback rejeté : code d'autorisation absent.");
    return finish('error');
  }

  try {
    // Le périmètre réellement accordé est celui du query param `scope` : Strava
    // ne le renvoie pas dans la réponse de jetons, et l'athlète peut avoir
    // décoché « activités privées » sur l'écran d'autorisation.
    const tokens = await exchangeCode(code, params.get('scope'));

    if (!hasRequiredScope(tokens.scope)) {
      console.error(
        `[strava] Callback refusé : le périmètre accordé ne contient pas ${REQUIRED_STRAVA_SCOPE}. Aucun jeton enregistré.`,
      );
      return finish('scope');
    }

    // Cf. `isForeignConnection` : garde-fou provisoire tant que l'application
    // n'a pas d'authentification.
    if (isForeignConnection(await getStravaAthleteId(), tokens.athleteStravaId)) {
      console.error(
        '[strava] Callback refusé : un autre compte Strava est déjà connecté. Aucun jeton enregistré.',
      );
      return finish('foreign');
    }

    await saveStravaTokens(tokens);
  } catch (error) {
    console.error("[strava] Échec de l'échange du code OAuth :", error);
    return finish('error');
  }

  // Backfill hors du chemin de réponse : l'utilisateur revient sur l'appli
  // immédiatement, les activités arrivent ensuite.
  after(async () => {
    try {
      await syncRecentActivities();
      console.log('[strava] Backfill initial terminé.');
    } catch (error) {
      console.error('[strava] Backfill initial en échec :', error);
    }
  });

  return finish('connected');
}
