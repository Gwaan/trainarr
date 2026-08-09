# Trainarr

Application de running self-hosted : plans d'entraînement, analytics et coach IA — une alternative libre à Runna et Runalyze.

## Stack

- **Next.js 16** (App Router, Turbopack) · TypeScript strict · React 19
- **PostgreSQL 17 + pgvector** via Drizzle ORM
- **Coach IA multi-provider** : toute API compatible OpenAI (llama.cpp local, Claude, …)
- **Strava** (OAuth + webhooks) comme source de données
- Déploiement Docker Compose

## Démarrer en local

Prérequis : Node.js ≥ 20.9, pnpm, une base PostgreSQL avec l'extension pgvector.

```bash
pnpm install
cp .env.example .env.local   # puis renseigner DATABASE_URL
pnpm exec drizzle-kit migrate
pnpm dev
```

L'application est disponible sur http://localhost:3000.

## Commandes

| Commande | Effet |
|---|---|
| `pnpm dev` | Serveur de développement (Turbopack) |
| `pnpm build` | Build de production |
| `pnpm start` | Sert le build de production |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest |
| `pnpm db:generate` | Génère une migration après modification du schéma |
| `pnpm db:migrate` | Applique les migrations |

> **pnpm uniquement.** Utiliser `pnpm exec` / `pnpm dlx` plutôt que npx.

## Déploiement

```bash
docker network create app-staging   # une seule fois, si le réseau n'existe pas
cp .env.example .env                # renseigner les valeurs de production
docker compose up -d --build
```

Le container applicatif s'appelle `trainarr` et écoute sur le port 3000 ; la base
tourne dans `trainarr-db`. Les deux rejoignent le réseau partagé `app-staging`.

La livraison est automatisée par un webhook GitHub vers Komodo, déclenché à chaque
push sur la branche configurée.

## Structure

```
src/
├── app/        routes (App Router) — code colocalisé dans _components/ et _lib/
├── components/ composants UI partagés
├── data/       Data Access Layer (server-only) : seul accès à la base
├── lib/        ai/ · strava/ · metrics/
└── config/     variables d'environnement validées par Zod
```

Les conventions détaillées vivent dans `CLAUDE.md` et `.claude/rules/`.
