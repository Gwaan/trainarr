import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { ReferenceDistance } from '@/lib/metrics/vdot';
import type { PlanIntent } from '@/lib/plan-skeleton/intent';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';
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

export type Plan = InferSelectModel<typeof plans>;
export type NewPlan = InferInsertModel<typeof plans>;

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
