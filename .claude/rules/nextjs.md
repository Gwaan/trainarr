---
description: Conventions Next.js 16 App Router (rendering, caching, routing)
paths:
  - "src/app/**"
  - "src/components/**"
  - "next.config.ts"
  - "src/proxy.ts"
---

# Next.js 16 — App Router

## Spécificités v16 (ne pas utiliser les patterns < 16)

- **APIs de requête asynchrones** : `params`, `searchParams`, `cookies()`, `headers()`, `draftMode()` doivent être `await`és. L'accès synchrone est supprimé en v16.
  ```tsx
  export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
  ```
- **`proxy.ts`, pas `middleware.ts`** : l'interception réseau se fait dans `src/proxy.ts` (fonction exportée `proxy`, runtime Node.js). `middleware.ts` est déprécié. Un seul usage ici : la redirection optimiste vers `/login` (cf. `.claude/rules/security.md`) — jamais la couche d'auth.
- **`next lint` n'existe plus** : ESLint s'exécute directement (flat config), et `next build` ne linte plus.
- **Turbopack est le bundler par défaut** : aucune config webpack. React Compiler activable via `reactCompiler: true` (mémoïsation auto — ne pas saupoudrer de `useMemo`/`useCallback` manuels).
- **Parallel routes** : chaque slot exige un `default.tsx` explicite, sinon le build échoue.
- `serverRuntimeConfig`/`publicRuntimeConfig` supprimés : variables d'env uniquement.

## Caching — modèle Cache Components (v16)

Le cache est **entièrement opt-in** : tout code dynamique s'exécute à la requête par défaut. Activer `cacheComponents: true` dans `next.config.ts` et raisonner ainsi :

- **`"use cache"`** sur une page, un composant ou une fonction pour cacher son rendu ; associer `cacheTag()` + `cacheLife()` pour piloter l'invalidation.
- **Invalidation — choisir la bonne API** :
  - `updateTag(tag)` (Server Actions uniquement) : sémantique *read-your-writes* — l'utilisateur voit sa modif immédiatement. **Choix par défaut pour nos mutations** (activités, plans, réglages).
  - `revalidateTag(tag, profile)` : SWR (contenu servi périmé pendant revalidation en fond). La v16 **exige le 2e argument** (`'max'` recommandé) — la forme à un argument est dépréciée.
  - `refresh()` (Server Actions) : rafraîchit uniquement les données non cachées (compteurs, indicateurs live) sans toucher au cache.
- Ne jamais compter sur un cache implicite de `fetch` : c'est le modèle pré-16.

## Accès au DAL depuis une page — règle vérifiée empiriquement

`cacheComponents: true` fait prérendre les pages au build. Une page qui appelle le DAL sans signal dynamique est donc **exécutée pendant `next build`**, où aucune base ni variable d'environnement n'existe (image Docker) → le build échoue.

Toute page consommant `src/data/` doit rendre son accès aux données explicitement dynamique :

```tsx
import { Suspense } from 'react'
import { connection } from 'next/server'

async function Stats() {
  await connection()            // ← indispensable : sans lui, Next prérend et interroge la base au build
  const data = await listRecentActivities(5)
  return <StatsView data={data} />
}

export default function Page() {
  return <Suspense fallback={<StatsSkeleton />}><Stats /></Suspense>
}
```

Le `Suspense` seul **ne suffit pas** (testé) : c'est `connection()` qui bascule la route en Partial Prerender (`◐` au build) — shell statique instantané, données streamées à la requête. Vérifier avec `env -u DATABASE_URL pnpm build`.

## Server / Client Components

- **Server Component par défaut.** `'use client'` uniquement pour : event handlers, hooks, APIs navigateur, état local. Pousser la directive vers les feuilles de l'arbre, jamais sur une page entière.
- Le fetching se fait dans les Server Components (async/await via le DAL) — pas de `useEffect`+fetch pour des données serveur. Paralléliser les requêtes indépendantes (`Promise.all`).
- **Streaming** : `loading.tsx` par route + `<Suspense>` autour des blocs lents (graphes, stats), pour un shell instantané.
- `error.tsx` par segment significatif ; les erreurs attendues (validation) sont des valeurs de retour, pas des throws.

## Structure des routes

- `src/app/` contient **uniquement** du routing : `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `default.tsx`, `route.ts`.
- Code propre à une route : colocalisé dans `_components/` et `_lib/` (underscore = hors routing). Route groups `(nom)` pour les frontières de layout sans impacter l'URL.
- Route handlers (`route.ts`) réservés aux entrées externes : upload multipart des fichiers FIT, streaming SSE du chat coach, points d'entrée de better-auth. Le reste passe par Server Actions.

## Formulaires & navigation

- Formulaires : `<form action={serverAction}>` + `useActionState` pour l'état (pending, erreurs de validation) — pas de gestion manuelle en `onSubmit`+fetch.
- `next/link` pour la navigation interne, `next/image` pour les images (en v16 : `images.qualities` par défaut `[75]`, `remotePatterns` obligatoire pour les images distantes, TTL par défaut 4 h).
