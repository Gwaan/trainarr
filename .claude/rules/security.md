---
description: Sécurité — Data Access Layer, Server Actions, secrets
paths:
  - "src/**"
---

# Sécurité (modèle officiel Next.js : Data Access Layer)

## Data Access Layer (`src/data/`)

Tout accès aux données passe par un DAL dédié, conformément à la reco officielle Next.js pour les nouveaux projets :

- Chaque module du DAL commence par `import 'server-only'` → erreur de build si importé côté client.
- **Seul le DAL (et `src/config/`) lit `process.env`** et importe le client DB. Drizzle n'est jamais importé dans un composant ou une action directement.
- Le DAL retourne des **DTOs minimaux** : uniquement les champs dont l'UI a besoin, jamais un enregistrement brut (les identifiants internes, par exemple, ne franchissent pas la frontière).
- Helpers d'auth mémoïsés avec `cache()` de React (`getCurrentUser`) plutôt que passés de composant en composant.

## Contrôle d'accès — deux étages, et un seul fait autorité

Rien de `(app)` ne s'atteint sans session. Le dispositif tient en deux étages, et
il faut les deux :

1. **`src/proxy.ts` — redirection optimiste.** Sur la seule **présence** du
   cookie de session (`getSessionCookie` de better-auth), sans aucune requête en
   base. C'est ce qui fait qu'un visiteur non authentifié tombe sur `/login`
   avant qu'une page ne soit rendue. Ce n'est **pas** la couche d'auth : un
   cookie périmé ou inventé passe.
2. **La vérification qui fait autorité**, au plus près des données :
   - pages de `(app)` : `requireSession()` (`(app)/_lib/require-session.ts`)
     appelé **dans le composant suspendu** qui porte déjà `connection()`. Hors
     `Suspense`, la coquille statique disparaîtrait et toutes les pages
     passeraient de `◐` à `ƒ` ;
   - **chaque** Server Action et **chaque** route handler : dans son propre
     corps (cf. ci-dessous).

**La liste des chemins publics vit dans `src/lib/auth/public-paths.ts`**, pure et
énumérée par `src/proxy.test.ts` : `/login`, `/first-account`, `/invitation/…`,
**toutes** les routes `/api/…` (dont `/api/auth/…`, par où passent connexion,
session et déconnexion), `/_next/…` et les fichiers. Se tromper là n'ouvre pas
une porte de trop : ça les ferme toutes, et le déploiement est automatique au
push. Ne jamais y toucher sans lancer ce test.

`/api/` est public **au niveau du proxy seulement** : rediriger un appel d'API
vers un écran HTML ne protégerait rien et casserait le client. Chaque handler
répond 401 lui-même.

## Server Actions — chaque action est un endpoint public

Une Server Action exportée est appelable par POST direct, même sans UI — et Next
le documente : une Server Function est un POST sur la route qui l'utilise, qu'un
matcher de proxy peut exclure sans qu'on s'en aperçoive. Donc dans **chaque**
action :

1. **Vérifier la session en premier**, dans le corps de l'action
   (`getSession() === null` → `{ status: 'error', message: SESSION_REQUIRED_MESSAGE }`).
   Ni le proxy ni la page ne la protègent. Avant toute validation : le refus doit
   être le même pour une entrée valide et pour une entrée absurde.
2. Valider l'input avec Zod (`formData`, arguments — tout vient du client, rien n'est fiable).
3. Vérifier l'**autorisation sur la ressource** (anti-IDOR) : l'id demandé appartient-il bien à l'utilisateur ? En pratique le DAL le fait déjà — il ne lit et n'écrit que sous l'athlète de la session — mais un refus ne doit jamais dire si la ressource existe.
4. Déléguer au DAL (auth + DB y vivent), puis `updateTag()`/`revalidatePath()`.
5. **Filtrer la valeur de retour** : elle est sérialisée vers le client — retourner `{ success, fieldErrors? }`, jamais l'enregistrement DB complet.

Jamais de mutation en side-effect de rendu (pas de `cookies().delete()` dans un composant) : les mutations passent par des actions.

## Frontière client

- Ne jamais passer à un composant `'use client'` un objet plus large que nécessaire — typer les props au strict besoin de l'affichage.
- Seules les variables `NEXT_PUBLIC_*` atteignent le client ; aucune clé API, aucun token ne doit en faire partie.
- Le chat coach passe par un route handler serveur qui streame — le navigateur ne détient jamais de clé provider.
- Les segments dynamiques `[param]` sont de l'input utilisateur : valider avant usage (Zod), `notFound()` si invalide.

## `proxy.ts` et `route.ts`

Ce sont les surfaces les plus sensibles (pouvoir maximal) :

- `proxy.ts` peut faire du routage/redirect optimiste mais **n'est pas la couche d'auth** — la vérification de session se fait dans le DAL, au plus près des données (cf. « Contrôle d'accès » plus haut).
- **Chaque `route.ts` vérifie la session dans son propre corps**, en premier, et répond 401 dans le format que son client sait lire (`{ message }` pour le chat, `{ error }` pour la progression, `{ results }` pour l'import FIT). Seul `/api/auth/[...all]` en est dispensé : c'est lui qui l'ouvre.
- `POST /api/fit/upload` est la seule entrée externe en écriture : session, puis borne de taille sur `Content-Length` **avant** de bufferiser le multipart, puis borne par fichier — et jamais de trace d'exécution dans la réponse.
- Rate-limiter les endpoints coûteux (chat IA notamment).

## Secrets

- `.env.local` uniquement, gitignoré. `.env.example` documente les clés sans valeurs.
- Avant tout commit : vérifier qu'aucun token/PAT/clé n'apparaît dans le diff (`git diff --staged`).
