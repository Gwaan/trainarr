/*
 * Service worker de Trainarr — il ne sert qu'aux notifications push.
 *
 * Aucun cache, aucune interception de requête : l'application est servie par
 * Next et n'a rien à faire hors ligne pour l'instant. Un service worker est en
 * revanche **obligatoire** pour recevoir un push — c'est lui, et lui seul, que
 * le navigateur réveille quand un message arrive, application fermée comprise.
 *
 * Fichier JavaScript brut, servi tel quel depuis `public/` : il n'entre dans
 * aucun build, n'est pas transpilé, et n'a donc ni import ni syntaxe exotique.
 * Il est public au sens du proxy (`looksLikeFile`, cf.
 * `src/lib/auth/public-paths.ts`) — c'est nécessaire : le navigateur le
 * télécharge sans cookie applicatif.
 *
 * Portée : posé à la racine de `public/`, il est servi depuis `/sw.js` et
 * contrôle donc toute l'origine, comme le `scope: "/"` du manifeste.
 */

/**
 * Contenu affiché quand le message reçu est illisible.
 *
 * **Il faut toujours afficher quelque chose.** Un abonnement `userVisibleOnly`
 * engage l'application à montrer une notification à chaque push ; les
 * navigateurs qui constatent l'inverse affichent un « ce site fonctionne en
 * arrière-plan » puis finissent par révoquer la permission. Une bannière
 * générique vaut mieux que ce silence-là.
 */
const REPLI = {
  title: 'Trainarr',
  body: 'Tu as une nouvelle information dans Trainarr.',
  url: '/',
  tag: 'trainarr',
};

/** L'icône de l'application, réutilisée en badge (Android en fait une silhouette). */
const ICONE = '/icons/icon-192.png';

/**
 * Lit le payload envoyé par le serveur (cf. `PushPayload` dans
 * `src/lib/push/send.ts`). Ne lève jamais : tout ce qui manque est remplacé par
 * la valeur de repli.
 */
function lirePayload(event) {
  if (!event.data) return REPLI;

  let brut;
  try {
    brut = event.data.json();
  } catch (erreur) {
    // Payload non-JSON : on garde le texte comme corps s'il y en a un.
    let texte = '';
    try {
      texte = event.data.text();
    } catch (_) {
      texte = '';
    }
    return { ...REPLI, body: texte === '' ? REPLI.body : texte };
  }

  if (typeof brut !== 'object' || brut === null) return REPLI;

  return {
    title: typeof brut.title === 'string' && brut.title !== '' ? brut.title : REPLI.title,
    body: typeof brut.body === 'string' && brut.body !== '' ? brut.body : REPLI.body,
    url: cheminInterne(brut.url),
    tag: typeof brut.tag === 'string' && brut.tag !== '' ? brut.tag : REPLI.tag,
  };
}

/**
 * Ramène une cible de clic à un chemin **de notre origine**, ou à l'accueil.
 *
 * Une simple vérification « commence par une barre » ne suffirait pas :
 * `//exemple.com/x` commence par une barre et se résout pourtant vers une
 * origine tierce (le parseur d'URL traite aussi `\` comme une barre). Seule la
 * comparaison d'origine **après résolution** tranche.
 *
 * Le serveur n'envoie jamais qu'un chemin interne ; ceci est la défense en
 * profondeur qui rend cette promesse vraie même si elle cessait de l'être.
 */
function cheminInterne(valeur) {
  if (typeof valeur !== 'string' || valeur === '') return REPLI.url;

  try {
    const url = new URL(valeur, self.location.origin);
    if (url.origin !== self.location.origin) return REPLI.url;
    return url.pathname + url.search + url.hash;
  } catch {
    return REPLI.url;
  }
}

/**
 * Un message est arrivé : afficher la bannière.
 *
 * `waitUntil` maintient le service worker en vie le temps de l'affichage —
 * sans lui, le navigateur peut le terminer avant que la promesse n'aboutisse.
 */
self.addEventListener('push', (event) => {
  const payload = lirePayload(event);

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Même `tag` = la nouvelle bannière remplace la précédente au lieu de
      // s'empiler (sept « ta séance du jour » après une semaine d'absence).
      tag: payload.tag,
      // Ce que `notificationclick` relira pour savoir où aller.
      data: { url: payload.url },
      icon: ICONE,
      badge: ICONE,
    }),
  );
});

/**
 * Clic sur la bannière : refermer, puis rejoindre l'écran concerné.
 *
 * On **réutilise** un onglet déjà ouvert sur l'origine plutôt que d'en ouvrir
 * un second : sur iPhone, l'application installée n'a qu'une fenêtre, et en
 * ouvrir une autre ferait perdre l'état de navigation en cours.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const cible = (event.notification.data && event.notification.data.url) || '/';
  // Repassée par le même filtre qu'à la réception : `data` a pu être posée par
  // une version antérieure du worker, plus permissive.
  const url = new URL(cheminInterne(cible), self.location.origin);

  event.waitUntil(
    self.clients
      // `includeUncontrolled` : au tout premier lancement, les fenêtres ouvertes
      // avant l'installation ne sont pas encore contrôlées par ce worker et
      // seraient invisibles sans ce drapeau.
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (new URL(client.url).origin !== url.origin) continue;

          // Naviguer puis focaliser : la fenêtre existante montre la bonne page.
          // `navigate` n'existe pas partout — on se rabat sur le seul focus.
          if (typeof client.navigate === 'function') {
            return (
              client
                .navigate(url.href)
                .then((navigue) => (navigue || client).focus())
                // `navigate` rejette sur une fenêtre que ce worker ne contrôle
                // pas encore — `includeUncontrolled` nous en a justement rendu.
                // La focaliser sans l'avoir déplacée vaut infiniment mieux qu'un
                // clic qui ne fait rien.
                .catch(() => client.focus())
            );
          }
          return client.focus();
        }

        return self.clients.openWindow(url.href);
      }),
  );
});

/**
 * `skipWaiting` : une version fraîchement déposée prend la main sans attendre
 * la fermeture de tous les onglets. Sans lui, une correction du worker
 * n'atteindrait l'appareil qu'après une fermeture complète de l'application —
 * ce qui, sur une PWA iOS, peut ne jamais arriver.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

/**
 * `clients.claim` : le worker prend le contrôle des fenêtres déjà ouvertes dès
 * son activation, plutôt qu'au prochain chargement.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
