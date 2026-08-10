/**
 * Gestion de la souscription au webhook Strava — opération d'administration
 * ponctuelle, volontairement hors de l'application (pas d'endpoint public).
 *
 * Usage :
 *   pnpm strava:subscribe list        # affiche la souscription en place
 *   pnpm strava:subscribe create      # souscrit au flux d'événements
 *   pnpm strava:subscribe delete [id] # supprime (id déduit si omis)
 *
 * À la création, Strava appelle immédiatement `callback_url` en GET pour le
 * handshake : l'application doit déjà tourner et être joignable publiquement à
 * l'adresse `APP_BASE_URL`, sinon Strava répond « callback url not verifiable ».
 *
 * Strava n'autorise qu'une souscription par application : recréer suppose de
 * supprimer l'ancienne d'abord.
 *
 * Référence : https://developers.strava.com/docs/webhooks/
 */

import { z } from 'zod';

const API_BASE = 'https://www.strava.com/api/v3/push_subscriptions';

const COMMANDS = ['create', 'list', 'delete'] as const;
type Command = (typeof COMMANDS)[number];

const subscriptionSchema = z.object({
  id: z.number().int().positive(),
  callback_url: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

type Subscription = z.infer<typeof subscriptionSchema>;

type Credentials = {
  clientId: string;
  clientSecret: string;
  appBaseUrl: string;
  verifyToken: string;
};

function loadEnvFile(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Fichier absent : normal selon l'environnement (dev vs Docker).
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} est requise. Renseigne-la dans .env.local (jamais commité).`);
  }
  return value.trim();
}

function parseCommand(argv: readonly string[]): { command: Command; subscriptionId?: number } {
  const raw = argv[2];
  if (!raw || !COMMANDS.includes(raw as Command)) {
    throw new Error(`Commande attendue : ${COMMANDS.join(' | ')} (reçu : ${raw ?? 'rien'}).`);
  }
  const command = raw as Command;

  const idArg = argv[3];
  if (idArg === undefined) {
    return { command };
  }

  const subscriptionId = Number(idArg);
  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    throw new Error(`Identifiant de souscription invalide : ${idArg}`);
  }
  return { command, subscriptionId };
}

/** Paramètres d'authentification — jamais loggés. */
function authParams(credentials: Credentials): URLSearchParams {
  return new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return `${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`;
}

async function listSubscriptions(credentials: Credentials): Promise<Subscription[]> {
  const response = await fetch(`${API_BASE}?${authParams(credentials).toString()}`);
  if (!response.ok) {
    throw new Error(`Lecture des souscriptions refusée : ${await readError(response)}`);
  }
  return z.array(subscriptionSchema).parse(await response.json());
}

async function createSubscription(credentials: Credentials): Promise<Subscription> {
  const callbackUrl = `${credentials.appBaseUrl.replace(/\/+$/, '')}/api/strava/webhook`;
  const body = authParams(credentials);
  body.set('callback_url', callbackUrl);
  body.set('verify_token', credentials.verifyToken);

  console.log(`Souscription du callback ${callbackUrl} …`);
  const response = await fetch(API_BASE, { method: 'POST', body });
  if (!response.ok) {
    throw new Error(
      `Création refusée : ${await readError(response)}\n` +
        "Vérifie que l'application est joignable publiquement à cette URL " +
        "(Strava appelle le handshake pendant l'appel) et qu'aucune souscription n'existe déjà.",
    );
  }
  return subscriptionSchema.parse(await response.json());
}

async function deleteSubscription(credentials: Credentials, id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/${id}?${authParams(credentials).toString()}`, {
    method: 'DELETE',
  });
  // 204 attendu ; certaines erreurs remontent tout de même en 200 avec un corps.
  if (!response.ok) {
    throw new Error(`Suppression refusée : ${await readError(response)}`);
  }
}

/** L'application ne peut avoir qu'une souscription : l'id est déductible. */
async function resolveSubscriptionId(credentials: Credentials): Promise<number> {
  const subscriptions = await listSubscriptions(credentials);
  const [first] = subscriptions;
  if (!first) {
    throw new Error('Aucune souscription à supprimer.');
  }
  if (subscriptions.length > 1) {
    throw new Error(
      `${subscriptions.length} souscriptions trouvées : précise l'identifiant ` +
        `(pnpm strava:subscribe delete <id>). Ids : ${subscriptions.map((s) => s.id).join(', ')}`,
    );
  }
  return first.id;
}

function printSubscriptions(subscriptions: readonly Subscription[]): void {
  if (subscriptions.length === 0) {
    console.log('Aucune souscription active.');
    return;
  }
  for (const subscription of subscriptions) {
    console.log(
      `  id ${subscription.id} → ${subscription.callback_url ?? '(callback inconnu)'}` +
        (subscription.created_at ? ` (créée le ${subscription.created_at})` : ''),
    );
  }
}

async function main(): Promise<void> {
  loadEnvFile('.env.local');
  loadEnvFile('.env');

  const { command, subscriptionId } = parseCommand(process.argv);

  const credentials: Credentials = {
    clientId: requireEnv('STRAVA_CLIENT_ID'),
    clientSecret: requireEnv('STRAVA_CLIENT_SECRET'),
    appBaseUrl: requireEnv('APP_BASE_URL'),
    verifyToken: requireEnv('STRAVA_WEBHOOK_VERIFY_TOKEN'),
  };

  switch (command) {
    case 'list':
      printSubscriptions(await listSubscriptions(credentials));
      break;
    case 'create': {
      const created = await createSubscription(credentials);
      console.log(`Souscription créée (id ${created.id}).`);
      break;
    }
    case 'delete': {
      const id = subscriptionId ?? (await resolveSubscriptionId(credentials));
      await deleteSubscription(credentials, id);
      console.log(`Souscription ${id} supprimée.`);
      break;
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Échec :', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
