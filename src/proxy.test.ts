import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { isPublicPath } from '@/lib/auth/public-paths';

import { config, proxy } from './proxy';

/**
 * Le filet de sécurité du chantier « fermer les accès ».
 *
 * Une erreur ici n'ouvre pas une porte de trop : elle les ferme toutes. Sans
 * `/login`, sans `/api/auth/…`, sans les fichiers de la page, personne ne se
 * reconnecte jamais — et le déploiement étant automatique au push, l'erreur est
 * en production avant d'être vue. D'où une **énumération** explicite plutôt
 * qu'un échantillon : chaque chemin qui doit répondre sans session est écrit,
 * et éprouvé deux fois — sur la règle (`isPublicPath`) et sur la réponse du
 * proxy.
 */

const ORIGIN = 'https://trainarr.test';

/** Le cookie de session tel que better-auth le pose, en clair puis en HTTPS. */
const SESSION_COOKIES = [
  'better-auth.session_token=Xk4.signature',
  '__Secure-better-auth.session_token=Xk4.signature',
] as const;

function visit(path: string, cookie?: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    headers: cookie === undefined ? undefined : { cookie },
  });
}

/** Le proxy a-t-il renvoyé ailleurs ? `null` = la requête poursuit sa route. */
function redirectionOf(path: string, cookie?: string): string | null {
  return proxy(visit(path, cookie)).headers.get('location');
}

/**
 * Tout ce qui doit répondre **sans session**, à la lettre.
 *
 * Les trois premiers groupes sont l'unique chemin de retour dans l'application ;
 * le dernier est ce sans quoi l'écran de connexion s'afficherait nu.
 */
const PUBLIC_PATHS: readonly string[] = [
  // Les écrans d'identité.
  '/login',
  '/first-account',
  '/invitation/aF7yq2mN8pR4tV6xZ1cB3dG5hJ9kL0sW',
  '/invitation/aF7yq2mN8pR4tV6xZ1cB3dG5hJ9kL0sW/',

  // **Toutes** les routes de better-auth : connexion, inscription, lecture de
  // session, déconnexion. Les fermer, c'est fermer la porte à clé de
  // l'extérieur.
  '/api/auth/get-session',
  '/api/auth/sign-in/email',
  '/api/auth/sign-up/email',
  '/api/auth/sign-out',
  '/api/auth/update-user',

  // Le reste de l'API : le proxy n'est pas sa couche d'auth (une redirection
  // HTML ne protégerait rien et casserait le client). Chaque handler vérifie la
  // session dans son propre corps et répond 401 — cf. leurs tests respectifs.
  '/api/fit/upload',
  '/api/coach/chat',
  '/api/plan-progress',

  // Ressources statiques, manifeste PWA, icônes.
  '/_next/static/chunks/main-app.js',
  '/_next/static/css/app.css',
  '/_next/static/media/archivo.woff2',
  '/_next/image',
  '/manifest.webmanifest',
  '/icon.svg',
  '/apple-icon.png',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/maplibre/maplibre-gl-csp-worker.js',
];

/** Les pages du groupe `(app)`, celles qui ne doivent rien montrer sans session. */
const PRIVATE_PATHS: readonly string[] = [
  '/',
  '/plan',
  '/coach',
  '/activities',
  '/activities/42',
  '/progression',
  '/profile',
  // Formes suffixées : Next les normalise en amont, mais la règle ne doit pas
  // en dépendre.
  '/plan/',
  '/profile/',
  // Une route qui n'existe pas n'est pas une raison de laisser entrer.
  '/inconnu',
];

describe('chemins publics — sans eux, plus personne ne rentre', () => {
  it.each(PUBLIC_PATHS)('%s répond sans session', (path) => {
    expect(isPublicPath(path)).toBe(true);
    expect(redirectionOf(path)).toBeNull();
  });

  it('renvoie vers /login, qui doit donc rester public — sans quoi la redirection boucle', () => {
    expect(PUBLIC_PATHS).toContain('/login');
    expect(redirectionOf('/plan')).toBe(`${ORIGIN}/login`);
  });
});

describe('pages privées — la redirection optimiste', () => {
  it.each(PRIVATE_PATHS)('%s mène à /login sans cookie de session', (path) => {
    expect(isPublicPath(path)).toBe(false);
    expect(redirectionOf(path)).toBe(`${ORIGIN}/login`);
  });

  it('répond 307 : une redirection de navigation, qui ne change pas la méthode', () => {
    expect(proxy(visit('/plan')).status).toBe(307);
  });

  it.each(SESSION_COOKIES)('laisse passer dès que le cookie « %s » est là', (cookie) => {
    for (const path of PRIVATE_PATHS) {
      expect(redirectionOf(path, cookie)).toBeNull();
    }
  });

  it('ne juge que la présence du cookie, jamais sa validité', () => {
    // C'est tout l'objet du second étage : `requireSession()` dans les pages,
    // et la vérification dans chaque action et chaque route handler. Un jeton
    // inventé passe donc ici — et seulement ici.
    expect(redirectionOf('/plan', 'better-auth.session_token=n-importe-quoi')).toBeNull();
  });

  it('ignore un cookie qui n’est pas celui de la session', () => {
    expect(redirectionOf('/plan', 'theme=dark; autre=1')).toBe(`${ORIGIN}/login`);
  });
});

describe('matcher', () => {
  it('n’écarte aucune page privée', () => {
    // Le matcher n'est qu'une économie d'invocations : `isPublicPath` décide.
    // Mais s'il écartait une page, la redirection optimiste ne s'exécuterait
    // jamais dessus — et l'écran s'afficherait avant que le second étage ne
    // renvoie. On vérifie donc son motif contre les mêmes chemins.
    const [source] = config.matcher;
    expect(source).toBeDefined();
    const pattern = new RegExp(`^${source}$`);

    for (const path of PRIVATE_PATHS) {
      expect(pattern.test(path)).toBe(true);
    }
  });
});
