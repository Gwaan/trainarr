---
description: Import des données d'entraînement (FIT), calculs physio
paths:
  - "src/lib/fit/**"
  - "src/lib/intervals/**"
  - "src/lib/metrics/**"
  - "src/lib/db/**"
---

# Données & import FIT

## Canal d'import

Le fichier FIT est le **seul** format d'entrée des données d'entraînement : quelle
que soit la route empruntée, tout finit dans la même boîte de dépôt
(`FIT_INBOX_DIR`) et passe par le même watcher.

- **Chemin nominal** : HealthFit (iPhone) exporte automatiquement chaque séance
  vers le point WebDAV `/dav` servi par l'appli (`src/lib/fit/dav.ts`) ; les
  fichiers atterrissent dans la boîte de dépôt (`FIT_INBOX_DIR`, volume partagé).
- **Chemin intervals.icu** : voir la section dédiée plus bas — même boîte de
  dépôt, même watcher.
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

## intervals.icu (`src/lib/intervals/`)

HealthFit synchronise aussi les séances vers intervals.icu. Trainarr y récupère
les fichiers **originaux** et les remet dans le circuit normal :

```
Montre → HealthFit (iPhone) → intervals.icu
                                   │  API HTTP (Basic auth)
                                   ▼
                         poller (dans fit-watcher)
                                   │  écrit intervals-<id>.fit
                                   ▼
                            FIT_INBOX_DIR
                                   │
                                   ▼
                        watcher → processed/ ou failed/
```

**Séparation stricte** : le poller parle au réseau et écrit des fichiers, il ne
parse rien et ne touche jamais à la base. Le watcher parle à la base. Les deux ne
se croisent que par le répertoire — et par le `.part` → rename, qui garantit que
le watcher ne voit jamais un `.fit` à moitié écrit.

- `client.ts` : appels HTTP, pur, `fetch` injectable. Auth Basic, utilisateur
  littéral `API_KEY`, mot de passe = la clé (Settings → Developer Settings).
  Endpoints utilisés : `GET /api/v1/athlete/{id}/activities?oldest=yyyy-MM-dd`
  et `GET /api/v1/activity/{id}/file` (le fichier **original**, pas
  `/fit-file` qui le régénère depuis les données retouchées). L'en-tête du
  module cite la spec OpenAPI utilisée — la mettre à jour si l'API bouge.
- `poll-plan.ts` : la décision (quoi télécharger) est pure et testée. Aucune
  logique décisionnelle dans le script.
- **Déduplication sans état persistant** : le nom déposé est déterministe
  (`intervals-<activityId>.fit`) ; une activité est « déjà rapatriée » si ce nom
  existe dans l'inbox, dans `processed/` ou dans `failed/`. L'état, c'est le
  système de fichiers — il survit aux redémarrages, sans table ni schéma. Un
  double téléchargement resterait de toute façon sans effet (SHA-256 en base).
- **Séance sans fichier** (saisie à la main, activité Strava) : l'API répond 404
  ou un corps vide. L'activité est mémorisée « sans fichier », journalisée une
  seule fois, et plus redemandée **pendant 24 h** (`WITHOUT_FILE_TTL_MS`) — un
  404 peut être transitoire, et un service qui tourne des mois ne doit pas
  perdre une séance réelle pour de bon. Un redémarrage refait une tentative.
- **Quotas et pannes** : un 429 arrête le cycle net et attend `Retry-After` (au
  minimum l'intervalle de cycle, au maximum `MAX_SLEEP_MS` = 1 h — au-delà de
  2³¹−1 ms `setTimeout` retombe à 1 ms et la boucle martèlerait l'API) — jamais
  de rafale. Une erreur réseau tient sur une ligne de log, le cycle suivant
  réessaie. Rien n'arrête le watcher.
- **Rien ne peut suspendre le poller** : chaque appel porte un délai de garde de
  30 s combiné au signal d'arrêt du service, et le corps d'une réponse est coupé
  dès qu'il dépasse `MAX_FIT_FILE_BYTES` (y compris en `chunked`, sans
  `Content-Length`). Un SIGTERM interrompt donc aussi les appels en vol, sans
  ligne d'erreur : c'est une sortie propre.
- **La clé API ne sort jamais** : ni dans un message d'erreur, ni dans un log,
  ni dans une URL — elle ne vit que dans l'en-tête `Authorization`.
- Le poller ne démarre que si `INTERVALS_ATHLETE_ID` **et** `INTERVALS_API_KEY`
  sont renseignés ; sinon il le dit au démarrage et se tait.

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
