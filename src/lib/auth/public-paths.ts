/**
 * Ce qui reste atteignable **sans session** — la liste dont dépend l'accès à
 * l'application.
 *
 * Module volontairement pur et sans dépendance : il est lu par `src/proxy.ts`,
 * qui s'exécute avant le routage, et énuméré chemin par chemin par son test.
 * C'est le seul endroit où la question « qui peut entrer sans être connecté ? »
 * se pose, et se relit.
 *
 * **Pourquoi une fonction plutôt qu'une expression régulière de `matcher`** :
 * un matcher ne se teste pas depuis Vitest et se lit mal, or une erreur ici
 * n'ouvre pas une porte de trop — elle ferme la dernière : plus d'écran de
 * connexion, plus d'API d'authentification, et personne ne rentre jamais. Le
 * matcher du proxy ne fait donc qu'**éviter des invocations inutiles** (assets
 * statiques) ; il ne décide de rien. Restreindre le matcher ne peut que laisser
 * passer davantage de requêtes sans contrôle optimiste, jamais en bloquer une
 * que cette fonction déclare publique.
 */

/**
 * Les deux écrans d'identité, à la lettre près.
 *
 * `/login` est la destination de la redirection : s'il devenait privé, la
 * redirection boucherait sur elle-même. `/first-account` ouvre la toute
 * première installation, où aucune session ne peut exister par construction.
 */
const PUBLIC_EXACT: ReadonlySet<string> = new Set(['/login', '/first-account']);

/**
 * Les familles de chemins publiques.
 *
 * - `/invitation/` : un compte invité se crée précisément sans session ;
 * - `/api/` : le proxy **n'est pas la couche d'auth** (cf.
 *   `.claude/rules/security.md`). Rediriger un appel d'API vers un écran HTML
 *   ne protégerait rien et casserait le client ; chaque route handler vérifie
 *   donc la session dans son propre corps et répond 401. `/api/auth/…`, lui,
 *   doit rester ouvert de toute façon : c'est par là que passent la connexion,
 *   la lecture de session et la déconnexion ;
 * - `/_next/` : les fabriqués du build (JS, CSS, polices, images optimisées).
 */
const PUBLIC_PREFIXES: readonly string[] = ['/invitation/', '/api/', '/_next/'];

/** `/plan/` et `/plan` désignent la même page : une seule forme est comparée. */
function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * `true` pour un chemin de **fichier**, reconnu à l'extension de son dernier
 * segment : `/icon.svg`, `/apple-icon.png`, `/manifest.webmanifest`,
 * `/favicon.ico`, et tout ce que sert `public/` (les tuiles et le worker
 * MapLibre). Aucune page de l'application n'a de point dans son URL — les
 * segments dynamiques sont un identifiant numérique ou un jeton — la règle ne
 * peut donc pas ouvrir une page par accident.
 */
function looksLikeFile(path: string): boolean {
  return path.slice(path.lastIndexOf('/') + 1).includes('.');
}

/** `true` si ce chemin doit répondre à un visiteur sans session. */
export function isPublicPath(pathname: string): boolean {
  const path = withoutTrailingSlash(pathname);

  if (PUBLIC_EXACT.has(path)) return true;
  if (PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;

  return looksLikeFile(path);
}
