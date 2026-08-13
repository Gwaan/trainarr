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

/** Profil de l'athlète. Application mono-utilisateur : une seule ligne, garantie par la base. */
export const athlete = pgTable(
  'athlete',
  {
    id: serial('id').primaryKey(),
    displayName: text('display_name').notNull(),
    sex: text('sex', { enum: ATHLETE_SEXES }),
    maxHrBpm: integer('max_hr_bpm'),
    restingHrBpm: integer('resting_hr_bpm'),
    weightKg: numeric('weight_kg', { precision: 5, scale: 2, mode: 'number' }),
    /** Date civile (mode `string`, `YYYY-MM-DD`) : pas d'heure, donc pas de fuseau. */
    birthDate: date('birth_date'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    /**
     * Contrainte de singleton : un index unique sur l'expression constante
     * `true` produit la même clé pour toute ligne, donc la seconde insertion
     * échoue (`23505`). C'est ce qui ferme la course entre deux soumissions
     * simultanées de l'onboarding — un `SELECT` suivi d'un `INSERT` en
     * `READ COMMITTED` ne la voit pas venir, les deux transactions lisant une
     * table encore vide. Côté DAL, `createAthlete` traduit la violation en
     * `AthleteAlreadyExistsError`.
     */
    uniqueIndex('athlete_singleton').on(sql`(true)`),
  ],
);

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

// Types inférés depuis le schéma — ne jamais les réécrire à la main.
export type Athlete = InferSelectModel<typeof athlete>;
export type NewAthlete = InferInsertModel<typeof athlete>;

export type Activity = InferSelectModel<typeof activities>;
export type NewActivity = InferInsertModel<typeof activities>;

export type ActivityStream = InferSelectModel<typeof activityStreams>;
export type NewActivityStream = InferInsertModel<typeof activityStreams>;

export type Plan = InferSelectModel<typeof plans>;
export type NewPlan = InferInsertModel<typeof plans>;

export type PlannedSession = InferSelectModel<typeof plannedSessions>;
export type NewPlannedSession = InferInsertModel<typeof plannedSessions>;

export type ActivityFeedback = InferSelectModel<typeof activityFeedbacks>;
export type NewActivityFeedback = InferInsertModel<typeof activityFeedbacks>;
