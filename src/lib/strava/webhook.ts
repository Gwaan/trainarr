import { z } from 'zod';

/**
 * Logique du webhook Strava, isolée du route handler pour être testable.
 *
 * Le route handler (`src/app/api/strava/webhook/route.ts`) n'est qu'une
 * enveloppe : il lit la requête, appelle ces fonctions pures et traduit leur
 * résultat en réponse HTTP.
 *
 * Référence : https://developers.strava.com/docs/webhooks/
 */

/** Valeur imposée par Strava sur le `GET` de validation de souscription. */
const HUB_MODE_SUBSCRIBE = 'subscribe';

export type SubscriptionHandshake =
  | { readonly ok: true; readonly challenge: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Handshake de souscription : Strava appelle l'URL de callback en `GET` avec
 * `hub.mode`, `hub.verify_token` et `hub.challenge`. Il faut lui renvoyer le
 * challenge tel quel, mais uniquement si le token correspond au nôtre.
 *
 * Les motifs de refus restent des libellés fixes : ils partent dans les logs
 * serveur, on n'y recopie aucune valeur fournie par l'appelant.
 */
export function verifySubscription(
  query: URLSearchParams,
  expectedToken: string | undefined,
): SubscriptionHandshake {
  // Token non configuré : on refuse plutôt que d'accepter n'importe qui.
  if (!expectedToken) {
    return { ok: false, reason: 'STRAVA_WEBHOOK_VERIFY_TOKEN non configuré' };
  }

  if (query.get('hub.mode') !== HUB_MODE_SUBSCRIBE) {
    return { ok: false, reason: 'hub.mode inattendu' };
  }

  if (query.get('hub.verify_token') !== expectedToken) {
    return { ok: false, reason: 'hub.verify_token invalide' };
  }

  const challenge = query.get('hub.challenge');
  if (!challenge) {
    return { ok: false, reason: 'hub.challenge absent' };
  }

  return { ok: true, challenge };
}

/**
 * Événement webhook. Tout ce qui n'est pas décrit ici est ignoré : aucune
 * donnée du payload n'est utilisée sans être passée par ce schéma.
 *
 * `object_type` n'accepte que les deux valeurs documentées par Strava ; une
 * valeur inconnue fait échouer la validation, ce qui revient à ignorer
 * l'événement (avec une trace).
 */
const webhookEventSchema = z.object({
  object_type: z.enum(['activity', 'athlete']),
  object_id: z.number().int().positive(),
  aspect_type: z.enum(['create', 'update', 'delete']),
  owner_id: z.number().int().positive(),
  /** Champs modifiés lors d'un `update` — Strava n'y envoie que des chaînes. */
  updates: z.record(z.string(), z.string()).optional(),
});

export type StravaWebhookEvent = z.infer<typeof webhookEventSchema>;

export type WebhookOutcome =
  /**
   * L'activité doit être (re)synchronisée depuis l'API Strava.
   *
   * `ownerId` est transmis à la sync, qui refuse tout ce qui n'appartient pas à
   * l'athlète connecté : le payload n'étant pas signé, l'identifiant d'activité
   * seul ne prouve rien.
   */
  | {
      readonly kind: 'sync-activity';
      readonly stravaActivityId: number;
      readonly ownerId: number;
    }
  /** Événement valide mais sans traitement de notre côté. */
  | { readonly kind: 'ignored'; readonly reason: string }
  /** Payload illisible ou hors contrat. */
  | { readonly kind: 'invalid'; readonly reason: string };

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`)
    .join(' ; ');
}

/**
 * Décide quoi faire d'un payload webhook brut. Ne déclenche rien elle-même :
 * l'appelant exécute la synchronisation en tâche de fond, après avoir répondu
 * à Strava (qui exige une réponse en moins de 2 secondes).
 *
 * Le payload n'est pas signé par Strava : seuls des identifiants en sont
 * extraits, et la donnée réelle est ensuite relue depuis l'API avec nos propres
 * jetons. Rien du corps de la requête n'est écrit tel quel en base, et
 * l'`owner_id` annoncé est confronté à l'athlète connecté par la sync.
 */
export function decideWebhookOutcome(payload: unknown): WebhookOutcome {
  const parsed = webhookEventSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: 'invalid', reason: describeIssues(parsed.error) };
  }

  const event = parsed.data;

  if (event.object_type !== 'activity') {
    return { kind: 'ignored', reason: "événement d'athlète non traité" };
  }

  switch (event.aspect_type) {
    case 'create':
    case 'update':
      return {
        kind: 'sync-activity',
        stravaActivityId: event.object_id,
        ownerId: event.owner_id,
      };
    case 'delete':
      // TODO: répercuter la suppression en base. Nécessite une opération de
      // suppression par `strava_id` dans le DAL, qui n'existe pas encore ;
      // l'activité reste donc visible dans Trainarr après suppression côté
      // Strava. À traiter avec la gestion du désabonnement (`updates.authorized`).
      return { kind: 'ignored', reason: "suppression d'activité non gérée pour l'instant" };
  }
}
