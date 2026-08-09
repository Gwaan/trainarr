---
description: Données d'entraînement, Strava, calculs physio
paths:
  - "src/lib/strava/**"
  - "src/lib/metrics/**"
  - "src/lib/db/**"
---

# Données & Strava

## Sync Strava

- OAuth : stocker `access_token` + `refresh_token` + `expires_at` en DB, rafraîchir automatiquement avant expiration. Tokens jamais loggés, jamais exposés au client.
- Ingestion via **webhooks** (événement `activity.create` → fetch de l'activité) avec un backfill initial paginé. Respecter les rate limits Strava (100 req/15 min, 1000/jour) : queue + backoff, pas de rafale.
- Idempotence : une activité Strava (id externe) ne doit jamais être dupliquée en base (upsert sur `strava_id`).
- Stocker les streams (FC, allure, altitude par point) dans des tables dédiées ou JSONB — pas dans la table `activities` principale.

## Calculs physio (`lib/metrics/`)

- Fonctions pures, testées unitairement avec des cas connus. Chaque formule (VO2max estimée, TRIMP, ATL/CTL/TSB, prédictions Riegel) documentée par un commentaire citant sa source.
- Ne jamais extrapoler silencieusement : si les données nécessaires manquent (pas de FC, pas de FC max renseignée), retourner « non calculable » plutôt qu'une valeur par défaut.
- Les unités sont explicites dans les noms (`paceSecPerKm`, `distanceM`, `hrBpm`) — pas de nombres nus ambigus.

## Base de données

- Toute modif de schéma passe par Drizzle : éditer `lib/db/schema.ts` → `drizzle-kit generate` → migration versionnée dans le repo. Jamais de SQL manuel sur la base.
- Dates en UTC en base, conversion au fuseau de l'utilisateur à l'affichage.
