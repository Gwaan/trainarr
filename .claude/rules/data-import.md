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
  disant, l'appli continue de servir. Un compte, un dossier ou une clé en défaut
  n'arrête jamais que lui-même.
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

## À qui appartient un fichier : un dossier par athlète

Une activité appartient à un athlète, qui appartient à un compte. **L'ingestion
reçoit donc son athlète en paramètre** (`ingestFitBuffer(buffer, athleteId)`) :
elle ne le déduit plus d'une session — le watcher et le poller tournent hors
requête, il n'y en a pas. Il n'existe **aucun repli** « le premier athlète venu »,
nulle part : c'est exactement ce que le cloisonnement par compte interdit.

Entre le poller (qui écrit) et le watcher (qui ingère, plus tard, éventuellement
après un redémarrage), l'appartenance est portée par **le système de fichiers** —
aucune mémoire de process ne survit à un `docker restart`, un chemin si :

```
FIT_INBOX_DIR/
├── athlete-1/            ← en attente d'ingestion
│   ├── processed/
│   ├── failed/           ← + .err.txt, et .backfill-pending
└── athlete-2/…
```

Les décisions de nommage vivent dans `src/lib/fit/inbox-layout.ts` (pur, testé).
`parseAthleteDirName` est **strictement canonique** — `athlete-007` est refusé
plutôt que ramené à 7 : deux dossiers pour un même athlète, c'est un backfill
sans fin et une déduplication aveugle à son jumeau.

**Les fichiers restés à la racine n'ont pas de propriétaire déductible** : rien
dans un FIT ne désigne un compte, et il n'y a plus aucun canal d'écriture qui
dépose à la racine (le dépôt WebDAV, qui le faisait, a été retiré — cf. plus
bas). Il n'y reste donc que des fichiers antérieurs au cloisonnement, ou posés à
la main dans le volume. Le watcher les **signale une fois chacun** et ne les
touche pas — ni import, ni déplacement, ni suppression. Les réimporter depuis la
page « Activités » les rattache au compte connecté, sans ambiguïté. Attribuer
ces fichiers à un compte « au hasard » serait le seul vrai bug possible ici.

## Canal d'import

Le fichier FIT est le **seul** format d'entrée des données d'entraînement : quelle
que soit la route empruntée, tout finit dans la même boîte de dépôt
(`FIT_INBOX_DIR`) et passe par le même watcher.

- **Chemin nominal** : HealthFit (iPhone) synchronise vers intervals.icu, d'où
  le poller rapatrie les FIT **originaux**. Voir la section dédiée plus bas —
  même boîte de dépôt, dossier du compte dont la clé a servi.
- **Il n'y a plus de dépôt WebDAV.** `/dav`, `src/lib/fit/dav.ts` et les
  variables `WEBDAV_*` ont été retirés : le point était plat et son Basic auth
  était celui de l'installation, pas d'un compte — il déposait donc à la racine
  des fichiers « sans propriétaire », que le watcher signalait sans jamais les
  importer. Un canal d'écriture qui ne sait pas à qui attribuer un fichier n'a
  pas sa place dans une application multi-comptes.
- **Watcher** (`src/lib/fit/service.ts`) : parcourt les dossiers d'athlète à
  intervalle fixe, n'ingère qu'un fichier dont la taille est stable sur deux
  passes (sinon l'upload est encore en cours), puis le range dans `processed/` ou
  `failed/` **du même dossier**, avec un `.err.txt` explicatif. Aucun fichier
  n'est supprimé en silence. Un dossier illisible n'empêche pas de servir les
  autres.
- **Import manuel** : `POST /api/fit/upload` depuis la page « Activités », même
  ingestion, rapport par fichier. C'est la route qui résout l'athlète (elle a une
  session) et le passe à l'ingestion ; sans athlète, elle répond 409 et ne lit
  aucun fichier.
- **Reprise après onboarding** (`recoverPendingImports(athleteId)`) : remet en
  file le `failed/` **de cet athlète**, jamais la racine.
- **Sécurité de la seule entrée en écriture restante** : `POST /api/fit/upload`
  exige une session (401 sinon, avant toute lecture du corps), borne la taille
  sur `Content-Length` avant de bufferiser le multipart, puis chaque fichier
  sur `MAX_FIT_FILE_BYTES` — et ne renvoie jamais de trace d'exécution.

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

- **Identifiant d'athlète facultatif** : la clé API suffit. Sans identifiant
  enregistré, l'API est interrogée sur l'athlète `0`, raccourci
  officiel pour « le propriétaire de la clé » (cookbook intervals.icu : « Note
  that the athlete id in the path is '0'. This indicates that the athlete ID
  that the access_token or API key belongs to should be used. »). La valeur
  saisie, s'il y en a une, est normalisée sans indulgence coupable : espaces
  retirés, préfixe `i` ajouté si oublié, `i0` ramené à `0`. **Un format invalide
  ne fait jamais échouer le démarrage** — il écarte ce compte seul, avec son
  motif (la validation vit dans `planPollerActivation`, qui retourne un résultat
  au lieu de lever).
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
- Le rapatriement ne tourne que pour les comptes ayant une clé ; sinon il le dit
  une fois et attend.

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
   inbox utilisée et cadences. L'activité du rapatriement, elle, ne dépend plus
   de la configuration du serveur mais des comptes : c'est le premier tour de la
   boucle qui l'annonce — « aucun compte configuré », un compte sauté *et
   pourquoi*, ou le compte rendu du premier cycle de chaque compte.

## Idempotence

**Deux clés, pas une** — parce qu'un même entraînement peut arriver sous
plusieurs fichiers d'octets différents :

1. **Empreinte du fichier** : `activities.fit_file_hash` (SHA-256), unique.
   Redéposer le *même fichier* retombe sur la même ligne.
2. **Séance** : `(athlete_id, started_at, sport_type)`, unique
   (`activities_athlete_started_at_sport_unique`). Rapproche le *même
   entraînement* arrivé sous un autre fichier. Le DAL cherche d'abord une séance
   du même athlète, du même sport, dans une fenêtre de ±60 s
   (`SESSION_MATCH_WINDOW_MS` — deux exports d'une même sortie peuvent dater le
   départ à quelques secondes d'écart) ; la plus proche en temps l'emporte.
   Le sport fait partie de la clé : un enchaînement (natation puis course)
   démarre légitimement à la seconde où la discipline précédente s'arrête.

Dans les deux cas c'est **la contrainte unique, pas la lecture préalable**, qui
porte l'idempotence : en `READ COMMITTED` deux ingestions simultanées lisent
toutes les deux une base sans doublon. `upsertActivityFromFit` attrape donc la
violation `23505` de l'index de séance et rejoue le rapprochement sur la ligne
que la course a créée. L'index porte les mêmes critères que la recherche, à la
fenêtre temporelle près : ce qu'il rejette est toujours rapprochable, et le seul
cas restant (transaction concurrente annulée entre-temps) échoue
explicitement — jamais de silence, jamais de doublon.

**Lire un code d'erreur Postgres passe par `src/data/db/errors.ts`.** Depuis
drizzle-orm 0.45, l'erreur du pilote remonte enveloppée dans un
`DrizzleQueryError` : un `error.code === '23505'` lu sur l'erreur de surface ne
matche jamais, et le rattrapage ne s'exécute pas. Les helpers remontent la
chaîne `cause` (profondeur bornée) — ne jamais relire `code` à la main.

### L'incident qui motive tout ça

Chaque séance existait en **trois exemplaires** en base. Trois activités
dupliquées en amont sur intervals.icu (depuis corrigées) avaient produit trois
fichiers FIT aux octets différents pour une seule sortie : trois empreintes,
donc trois lignes, avec un `started_at` strictement identique. La leçon n'est pas
« intervals.icu a eu un bug » mais **l'amont n'est jamais fiable** : la seule
défense est une clé qui décrit la séance, pas le transport. La migration
`0005_dedupe_activities_by_session` a nettoyé l'existant avant que `0006` ne
pose l'index : ligne gardienne = celle qui **porte des séries** d'abord, la
mieux renseignée ensuite, plus petit `id` en dernier ; complétée par les
scalaires des autres, `planned_sessions` repointées, et **les canaux qui lui
manquaient transférés depuis les doublons** avant leur suppression. L'ordre des
critères n'est pas cosmétique : un exemplaire « résumé seul » aurait gagné sur
un exemplaire porteur des séries si le compte de colonnes passait devant.

### Ce qu'un réimport écrit

- Un réimport ne **complète que les trous** des colonnes de `activities`
  (`null`) : une valeur déjà en base, ou un nom corrigé à la main, n'est jamais
  écrasé. Un rapprochement par séance ne touche **pas** `fit_file_hash` : le
  premier fichier reste l'origine canonique de la ligne.
- **Les séries temporelles dépendent du type de rapprochement** :
  - création ou **même fichier** → **remplacement intégral**
    (`saveActivityStreams`, upsert sur `(activity_id, type)` + purge des types
    disparus). Ne jamais perdre ce que seul l'humain produit, toujours
    rafraîchir ce que seul le fichier produit ; un stream n'est pas éditable
    dans l'appli, et ne réécrire que les activités dépourvues de séries rendait
    toute correction du parseur inopérante sur l'historique.
  - **même séance, autre fichier** → écriture **seulement si l'activité n'a
    aucune série** (`hasActivityStreams`). Un doublon venu d'une autre source
    n'est pas une meilleure version de la séance : rien ne dit qu'il porte les
    mêmes canaux (une même sortie réexportée peut avoir perdu sa FC en chemin),
    il n'a donc aucun titre à écraser des séries saines.
- Les trois issues remontent jusqu'à l'UI (`IngestReport.status`) :
  `created` / `updated` (même fichier) / `merged` (même séance) — un import qui
  ne crée rien doit le dire, pas se faire passer pour une mise à jour.
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

### Ce qui se recalcule, ce qui se persiste

Par défaut **tout se recalcule à la lecture** : zones FC, TRIMP, VO₂max,
comparaison aux objectifs. C'est la seule façon qu'une correction du profil
(FC max, FC seuil, sexe) relise rétroactivement tout l'historique au lieu de
laisser des valeurs figées mentir.

L'exception, et son critère : **une dérivée qui ne dépend d'aucune donnée de
profil** peut être persistée, parce qu'elle ne peut pas devenir incohérente avec
lui. C'est le cas des meilleurs efforts (`activity_best_segments`) — une
distance et un chrono, lus dans le fichier et dans lui seul —, écrits à
l'ingestion comme `sustained_max_hr_bpm`. Ce qu'on y gagne : les records de tous
les temps sont un `MIN` indexé, là où les tirer des flux imposerait de parser
des dizaines de mégaoctets de JSONB à chaque affichage, et de faire lire
`activity_streams` à des modules d'écran qui ne l'ont jamais fait
(`progression.ts`, `dashboard.ts`).

Toute colonne calculée à l'ingestion vaut **pour les imports à venir** et laisse
l'historique déjà en base sans valeur : soit on l'assume (`NULL`, cf. la FC max
soutenue), soit on livre un rattrapage — `pnpm db:backfill:best-segments`, par
lots, idempotent, autonome comme `src/data/db/migrate.ts`. Tant qu'il n'est pas
passé, l'écran doit **dire** que sa lecture est provisoire plutôt que de laisser
croire à un historique complet.

**Un rattrapage doit pouvoir finir.** Le compteur qui déclenche cet
avertissement se lit « il reste des séances à balayer » ; il doit donc pouvoir
atteindre zéro. Une séance balayée **sans résultat** — flux de distance absent,
canal vide d'un import indoor, valeurs non numériques d'un ancien fichier — se
marque comme balayée (`activities.best_segments_scanned_at`, posée dans la même
transaction que l'écriture, y compris quand le calcul ne rend rien). Sans cette
marque, le prédicat la resélectionne indéfiniment : l'écran réclamerait le
rattrapage pour toujours, après qu'il a été lancé. Le critère de sortie d'un
rattrapage est « je l'ai regardée », jamais « elle a produit quelque chose ».

**Une contrainte `CHECK` ne protège pas d'un arrondi de type.** Postgres coerce
la valeur vers le type de la colonne **avant** d'évaluer la contrainte : sur un
`numeric(9,2)`, insérer `1609.344` passe un `CHECK` qui liste `1609.34`, et se
stocke arrondi — l'incohérence n'apparaît que plus tard, en collision de clé.
Ce que le `CHECK` attrape, c'est une valeur qui n'est pas une cible connue (une
erreur d'unité) ; ce qu'il n'attrape pas, c'est une cible plus précise que la
colonne. Cette seconde garde se pose côté TypeScript, au chargement du schéma,
pour échouer au build et aux tests plutôt qu'en production.

## Base de données

- Toute modif de schéma passe par Drizzle : éditer `lib/db/schema.ts` → `drizzle-kit generate` → migration versionnée dans le repo. Jamais de SQL manuel sur la base.
- Dates en UTC en base, conversion au fuseau de l'utilisateur à l'affichage.
