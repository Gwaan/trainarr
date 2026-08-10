---
description: Import des données d'entraînement (FIT), calculs physio
paths:
  - "src/lib/fit/**"
  - "src/lib/intervals/**"
  - "src/lib/metrics/**"
  - "src/lib/db/**"
---

# Données & import FIT

## Un seul container applicatif

Les boucles d'ingestion et de rapatriement tournent **dans le process du serveur
Next**, démarrées par `src/instrumentation.ts` (`register()`, runtime Node
uniquement). Il n'existe pas de container `fit-watcher` : `docker logs trainarr`
montre tout, préfixé `[fit]` et `[fit/intervals]`.

Ce qu'implique cette cohabitation, et qui n'est pas négociable :

- **Rien de l'import ne peut emporter le serveur HTTP.** Chaque boucle est
  enrobée d'un dernier recours qui journalise et relance après délai ; une
  configuration illisible ou une inbox inaccessible désactive le service en le
  disant, l'appli continue de servir.
- La configuration vient de `src/config/env.ts` comme le reste de
  l'application — aucun chargement de `.env` par un script, aucune lecture de
  `process.env` hors `src/config/`. **Une exception, documentée** :
  `src/instrumentation.ts` lit `process.env.NEXT_RUNTIME` — le fichier est
  compilé pour tous les runtimes (Edge compris) et ne peut donc pas importer
  `src/config/env` (`server-only`) ; `NEXT_RUNTIME` est une constante de build,
  pas de la configuration.
- **L'arrêt doit être synchrone.** Next installe son propre gestionnaire de
  SIGTERM qui termine par `process.exit(143)` : vérifié, une continuation
  asynchrone de 5 ms n'a déjà plus la main. `stop()` lève le drapeau d'arrêt et
  annule les appels en vol sans attendre. La sûreté vient d'ailleurs (`.part` +
  renommage atomique, empreinte SHA-256), pas d'une fermeture propre.

## Canal d'import

Le fichier FIT est le **seul** format d'entrée des données d'entraînement : quelle
que soit la route empruntée, tout finit dans la même boîte de dépôt
(`FIT_INBOX_DIR`) et passe par le même watcher.

- **Chemin nominal** : HealthFit (iPhone) exporte automatiquement chaque séance
  vers le point WebDAV `/dav` servi par l'appli (`src/lib/fit/dav.ts`) ; les
  fichiers atterrissent dans la boîte de dépôt (`FIT_INBOX_DIR`, volume partagé).
- **Chemin intervals.icu** : voir la section dédiée plus bas — même boîte de
  dépôt, même watcher.
- **Watcher** (`src/lib/fit/service.ts`) : scanne le dossier à intervalle fixe,
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
                      poller (dans le process de l'appli)
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

- **Identifiant d'athlète facultatif** : `INTERVALS_API_KEY` suffit. Sans
  `INTERVALS_ATHLETE_ID`, l'API est interrogée sur l'athlète `0`, raccourci
  officiel pour « le propriétaire de la clé » (cookbook intervals.icu : « Note
  that the athlete id in the path is '0'. This indicates that the athlete ID
  that the access_token or API key belongs to should be used. »). La variable,
  si elle est donnée, est normalisée sans indulgence coupable : espaces retirés,
  préfixe `i` ajouté si oublié, `i0` ramené à `0`. **Un format invalide ne fait
  jamais échouer le démarrage** — il désactive le poller seul, avec son motif
  (d'où l'absence de regex dans `src/config/env.ts` : la validation vit dans
  `planPollerActivation`, qui retourne un résultat au lieu de lever).
- `client.ts` : appels HTTP, pur, `fetch` injectable. Auth Basic, utilisateur
  littéral `API_KEY`, mot de passe = la clé (Settings → Developer Settings).
  Endpoints utilisés : `GET /api/v1/athlete/{id}/activities?oldest=yyyy-MM-dd`
  et `GET /api/v1/activity/{id}/file` (le fichier **original**, pas
  `/fit-file` qui le régénère depuis les données retouchées). L'en-tête du
  module cite la spec OpenAPI utilisée — la mettre à jour si l'API bouge.
- `poll-plan.ts` : les décisions (quelle fenêtre interroger, quoi télécharger)
  sont pures et testées. Aucune logique décisionnelle dans le script.
- **Backfill intégral au premier passage** : tant qu'aucun `intervals-*.fit`
  n'existe (inbox, `processed/`, `failed/`), le cycle interroge tout
  l'historique (`oldest` = 2000-01-01) au lieu de la fenêtre glissante ; ensuite
  seulement `INTERVALS_LOOKBACK_DAYS` s'applique. Un cycle rapatrie au plus
  `MAX_DOWNLOADS_PER_CYCLE` = 50 fichiers, espacés de `DOWNLOAD_SPACING_MS` =
  500 ms, et les suivants reprennent la suite — la fenêtre historique est
  maintenue tant qu'un cycle laisse du travail derrière lui, sans quoi les 50
  premiers fichiers déposés la refermeraient. Les activités sont listées de la
  plus récente à la plus ancienne : une séance du jour n'attend jamais la fin
  d'un backfill. Relancer un backfill par accident (`processed/` vidé à la main)
  est inoffensif — l'empreinte SHA-256 en base absorbe les re-téléchargements.
- **Pas de pagination côté API** : `GET /athlete/{id}/activities` n'offre ni
  page, ni curseur ; `limit` existe mais reste volontairement non transmis (la
  liste étant en ordre décroissant, il tronquerait l'historique ancien). Le
  volume se maîtrise sur les téléchargements, pas sur la liste.
- **Cadence** : `INTERVALS_POLL_INTERVAL_S` vaut 60 s par défaut — une nouvelle
  séance arrive donc dans Trainarr environ une minute après sa synchronisation
  sur intervals.icu.
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
- Le poller ne démarre que si `INTERVALS_API_KEY` est renseignée ; sinon il le
  dit au démarrage et se tait.

## Le silence est un bug (incident, corrigé)

Le poller a déjà tourné des minutes entières sans rien journaliser ni rapatrier,
alors que 237 activités attendaient. Cause : une `IntervalsAbortError` était
interprétée comme « arrêt du service en cours » d'après son seul type, donc
absorbée sans log. Trois règles en découlent, à ne pas défaire :

1. **Le silence ne se déduit jamais du type d'une erreur.** Une erreur n'est tue
   que si le drapeau d'arrêt est *effectivement* levé au moment du catch — c'est
   tout l'objet de `classifyPollError` (`src/lib/intervals/poll-errors.ts`), pur
   et testé. Tout le reste, abort compris, se journalise avec son type **et** son
   message.
2. **Un cycle qui trouve du travail ou échoue laisse toujours une trace.** Un
   cycle vide se tait pour ne pas noyer les journaux — sauf le premier après un
   démarrage, qui annonce toujours son résultat (`pollCycleSummary`). C'est la
   réponse à « est-ce que ça marche ? ».
3. **Le premier log au boot dit l'état**, pas seulement que le service existe :
   inbox utilisée, cadence, poller actif ou inactif *et pourquoi*.

## Idempotence

- Clé unique : `activities.fit_file_hash` (SHA-256 du fichier). Redéposer le même
  fichier retombe sur la même ligne, jamais un doublon — c'est la contrainte
  unique, pas une lecture préalable, qui le garantit.
- Un réimport ne **complète que les trous** des colonnes de `activities`
  (`null`) : une valeur déjà en base, ou un nom corrigé à la main, n'est jamais
  écrasé.
- **Les séries temporelles, elles, sont intégralement remplacées** à chaque
  ingestion (`saveActivityStreams`, upsert sur `(activity_id, type)` + purge des
  types disparus). La règle est la même vue de plus haut : ne jamais perdre ce
  que seul l'humain produit, toujours rafraîchir ce que seul le fichier produit.
  Un stream n'est pas éditable dans l'appli ; ne réécrire que les activités
  dépourvues de séries rendait toute correction du parseur inopérante sur
  l'historique.
- Le parseur (`src/lib/fit/parse.ts`) est pur : octets → structure. Aucun accès
  base, fichier ou réseau. Ce qu'il a dû écarter part dans `warnings`, jamais
  masqué.
- Stocker les séries temporelles (FC, allure, altitude par point) dans la table
  dédiée `activity_streams` (JSONB) — pas dans la table `activities` principale.

## Échantillonnage clairsemé (ne pas le relire comme une panne)

Un fichier FIT n'écrit **pas** tous les champs dans chaque message `record` :
un *definition message* déclare le sous-ensemble de champs que porteront les
messages de données suivants, et l'appareil change de définition en cours de
fichier. Chaque capteur écrit donc à sa propre cadence. Un `record` sans champ
`heart_rate` signifie « pas de nouvelle mesure à cet instant », jamais « la FC
est en panne ».

- Les streams sont **alignés sur l'axe `time`**, `null` aux points muets. Jamais
  de report de la dernière valeur, jamais de canal écarté pour cause de trous —
  c'est la règle qui, enfreinte, avait fait perdre la FC de 21 des 27 premières
  activités importées.
- Seul un canal réellement mort est écarté : moins de **10 mesures** dans tout le
  fichier (`MIN_CHANNEL_MEASURES` dans `parse.ts`). Le plancher est absolu, pas
  proportionnel — c'est le nombre de mesures qui rend un canal exploitable, pas
  sa couverture : une ceinture FC en mode économie (une mesure toutes les 30 s
  sur un flux à 1 Hz, soit 3,3 % des points) reste parfaitement lisible. Un canal
  **totalement** absent du fichier, lui, ne produit aucun avertissement : une
  Apple Watch n'écrit jamais `speed`, un tapis n'a pas de GPS — un capteur qu'on
  n'a pas n'est pas une donnée perdue.
- Tout consommateur d'un stream saute ses propres `null` **sans décaler les
  autres canaux** (`computeHrZones`, `computeSplits`, `smoothPace`,
  `resamplePoints`, `getActivityFull`). Seul `time` est dense : c'est l'axe.
- Un canal absent du fichier n'est pas fabriqué à l'écriture. En revanche le DAL
  peut le **dériver à la lecture** quand c'est un calcul et non une estimation :
  `deriveVelocity` (Δdistance/Δtemps) donne son allure à une séance Apple Watch,
  dont les fichiers ne portent aucun champ `speed`. Un intervalle plus long que
  le plafond de trou (`sampleDurationCapS`, calculé sur les seuls instants où la
  distance est mesurée) rend `null` : une auto-pause de 5 min n'est pas une
  vitesse de 0,017 m/s étalée sur la pause, c'est du temps que personne n'a
  couru.

## Calculs physio (`lib/metrics/`)

- Fonctions pures, testées unitairement avec des cas connus. Chaque formule (VO2max estimée, TRIMP, ATL/CTL/TSB, prédictions Riegel) documentée par un commentaire citant sa source.
- Ne jamais extrapoler silencieusement : si les données nécessaires manquent (pas de FC, pas de FC max renseignée), retourner « non calculable » plutôt qu'une valeur par défaut.
- Les unités sont explicites dans les noms (`paceSecPerKm`, `distanceM`, `hrBpm`) — pas de nombres nus ambigus.

## Base de données

- Toute modif de schéma passe par Drizzle : éditer `lib/db/schema.ts` → `drizzle-kit generate` → migration versionnée dans le repo. Jamais de SQL manuel sur la base.
- Dates en UTC en base, conversion au fuseau de l'utilisateur à l'affichage.
