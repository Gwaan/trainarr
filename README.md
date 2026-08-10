# Trainarr

Application de running self-hosted : plans d'entraînement, analytics et coach IA — une alternative libre à Runna et Runalyze.

## Stack

- **Next.js 16** (App Router, Turbopack) · TypeScript strict · React 19
- **PostgreSQL 17 + pgvector** via Drizzle ORM
- **Coach IA multi-provider** : toute API compatible OpenAI (llama.cpp local, Claude, …)
- **Fichiers FIT** comme unique source de données (voir ci-dessous)
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

## Import des séances

Les données d'entraînement arrivent par un seul canal : le **fichier FIT** de la
montre. Pas d'API tierce, donc rien à connecter, aucun quota.

```
Montre → HealthFit (iPhone)
           │  export automatique après chaque séance
           ▼
   https://<domaine>/dav        ← point WebDAV servi par l'appli
           │  (Basic auth : WEBDAV_USERNAME / WEBDAV_PASSWORD)
           ▼
   FIT_INBOX_DIR                ← volume partagé trainarr-fit-inbox
           │  scan périodique
           ▼
   fit-watcher                  → ingestion, puis processed/ ou failed/
```

- **HealthFit** est configuré une fois pour envoyer chaque séance en WebDAV vers
  `https://<domaine>/dav`. Tant que `WEBDAV_USERNAME` et `WEBDAV_PASSWORD` ne
  sont pas renseignés, le dépôt répond 503 (jamais ouvert sans authentification).
- Le **watcher** (`pnpm fit:watch`, ou le service `trainarr-fit-watcher` en
  Docker) n'ingère un fichier que si sa taille est stable sur deux scans, puis le
  range dans `processed/` ou dans `failed/` avec un `.err.txt` expliquant le rejet.
- L'**import manuel** reste possible depuis la page « Activités » (bouton ou
  glisser-déposer de `.fit`).
- L'idempotence repose sur l'empreinte SHA-256 du fichier : redéposer le même
  fichier ne crée jamais de doublon.

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
├── lib/        ai/ · fit/ · metrics/
└── config/     variables d'environnement validées par Zod
```

Les conventions détaillées vivent dans `CLAUDE.md` et `.claude/rules/`.
