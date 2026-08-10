import { NextResponse, after, connection, type NextRequest } from 'next/server';

import { env } from '@/config/env';
import { syncSingleActivity } from '@/lib/strava/sync';
import { decideWebhookOutcome, verifySubscription } from '@/lib/strava/webhook';

/**
 * Webhook Strava. Enveloppe mince : la logique (handshake, validation, aiguillage)
 * vit dans `src/lib/strava/webhook.ts` et y est testée.
 */

/** Handshake de validation de souscription : Strava attend son challenge en retour. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Route par nature dynamique : `connection()` empêche tout prérendu au build.
  await connection();

  const handshake = verifySubscription(
    request.nextUrl.searchParams,
    env.STRAVA_WEBHOOK_VERIFY_TOKEN,
  );

  if (!handshake.ok) {
    console.error('[strava] Handshake webhook refusé :', handshake.reason);
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  return NextResponse.json({ 'hub.challenge': handshake.challenge });
}

/**
 * Réception d'un événement.
 *
 * Strava attend une réponse en moins de 2 secondes et retente sinon : on accuse
 * toujours réception (y compris sur un payload invalide, pour ne pas déclencher
 * de boucle de renvoi) et le travail réel part dans `after()`.
 *
 * Les événements ne sont pas signés : le corps de la requête ne sert qu'à
 * extraire des identifiants, la donnée est ensuite relue depuis l'API Strava avec
 * nos propres jetons — et seulement si l'`owner_id` annoncé est bien celui de
 * l'athlète connecté.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const payload: unknown = await request.json().catch(() => null);
  const outcome = decideWebhookOutcome(payload);

  switch (outcome.kind) {
    case 'sync-activity': {
      const { stravaActivityId, ownerId } = outcome;
      after(async () => {
        try {
          // `ownerId` vient d'un payload non signé : la sync le confronte à
          // l'athlète connecté et abandonne s'il ne correspond pas.
          await syncSingleActivity(stravaActivityId, ownerId);
        } catch (error) {
          console.error(
            `[strava] Synchronisation de l'activité ${stravaActivityId} en échec :`,
            error,
          );
        }
      });
      break;
    }
    case 'ignored':
      console.log('[strava] Événement webhook ignoré :', outcome.reason);
      break;
    case 'invalid':
      console.error('[strava] Payload webhook invalide :', outcome.reason);
      break;
  }

  return NextResponse.json({ received: true });
}
