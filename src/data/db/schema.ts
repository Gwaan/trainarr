import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { LthrSource } from '@/lib/metrics/lthr';
import type { ReferenceDistance } from '@/lib/metrics/vdot';
import type { PlanRevisionDirection } from '@/lib/plan-revision/direction';
// Type seul, donc effacé à la compilation : la table décrit la forme du payload
// qu'elle stocke, et cette forme est celle que le DAL valide (`plan-revisions.ts`).
// Une seconde déclaration aurait divergé de la première au premier champ ajouté.
import type { PlanRevisionPayload } from '../plan-revisions';
import type { PlanIntent } from '@/lib/plan-skeleton/intent';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';
import type { WeatherForecastStatus } from '@/lib/weather/forecast-plan';
import type { ActivityWeatherStatus, WeatherSource } from '@/lib/weather/plan';

/**
 * Schéma Drizzle de Trainarr.
 *
 * Conventions :
 * - toutes les dates/heures sont en `timestamp with time zone` (stockage UTC,
 *   conversion au fuseau de l'utilisateur à l'affichage) ;
 * - les unités sont explicites dans les noms de colonnes (`distance_m`,
 *   `avg_hr_bpm`, `avg_pace_sec_per_km`…), jamais de nombre nu ambigu.
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Sexe biologique — nécessaire au TRIMP de Banister, dont le coefficient
 * exponentiel diffère (1.92 homme / 1.67 femme). Nullable : tant qu'il n'est pas
 * renseigné, la charge d'entraînement n'est pas calculable (jamais approximée).
 */
export const ATHLETE_SEXES = ['male', 'female'] as const;

export type AthleteSex = (typeof ATHLETE_SEXES)[number];

/**
 * D'où sort la mesure de FC seuil que porte une séance
 * (`activities.lthr_sample_source`).
 *
 * Recopié plutôt qu'importé — la base ne dépend pas du module de calcul — mais
 * `satisfies` interdit qu'il en diverge (même dispositif que
 * {@link PLAN_REVISION_DIRECTIONS}).
 */
export const LTHR_SAMPLE_SOURCES = [
  'threshold-blocks',
  'time-trial',
] as const satisfies readonly LthrSource[];

/**
 * Profil de l'athlète, **propriété d'un compte**.
 *
 * L'index unique `athlete_singleton` a disparu (migration 0017) : c'était lui
 * qui interdisait matériellement un second athlète. Ce qui borne désormais la
 * table, c'est l'unicité de `user_id` — un athlète par compte, et un compte par
 * athlète.
 */
export const athlete = pgTable('athlete', {
  id: serial('id').primaryKey(),
  /**
   * Compte propriétaire de l'athlète (`auth_users.id`).
   *
   * **Nullable**, et ça n'est pas un provisoire mal assumé : la migration peut
   * s'appliquer avant qu'un seul compte existe (c'est même le cas courant — les
   * tables d'authentification sont neuves), et une colonne `NOT NULL` n'aurait
   * alors aucune valeur à écrire. Une ligne à `user_id IS NULL` est un athlète
   * **à réclamer** : le premier compte qui se connecte sans athlète se
   * l'attribue (cf. `getCurrentAthleteId` dans `src/data/athlete.ts`). Sans ce
   * chemin, l'onboarding créerait un athlète neuf et vide pendant que des années
   * d'entraînement dormiraient sous une ligne orpheline devenue invisible.
   *
   * **Unique** : deux comptes ne peuvent pas pointer sur le même athlète, ce qui
   * ferme aussi la course entre deux réclamations simultanées.
   *
   * **`ON DELETE RESTRICT`.** Les deux autres comportements sont pires :
   * `CASCADE` effacerait l'historique d'entraînement avec le compte (et
   * échouerait de toute façon, `activities.athlete_id` ne cascadant pas), et
   * `SET NULL` rendrait l'athlète orphelin — donc **réclamable par le prochain
   * compte créé**, qui hériterait silencieusement des données de quelqu'un
   * d'autre. Avec `RESTRICT`, la base refuse la suppression tant que l'athlète
   * n'a pas été traité explicitement : rien ne disparaît ni ne change de mains
   * par accident.
   */
  userId: text('user_id')
    .unique()
    .references(() => authUsers.id, { onDelete: 'restrict' }),
  displayName: text('display_name').notNull(),
  sex: text('sex', { enum: ATHLETE_SEXES }),
  maxHrBpm: integer('max_hr_bpm'),
  restingHrBpm: integer('resting_hr_bpm'),
  /**
   * **FC seuil** (LTHR) adoptée par l'athlète, en bpm. `NULL` tant qu'il n'en a
   * adopté aucune — ce qui est l'état par défaut, et l'état de tout l'existant.
   *
   * Cette colonne décide de l'**ancrage des zones cardiaques** (cf.
   * `lib/metrics/hr-zones.ts`) : renseignée, les cinq zones se calent sur le
   * seuil (échelle Friel) ; `NULL`, elles restent en pourcentage de FC max,
   * exactement comme avant. Rien n'est stocké côté zones — tout se recalcule à
   * la lecture —, donc l'adopter relit rétroactivement tout l'historique dans le
   * nouveau cadre.
   *
   * Elle ne s'écrit **jamais toute seule** : l'application mesure, propose, et
   * l'athlète tranche (`src/data/lthr-suggestion.ts`), comme pour la FC max et
   * la FC de repos.
   */
  lthrBpm: integer('lthr_bpm'),
  /**
   * **Dernière** valeur de FC seuil écartée par l'athlète, en bpm. `NULL` tant
   * qu'aucune ne l'a été.
   *
   * Une valeur, pas un seuil — le calque exact de
   * `resting_hr_suggestion_dismissed_bpm`, et pour la même raison : une FC seuil
   * bouge dans les **deux** sens (elle monte avec la forme, elle redescend avec
   * le désentraînement ou l'âge), donc « tout ce qui est au-dessus de 172 est
   * écarté » enterrerait la moitié des propositions légitimes. Rien ne se
   * repropose tant que la candidate ne s'écarte pas d'au moins
   * `LTHR_REPROPOSE_DELTA_BPM` battements de la valeur refusée (cf.
   * `src/lib/metrics/lthr.ts`).
   */
  lthrSuggestionDismissedBpm: integer('lthr_suggestion_dismissed_bpm'),
  weightKg: numeric('weight_kg', { precision: 5, scale: 2, mode: 'number' }),
  /** Date civile (mode `string`, `YYYY-MM-DD`) : pas d'heure, donc pas de fuseau. */
  birthDate: date('birth_date'),
  /**
   * Identifiant intervals.icu de l'athlète (ex. `i123456`). `NULL` tant qu'il
   * n'est pas renseigné : l'API résout alors l'athlète `0` en « le propriétaire
   * de la clé ». Ce n'est pas un secret — il n'ouvre rien à lui seul.
   */
  intervalsAthleteId: text('intervals_athlete_id'),
  /**
   * Clé API intervals.icu, **chiffrée** (AES-256-GCM, cf. `src/lib/crypto/`).
   * Jamais la clé en clair : la colonne porte l'enveloppe `v1:<base64>` qui
   * embarque son vecteur d'initialisation et son marqueur d'authenticité.
   *
   * La clé de chiffrement dérive de `BETTER_AUTH_SECRET` : changer ce secret
   * rend cette colonne indéchiffrable, ce que le DAL rapporte comme « clé
   * illisible, à ressaisir » — jamais comme une panne.
   */
  intervalsApiKeyEncrypted: text('intervals_api_key_encrypted'),
  /**
   * Lieu **réglé** des prévisions météo : le libellé choisi (« Bordeaux ») et
   * ses coordonnées géocodées.
   *
   * **Les trois colonnes vont ensemble ou pas du tout** : `NULL` partout, c'est
   * le mode automatique — le lieu se déduit alors du plus central des départs
   * récents (`habitualStart`), qui reste le défaut pour un compte qui n'a rien
   * réglé. Un libellé sans coordonnées ne serait interrogeable nulle part, et
   * des coordonnées sans libellé ne se diraient pas à l'écran ; le DAL ne rend
   * donc le réglage que lorsque les trois sont là.
   *
   * Un réglage **par compte**, comme les identifiants intervals.icu au-dessus :
   * l'installation peut porter plusieurs athlètes, qui ne courent pas au même
   * endroit.
   *
   * Coordonnées **arrondies** à deux décimales (≈ 1 km, cf.
   * `COORDINATE_DECIMALS`), comme partout ailleurs dans le système. Un lieu
   * public n'a rien de secret, mais une exception à la règle d'arrondi finirait
   * par en faire une autre.
   *
   * Le libellé, lui, **franchit la frontière client** : c'est la réponse à « la
   * prévision, c'est quelle ville ? ». Les coordonnées, non.
   */
  forecastLocationLabel: text('forecast_location_label'),
  forecastLatitudeDeg: real('forecast_latitude_deg'),
  forecastLongitudeDeg: real('forecast_longitude_deg'),
  /**
   * Seuil de refus des propositions de FC max : **toute proposition supérieure
   * ou égale à cette valeur a déjà été écartée** par l'athlète. `NULL` tant
   * qu'aucune ne l'a été.
   *
   * L'application propose une FC max quand une séance importée a tenu une
   * fréquence plus haute que celle du profil (cf. `src/data/max-hr-suggestion.ts`).
   * L'athlète peut refuser — un artefact de capteur qui aurait passé le filtre
   * des cinq secondes soutenues — et ce refus doit tenir : sans mémoire, la même
   * proposition reviendrait à chaque lecture de l'écran.
   *
   * **Un seuil, et pas un simple « déjà vu »**, parce que la proposition est
   * toujours la valeur la plus haute observée : mémoriser le refus sans borner
   * ce qu'il couvre enterrerait aussi toutes les valeurs plus basses, et un seul
   * artefact à 215 désactiverait la fonction pour de bon. Avec un seuil, refuser
   * 215 fait remonter la meilleure valeur **strictement inférieure** — la vraie,
   * le plus souvent.
   *
   * Il n'est pas remis à zéro par une acceptation : « 215 et au-dessus, c'est du
   * bruit » reste vrai après avoir accepté 192.
   */
  maxHrSuggestionDismissedBpm: integer('max_hr_suggestion_dismissed_bpm'),
  /**
   * **Dernière** valeur de FC de repos écartée par l'athlète, en bpm. `NULL`
   * tant qu'aucune ne l'a été.
   *
   * Une valeur, pas un seuil — et c'est toute la différence avec
   * `max_hr_suggestion_dismissed_bpm` juste au-dessus. La proposition de FC max
   * ne va que vers le haut : mémoriser « tout ce qui est au-dessus de 215 est du
   * bruit » a un sens. La FC de repos, elle, **bouge dans les deux sens** — elle
   * baisse quand la forme monte, elle remonte sinon : un seuil directionnel
   * enterrerait la moitié des propositions légitimes. On mémorise donc la valeur
   * refusée, et rien ne se repropose tant que la médiane ne s'en écarte pas d'au
   * moins `RESTING_HR_REPROPOSE_DELTA_BPM` battements (cf.
   * `src/lib/metrics/resting-hr.ts`).
   */
  restingHrSuggestionDismissedBpm: integer('resting_hr_suggestion_dismissed_bpm'),
  /**
   * Marqueur du dernier relevé bien-être **réussi** : la date civile du dernier
   * passage de l'heure de relevé révolu (cf. `wellnessReadingMarker`).
   *
   * Même esprit que `weather_forecast_runs.reading_day`, en une seule colonne :
   * le relevé bien-être n'a ni statut à afficher, ni compteur de tentatives à
   * borner — ce que l'écran montre, ce sont les jours de `wellness_days`, et une
   * journée manquée se rattrape toute seule (chaque relevé redemande les
   * `WELLNESS_WINDOW_DAYS` derniers jours). Une table d'état n'aurait rien
   * porté de plus.
   *
   * Écrit **seulement** quand le relevé a abouti : un échec réseau se reprend au
   * cycle suivant plutôt que d'attendre le lendemain.
   */
  wellnessReadingDay: date('wellness_reading_day'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Nom de l'index unique qui interdit deux activités du même sport au même
 * instant pour le même athlète.
 *
 * Le sport fait partie de la clé, exactement comme dans la recherche de séance
 * du DAL : un enchaînement (natation puis course) démarre légitimement à la
 * seconde où la discipline précédente s'arrête. Sans lui, ce cas violerait
 * l'index sans être rapprochable — l'import échouerait définitivement.
 *
 * Exporté parce que le DAL le lit : quand l'insertion d'un import FIT se heurte à
 * cet index (course entre deux ingestions simultanées de la même séance), c'est
 * ce nom-là qui distingue la collision « même séance » de celle sur
 * `fit_file_hash`, laquelle est déjà absorbée par un `ON CONFLICT`.
 */
export const ACTIVITIES_SESSION_UNIQUE_INDEX = 'activities_athlete_started_at_sport_unique';

/**
 * Une séance.
 *
 * **Deux clés d'idempotence**, et non une seule :
 *
 * 1. `fit_file_hash` (SHA-256 du fichier), unique et **nullable** — une ligne
 *    peut naître autrement qu'en lisant un fichier ; Postgres autorise plusieurs
 *    `NULL` dans une contrainte `UNIQUE`, ces lignes-là ne se collisionnent pas
 *    entre elles. Elle protège du redépôt du **même fichier**.
 * 2. `(athlete_id, started_at)`, unique — elle protège de la **même séance**
 *    arrivée sous plusieurs fichiers d'octets différents. Cas vécu : trois
 *    doublons créés en amont sur intervals.icu ont produit trois fichiers FIT
 *    distincts, donc trois empreintes distinctes, donc trois lignes pour une
 *    seule sortie. Un athlète ne peut pas démarrer deux séances au même instant.
 */
export const activities = pgTable(
  'activities',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    /**
     * Empreinte SHA-256 du fichier FIT à l'origine de l'activité — clé
     * d'idempotence de l'import. Redéposer le même fichier retombe sur la même
     * ligne au lieu de la dupliquer.
     */
    fitFileHash: text('fit_file_hash').unique(),
    name: text('name').notNull(),
    sportType: text('sport_type').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    distanceM: real('distance_m').notNull(),
    movingTimeS: integer('moving_time_s').notNull(),
    elapsedTimeS: integer('elapsed_time_s').notNull(),
    elevationGainM: real('elevation_gain_m'),
    avgHrBpm: integer('avg_hr_bpm'),
    maxHrBpm: integer('max_hr_bpm'),
    /**
     * FC max **soutenue** de la séance : la plus haute fréquence tenue cinq
     * secondes d'affilée (cf. `src/lib/metrics/sustained-hr.ts`). `NULL` quand
     * elle n'est pas établie — pas de canal cardiaque, ou aucune plage de
     * mesures contiguës assez longue.
     *
     * Distincte de `max_hr_bpm`, qui est le maximum **instantané** annoncé par
     * la session FIT : celui-ci porte les artefacts du capteur optique, et c'est
     * précisément pour ça qu'il ne peut pas servir à proposer une FC max de
     * profil. Les deux colonnes cohabitent — l'une décrit la séance, l'autre
     * sert de preuve.
     *
     * Calculée à l'ingestion, en même temps que les séries temporelles dont elle
     * dérive (cf. `src/lib/fit/ingest.ts`) : elle vaut donc pour les imports à
     * venir, et reste `NULL` sur l'historique déjà en base.
     */
    sustainedMaxHrBpm: integer('sustained_max_hr_bpm'),
    /**
     * Ce que cette séance dit de la **FC seuil** de l'athlète, en bpm — `NULL`
     * quand elle n'en dit rien, ce qui est le cas de l'immense majorité des
     * séances (un footing ne mesure aucun seuil).
     *
     * Deux façons pour une séance de porter cette mesure, et
     * `lthr_sample_source` dit laquelle :
     *
     * - `threshold-blocks` : la séance réalisait une séance de **seuil**
     *   planifiée, et la FC s'est stabilisée sur son bloc (mesure de la seconde
     *   moitié du bloc — la FC met deux à trois minutes à rejoindre son plateau) ;
     * - `time-trial` : la séance était le **test chronométré** du plan, vérifié
     *   maximal, dont on retient la FC moyenne des 20 dernières minutes
     *   (protocole Friel).
     *
     * Le détail des méthodes, leurs bornes de validité et leur niveau de preuve
     * vivent dans `src/lib/metrics/lthr.ts`.
     *
     * **Une mesure par séance, pas une proposition** : c'est la médiane de
     * plusieurs séances qui devient une candidate (`src/data/lthr-suggestion.ts`),
     * jamais un bloc isolé — la FC d'un jour donné dépend autant de la chaleur et
     * du sommeil que du seuil.
     *
     * Écrite au **rapprochement** de l'activité à sa séance planifiée : elle vaut
     * donc pour les imports à venir, et reste `NULL` sur l'historique déjà en
     * base. Comme `sustained_max_hr_bpm`, elle dérive du fichier seul et se
     * réécrit à chaque relecture de celui-ci.
     */
    lthrSampleBpm: integer('lthr_sample_bpm'),
    /** D'où sort `lthr_sample_bpm` — cf. {@link LTHR_SAMPLE_SOURCES}. `NULL` avec elle. */
    lthrSampleSource: text('lthr_sample_source', { enum: LTHR_SAMPLE_SOURCES }),
    avgPaceSecPerKm: real('avg_pace_sec_per_km'),
    avgCadenceSpm: real('avg_cadence_spm'),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Backstop de la déduplication au niveau séance. Le DAL cherche d'abord une
     * séance voisine avant d'insérer, mais en `READ COMMITTED` deux ingestions
     * simultanées du même entraînement lisent toutes les deux une base sans
     * doublon : c'est la contrainte, et non la lecture préalable, qui porte
     * l'idempotence. `upsertActivityFromFit` traduit la violation `23505` en
     * rapprochement (cf. {@link ACTIVITIES_SESSION_UNIQUE_INDEX}).
     *
     * Il sert **aussi** de chemin d'accès aux lectures par athlète ordonnées
     * dans le temps : son préfixe `(athlete_id, started_at)` est celui de
     * l'ancien `activities_athlete_started_at_idx`, que la migration 0006
     * supprime pour cela — un btree se parcourt dans les deux sens, le `DESC`
     * de l'ancien index n'apportait rien de plus.
     */
    uniqueIndex(ACTIVITIES_SESSION_UNIQUE_INDEX).on(
      table.athleteId,
      table.startedAt,
      table.sportType,
    ),
  ],
);

/** Types de séries temporelles conservées (point par point). */
export const ACTIVITY_STREAM_TYPES = [
  'time',
  'distance',
  'heartrate',
  'altitude',
  'cadence',
  'velocity',
  'latlng',
] as const;

export type ActivityStreamType = (typeof ACTIVITY_STREAM_TYPES)[number];

/**
 * Un stream est une série de scalaires, sauf `latlng` qui est une série de
 * couples.
 *
 * **`null` = le capteur n'a rien mesuré à cet index.** Un fichier FIT n'écrit
 * pas tous les champs dans chaque message `record` : chaque message ne porte que
 * les champs déclarés par sa *definition message*, et chaque capteur écrit à sa
 * propre cadence (le GPS à son taux de fix, la FC à celui de la ceinture). Un
 * canal clairsemé est donc la norme, pas une panne — le représenter avec des
 * trous explicites est la seule façon de garder les index alignés entre séries
 * sans inventer de mesure.
 *
 * Le stockage est en JSONB : `null` y est une valeur native, aucune migration
 * n'est nécessaire pour l'accueillir.
 */
export type ActivityStreamData = (number | null)[] | Array<[number, number] | null>;

/** Séries temporelles d'une activité, hors table principale (JSONB). */
export const activityStreams = pgTable(
  'activity_streams',
  {
    id: serial('id').primaryKey(),
    activityId: integer('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ACTIVITY_STREAM_TYPES }).notNull(),
    data: jsonb('data').$type<ActivityStreamData>().notNull(),
  },
  (table) => [
    index('activity_streams_activity_id_idx').on(table.activityId),
    /**
     * Une seule ligne par (activité, type) : c'est cette contrainte qui rend
     * `saveActivityStreams` idempotent (`ON CONFLICT`) et interdit les doublons
     * si deux imports de la même activité se croisent.
     */
    uniqueIndex('activity_streams_activity_id_type_idx').on(table.activityId, table.type),
  ],
);

/**
 * Statuts recopiés de `lib/weather/plan` — la base ne dépend pas du service,
 * mais `satisfies` interdit qu'ils en divergent (même montage que
 * {@link PLAN_INTENTS}).
 */
export const ACTIVITY_WEATHER_STATUSES = [
  'observed',
  'no-location',
  'unsupported',
  'failed',
] as const satisfies readonly ActivityWeatherStatus[];

/** Endpoint Open-Meteo qui a fourni la mesure. */
export const WEATHER_SOURCES = ['forecast', 'archive'] as const satisfies readonly WeatherSource[];

/**
 * La météo d'une séance **effectuée**, relevée après coup chez Open-Meteo.
 *
 * **Une ligne par activité, et c'est la clé primaire** : la météo d'une sortie
 * passée ne change plus, il n'y a donc rien à versionner. `ON DELETE CASCADE`
 * parce que ce relevé n'a aucun sens sans sa séance.
 *
 * **La ligne existe aussi quand il n'y a pas de météo**, et c'est tout l'objet
 * de `status` : sans elle, « pas encore essayé » et « essayé, sans résultat »
 * seraient le même état — l'absence de ligne — et chaque cycle de rattrapage
 * redemanderait éternellement la séance sur tapis qui n'a pas de GPS, ou la
 * position que le service refuse. Les mesures sont donc toutes nullables : elles
 * ne sont renseignées que sous `observed`.
 *
 * `attempts`, `last_attempt_at` et `failure_reason` ne servent qu'aux échecs
 * **réessayables** (`failed`) : ils décident du moment de la prochaine tentative
 * et de l'abandon (cf. `RETRY_DELAYS_MS`). Une panne réseau ne doit pas coûter
 * une séance pour de bon, et ne doit pas non plus tourner en boucle.
 *
 * Pas de colonne `athlete_id` : l'appartenance est celle de l'activité, et le
 * DAL ne lit ni n'écrit ici sans avoir joint `activities` sur l'athlète — la
 * dupliquer ouvrirait la possibilité qu'elle diverge.
 */
export const activityWeather = pgTable(
  'activity_weather',
  {
    activityId: integer('activity_id')
      .primaryKey()
      .references(() => activities.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ACTIVITY_WEATHER_STATUSES }).notNull(),
    /** `NULL` hors `observed` : aucun endpoint n'a répondu. */
    source: text('source', { enum: WEATHER_SOURCES }),
    /**
     * Coordonnées **arrondies** telles qu'elles ont été envoyées (deux
     * décimales, ≈ 1 km — cf. `COORDINATE_DECIMALS`). Conservées comme
     * provenance de la mesure : sans elles, impossible de dire de quel point
     * parle un relevé qui semble faux.
     */
    latitudeDeg: real('latitude_deg'),
    longitudeDeg: real('longitude_deg'),
    /** Heure horaire retenue par Open-Meteo — celle qu'il a rendue, pas celle demandée. */
    observedAt: timestamp('observed_at', { withTimezone: true }),
    temperatureC: real('temperature_c'),
    /** Ressenti : humidité, vent et rayonnement compris. */
    apparentTemperatureC: real('apparent_temperature_c'),
    /**
     * Précipitations en mm, **cumulées sur l'heure précédant `observed_at`** —
     * c'est la sémantique d'Open-Meteo pour les variables de somme, les autres
     * étant instantanées. Donc « il est tombé tant dans l'heure autour de la
     * séance », jamais « pendant la séance ».
     */
    precipitationMm: real('precipitation_mm'),
    windSpeedKmh: real('wind_speed_kmh'),
    /** Direction **d'où vient** le vent, en degrés (convention météo : 0 = nord). */
    windDirectionDeg: real('wind_direction_deg'),
    relativeHumidityPct: real('relative_humidity_pct'),
    /** Code temps WMO 4677 (0 = ciel clair, 61 = pluie faible, 95 = orage…). */
    weatherCode: integer('weather_code'),
    /** Nombre de relevés tentés, échecs compris. Borné par `MAX_ATTEMPTS`. */
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Motif du dernier échec, tel que le service l'a formulé (`nom : message`).
     * `NULL` sous `observed`. Jamais d'URL ni de coordonnées brutes.
     */
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Chemin d'accès de la seule lecture de service : « les relevés en échec
     * dont le délai de reprise est écoulé ». Le statut d'abord, il découpe la
     * table en quatre paquets très inégaux dont un seul est scanné.
     */
    index('activity_weather_status_last_attempt_idx').on(table.status, table.lastAttemptAt),
  ],
);

/**
 * Statuts recopiés de `lib/weather/forecast-plan` — même montage que
 * {@link ACTIVITY_WEATHER_STATUSES}.
 */
export const WEATHER_FORECAST_STATUSES = [
  'forecast',
  'no-location',
  'unsupported',
  'failed',
] as const satisfies readonly WeatherForecastStatus[];

/**
 * Le relevé de prévisions du matin : **une ligne par athlète**, celle du dernier
 * relevé tenté.
 *
 * Il n'y a rien à versionner ici : la prévision de ce matin remplace celle
 * d'hier, qui ne vaut plus rien. Cette ligne dit donc **où en est** le relevé
 * quotidien, et elle existe aussi quand il n'a rien donné — c'est tout l'objet
 * de `status`. Sans elle, « pas encore relevé » et « relevé sans résultat »
 * seraient le même état (l'absence de ligne), et un athlète sans sortie
 * géolocalisée verrait le service redemander la même chose à chaque cycle.
 *
 * `reading_day` est le **marqueur** du relevé : la date civile du dernier
 * passage de 6 h (heure locale) révolu. Comparer ce marqueur à celui de
 * l'instant courant donne d'un coup le relevé quotidien et son rattrapage — une
 * application arrêtée à 6 h revient avec un marqueur en retard, et relève au
 * premier cycle. Cf. `forecastReadingMarker`.
 *
 * Pas de colonne `attempts` par jour civil : le compteur appartient au marqueur
 * et repart de 1 à chaque matin (cf. `FORECAST_MAX_ATTEMPTS`).
 */
export const weatherForecastRuns = pgTable('weather_forecast_runs', {
  /**
   * `ON DELETE CASCADE` : une prévision n'a aucun sens sans son athlète — même
   * raison qu'`activity_weather` avec son activité. C'est une donnée dérivée et
   * périssable, rien ne se perd à l'effacer avec son propriétaire.
   */
  athleteId: integer('athlete_id')
    .primaryKey()
    .references(() => athlete.id, { onDelete: 'cascade' }),
  /** Marqueur du relevé dont cette ligne rend compte (date civile locale). */
  readingDay: date('reading_day').notNull(),
  status: text('status', { enum: WEATHER_FORECAST_STATUSES }).notNull(),
  /**
   * Instant du dernier essai — c'est lui qui date la prévision à l'écran
   * (« relevé de 6 h 02 ») et qui espace les reprises.
   */
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  /** Essais faits pour ce marqueur, échecs compris. Borné par `FORECAST_MAX_ATTEMPTS`. */
  attempts: integer('attempts').notNull().default(0),
  /**
   * Coordonnées **arrondies** interrogées (deux décimales, ≈ 1 km — cf.
   * `COORDINATE_DECIMALS`), déduites des départs récents. Conservées comme
   * provenance : sans elles, impossible de dire de quel lieu parle une prévision
   * qui semble fausse. Ne franchissent jamais la frontière client.
   */
  latitudeDeg: real('latitude_deg'),
  longitudeDeg: real('longitude_deg'),
  /** Motif du dernier échec (`nom : message`). `NULL` sous `forecast`. */
  failureReason: text('failure_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * La prévision d'un jour, pour un athlète — **une ligne par jour et par
 * compte**.
 *
 * Table distincte d'`activity_weather`, et ce n'est pas un détail : celle-ci
 * porte des **observations** immuables rattachées à une activité, celle-là des
 * **estimations** périssables rattachées à un jour. Les mélanger ferait tôt ou
 * tard écraser une mesure par une prévision — l'inverse de ce qu'on veut lire
 * une fois la séance courue.
 *
 * Les valeurs sont des **agrégats de journée civile** (maximum, minimum, cumul),
 * parce qu'une séance planifiée porte une date et jamais une heure. Le fuseau
 * qui découpe ces journées est celui de l'application, imposé à Open-Meteo dans
 * la requête.
 *
 * Toutes les lignes d'un athlète sont **remplacées** à chaque relevé du matin :
 * une prévision ne s'accumule pas, elle se périme. `fetched_at` porte l'instant
 * du relevé pour que l'écran puisse dire de quand elle date — dupliqué depuis
 * `weather_forecast_runs` pour qu'une lecture d'écran n'ait pas à joindre.
 *
 * Pas de `created_at` / `updated_at` : une ligne n'est jamais modifiée sur
 * place, elle est effacée puis réécrite. Trois horodatages dont un seul aurait
 * du sens seraient trois occasions de se tromper de colonne.
 */
export const weatherForecasts = pgTable(
  'weather_forecasts',
  {
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id, { onDelete: 'cascade' }),
    /** Jour civil couvert, dans le fuseau de l'application. */
    forecastDate: date('forecast_date').notNull(),
    /** Instant du relevé qui a écrit cette ligne. */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    /** Code temps WMO 4677 **dominant** de la journée. */
    weatherCode: integer('weather_code'),
    temperatureMaxC: real('temperature_max_c'),
    temperatureMinC: real('temperature_min_c'),
    /** Ressenti : humidité, vent et rayonnement compris. */
    apparentTemperatureMaxC: real('apparent_temperature_max_c'),
    apparentTemperatureMinC: real('apparent_temperature_min_c'),
    /** Cumul de précipitations **sur toute la journée**, en mm. */
    precipitationSumMm: real('precipitation_sum_mm'),
    /** Probabilité de précipitations la plus forte de la journée, en %. */
    precipitationProbabilityMaxPct: real('precipitation_probability_max_pct'),
    windSpeedMaxKmh: real('wind_speed_max_kmh'),
  },
  (table) => [
    /**
     * Un athlète, un jour, une prévision. La clé est aussi le chemin d'accès de
     * la seule lecture d'écran (« les prévisions de cet athlète entre deux
     * dates »), qui parcourt donc un intervalle contigu de l'index.
     */
    primaryKey({ columns: [table.athleteId, table.forecastDate] }),
  ],
);

/**
 * Le relevé bien-être d'une journée — **une ligne par athlète et par jour**.
 *
 * Ces mesures ne sont **pas produites par Trainarr** : elles sont prises par la
 * montre (HRV nocturne, FC de repos, sommeil) ou par la balance, synchronisées
 * vers intervals.icu par HealthFit, et rapatriées telles quelles par le relevé
 * quotidien (`src/lib/intervals/wellness-service.ts`). L'application les stocke,
 * les montre et les donne à lire au coach ; elle n'en dérive aucun calcul physio.
 *
 * **Rien de ce qu'intervals.icu calcule n'entre ici** : ni `ctl`, ni `atl`, ni
 * `rampRate`. Trainarr calcule les siens depuis ses propres activités, et deux
 * charges concurrentes sous le même nom seraient la pire donnée possible — celle
 * dont personne ne sait laquelle croire.
 *
 * **Une mesure absente est `NULL`, jamais `0`.** Une nuit sans ceinture n'est pas
 * une HRV nulle, et une journée sans pesée n'est pas un poids de zéro. C'est la
 * règle du projet, et c'est aussi ce qui fait que les lignes se **complètent**
 * après coup : la montre synchronise en retard, un jour déjà écrit peut recevoir
 * son sommeil plusieurs heures plus tard (cf. `saveWellnessDays`, qui ne remplace
 * jamais une valeur connue par un trou).
 *
 * Pas de `created_at` : la date de la ligne *est* le jour qu'elle décrit.
 * `updated_at` dit quand le relevé l'a touchée pour la dernière fois.
 */
export const wellnessDays = pgTable(
  'wellness_days',
  {
    /**
     * `ON DELETE CASCADE` : un relevé bien-être n'a aucun sens sans son athlète,
     * et c'est une donnée rapatriée — elle se reconstruit d'un appel.
     */
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id, { onDelete: 'cascade' }),
    /** Jour civil décrit, dans le fuseau de l'athlète (tel qu'intervals.icu le date). */
    day: date('day').notNull(),
    /** FC de repos de la journée, en bpm. */
    restingHrBpm: integer('resting_hr_bpm'),
    /**
     * Variabilité cardiaque nocturne **rMSSD**, en millisecondes.
     *
     * Deux colonnes pour « la HRV », et c'est voulu : `hrvSdnnMs` porte l'autre
     * grandeur (SDNN), qui n'est ni la même mesure ni la même échelle. Selon le
     * modèle, une montre pousse l'une **ou** l'autre ; les ranger ensemble
     * donnerait une série qui saute d'un facteur deux au changement d'appareil
     * sans que rien ne l'ait indiqué (cf. `src/lib/wellness/hrv.ts`).
     */
    hrvRmssdMs: real('hrv_rmssd_ms'),
    /** Variabilité cardiaque nocturne **SDNN**, en millisecondes. */
    hrvSdnnMs: real('hrv_sdnn_ms'),
    /** Temps de sommeil, en secondes. */
    sleepTimeS: integer('sleep_time_s'),
    /** Score de sommeil de la montre, sur 100. Ce n'est pas un calcul de Trainarr. */
    sleepScore: real('sleep_score'),
    /** FC moyenne pendant le sommeil, en bpm. */
    avgSleepingHrBpm: real('avg_sleeping_hr_bpm'),
    /**
     * Poids du jour, en kg — celui de la balance, **pas** celui du profil.
     *
     * Décision, et non oubli : `athlete.weight_kg` reste saisi à la main. Une
     * balance qui réécrirait le profil sans accord est exactement ce qu'on
     * refuse pour les fréquences cardiaques, dont l'application propose la mise
     * à jour au lieu de l'appliquer.
     */
    weightKg: real('weight_kg'),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Un athlète, un jour, une ligne. La clé est aussi le chemin d'accès de
     * toutes les lectures (« le bien-être de cet athlète entre deux dates »),
     * qui parcourent donc un intervalle contigu de l'index — et c'est elle qui
     * porte l'idempotence du relevé, dont chaque passage réécrit les quatorze
     * derniers jours.
     */
    primaryKey({ columns: [table.athleteId, table.day] }),
  ],
);

/**
 * États d'un plan.
 *
 * - `draft` : la proposition que le coach vient d'écrire, soumise à l'athlète.
 *   Elle n'existe que pour être lue et tranchée — rien d'autre dans l'appli ne
 *   la regarde (ni le tableau de bord, ni le rapprochement des imports, ni la
 *   synchronisation intervals.icu, qui filtrent tous sur `active`) ;
 * - `active` : le plan que l'athlète suit. Un seul par athlète à la fois, garanti
 *   par l'index partiel ci-dessous ;
 * - `archived` : un plan que l'athlète ne suit plus.
 *
 * L'index partiel ne porte que sur `active` : les brouillons comme les archives
 * s'accumulent librement sous le même athlète du point de vue de la base. Le
 * « au plus un brouillon » est, lui, tenu par le DAL (`src/data/plans.ts`), qui
 * supprime le précédent avant d'en écrire un nouveau.
 */
export const PLAN_STATUSES = ['draft', 'active', 'archived'] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Nature de l'objectif, qui décide de ce qui date le plan.
 *
 * - `race` : une échéance réelle (« 10 km sous 50 min le 15 novembre ») —
 *   `race_date` est alors renseignée et c'est elle qui fixe la fin du travail ;
 * - `free` : un cap sans date (« améliorer mon endurance ») — la durée est
 *   donnée en semaines, `race_date` reste `NULL`.
 */
export const PLAN_GOAL_TYPES = ['race', 'free'] as const;

export type PlanGoalType = (typeof PLAN_GOAL_TYPES)[number];

/**
 * Ce que l'athlète vient chercher dans son plan — le paramètre qui décide de sa
 * **forme** (longueur de la base, existence d'une spécificité, nombre de séances
 * dures, plafond de la sortie longue, marche/course d'une reprise).
 *
 * C'est le sélecteur du formulaire de création, et il a remplacé l'objectif en
 * texte libre : `goal_text` n'est plus qu'une note facultative. `goal_type` reste
 * **solidaire** de cette colonne — `intent = 'race'` si et seulement si
 * `goal_type = 'race'` (invariant porté par le DAL) : les deux disent la même
 * chose, l'une pour la structure du plan, l'autre pour ce qui le date.
 *
 * La liste est recopiée plutôt qu'importée — la base ne dépend pas du module de
 * calcul — mais `satisfies` interdit qu'elle en diverge : une intention ajoutée
 * dans `lib/plan-skeleton/intent.ts` et oubliée ici ne compilerait plus.
 */
export const PLAN_INTENTS = [
  'race',
  'faster',
  'weight_loss',
  'return',
] as const satisfies readonly PlanIntent[];

/**
 * Niveau en course de l'athlète, déclaré à la création du plan.
 *
 * - `beginner` : moins d'un an de pratique, ou une pratique intermittente ;
 * - `intermediate` : un à trois ans de pratique régulière ;
 * - `advanced` : plusieurs années d'entraînement structuré.
 *
 * Il conditionne la méthodologie que le coach applique (volume de qualité,
 * longueur des blocs, progression). Il se choisit **à la création** et ne bouge
 * plus : changer de niveau, c'est régénérer un plan.
 */
export const PLAN_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;

export type PlanLevel = (typeof PLAN_LEVELS)[number];

/**
 * Distances sur lesquelles l'athlète peut déclarer un chrono de référence.
 *
 * Ce sont exactement les ancres de `lib/metrics/vdot` (`REFERENCE_DISTANCES`) :
 * le couple (distance, temps) sert à calculer un VDOT (Daniels & Gilbert, 1979),
 * donc la table d'allures E/M/T/I/R que le coach reçoit comme prescription.
 *
 * La liste est recopiée plutôt qu'importée — la base ne dépend pas du module de
 * calcul — mais `satisfies` interdit qu'elle en diverge : une ancre ajoutée là-bas
 * et oubliée ici ne compilerait plus.
 */
export const PLAN_REFERENCE_DISTANCES = [
  '5k',
  '10k',
  'half',
  'marathon',
] as const satisfies readonly ReferenceDistance[];

export type PlanReferenceDistance = (typeof PLAN_REFERENCE_DISTANCES)[number];

/**
 * Un plan d'entraînement, tel que le coach IA le construit à partir des
 * contraintes de l'athlète.
 *
 * **Invariants** (portés par le DAL, `src/data/plans.ts`) :
 * - `race_date` est renseignée si et seulement si `goal_type = 'race'` ;
 * - la fenêtre couverte est `[starts_on, starts_on + weeks × 7)` — toute séance
 *   du plan y tombe ;
 * - `weeks ≥ 1`, `1 ≤ sessions_per_week ≤ 7`, `long_run_day ∈ 1..7` ;
 * - un seul plan actif par athlète, garanti par la base (index partiel) : une
 *   création archive le précédent dans la même transaction.
 *
 * `sessions_per_week`, `weekly_time_minutes` et `long_run_day` restent les
 * **contraintes déclarées** par l'athlète, pas un résumé des séances écrites :
 * elles survivent au remplacement des séances futures (« je préfère 3 séances au
 * lieu de 4 ») et c'est sur elles que le coach régénère.
 */
export const plans = pgTable(
  'plans',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    status: text('status', { enum: PLAN_STATUSES }).notNull(),
    goalType: text('goal_type', { enum: PLAN_GOAL_TYPES }).notNull(),
    /**
     * L'intention du plan, choisie au sélecteur à la création
     * ({@link PLAN_INTENTS}). Les plans antérieurs à cette colonne ont été
     * repris par la migration : `goal_type = 'race'` → `'race'`, tout le reste
     * → `'faster'`, qui est la structure que ces plans-là recevaient déjà.
     */
    intent: text('intent', { enum: PLAN_INTENTS }).notNull(),
    /**
     * L'athlète a déclaré un **antécédent de blessure** à la création. Ne joue
     * qu'en reprise (`intent = 'return'`), où il rallonge la base et double la
     * fenêtre de marche/course — c'est le prédicteur le plus fort du dossier
     * (OR 7,56, Relph 2023). `false` partout ailleurs.
     */
    returnInjuryHistory: boolean('return_injury_history').notNull().default(false),
    /**
     * Niveau déclaré par l'athlète à la création. **Nullable** : les plans
     * antérieurs à ce champ n'en portent pas, et rien ne permet de le deviner
     * après coup — mieux vaut ne rien dire au coach que lui inventer un niveau.
     */
    level: text('level', { enum: PLAN_LEVELS }),
    /** Objectif tel que l'athlète l'a formulé, conservé mot pour mot. */
    goalText: text('goal_text').notNull(),
    /**
     * Date civile (mode `string`, `YYYY-MM-DD`) de la course visée. `NULL` pour
     * un objectif libre — jamais une date inventée pour combler la colonne.
     */
    raceDate: date('race_date'),
    /** Date civile du premier jour couvert par le plan. */
    startsOn: date('starts_on').notNull(),
    /** Durée du plan en semaines pleines à partir de `starts_on`. */
    weeks: integer('weeks').notNull(),
    /** Nombre de séances par semaine demandé par l'athlète (1 à 7). */
    sessionsPerWeek: integer('sessions_per_week').notNull(),
    /** Temps hebdomadaire disponible, en minutes. `NULL` si non renseigné. */
    weeklyTimeMinutes: integer('weekly_time_minutes'),
    /** Jour de la sortie longue, au format ISO-8601 : 1 = lundi … 7 = dimanche. */
    longRunDay: integer('long_run_day').notNull(),
    /**
     * Chrono de course récent déclaré à la création : la distance courue et le
     * temps réalisé, en secondes.
     *
     * **Les deux vont ensemble** — les deux `NULL`, ou les deux renseignées
     * (invariant porté par le DAL) : une distance sans temps ne calcule rien, un
     * temps sans distance non plus. C'est de ce couple que se déduit le VDOT,
     * donc la table d'allures imposée au coach ; sans lui, le plan retombe sur
     * l'allure d'entraînement récente, bien moins fiable.
     */
    referenceDistance: text('reference_distance', { enum: PLAN_REFERENCE_DISTANCES }),
    referenceTimeS: integer('reference_time_s'),
    /**
     * Date civile de la dernière **mise à jour** du chrono de référence par un
     * test chronométré. `NULL` tant qu'aucun test ne l'a fait bouger — le chrono
     * est alors celui de la création, et c'est `starts_on` qui sert d'ancre.
     *
     * Cette date porte la **cadence** de Daniels : pas plus d'une mise à jour
     * toutes les quatre semaines (`REFERENCE_UPDATE_MIN_GAP_DAYS`). Ce n'est
     * donc pas un champ d'affichage qu'on pourrait dériver d'ailleurs, c'est
     * l'état d'une règle.
     */
    referenceUpdatedOn: date('reference_updated_on'),
    /**
     * Ce que le dernier test a donné, en une phrase française destinée à
     * l'athlète — `NULL` tant qu'aucun test n'a été couru.
     *
     * Écrite **quel que soit le verdict**, y compris quand rien ne bouge : une
     * contre-performance qui ne dégrade rien doit se lire, sans quoi le plan
     * aurait des décisions que personne ne voit. C'est le strict minimum qui
     * informe vraiment, en attendant un journal du coach.
     */
    lastTestNote: text('last_test_note'),
    /** Approche du plan rédigée par le coach (markdown). `NULL` tant qu'il n'a rien écrit. */
    summary: text('summary'),
    /**
     * Nombre de séances **réalisées** du plan que la dernière révision
     * automatique a déjà prises en compte.
     *
     * C'est le marqueur qui cadence la relecture du plan par le coach : le
     * service de révision compare ce compte à celui des séances réalisées à ce
     * jour, et ne se déclenche qu'au-delà d'un écart de quelques séances. Un
     * compte plutôt qu'une date, parce que c'est bien l'entraînement réalisé —
     * pas le temps passé — qui donne matière à réviser.
     *
     * `0` sur un plan neuf : tout ce qui sera couru reste à examiner.
     */
    reviewedSessionCount: integer('reviewed_session_count').notNull().default(0),
    /**
     * Instant de la dernière révision automatique réussie, `NULL` tant qu'il n'y
     * en a pas eu — l'UI ne date alors rien plutôt que d'afficher la création du
     * plan pour une révision.
     */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Un seul plan actif par athlète. Index **partiel** : la clé n'existe que
     * pour les lignes `status = 'active'`, si bien que les plans archivés
     * s'accumulent librement sous le même athlète.
     *
     * Comme pour le singleton d'`athlete`, c'est la contrainte — et non la
     * lecture préalable du DAL — qui ferme la course : en `READ COMMITTED`, deux
     * créations simultanées voient toutes les deux l'ancien plan encore actif et
     * insèrent chacune le leur.
     */
    uniqueIndex('plans_active_per_athlete').on(table.athleteId).where(sql`status = 'active'`),
    /**
     * Une seule **proposition** en attente par athlète, pour la même raison et
     * par le même moyen : le DAL efface le brouillon précédent avant d'insérer
     * le nouveau, mais en `READ COMMITTED` deux générations lancées en même
     * temps ne voient chacune que le brouillon d'avant — et en laisseraient
     * deux, dont un que la lecture `LIMIT 1` choisirait au hasard.
     *
     * Conséquence assumée : la seconde génération concurrente échoue sur la
     * contrainte plutôt que d'écrire un doublon silencieux. Le DAL traduit la
     * violation en erreur métier lisible (`ConcurrentDraftError`).
     */
    uniqueIndex('plans_draft_per_athlete').on(table.athleteId).where(sql`status = 'draft'`),
  ],
);

/**
 * Une séance planifiée : une case du calendrier.
 *
 * Deux descriptions cohabitent, et c'est voulu : les textes libres (`warmup`,
 * `recovery`, `cooldown`) que le coach rédige et que l'UI restitue tels quels,
 * et `steps`, le déroulé **structuré** en blocs d'étapes (cf.
 * `lib/plan-steps/schema`) qu'un lecteur de montre peut exécuter. `steps` est
 * nullable : les séances déjà planifiées n'en portent pas, et le coach peut
 * proposer une séance qui ne se structure pas (« sortie libre au feeling »).
 *
 * `plan_id` est **nullable** : une séance peut exister hors plan (jeu de
 * développement, séances historiques antérieures au premier plan). Rattachée à
 * un plan, elle disparaît avec lui (`ON DELETE CASCADE`).
 *
 * `completed_activity_id` fait la jonction avec le réalisé : une séance déjà
 * rapprochée d'une activité n'est jamais réécrite par une régénération du plan.
 */
export const plannedSessions = pgTable(
  'planned_sessions',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    /** Plan dont la séance fait partie. `null` pour une séance hors plan. */
    planId: integer('plan_id').references(() => plans.id, { onDelete: 'cascade' }),
    /** Date civile (mode `string`, `YYYY-MM-DD`) : une séance est planifiée un jour, pas à une heure. */
    scheduledOn: date('scheduled_on').notNull(),
    /** Ex. « VMA courte · piste ». */
    kind: text('kind').notNull(),
    /** Ex. « 6 × 800 m ». */
    title: text('title').notNull(),
    targetPaceSecPerKm: real('target_pace_sec_per_km'),
    /** Textes libres affichés tels quels, ex. « 20 min @ 5:30/km ». */
    warmup: text('warmup'),
    recovery: text('recovery'),
    cooldown: text('cooldown'),
    /**
     * Déroulé structuré de la séance, `null` quand elle n'en a pas.
     *
     * En `jsonb` plutôt qu'en tables `blocks`/`steps` : la donnée est lue et
     * écrite d'un seul tenant avec sa séance, jamais interrogée par étape — deux
     * tables de plus coûteraient deux jointures pour zéro requête gagnée. Sa
     * forme est tenue par Zod à l'écriture (`planSessionStepsSchema`).
     */
    steps: jsonb('steps').$type<PlanSessionSteps>(),
    volumeM: real('volume_m'),
    durationS: integer('duration_s'),
    /** Activité qui a réalisé la séance. `null` tant qu'elle n'est pas faite (ou pas rapprochée). */
    completedActivityId: integer('completed_activity_id').references(() => activities.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    index('planned_sessions_athlete_scheduled_on_idx').on(table.athleteId, table.scheduledOn),
    /** Chemin d'accès des lectures « les séances de ce plan » (affichage, régénération). */
    index('planned_sessions_plan_id_idx').on(table.planId),
  ],
);

/**
 * D'où vient une réévaluation de plan en attente.
 *
 * Deux déclencheurs, et deux seulement : la **revue** périodique du coach
 * (`lib/ai/review-service.ts`, toutes les quelques séances réalisées) et un
 * **test chronométré** qui recalibre les allures (`lib/ai/fitness-test-service.ts`).
 * L'ajustement demandé par l'athlète depuis la page du plan n'en est pas : elle
 * l'a demandé, il s'applique directement.
 *
 * La source décide de ce que le dépôt marque comme déjà examiné (cf.
 * `src/data/plan-revisions.ts`) : le compte de séances relues d'un côté, la date
 * du dernier test pris en compte de l'autre.
 */
export const PLAN_REVISION_SOURCES = ['review', 'fitness-test'] as const;

export type PlanRevisionSource = (typeof PLAN_REVISION_SOURCES)[number];

/**
 * Le sens d'une réévaluation, tel que le calcul le rend — jamais tel qu'un
 * service ou un modèle le déclarerait (cf. `lib/plan-revision/direction.ts`).
 *
 * Recopié plutôt qu'importé — la base ne dépend pas du module de calcul — mais
 * `satisfies` interdit qu'il en diverge.
 */
export const PLAN_REVISION_DIRECTIONS = [
  'increase',
  'decrease',
  'neutral',
] as const satisfies readonly PlanRevisionDirection[];

/**
 * Une **réévaluation de plan proposée**, en attente de la décision de l'athlète.
 *
 * ## Pourquoi cette table existe
 *
 * La revue périodique et la recalibration d'après test réécrivaient la suite du
 * plan **directement**, en tâche de fond après un import : le plan changeait
 * sans accord, et l'athlète le découvrait en ouvrant son calendrier. Elles
 * déposent désormais une proposition ici, et rien ne s'applique tant qu'elle
 * n'est pas acceptée.
 *
 * Une proposition qui ne survivrait pas à un redémarrage ne serait pas une
 * proposition : le calcul coûte plusieurs minutes de modèle, et le conteneur
 * redémarre à chaque déploiement. D'où une table, et non un état de processus
 * comme les verrous des deux services.
 *
 * ## Ce qu'elle porte, et pourquoi
 *
 * - `payload` : **le contenu exact calculé**, dans la forme que le DAL sait
 *   rejouer (`PlanUpdate` — jour de reprise, séances, réglages). Accepter
 *   applique ce payload tel quel : recalculer au moment du clic donnerait un
 *   autre plan que celui qui a été montré, et l'accord ne porterait plus sur
 *   rien. Sa forme est tenue par Zod à l'écriture **et** à la lecture
 *   (`src/data/plan-revisions.ts`) : Postgres rend ce qu'une version antérieure
 *   du code y a écrit.
 * - `direction` et les quatre totaux : ce que la proposition change à la charge,
 *   calculé (cf. {@link PLAN_REVISION_DIRECTIONS}) et stocké — l'écran l'affiche
 *   sans avoir à relire le plan.
 * - `plan_updated_at` : l'état du plan **au moment du calcul**. Un ajustement
 *   manuel, un déplacement de séance ou un archivage survenus entre-temps le
 *   font bouger, et la proposition devient alors périmée : elle décrit une suite
 *   qui ne prolonge plus le plan qu'elle visait. C'est ce témoin qui permet de le
 *   dire plutôt que d'écrire par-dessus.
 *
 * ## Au plus une proposition en attente par athlète
 *
 * L'index unique le garantit, comme `plans_draft_per_athlete` garantit un seul
 * brouillon. Il n'a **pas** de prédicat partiel, et c'est parce que cette table
 * n'a pas d'autre état : une décision — acceptation comme refus — supprime la
 * ligne. Toute ligne présente est donc en attente, et un prédicat
 * `WHERE status = 'pending'` ne filtrerait rien tout en obligeant à porter une
 * colonne qui ne prendrait jamais qu'une valeur.
 */
export const planRevisions = pgTable(
  'plan_revisions',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    /** Plan visé. La proposition disparaît avec lui (`ON DELETE CASCADE`). */
    planId: integer('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    source: text('source', { enum: PLAN_REVISION_SOURCES }).notNull(),
    /**
     * Pourquoi le plan doit être réévalué, en une ou deux phrases françaises —
     * rédigée par le service au moment du calcul (le constat de la revue, ou la
     * note du test).
     */
    reason: text('reason').notNull(),
    direction: text('direction', { enum: PLAN_REVISION_DIRECTIONS }).notNull(),
    /** Nombre de semaines réécrites — « sur les 3 semaines restantes ». */
    weeks: integer('weeks').notNull(),
    /** Ce que le plan prescrit encore sur la fenêtre, avant la proposition. */
    beforeVolumeKm: real('before_volume_km').notNull(),
    beforeIntensityKm: real('before_intensity_km').notNull(),
    /** Ce que la proposition y mettrait. */
    afterVolumeKm: real('after_volume_km').notNull(),
    afterIntensityKm: real('after_intensity_km').notNull(),
    /** Le contenu rejouable de la proposition (cf. l'en-tête). */
    payload: jsonb('payload').$type<PlanRevisionPayload>().notNull(),
    /** `plans.updated_at` au moment du calcul — le témoin de péremption. */
    planUpdatedAt: timestamp('plan_updated_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('plan_revisions_pending_per_athlete').on(table.athleteId),
    /** Chemin d'accès de la purge d'un plan archivé. */
    index('plan_revisions_plan_id_idx').on(table.planId),
  ],
);

/**
 * Le verdict d'une revue de plan : le plan tient, ou il est recalculé.
 *
 * Recopié depuis le contrat de sortie du coach (`lib/ai/plan-schema.ts`) plutôt
 * qu'importé — la base ne dépend pas du module qui parle au modèle.
 */
export const PLAN_REVIEW_VERDICTS = ['keep', 'adjust'] as const;

export type PlanReviewVerdict = (typeof PLAN_REVIEW_VERDICTS)[number];

/**
 * Le **journal des décisions de revue** : ce que le coach a conclu, sur quoi, et
 * quand.
 *
 * ## Pourquoi cette table existe
 *
 * Une revue qui conclut « adjust » laisse une trace — la proposition déposée
 * dans `plan_revisions`. Une revue qui conclut « keep » n'en laissait aucune :
 * elle avançait le marqueur, écrivait une ligne de log, et disparaissait au
 * redémarrage du conteneur. Or c'est le verdict le plus fréquent, et de loin.
 * Impossible, dans ces conditions, de répondre à la seule question qui vaille
 * sur un juge : rend-il la même décision deux fois sur des situations
 * semblables ? Le journal la rend vérifiable, en gardant côte à côte le verdict,
 * sa justification et les entrées qui l'ont produit.
 *
 * **Il observe, il ne gouverne pas** : rien dans l'application ne le lit pour
 * décider quoi que ce soit, et une panne d'écriture n'interrompt pas la revue
 * (cf. `lib/ai/review-service.ts`). Le marqueur qui cadence les revues reste
 * `plans.reviewed_session_count` — pas cette table.
 *
 * ## Le résumé des entrées, et pas les entrées
 *
 * Quatre chiffres et un rang de semaine, en colonnes simples : ce qu'il faut
 * pour reconnaître deux situations semblables, et rien de plus. Le bilan complet
 * envoyé au modèle (séance par séance, le plan restant, l'état de forme) se
 * recalcule depuis les activités et le plan, qui sont la source de vérité — le
 * copier ici en ferait une seconde, qui divergerait.
 *
 * ## `revision_id` sans clé étrangère, délibérément
 *
 * Une ligne de `plan_revisions` est **éphémère** : accepter ou refuser la
 * supprime. Une clé étrangère obligerait donc à effacer le lien (`SET NULL`) au
 * moment précis où la décision de l'athlète devient intéressante, ou à retenir
 * une ligne que le DAL veut supprimer. L'identifiant est gardé tel quel : c'est
 * une trace, pas une jointure garantie.
 */
export const planReviewDecisions = pgTable(
  'plan_review_decisions',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    /** Plan relu. Le journal disparaît avec lui (`ON DELETE CASCADE`). */
    planId: integer('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    verdict: text('verdict', { enum: PLAN_REVIEW_VERDICTS }).notNull(),
    /** Ce que le modèle a dit de sa décision, en une ou deux phrases. */
    reason: text('reason').notNull(),
    /** Rang de la semaine du plan au jour de la décision : 1 = première semaine. */
    planWeek: integer('plan_week').notNull(),
    /** Séances réalisées sur la fenêtre relue (le détail **et** les plus anciennes). */
    sessionsCompleted: integer('sessions_completed').notNull(),
    /** Séances manquées sur cette même fenêtre. */
    sessionsMissed: integer('sessions_missed').notNull(),
    /**
     * La charge du jour telle que le modèle l'a lue. `NULL` quand elle n'était
     * pas calculable — un zéro serait une donnée inventée.
     */
    ctl: real('ctl'),
    atl: real('atl'),
    tsb: real('tsb'),
    /**
     * La proposition déposée par cette décision, `NULL` quand il n'y en a pas :
     * un « keep », ou un « adjust » abandonné avant le dépôt (plan modifié
     * pendant la reconstruction, plan archivé, dépôt concurrent).
     */
    revisionId: integer('revision_id'),
    createdAt: createdAt(),
  },
  (table) => [
    /** Chemin d'accès de la lecture : les décisions d'un athlète, les récentes d'abord. */
    index('plan_review_decisions_athlete_created_at_idx').on(table.athleteId, table.createdAt),
  ],
);

/**
 * Le retour du coach sur une séance réalisée, en markdown.
 *
 * **Une ligne au plus par activité** (index unique) : le feedback n'est pas un
 * historique de conversation, c'est l'analyse courante de la séance — la
 * régénérer écrase la précédente (`ON CONFLICT (activity_id)`).
 *
 * `model` garde le modèle qui a rédigé le texte : le coach est multi-provider,
 * et un feedback ancien doit rester attribuable après un changement de modèle.
 * `NULL` quand la provenance n'est pas connue.
 */
export const activityFeedbacks = pgTable('activity_feedbacks', {
  id: serial('id').primaryKey(),
  activityId: integer('activity_id')
    .notNull()
    .unique()
    .references(() => activities.id, { onDelete: 'cascade' }),
  /** Texte markdown rendu tel quel par l'UI. */
  content: text('content').notNull(),
  /** Identifiant du modèle ayant rédigé le feedback, ex. `claude-opus-5`. */
  model: text('model'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Qui a écrit un message du fil du coach.
 *
 * Les deux seuls rôles que la conversation connaît, et ceux qu'attend une API
 * de complétion : `user` pour l'athlète, `assistant` pour le coach. Les
 * instructions système ne sont **pas** persistées — elles sont reconstruites à
 * chaque appel à partir des données d'entraînement du moment, et les figer en
 * base ferait répondre le coach sur une forme périmée.
 */
export const COACH_MESSAGE_ROLES = ['user', 'assistant'] as const;

export type CoachMessageRole = (typeof COACH_MESSAGE_ROLES)[number];

/**
 * Le fil de discussion avec le coach.
 *
 * **Un seul fil, pas de colonne de conversation** : l'application est
 * mono-utilisateur et le coach y est un interlocuteur continu, qui se souvient
 * d'une session à l'autre. Introduire un identifiant de fil coûterait une
 * gestion (créer, choisir, renommer, archiver) que rien dans l'appli ne
 * réclame, et une lecture « le fil courant » qu'il faudrait de toute façon
 * définir. La conséquence est assumée : repartir de zéro, c'est vider la table
 * pour l'athlète — d'où `clearCoachConversation` dans le DAL, seule façon de
 * remettre le compteur à zéro.
 *
 * Rien d'autre que le rôle, le texte et l'instant : le modèle qui a rédigé la
 * réponse n'est pas conservé (contrairement à `activity_feedbacks`, dont un
 * texte isolé reste attribuable des mois plus tard) — dans un fil, c'est
 * l'échange qui fait sens, pas la provenance de chaque tour.
 */
export const coachMessages = pgTable(
  'coach_messages',
  {
    id: serial('id').primaryKey(),
    athleteId: integer('athlete_id')
      .notNull()
      .references(() => athlete.id),
    role: text('role', { enum: COACH_MESSAGE_ROLES }).notNull(),
    /** Texte brut du tour de parole, rendu tel quel (markdown côté assistant). */
    content: text('content').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * Chemin d'accès de la seule lecture qui existe : « les N derniers messages
     * de l'athlète, dans l'ordre du temps ». Le btree se parcourt dans les deux
     * sens, ce même index sert donc la lecture décroissante (`LIMIT N`) comme
     * l'affichage croissant.
     */
    index('coach_messages_athlete_created_at_idx').on(table.athleteId, table.createdAt),
  ],
);

/* =========================================================================
 * Authentification (better-auth)
 *
 * Les quatre tables que better-auth attend, dérivées de `getAuthTables()`
 * (@better-auth/core/db) — sa source de vérité, celle que sa CLI utilise elle
 * aussi pour générer un schéma. Une colonne manquante ou d'un autre type ne se
 * verrait pas à la compilation : elle casserait à la première connexion.
 *
 * **Préfixe `auth_` sur les quatre noms de tables.** Deux raisons : `user` est
 * un mot réservé SQL (toute requête écrite à la main devrait le mettre entre
 * guillemets), et `session` comme `account` sont des noms trop génériques à
 * côté d'`athlete` — le préfixe dit d'un coup d'œil qui possède ces tables.
 * better-auth n'en sait rien et n'a pas à le savoir : ses noms de modèles
 * restent `user`/`session`/`account`/`verification`, la correspondance vers ces
 * tables-ci se fait dans `auth-adapter.ts`.
 *
 * En revanche les **clés TypeScript des colonnes gardent le nom de champ exact
 * de better-auth** (`emailVerified`, `expiresAt`, `userId`…) : l'adaptateur
 * Drizzle indexe la table par ce nom-là (`table[fieldName]`). Seul le nom de
 * colonne en base est libre, d'où le snake_case habituel du fichier.
 * ========================================================================= */

/**
 * Un compte capable de se connecter.
 *
 * `emailVerified` est conservée bien qu'aucun e-mail ne parte d'ici (appli
 * auto-hébergée, pas de serveur SMTP) : better-auth l'écrit à chaque création
 * de compte, elle ne peut pas être omise.
 */
export const authUsers = pgTable(
  'auth_users',
  {
    /** Identifiant opaque généré par better-auth (chaîne aléatoire), pas un serial. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    /** URL d'avatar — inutilisée ici, mais écrite par better-auth. */
    image: text('image'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * Marque le compte créé par la porte d'amorçage — celle qui n'est ouverte
     * que tant qu'aucun compte n'existe (cf. `src/lib/auth/`).
     *
     * Elle n'existe que pour l'index partiel ci-dessous : c'est lui qui ferme
     * la course entre deux inscriptions simultanées sur une base vide. Un
     * simple « compter les comptes puis insérer » ne la voit pas venir — en
     * `READ COMMITTED`, les deux requêtes comptent zéro. Ici, les deux
     * insertions portent `true`, et la base n'en accepte qu'une (`23505`).
     *
     * Nullable et jamais lue par l'application : les comptes créés plus tard
     * (invitations, étape 4) la laissent vide.
     */
    isFirstAccount: boolean('is_first_account'),
  },
  (table) => [
    /**
     * Index partiel : seules les lignes à `true` y entrent, et elles y portent
     * toutes la même clé. Le second compte d'amorçage est donc rejeté par la
     * base, pas par une lecture préalable. Rien n'est consommé au passage — une
     * inscription qui échoue ne laisse aucune trace et la porte reste ouverte.
     */
    uniqueIndex('auth_users_first_account_unique')
      .on(table.isFirstAccount)
      .where(sql`${table.isFirstAccount}`),
  ],
);

/**
 * Une session ouverte. `token` est le secret présenté par le cookie : il est
 * unique, et c'est par lui que se fait la lecture à chaque requête.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Traçabilité d'une session ouverte, renseignée par better-auth. */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (table) => [
    /** Révoquer les sessions d'un compte, et les lister : deux lectures par `user_id`. */
    index('auth_sessions_user_id_idx').on(table.userId),
  ],
);

/**
 * Le moyen de connexion rattaché à un compte.
 *
 * Une seule ligne par compte ici, avec `provider_id = 'credential'` : c'est là
 * que vit le **hachage** du mot de passe (`password`), jamais dans `auth_users`.
 * Les colonnes de jetons OAuth restent vides — aucun fournisseur externe n'est
 * configuré (appli auto-hébergée) — mais better-auth les écrit le cas échéant.
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Hachage scrypt du mot de passe — jamais le mot de passe lui-même. */
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Lecture systématique à la connexion : « les moyens d'accès de ce compte ». */
    index('auth_accounts_user_id_idx').on(table.userId),
  ],
);

/**
 * Jetons à usage unique et à durée de vie courte (vérification d'e-mail,
 * réinitialisation de mot de passe). Table vide en pratique tant qu'aucun envoi
 * d'e-mail n'est configuré, mais better-auth l'exige dans son schéma.
 */
export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Un jeton se retrouve par son `identifier`, jamais par son id. */
    index('auth_verifications_identifier_idx').on(table.identifier),
  ],
);

/**
 * Invitations à créer un compte — la seule porte d'entrée une fois le compte
 * d'amorçage créé.
 *
 * **Le jeton n'est jamais stocké.** Seule son empreinte SHA-256 l'est, et c'est
 * par elle que se fait la recherche. Un hachage lent (scrypt, comme les mots de
 * passe) n'apporterait rien ici : il protège les secrets *devinables*, et un
 * jeton de 256 bits tirés au sort ne l'est pas. Ce que l'empreinte protège, en
 * revanche, c'est la fuite de base : une copie du dump ne donne aucun lien
 * utilisable.
 *
 * `consumed_at` est le **verrou d'usage unique**, et il est posé par une mise à
 * jour conditionnelle (`WHERE consumed_at IS NULL AND expires_at > now()`) et
 * non par une lecture suivie d'une écriture : en `READ COMMITTED`, Postgres
 * réévalue la clause sur la ligne verrouillée, si bien que deux réclamations
 * simultanées du même lien ne peuvent pas aboutir toutes les deux
 * (cf. `claimOrphanAthlete`, même motif).
 *
 * `consumed_by_user_id` est renseigné juste après la création du compte : au
 * moment où la ligne est verrouillée, l'identifiant n'existe pas encore — c'est
 * better-auth qui le génère.
 */
export const authInvitations = pgTable(
  'auth_invitations',
  {
    id: serial('id').primaryKey(),
    /** SHA-256 du jeton, en hexadécimal. Le jeton lui-même n'est écrit nulle part. */
    tokenHash: text('token_hash').notNull(),
    /** Le compte qui a émis l'invitation — le compte d'amorçage, seul habilité. */
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** `NULL` tant que le lien n'a pas servi. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /**
     * Le compte né de cette invitation. `SET NULL` à sa suppression : la trace
     * de la consommation reste (le lien a bien servi), seul le lien vers un
     * compte disparu s'efface.
     */
    consumedByUserId: text('consumed_by_user_id').references(() => authUsers.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    /**
     * Unicité de l'empreinte : c'est la clé de recherche du lien présenté, et
     * deux invitations ne peuvent pas désigner le même jeton (le tirage rend la
     * collision invraisemblable ; la base la rend impossible).
     */
    uniqueIndex('auth_invitations_token_hash_unique').on(table.tokenHash),
  ],
);

// Types inférés depuis le schéma — ne jamais les réécrire à la main.
export type Athlete = InferSelectModel<typeof athlete>;
export type NewAthlete = InferInsertModel<typeof athlete>;

export type Activity = InferSelectModel<typeof activities>;
export type NewActivity = InferInsertModel<typeof activities>;

export type ActivityStream = InferSelectModel<typeof activityStreams>;
export type NewActivityStream = InferInsertModel<typeof activityStreams>;

export type ActivityWeather = InferSelectModel<typeof activityWeather>;
export type NewActivityWeather = InferInsertModel<typeof activityWeather>;

export type WeatherForecastRun = InferSelectModel<typeof weatherForecastRuns>;
export type NewWeatherForecastRun = InferInsertModel<typeof weatherForecastRuns>;

export type WeatherForecast = InferSelectModel<typeof weatherForecasts>;
export type NewWeatherForecast = InferInsertModel<typeof weatherForecasts>;

export type WellnessDay = InferSelectModel<typeof wellnessDays>;
export type NewWellnessDay = InferInsertModel<typeof wellnessDays>;

export type Plan = InferSelectModel<typeof plans>;
export type NewPlan = InferInsertModel<typeof plans>;

export type PlanRevision = InferSelectModel<typeof planRevisions>;
export type NewPlanRevision = InferInsertModel<typeof planRevisions>;

export type PlanReviewDecision = InferSelectModel<typeof planReviewDecisions>;
export type NewPlanReviewDecision = InferInsertModel<typeof planReviewDecisions>;

export type PlannedSession = InferSelectModel<typeof plannedSessions>;
export type NewPlannedSession = InferInsertModel<typeof plannedSessions>;

export type ActivityFeedback = InferSelectModel<typeof activityFeedbacks>;
export type NewActivityFeedback = InferInsertModel<typeof activityFeedbacks>;

export type CoachMessage = InferSelectModel<typeof coachMessages>;
export type NewCoachMessage = InferInsertModel<typeof coachMessages>;

export type AuthUser = InferSelectModel<typeof authUsers>;
export type NewAuthUser = InferInsertModel<typeof authUsers>;

export type AuthInvitation = InferSelectModel<typeof authInvitations>;
export type NewAuthInvitation = InferInsertModel<typeof authInvitations>;
