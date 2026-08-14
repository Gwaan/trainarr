import 'server-only';

/**
 * L'instance better-auth de Trainarr.
 *
 * Trois partis pris, tous dictés par le fait que l'appli est auto-hébergée et
 * mono-utilisatrice :
 *
 * - **e-mail + mot de passe uniquement.** Aucun fournisseur OAuth : ce serait
 *   confier l'accès à ses propres données d'entraînement à un tiers, et faire
 *   dépendre la connexion d'un service qui peut tomber.
 * - **Inscription fermée, sauf la toute première.** Tant qu'aucun compte
 *   n'existe, n'importe qui peut créer le sien — c'est ce qui évite un script
 *   manuel au premier lancement. Dès qu'il en existe un, la porte se referme
 *   (cf. {@link SIGN_UP_CLOSED_MESSAGE}).
 * - **Rien n'est obligatoire au démarrage.** Sans `BETTER_AUTH_SECRET`,
 *   {@link getAuth} rend `null` et l'application continue de servir ses pages :
 *   c'est l'authentification qui est hors service, pas l'appli.
 *
 * `better-auth/minimal` et non `better-auth` : la variante complète embarque
 * Kysely pour se connecter elle-même à la base, dont on n'a que faire puisqu'on
 * fournit un adaptateur Drizzle (c'est l'usage que sa propre documentation
 * embarquée recommande).
 */

import { betterAuth } from 'better-auth/minimal';
import { nextCookies } from 'better-auth/next-js';

import { env } from '@/config/env';
import { authDatabaseAdapter } from '@/data/db/auth-adapter';

import { AUTH_DISABLED_MESSAGES, resolveAuthConfig } from './config';
import { AUTH_PASSWORD_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH } from './limits';
import { guardSignUp } from './sign-up-guard';

export { AUTH_DISABLED_MESSAGES, AUTH_SECRET_MIN_LENGTH } from './config';
export {
  AUTH_NAME_MAX_LENGTH,
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from './limits';
export { SIGN_UP_CLOSED_CODE, SIGN_UP_CLOSED_MESSAGE } from './sign-up-guard';

function buildAuth(secret: string) {
  return betterAuth({
    secret,
    /**
     * Vide en dev : better-auth déduit alors l'origine de la requête. En
     * production, `APP_BASE_URL` évite qu'un en-tête `Host` falsifié serve
     * d'origine de confiance.
     */
    baseURL: env.APP_BASE_URL,
    database: authDatabaseAdapter(),
    emailAndPassword: {
      enabled: true,
      /**
       * Pas de `disableSignUp` : ce drapeau est figé au démarrage, alors que la
       * règle dépend de l'état de la base. C'est {@link guardSignUp} qui décide,
       * requête par requête.
       */
      autoSignIn: true,
      /**
       * Les mêmes bornes que celles affichées par le formulaire : elles
       * viennent d'une constante unique (cf. `limits.ts`), pour qu'un refus du
       * serveur ne contredise jamais le message lu à l'écran.
       */
      minPasswordLength: AUTH_PASSWORD_MIN_LENGTH,
      maxPasswordLength: AUTH_PASSWORD_MAX_LENGTH,
    },
    user: {
      additionalFields: {
        /**
         * Marque du compte d'amorçage. `input: false` — aucun client ne peut la
         * poser, elle vient du crochet seul ; `returned: false` — elle ne sort
         * jamais dans un objet utilisateur, c'est un détail de contrainte de
         * base, pas une donnée de profil.
         */
        isFirstAccount: {
          type: 'boolean',
          required: false,
          input: false,
          returned: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: { before: guardSignUp },
      },
    },
    /**
     * Aucune donnée d'usage ne quitte l'installation. C'est déjà le défaut de
     * better-auth ; on l'écrit pour que ça reste vrai si le défaut change.
     */
    telemetry: { enabled: false },
    /**
     * `nextCookies` doit rester **en dernier** : son crochet d'après-coup
     * recopie les `Set-Cookie` de la réponse dans le magasin de cookies de
     * Next, ce qui permet à une Server Action d'ouvrir une session.
     */
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

/**
 * L'instance, ou `null` si l'authentification n'est pas configurée.
 *
 * Construite une seule fois puis mémorisée : `betterAuth()` démarre l'ouverture
 * de son contexte (lecture des options, montage des points d'entrée) dès
 * l'appel, et le refaire à chaque requête serait du gaspillage pur.
 *
 * **N'appeler qu'au moment d'une requête.** La fonction lit l'environnement, ce
 * qui échoue pendant `next build` où aucune variable n'existe (cf. `getEnv`).
 */
let cached: Auth | null | undefined;

export function getAuth(): Auth | null {
  if (cached === undefined) {
    const config = resolveAuthConfig();
    cached = config.status === 'ready' ? buildAuth(config.secret) : null;
  }
  return cached;
}

/**
 * Le diagnostic prêt à afficher, ou `null` si l'authentification fonctionne.
 *
 * C'est **la seule** forme sous laquelle le verdict d'activation sort de ce
 * module : `resolveAuthConfig()` porte le secret en clair, il n'a rien à faire
 * dans une page ni, pire, dans une prop de composant client.
 */
export function authUnavailableMessage(): string | null {
  const config = resolveAuthConfig();
  return config.status === 'ready' ? null : AUTH_DISABLED_MESSAGES[config.reason];
}

/** Oublie l'instance mémorisée — réservé aux tests (cf. `resetEnvCache`). */
export function resetAuthCache(): void {
  cached = undefined;
}
