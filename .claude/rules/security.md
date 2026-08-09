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
- Le DAL retourne des **DTOs minimaux** : uniquement les champs dont l'UI a besoin, jamais un enregistrement brut (les tokens Strava, par exemple, ne sortent jamais du DAL).
- Helpers d'auth mémoïsés avec `cache()` de React (`getCurrentUser`) plutôt que passés de composant en composant.

## Server Actions — chaque action est un endpoint public

Une Server Action exportée est appelable par POST direct, même sans UI. Donc dans **chaque** action :

1. Valider l'input avec Zod (`formData`, arguments — tout vient du client, rien n'est fiable).
2. Re-vérifier l'authentification **dans l'action** (un check au niveau de la page ne protège pas l'action).
3. Vérifier l'**autorisation sur la ressource** (anti-IDOR) : l'id demandé appartient-il bien à l'utilisateur ? — même en mono-utilisateur, le pattern reste (l'appli est exposée sur le réseau).
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

- `proxy.ts` peut faire du routage/redirect optimiste mais **n'est pas la couche d'auth** — la vérification de session se fait dans le DAL, au plus près des données.
- Webhook Strava : vérifier le token de souscription à chaque requête ; callback OAuth : valider `state` (anti-CSRF).
- Rate-limiter les endpoints coûteux (chat IA notamment).

## Secrets

- `.env.local` uniquement, gitignoré. `.env.example` documente les clés sans valeurs.
- Avant tout commit : vérifier qu'aucun token/PAT/clé n'apparaît dans le diff (`git diff --staged`).
