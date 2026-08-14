@AGENTS.md

# Trainarr

Appli de running self-hosted qui remplace Runna (plans d'entraînement) et Runalyze (analytics), avec un coach IA. Utilisateur unique (Gwen), pas de multi-tenant. Langue de l'UI : français.

## Stack

- **Next.js 16 (App Router, Turbopack)** + TypeScript strict + React 19 — full-stack, pas de backend séparé. Node.js ≥ 20.9.
- **PostgreSQL + pgvector** (Drizzle ORM) — activités, plans, séries temporelles, embeddings RAG
- **Coach IA multi-provider** : abstraction unique compatible OpenAI — llama.cpp local (`llama-server`), Claude API, ou toute API compatible. Jamais de couplage direct à un provider dans le code métier.
- **Import FIT** comme format de données unique. Canal automatique : HealthFit (iPhone) synchronise vers intervals.icu, dont un poller rapatrie les FIT originaux dans l'inbox du watcher — **un dossier par athlète** (`athlete-<id>/`), le chemin porte le propriétaire du fichier, et les identifiants intervals.icu appartiennent au compte (chiffrés en base), pas à l'environnement. En secours : import manuel depuis la page « Activités » (`POST /api/fit/upload`, qui exige une session). **Il n'y a plus de dépôt WebDAV** — retiré, cf. `.claude/rules/data-import.md`.
- Déploiement : Docker Compose (container `trainarr` sur le port 3000 + Postgres/pgvector), livraison auto via webhook Komodo sur push.

## Commandes (pnpm)

```bash
pnpm dev              # dev server (Turbopack)
pnpm build            # build de prod
pnpm lint             # eslint directement (`next lint` n'existe plus en v16)
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest
pnpm exec drizzle-kit generate   # génère une migration après modif du schéma
pnpm exec drizzle-kit migrate    # applique les migrations
```

- **Toujours pnpm, jamais npm/yarn/npx** (utiliser `pnpm exec` / `pnpm dlx`).
- `next build` ne lance plus le lint en v16 : toujours exécuter `pnpm typecheck` **et** `pnpm lint` avant de considérer une tâche terminée.
- La doc officielle en markdown : ajouter `.md` à toute URL nextjs.org/docs (version-matched).

## Architecture

```
src/
├── app/                  # routes uniquement (pages, layouts, route handlers)
│   └── <route>/_components, _lib   # code colocalisé propre à la route
├── components/           # composants UI partagés
├── data/                 # Data Access Layer (server-only) — SEUL accès DB + auth
├── lib/
│   ├── ai/               # abstraction provider LLM + outils du coach
│   ├── fit/              # lecture des fichiers FIT, boîte de dépôt, ingestion
│   └── metrics/          # calculs physio purs (VO2max, TRIMP, ATL/CTL/TSB)
├── config/               # env validé par Zod (fail fast au build)
└── proxy.ts              # redirection optimiste vers /login (ex-middleware.ts)
```

Flux d'une mutation : Server Action mince → valide (Zod) → délègue au DAL (`src/data/`) qui porte auth + accès DB → `updateTag()`/`revalidatePath()`. La logique métier vit dans des services testables, jamais dans les actions ni les composants.

## Mode de travail (orchestration)

- **Session principale = Fable 5 (effort high)** : analyse, plan, découpage en tâches, vérification finale, commits. Elle n'implémente directement que le trivial (config, renommage, une ligne).
- **Implémentation = sous-agent `implementer` (Opus 5, effort high)** : une tâche bornée et entièrement spécifiée par prompt (fichiers, contrats, critères de done). Tâches indépendantes lancées en parallèle ; les installations de dépendances restent centralisées côté orchestrateur pour éviter les conflits de lockfile.
- **Avant commit** : l'orchestrateur relance typecheck/lint/tests lui-même (ne pas croire un rapport sur parole), et passe le sous-agent `reviewer` sur les diffs significatifs.
- **Commit + push à chaque fin d'implémentation complète** (vérifiée : typecheck, lint, tests, build si pertinent) — sans attendre qu'on le demande. Le déploiement est automatique via webhook Komodo sur push : un correctif validé mais non poussé n'existe pas pour l'utilisateur. Une implémentation incomplète ou non vérifiée ne se committe pas.

## Règles critiques

- **JAMAIS de secret dans le repo** : ni PAT GitHub, ni `BETTER_AUTH_SECRET`, ni clés API. Tout passe par `.env.local` (gitignoré) et n'est lu que dans `src/config/` + le DAL. Vérifier avant chaque commit.
- Les données d'entraînement sont la source de vérité : ne jamais inventer ou approximer des métriques physio — si un calcul manque de données, le dire.
- **Rien de `(app)` sans session.** Deux étages : redirection optimiste dans `src/proxy.ts` (présence du cookie), puis vérification qui fait autorité dans les composants suspendus, dans chaque Server Action et dans chaque route handler. La liste des chemins publics est dans `src/lib/auth/public-paths.ts`, énumérée par `src/proxy.test.ts` — s'y tromper enferme dehors, en production.
- Design : direction **Pulse** verrouillée (sombre, accent indigo, rampe de zones et types de séance validés au validateur dataviz), tokens dans `.claude/rules/design.md` — aucune couleur ni typo hors système.
- Règles détaillées par domaine dans `.claude/rules/` (nextjs, security, typescript, design, ai-coach, data-import).
