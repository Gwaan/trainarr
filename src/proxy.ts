import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

import { isPublicPath } from '@/lib/auth/public-paths';

/**
 * Interception réseau (ex-`middleware.ts`, déprécié en v16). Runtime Node.js.
 *
 * Un seul usage : **la redirection optimiste** d'un visiteur sans session vers
 * l'écran de connexion. C'est le premier des deux étages du contrôle d'accès,
 * et le seul qui puisse répondre avant qu'une page ne soit rendue — c'est donc
 * lui qui fait qu'on « tombe forcément sur la connexion ».
 *
 * **Optimiste, et rien de plus.** Il regarde la *présence* du cookie de
 * session, jamais sa validité : aucune requête en base, aucune vérification de
 * signature. `.claude/rules/security.md` le dit — « `proxy.ts` peut faire du
 * routage optimiste mais n'est pas la couche d'auth ». Un cookie périmé,
 * falsifié ou copié d'une autre installation passe donc ici ; c'est le second
 * étage qui le refuse :
 *
 * - les pages du groupe `(app)` appellent `requireSession()` dans le composant
 *   suspendu qui porte déjà `connection()` — hors du `Suspense`, la coquille
 *   statique disparaîtrait et le Partial Prerender avec elle ;
 * - chaque Server Action et chaque route handler revérifie la session dans son
 *   propre corps. Une action exportée est un endpoint public appelable en POST
 *   direct : un contrôle posé ici ne la protégerait pas (Next le documente —
 *   une Server Function est un POST sur la route qui l'utilise, et un matcher
 *   qui exclut cette route l'exclut aussi).
 *
 * La liste des chemins qui doivent répondre sans session vit dans
 * `src/lib/auth/public-paths.ts`, pure et énumérée par son test : se tromper
 * là-dessus n'ouvre pas une porte de trop, ça les ferme toutes.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  /**
   * `getSessionCookie` de better-auth plutôt qu'une lecture de cookie à la
   * main : c'est lui qui connaît le nom réel du cookie (`better-auth.
   * session_token`) et sa variante `__Secure-` posée en HTTPS. Fonction pure —
   * elle ne lit que l'en-tête `Cookie`.
   */
  if (getSessionCookie(request) !== null) return NextResponse.next();

  return NextResponse.redirect(new URL('/login', request.nextUrl));
}

/**
 * Le matcher n'écarte que ce qui n'a **rien** à gagner à traverser le proxy :
 * les fabriqués du build, les fichiers, et les routes d'API — dont la session
 * se vérifie dans le handler, pas par une redirection HTML.
 *
 * Il ne décide de rien : `isPublicPath` réserve déjà le même sort à ces
 * chemins. Le matcher ne peut donc que réduire le nombre d'invocations, jamais
 * changer une réponse.
 */
export const config = {
  matcher: ['/((?!_next/|api/|.*\\.).*)'],
};
