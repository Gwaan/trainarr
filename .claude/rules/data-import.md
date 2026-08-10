---
description: Import des données d'entraînement (FIT), calculs physio
paths:
  - "src/lib/fit/**"
  - "src/lib/metrics/**"
  - "src/lib/db/**"
---

# Données & import FIT

## Canal d'import

Le fichier FIT est le **seul** canal d'entrée des données d'entraînement. Il n'y
a pas d'API tierce : rien à synchroniser, rien à rafraîchir, aucun quota.

- **Chemin nominal** : HealthFit (iPhone) exporte automatiquement chaque séance
  vers le point WebDAV `/dav` servi par l'appli (`src/lib/fit/dav.ts`) ; les
  fichiers atterrissent dans la boîte de dépôt (`FIT_INBOX_DIR`, volume partagé).
- **Watcher** (`scripts/fit-watcher.ts`) : scanne le dossier à intervalle fixe,
  n'ingère qu'un fichier dont la taille est stable sur deux passes (sinon
  l'upload est encore en cours), puis le range dans `processed/` ou `failed/`
  avec un `.err.txt` explicatif. Aucun fichier n'est supprimé en silence.
- **Import manuel** : `POST /api/fit/upload` depuis la page « Activités », même
  ingestion, rapport par fichier.
- **Sécurité du dépôt** : `/dav` est exposé sur Internet en écriture. Basic auth
  (`WEBDAV_USERNAME` / `WEBDAV_PASSWORD`) obligatoire — tant que les deux ne sont
  pas renseignés, le point répond 503. Jamais d'état « ouvert sans
  authentification ».

## Idempotence

- Clé unique : `activities.fit_file_hash` (SHA-256 du fichier). Redéposer le même
  fichier retombe sur la même ligne, jamais un doublon — c'est la contrainte
  unique, pas une lecture préalable, qui le garantit.
- Un réimport ne **complète que les trous** (colonnes `null`) : une valeur déjà
  en base, ou un nom corrigé à la main, n'est jamais écrasé.
- Le parseur (`src/lib/fit/parse.ts`) est pur : octets → structure. Aucun accès
  base, fichier ou réseau. Ce qu'il a dû écarter part dans `warnings`, jamais
  masqué.
- Stocker les séries temporelles (FC, allure, altitude par point) dans la table
  dédiée `activity_streams` (JSONB) — pas dans la table `activities` principale.

## Calculs physio (`lib/metrics/`)

- Fonctions pures, testées unitairement avec des cas connus. Chaque formule (VO2max estimée, TRIMP, ATL/CTL/TSB, prédictions Riegel) documentée par un commentaire citant sa source.
- Ne jamais extrapoler silencieusement : si les données nécessaires manquent (pas de FC, pas de FC max renseignée), retourner « non calculable » plutôt qu'une valeur par défaut.
- Les unités sont explicites dans les noms (`paceSecPerKm`, `distanceM`, `hrBpm`) — pas de nombres nus ambigus.

## Base de données

- Toute modif de schéma passe par Drizzle : éditer `lib/db/schema.ts` → `drizzle-kit generate` → migration versionnée dans le repo. Jamais de SQL manuel sur la base.
- Dates en UTC en base, conversion au fuseau de l'utilisateur à l'affichage.
