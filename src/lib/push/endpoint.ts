/**
 * D'où une endpoint d'abonnement a le droit de venir.
 *
 * ## Le problème que ce module ferme
 *
 * L'endpoint est fournie **par le client** : l'écran la lit dans l'objet
 * `PushSubscription` du navigateur et la transmet à la Server Action, qui
 * l'enregistre. Le serveur POSTera ensuite dessus à chaque notification. Sans
 * borne, un compte authentifié peut donc faire émettre au serveur une requête
 * vers **n'importe quelle URL https** — y compris une adresse interne au réseau
 * du container, injoignable depuis l'extérieur (une console d'administration,
 * une base, un autre service Docker). C'est une SSRF aveugle : la réponse ne
 * revient nulle part, mais l'effet de bord, lui, a lieu.
 *
 * Une simple vérification « c'est bien une URL https » n'y change rien : elle
 * est déjà satisfaite par `https://postgres:5432/…`.
 *
 * ## Une allowlist, et le compromis qu'elle impose
 *
 * Les services de push sont **quatre**, connus, et leurs domaines sont stables
 * depuis des années. Une liste blanche est donc la borne la plus honnête : tout
 * ce qui n'est pas un service de push est refusé, y compris ce qu'on n'a pas
 * imaginé.
 *
 * **Le prix est assumé et il faut l'écrire** : le jour où un navigateur
 * légitime change de domaine de push (ou en ajoute un — Chrome l'a déjà fait en
 * passant de `android.googleapis.com/gcm` à `fcm.googleapis.com`), l'abonnement
 * cessera de s'enregistrer sur cette installation, avec un message qui parle
 * d'un « service inconnu » pour un navigateur parfaitement à jour. Le remède
 * tient en une ligne à ajouter ici, mais il faut savoir où regarder — d'où ce
 * paragraphe. Le compromis est accepté parce qu'une installation personnelle
 * dont les notifications tombent en panne est un désagrément, là où un serveur
 * qui poste où on lui dit est un vecteur.
 *
 * Module **pur** : ni base, ni réseau, ni environnement.
 */

/**
 * Un hôte de service de push admis.
 *
 * `subdomains` distingue deux cas qui n'ont pas la même surface : Apple, Mozilla
 * et Microsoft répartissent leurs endpoints sur des sous-domaines
 * (`web.push.apple.com`, `updates.push.services.mozilla.com`, un par région chez
 * Microsoft) — il faut donc les accepter tous. Google, lui, sert tout depuis un
 * hôte unique : l'ouvrir aux sous-domaines élargirait la cible sans aucune
 * contrepartie.
 */
type PushHost = { readonly host: string; readonly subdomains: boolean };

/**
 * Les services de push des navigateurs qui savent recevoir une notification.
 *
 * - `push.apple.com` — Safari, iOS et macOS (`web.push.apple.com`) ;
 * - `fcm.googleapis.com` — Chrome et tous les navigateurs Chromium, desktop et
 *   Android ;
 * - `push.services.mozilla.com` — Firefox ;
 * - `notify.windows.com` — WNS, le service de push de Windows, qu'Edge utilise
 *   pour les applications installées.
 */
const ALLOWED_HOSTS: readonly PushHost[] = [
  { host: 'push.apple.com', subdomains: true },
  { host: 'fcm.googleapis.com', subdomains: false },
  { host: 'push.services.mozilla.com', subdomains: true },
  { host: 'notify.windows.com', subdomains: true },
];

/**
 * Ce que l'écran affiche quand l'endpoint ne vient d'aucun service connu.
 *
 * Il dit ce qui a été refusé **sans citer l'adresse** : la phrase part vers le
 * navigateur, et recopier une URL interne dans une bannière rendrait au client
 * exactement ce que le refus vient de lui cacher.
 */
export const UNKNOWN_PUSH_HOST_MESSAGE =
  'Cet abonnement ne vient pas d’un service de notifications connu : il n’a pas été enregistré.';

/** `true` si `host` est `expected` ou l'un de ses sous-domaines. */
function matches(host: string, allowed: PushHost): boolean {
  if (host === allowed.host) return true;
  return allowed.subdomains && host.endsWith(`.${allowed.host}`);
}

/**
 * L'endpoint désigne-t-elle un service de push connu ?
 *
 * Trois conditions, et aucune n'est superflue :
 *
 * 1. **une URL analysable** — ce qui vient du client peut être n'importe quoi ;
 * 2. **https, et rien d'autre** — le protocole Web Push n'existe qu'en TLS, et
 *    `http://` ouvrirait les adresses en clair du réseau interne ;
 * 3. **un port implicite (443)** — aucun service de push n'écoute ailleurs, et
 *    le port est justement ce qui distingue les services internes d'une machine
 *    dont on maîtriserait le nom.
 */
export function isKnownPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  // `URL.port` est vide quand le port est celui du protocole ; « 443 » écrit
  // explicitement désigne le même service et reste donc admis.
  if (url.port !== '' && url.port !== '443') return false;

  // `hostname` est déjà en minuscules et sans identifiants ; c'est bien lui,
  // et jamais `host` (qui porterait le port), qu'on compare.
  return ALLOWED_HOSTS.some((allowed) => matches(url.hostname, allowed));
}
