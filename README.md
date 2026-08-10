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

Les données d'entraînement arrivent sous un seul format : le **fichier FIT** de
la montre. Deux routes y mènent, et toutes deux aboutissent à la même boîte de
dépôt.

```
Montre → HealthFit (iPhone)
           │                              │
           │  export WebDAV               │  synchronisation intervals.icu
           ▼                              ▼
   https://<domaine>/dav            intervals.icu
   ← point servi par l'appli              │  API : le poller récupère
     (Basic auth WEBDAV_*)                │  le fichier original
           │                              ▼
           └──────────────►  FIT_INBOX_DIR  ← volume trainarr-fit-inbox
                                   │  scan périodique
                                   ▼
                        service d'import  → ingestion, puis processed/ ou failed/
```

Tout cela tourne dans **un seul container applicatif** : le dépôt WebDAV, le
poller et le watcher vivent dans le process du serveur Next, démarrés au boot par
`src/instrumentation.ts`. Leurs journaux sont donc ceux de l'appli
(`docker logs trainarr`), préfixés `[fit]` et `[fit/intervals]`.

- **HealthFit** est configuré une fois pour envoyer chaque séance en WebDAV vers
  `https://<domaine>/dav`. Tant que `WEBDAV_USERNAME` et `WEBDAV_PASSWORD` ne
  sont pas renseignés, le dépôt répond 503 (jamais ouvert sans authentification).
- Le **watcher** n'ingère un fichier que si sa taille est stable sur deux scans
  (`FIT_WATCH_INTERVAL_S`, 30 s par défaut), puis le range dans `processed/` ou
  dans `failed/` avec un `.err.txt` expliquant le rejet.
- **Rien de tout cela ne peut faire tomber le serveur** : une inbox inaccessible,
  une clé refusée ou une exception imprévue désactivent ou relancent la boucle
  concernée en le journalisant — l'application continue de servir.
- L'**import manuel** reste possible depuis la page « Activités » (bouton ou
  glisser-déposer de `.fit`).
- L'idempotence repose sur l'empreinte SHA-256 du fichier : redéposer le même
  fichier ne crée jamais de doublon.

### Rapatriement depuis intervals.icu (optionnel)

Si HealthFit synchronise déjà les séances vers [intervals.icu](https://intervals.icu),
Trainarr peut y récupérer les fichiers d'activité **originaux** et les déposer
lui-même dans la boîte d'import. C'est un filet : une séance que l'envoi WebDAV a
manquée arrive quand même.

Configuration, une fois :

1. Créer un compte sur intervals.icu et y connecter HealthFit (réglage
   « intervals.icu » dans l'app iPhone, qui envoie chaque séance après l'export).
2. Dans intervals.icu, **Settings → Developer Settings**, générer une clé API.
   C'est un secret : elle ne va que dans `.env.local` (dev) ou `.env` (Docker),
   jamais dans le repo.
3. Renseigner `INTERVALS_API_KEY`, puis redémarrer l'application. **C'est tout** :
   l'identifiant d'athlète est facultatif.

| Variable | Rôle | Défaut |
|---|---|---|
| `INTERVALS_API_KEY` | Clé API personnelle — **seule variable requise** | — |
| `INTERVALS_ATHLETE_ID` | Identifiant d'athlète, si l'on veut en viser un autre que soi | le propriétaire de la clé |
| `INTERVALS_POLL_INTERVAL_S` | Intervalle entre deux cycles, en secondes | `60` |
| `INTERVALS_LOOKBACK_DAYS` | Profondeur de la fenêtre glissante, en jours | `30` |

Sans `INTERVALS_ATHLETE_ID`, l'API est interrogée sur l'athlète `0`, que
intervals.icu résout en « celui à qui appartient la clé ». Si la variable est
renseignée, les deux graphies sont acceptées (`i123456` comme `123456`) ; une
valeur illisible désactive **le poller seul**, en disant laquelle et pourquoi.

Tant que `INTERVALS_API_KEY` n'est pas renseignée, le rapatriement reste inactif —
l'appli le signale au démarrage et le reste de l'import fonctionne normalement.

Au démarrage, une ligne dit dans quel état on est :

```
[fit] service FIT démarré — inbox: /data/fit-inbox (scan toutes les 30 s), poll intervals.icu: actif (60 s, athlète 0, par tranches de 50)
[fit] service FIT démarré — inbox: /data/fit-inbox (scan toutes les 30 s), poll intervals.icu: inactif (INTERVALS_API_KEY manquante)
```

Le premier cycle du poller annonce toujours son résultat (`premier cycle
(historique complet) : 237 activités listées, 50 à rapatrier, 50 déposées.`) ;
ensuite, seuls les cycles qui trouvent du travail ou échouent parlent.

Une activité déjà rapatriée n'est jamais retéléchargée : le fichier déposé
s'appelle `intervals-<id>.fit`, et sa présence dans la boîte, dans `processed/`
ou dans `failed/` suffit à le savoir. Une séance saisie à la main sur
intervals.icu n'a pas de fichier : c'est noté une fois, puis on passe.

**Le premier démarrage rapatrie tout l'historique.** Tant qu'aucune séance n'a
été récupérée, le poller demande l'intégralité des activités du compte plutôt que
les 30 derniers jours, et les télécharge par tranches de 50 par cycle — plusieurs
centaines de séances s'étalent donc sur quelques minutes, tranche par tranche,
sans marteler l'API (les journaux annoncent `backfill : 50 rapatriés, reste ~N`).
Une fois l'historique en place, chaque cycle se limite à la fenêtre glissante de
`INTERVALS_LOOKBACK_DAYS` jours : **une nouvelle séance apparaît dans Trainarr
environ une minute après sa synchronisation sur intervals.icu.**

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
Un troisième container, `trainarr-migrate`, applique les migrations puis sort —
**il n'y a pas d'autre container applicatif** : l'import FIT tourne dans
`trainarr`, et `docker logs trainarr` montre tout.

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
