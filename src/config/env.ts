import 'server-only';

import { z } from 'zod';

/**
 * Validation des variables d'environnement (fail fast au démarrage).
 *
 * Avec le Data Access Layer (`src/data/`), ce module est le SEUL endroit autorisé
 * à lire `process.env`. Le reste de l'application importe l'objet `env` typé.
 */

const envSchema = z.object({
  // Base de données
  DATABASE_URL: z.url({ error: 'URL Postgres requise (ex: postgres://user:pass@host:5432/trainarr)' }),

  // URL publique de l'application (ex: https://watchenv.gwenzr.dev) — celle par
  // laquelle la montre atteint le dépôt WebDAV, et qu'affichent les liens
  // absolus construits côté serveur.
  APP_BASE_URL: z.url().optional(),

  // Coach IA — abstraction compatible OpenAI, jamais de couplage direct à un provider
  AI_PROVIDER: z.enum(['llamacpp', 'anthropic', 'openai']).default('llamacpp'),
  AI_BASE_URL: z.url().optional(),
  AI_MODEL: z.string().min(1).optional(),
  AI_API_KEY: z.string().min(1).optional(),

  // Import FIT — boîte de dépôt du service d'ingestion, qui tourne dans le
  // process de l'application (cf. src/instrumentation.ts et src/lib/fit/service.ts).
  // En Docker, c'est le point de montage du volume trainarr-fit-inbox.
  FIT_INBOX_DIR: z.string().min(1).default('/data/fit-inbox'),
  // Intervalle entre deux scans du dossier, en secondes. C'est aussi le délai
  // minimal avant qu'un fichier soit jugé complet : sa taille doit être
  // identique sur deux scans consécutifs.
  FIT_WATCH_INTERVAL_S: z.coerce.number().int().positive().default(30),

  // Rapatriement automatique depuis intervals.icu (cf. src/lib/intervals/).
  // Le poller ne démarre que si la clé API est renseignée. Tant qu'aucune séance
  // n'a été rapatriée, il demande tout l'historique (par tranches, sur plusieurs
  // cycles) ; ensuite seulement la fenêtre glissante de INTERVALS_LOOKBACK_DAYS
  // jours.
  //
  // INTERVALS_ATHLETE_ID est **optionnelle** : omise, le poller interroge
  // l'athlète 0, que l'API résout en « le propriétaire de la clé ». Et son
  // format n'est volontairement PAS validé ici : une valeur illisible ne doit
  // désactiver que le poller, jamais empêcher l'application de démarrer — la
  // normalisation et le diagnostic vivent dans `planPollerActivation`
  // (src/lib/intervals/poll-plan.ts).
  INTERVALS_ATHLETE_ID: z.string().min(1).optional(),
  INTERVALS_API_KEY: z.string().min(1).optional(),
  INTERVALS_POLL_INTERVAL_S: z.coerce.number().int().positive().default(60),
  INTERVALS_LOOKBACK_DAYS: z.coerce.number().int().positive().default(30),

  // Secret de signature des sessions et des jetons (better-auth, cf. src/lib/auth/).
  //
  // **Facultative**, comme INTERVALS_API_KEY : absente, l'authentification est
  // inopérante (l'écran de connexion le dit, la route /api/auth répond 503) mais
  // l'application démarre et sert ses pages. Un secret manquant ne doit pas
  // couper une installation entière — le déploiement est automatique au push.
  //
  // Sa LONGUEUR n'est volontairement pas validée ici, pour la même raison que
  // le format d'INTERVALS_ATHLETE_ID : un secret trop court doit désactiver la
  // seule authentification, jamais empêcher le démarrage. Le seuil et son
  // diagnostic vivent dans `resolveAuthConfig` (src/lib/auth/config.ts).
  BETTER_AUTH_SECRET: z.string().min(1).optional(),

  // Identifiants du point de dépôt WebDAV servi sur /dav (cf. src/lib/fit/dav.ts).
  // Optionnels, mais tant que les deux ne sont pas renseignés le dépôt répond
  // 503 : il n'existe pas d'état « ouvert sans authentification ».
  WEBDAV_USERNAME: z.string().min(1).optional(),
  WEBDAV_PASSWORD: z.string().min(1).optional(),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

/** Une variable définie mais vide (`FOO=`) équivaut à une variable absente. */
function normalize(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = source[key];
    // Clé volontairement omise (et non mise à `undefined`) pour que les champs
    // optionnels restent absents de l'objet résultat.
    if (value !== undefined && value.trim() !== '') {
      normalized[key] = value;
    }
  }
  return normalized;
}

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join('.') || '(racine)';
    return `  - ${name} : ${issue.message}`;
  });
  return [
    "Variables d'environnement invalides ou manquantes :",
    ...lines,
    'Renseigne-les dans .env.local (jamais commité).',
  ].join('\n');
}

/**
 * Valide une source de variables d'environnement. Exportée pour les tests ;
 * le code applicatif utilise l'objet `env` ci-dessous.
 *
 * @throws Error listant explicitement chaque variable en défaut.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(normalize(source));
  if (!result.success) {
    throw new Error(formatIssues(result.error));
  }
  return Object.freeze(result.data);
}

let cached: Env | undefined;

/**
 * Accès validé aux variables d'environnement, résolu au premier usage.
 *
 * La validation est volontairement paresseuse : `next build` (notamment dans
 * l'image Docker) importe les modules applicatifs sans disposer des variables
 * runtime. Valider au chargement ferait échouer le build. Le fail fast reste
 * réel — il se produit à la première lecture d'une variable, donc au démarrage
 * effectif de l'application.
 */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Réinitialise le cache — réservé aux tests. */
export function resetEnvCache(): void {
  cached = undefined;
}

export const env: Env = new Proxy({} as Env, {
  get: (_target, prop) => getEnv()[prop as keyof Env],
  has: (_target, prop) => prop in getEnv(),
  set: () => {
    throw new TypeError("L'objet env est en lecture seule.");
  },
  deleteProperty: () => {
    throw new TypeError("L'objet env est en lecture seule.");
  },
  // Sans ce garde, un `Object.freeze(env)` rendrait la cible non extensible et
  // casserait définitivement `ownKeys` (invariant des proxies).
  preventExtensions: () => false,
  ownKeys: () => Reflect.ownKeys(getEnv()),
  getOwnPropertyDescriptor: (_target, prop) => {
    const descriptor = Object.getOwnPropertyDescriptor(getEnv(), prop);
    // `getEnv()` retourne un objet figé : le proxy exige des descripteurs
    // configurables puisque la cible (`{}`) ne porte pas ces propriétés.
    return descriptor && { ...descriptor, configurable: true };
  },
});
