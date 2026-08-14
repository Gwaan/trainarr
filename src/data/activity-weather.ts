import 'server-only';

import { and, desc, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';

import {
  RETRY_DELAYS_MS,
  firstFixedPoint,
  type ActivityWeatherStatus,
  type Coordinates,
  type WeatherSource,
} from '@/lib/weather/plan';
import type { HourlyWeatherSample } from '@/lib/weather/client';

import { getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import {
  activities,
  activityStreams,
  activityWeather,
  type ActivityStreamData,
} from './db/schema';

/**
 * Météo des séances — lecture d'écran, et écritures du relevé.
 *
 * **Toute lecture et toute écriture est cloisonnée par athlète**, des deux
 * façons déjà en vigueur dans `./activities.ts` :
 *
 * - la lecture d'**écran** ({@link getActivityWeather}) résout l'athlète depuis
 *   la session et ne rend rien quand il n'y en a pas ;
 * - les fonctions du **service** (relevé après import, rattrapage) tournent hors
 *   requête : elles reçoivent l'athlète en paramètre, comme `ingestFitBuffer`.
 *   Il n'existe ici aucun chemin qui déduirait l'athlète autrement.
 *
 * Un identifiant d'activité qui n'appartient pas à l'appelant se comporte
 * **exactement** comme un identifiant inexistant : `null` à la lecture, `false`
 * à l'écriture. Jamais un refus distinct — il révélerait l'existence de la ligne.
 * Chaque requête pose la condition d'athlète dans sa jointure sur `activities`,
 * qui porte seule l'appartenance (la table météo n'a pas de colonne `athlete_id`,
 * cf. le schéma).
 */

/**
 * La météo telle que l'UI la reçoit.
 *
 * DTO minimal : ni `attempts`, ni `failure_reason`, ni les coordonnées. Les deux
 * premiers sont de la mécanique de service ; les dernières n'ont rien à faire
 * dans un document envoyé au navigateur — les avoir arrondies avant de les
 * envoyer à un tiers et les renvoyer ensuite au client serait absurde.
 *
 * `status` franchit la frontière parce qu'il **porte du sens pour l'athlète** :
 * une séance sur tapis n'a pas de météo, et l'écran doit pouvoir le dire au lieu
 * d'afficher un vide indistinct de « pas encore relevé ».
 */
export type ActivityWeatherDto = {
  status: ActivityWeatherStatus;
  source: WeatherSource | null;
  /** Heure horaire retenue par Open-Meteo. `null` hors `observed`. */
  observedAt: Date | null;
  temperatureC: number | null;
  /** Ressenti : humidité, vent et rayonnement compris. */
  apparentTemperatureC: number | null;
  /** Cumul de l'heure précédant `observedAt` (sémantique Open-Meteo). */
  precipitationMm: number | null;
  windSpeedKmh: number | null;
  /** Direction **d'où vient** le vent, en degrés (0 = nord). */
  windDirectionDeg: number | null;
  relativeHumidityPct: number | null;
  /** Code temps WMO 4677. */
  weatherCode: number | null;
};

/** Colonnes du DTO, en un seul endroit : lecture d'écran et tests s'y alignent. */
const dtoColumns = {
  status: activityWeather.status,
  source: activityWeather.source,
  observedAt: activityWeather.observedAt,
  temperatureC: activityWeather.temperatureC,
  apparentTemperatureC: activityWeather.apparentTemperatureC,
  precipitationMm: activityWeather.precipitationMm,
  windSpeedKmh: activityWeather.windSpeedKmh,
  windDirectionDeg: activityWeather.windDirectionDeg,
  relativeHumidityPct: activityWeather.relativeHumidityPct,
  weatherCode: activityWeather.weatherCode,
};

/**
 * La météo d'une séance **de l'athlète connecté**.
 *
 * `null` quand la séance n'est pas la sienne, n'existe pas, ou n'a pas encore
 * été relevée — trois absences que l'UI traite de la même façon (rien à
 * afficher) et qu'il n'y a aucune raison de distinguer côté client.
 */
export async function getActivityWeather(activityId: number): Promise<ActivityWeatherDto | null> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return null;

  const rows = await db
    .select(dtoColumns)
    .from(activityWeather)
    .innerJoin(
      activities,
      and(eq(activities.id, activityWeather.activityId), eq(activities.athleteId, athleteId)),
    )
    .where(eq(activityWeather.activityId, activityId))
    .limit(1);

  return rows[0] ?? null;
}

/*
 * Ce dont le service a besoin pour relever une séance.
 */

/** Une séance à relever, réduite à ce qui décide de la demande. */
export type WeatherLookupTarget = {
  activityId: number;
  startedAt: Date;
  elapsedTimeS: number;
  /**
   * Premier point GPS exploitable de la séance, déjà **arrondi** pour le réseau.
   * `null` quand la séance n'a pas de position — un tapis n'a pas de GPS.
   */
  coordinates: Coordinates | null;
};

/**
 * Un flux `latlng` ramené à des couples, sans `as`.
 *
 * Le JSONB est typé par `$type` côté Drizzle, ce que le pilote ne vérifie pas :
 * on ne suppose donc rien de son contenu. Tout ce qui n'est pas un couple est
 * traité comme un point muet — `firstFixedPoint` écarte de toute façon les
 * valeurs non finies et le point de garde `0/0`.
 */
function toLatLngPoints(data: ActivityStreamData): (readonly [number, number] | null)[] {
  const points: (readonly [number, number] | null)[] = [];
  for (const entry of data) {
    points.push(entry === null || typeof entry === 'number' ? null : entry);
  }
  return points;
}

/**
 * Le premier point de la séance, ou `null` s'il n'y en a pas.
 *
 * Le flux entier remonte du JSONB pour n'en garder que le premier point fixé :
 * c'est le prix d'un `null` en tête de série (la montre n'a pas encore accroché
 * au départ), et il reste sans conséquence — le rattrapage traite au plus
 * `MAX_LOOKUPS_PER_CYCLE` séances par minute.
 */
async function readStartCoordinates(
  activityId: number,
  athleteId: number,
): Promise<Coordinates | null> {
  const rows = await db
    .select({ data: activityStreams.data })
    .from(activityStreams)
    .innerJoin(
      activities,
      and(eq(activities.id, activityStreams.activityId), eq(activities.athleteId, athleteId)),
    )
    .where(and(eq(activityStreams.activityId, activityId), eq(activityStreams.type, 'latlng')))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return firstFixedPoint(toLatLngPoints(row.data));
}

/**
 * Tout ce qu'il faut pour relever une séance **de cet athlète**, `null` si elle
 * ne lui appartient pas ou n'existe pas.
 *
 * C'est le point d'entrée du relevé qui suit un import : l'athlète est un
 * paramètre, jamais une déduction — le watcher et le poller n'ont pas de session.
 */
export async function getWeatherLookupTarget(
  activityId: number,
  athleteId: number,
): Promise<WeatherLookupTarget | null> {
  const rows = await db
    .select({
      activityId: activities.id,
      startedAt: activities.startedAt,
      elapsedTimeS: activities.elapsedTimeS,
    })
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, athleteId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return { ...row, coordinates: await readStartCoordinates(activityId, athleteId) };
}

/**
 * Condition SQL « ce relevé en échec est de nouveau dû ».
 *
 * Construite depuis {@link RETRY_DELAYS_MS} pour que le délai vive à un seul
 * endroit : une tentative de plus, c'est une entrée de plus dans ce tableau, et
 * rien à toucher ici. Au-delà du dernier délai, aucune branche ne matche — la
 * séance est abandonnée, elle ne consomme plus de créneau à chaque cycle.
 *
 * La première branche est un `<=` et non un `=` : une ligne à `attempts = 0`
 * (qui ne devrait pas exister, tout écrit incrémentant le compteur) resterait
 * sinon coincée en échec pour toujours.
 */
function retryDue(now: Date): SQL | undefined {
  const branches = RETRY_DELAYS_MS.map((delayMs, index) =>
    and(
      index === 0
        ? lte(activityWeather.attempts, 1)
        : eq(activityWeather.attempts, index + 1),
      lte(activityWeather.lastAttemptAt, new Date(now.getTime() - delayMs)),
    ),
  );
  return or(...branches);
}

/**
 * Les séances de cet athlète qui attendent leur météo, au plus `limit`.
 *
 * Deux populations, dans cet ordre :
 *
 * 1. **jamais relevées** — l'historique importé avant que la météo n'existe.
 *    Les plus récentes d'abord : c'est ce que l'athlète regarde, et une sortie
 *    de la semaine ne doit pas attendre la fin d'un rattrapage de trois ans ;
 * 2. **en échec et de nouveau dues** (cf. {@link retryDue}), la tentative la
 *    plus ancienne d'abord.
 *
 * **La reprise n'a rien à mémoriser** : toute tentative écrit sa ligne, succès
 * comme échec, ce qui sort la séance de l'ensemble des candidats. Le cycle
 * suivant repart donc exactement là où le précédent s'est arrêté, y compris
 * après un redémarrage — même principe que la déduplication du poller
 * intervals.icu, dont l'état est le système de fichiers.
 */
export async function listActivitiesAwaitingWeather(
  athleteId: number,
  limit: number,
  now: Date = new Date(),
): Promise<WeatherLookupTarget[]> {
  if (limit <= 0) return [];

  const columns = {
    activityId: activities.id,
    startedAt: activities.startedAt,
    elapsedTimeS: activities.elapsedTimeS,
  };

  const never = await db
    .select(columns)
    .from(activities)
    .leftJoin(activityWeather, eq(activityWeather.activityId, activities.id))
    .where(and(eq(activities.athleteId, athleteId), isNull(activityWeather.activityId)))
    .orderBy(desc(activities.startedAt))
    .limit(limit);

  const remaining = limit - never.length;
  const retryable =
    remaining <= 0
      ? []
      : await db
          .select(columns)
          .from(activityWeather)
          .innerJoin(
            activities,
            and(
              eq(activities.id, activityWeather.activityId),
              eq(activities.athleteId, athleteId),
            ),
          )
          .where(and(eq(activityWeather.status, 'failed'), retryDue(now)))
          .orderBy(activityWeather.lastAttemptAt)
          .limit(remaining);

  const targets: WeatherLookupTarget[] = [];
  for (const row of [...never, ...retryable]) {
    targets.push({ ...row, coordinates: await readStartCoordinates(row.activityId, athleteId) });
  }
  return targets;
}

/*
 * Écriture.
 */

/**
 * Ce qu'une tentative de relevé a donné — le contrat d'écriture du service.
 *
 * Chaque variante porte **exactement** ce que son statut permet d'écrire : il
 * n'existe pas d'`observed` sans mesures, ni d'échec sans motif.
 */
export type WeatherLookupOutcome =
  | {
      status: 'observed';
      source: WeatherSource;
      /** Coordonnées arrondies effectivement envoyées. */
      coordinates: Coordinates;
      sample: HourlyWeatherSample;
    }
  | { status: 'no-location' }
  | {
      /** Refus argumenté d'Open-Meteo, ou panne réessayable. */
      status: 'unsupported' | 'failed';
      reason: string;
      /** `null` seulement si l'échec précède la construction de la demande. */
      coordinates: Coordinates | null;
    };

/** Les colonnes de mesure, toutes remises à `null` hors `observed`. */
function measureColumns(outcome: WeatherLookupOutcome) {
  if (outcome.status !== 'observed') {
    return {
      source: null,
      latitudeDeg: outcome.status === 'no-location' ? null : outcome.coordinates?.latitudeDeg ?? null,
      longitudeDeg:
        outcome.status === 'no-location' ? null : outcome.coordinates?.longitudeDeg ?? null,
      observedAt: null,
      temperatureC: null,
      apparentTemperatureC: null,
      precipitationMm: null,
      windSpeedKmh: null,
      windDirectionDeg: null,
      relativeHumidityPct: null,
      weatherCode: null,
      failureReason: outcome.status === 'no-location' ? null : outcome.reason,
    };
  }

  return {
    source: outcome.source,
    latitudeDeg: outcome.coordinates.latitudeDeg,
    longitudeDeg: outcome.coordinates.longitudeDeg,
    observedAt: outcome.sample.observedAt,
    temperatureC: outcome.sample.temperatureC,
    apparentTemperatureC: outcome.sample.apparentTemperatureC,
    precipitationMm: outcome.sample.precipitationMm,
    windSpeedKmh: outcome.sample.windSpeedKmh,
    windDirectionDeg: outcome.sample.windDirectionDeg,
    relativeHumidityPct: outcome.sample.relativeHumidityPct,
    weatherCode: outcome.sample.weatherCode,
    failureReason: null,
  };
}

/**
 * Enregistre le résultat d'une tentative. Rend `false` si la séance n'appartient
 * pas à cet athlète (ou n'existe pas) — auquel cas rien n'est écrit.
 *
 * **Une tentative écrit toujours**, y compris quand elle échoue : c'est la ligne
 * elle-même qui mémorise qu'on a déjà essayé. Sans elle, la séance sur tapis et
 * la séance refusée par le service reviendraient à chaque cycle, indéfiniment.
 *
 * `attempts` est incrémenté **en base** (`attempts + 1`) plutôt que recalculé
 * depuis une lecture : deux tentatives concurrentes sur la même séance ne
 * peuvent donc pas se recouvrir et faire repartir le compteur en arrière.
 *
 * L'appartenance est vérifiée **ici**, contre `activities.athlete_id`, avant
 * toute écriture : un appelant qui se tromperait de séance n'en écrase pas la
 * météo, il n'écrit rien et on le lui dit.
 */
export async function saveActivityWeather(
  activityId: number,
  athleteId: number,
  outcome: WeatherLookupOutcome,
): Promise<boolean> {
  const owned = await db
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, athleteId)))
    .limit(1);
  if (owned.length === 0) return false;

  const measures = measureColumns(outcome);
  const now = new Date();

  await db
    .insert(activityWeather)
    .values({
      activityId,
      status: outcome.status,
      ...measures,
      attempts: 1,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: activityWeather.activityId,
      set: {
        status: outcome.status,
        ...measures,
        attempts: sql`${activityWeather.attempts} + 1`,
        lastAttemptAt: now,
        updatedAt: now,
      },
    });

  return true;
}
