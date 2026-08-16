import 'server-only';

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';

import {
  type ConfiguredForecastLocation,
  type DailyForecast,
  type ForecastRunState,
  type WeatherForecastStatus,
} from '@/lib/weather/forecast-plan';
import { toRequestCoordinates, type Coordinates } from '@/lib/weather/plan';

import { AthleteNotFoundError, getCurrentAthleteId, todayCivilDate } from './athlete';
import { db } from './db/client';
import {
  activities,
  activityWeather,
  athlete,
  weatherForecastRuns,
  weatherForecasts,
} from './db/schema';

/**
 * Prévisions météo — lecture d'écran, et écritures du relevé du matin.
 *
 * **Toute lecture et toute écriture est cloisonnée par athlète**, des deux
 * façons déjà en vigueur dans `./activity-weather.ts` :
 *
 * - la lecture d'**écran** ({@link getWeatherForecast}) résout l'athlète depuis
 *   la session et ne rend rien quand il n'y en a pas ;
 * - les fonctions du **service** reçoivent l'athlète en paramètre. Le relevé du
 *   matin tourne hors requête : il n'y a aucune session à interroger, et il
 *   n'existe ici aucun chemin qui déduirait l'athlète autrement.
 *
 * **Les coordonnées ne franchissent jamais la frontière client.** Elles sont
 * écrites (provenance d'un relevé, lieu réglé) et relues par le service ; le DTO
 * d'écran ne porte que le **nom** du lieu. Les avoir arrondies avant de les
 * envoyer à un tiers puis les renvoyer au navigateur serait absurde.
 *
 * Le **lieu réglé** vit sur `athlete` (c'est un réglage de compte, comme les
 * identifiants intervals.icu) mais se lit et s'écrit ici : le changer périme le
 * relevé en cours, et ces deux gestes ne doivent pas pouvoir se séparer.
 */

/*
 * Le lieu réglé.
 */

/**
 * Longueur maximale du libellé de lieu.
 *
 * Il vient du géocodage, pas d'une saisie libre : les noms les plus longs du
 * jeu de données (« Llanfairpwllgwyngyll… ») tiennent très en dessous. La borne
 * existe pour que la colonne ne puisse pas recevoir un roman par un appel
 * direct à l'action, pas pour contrarier un nom de ville.
 *
 * Source unique : la Server Action construit son schéma Zod dessus, et le DAL la
 * re-vérifie.
 */
export const FORECAST_LOCATION_LABEL_MAX_CHARS = 120;

/** Le lieu proposé n'est pas enregistrable. `field` désigne ce qui cloche. */
export class InvalidForecastLocationError extends Error {
  constructor(
    readonly field: 'label' | 'coordinates',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidForecastLocationError';
  }
}

/** Ce que l'écran de réglages soumet — le lieu choisi dans la liste du géocodage. */
export type ForecastLocationInput = {
  label: string;
  latitudeDeg: number;
  longitudeDeg: number;
};

/**
 * Vérifie et normalise un lieu à régler. Fonction pure, exportée pour les tests.
 *
 * Les coordonnées passent par `toRequestCoordinates`, comme toute coordonnée qui
 * entre dans le système : **arrondies à deux décimales**, refusées hors bornes
 * ou sur le point de garde `0/0`. Un lieu dont on ne saurait pas relever la
 * météo ne s'enregistre pas.
 *
 * @throws {InvalidForecastLocationError} au premier défaut.
 */
export function validateForecastLocation(input: ForecastLocationInput): ConfiguredForecastLocation {
  const label = input.label.trim();
  if (label === '') {
    throw new InvalidForecastLocationError('label', 'Le lieu doit porter un nom.');
  }
  if (label.length > FORECAST_LOCATION_LABEL_MAX_CHARS) {
    throw new InvalidForecastLocationError(
      'label',
      `Le nom du lieu dépasse ${FORECAST_LOCATION_LABEL_MAX_CHARS} caractères.`,
    );
  }

  const coordinates = toRequestCoordinates(input.latitudeDeg, input.longitudeDeg);
  if (coordinates === null) {
    throw new InvalidForecastLocationError(
      'coordinates',
      "Les coordonnées de ce lieu ne sont pas exploitables : relance la recherche et choisis dans la liste.",
    );
  }

  return { label, coordinates };
}

/**
 * Le lieu **réglé** d'un athlète désigné, `null` en mode automatique.
 *
 * Reçoit son athlète en paramètre : c'est le relevé du matin qui l'appelle, hors
 * requête, sans session (cf. l'en-tête de ce module).
 *
 * Les trois colonnes vont ensemble : un libellé sans coordonnées — ou l'inverse
 * — n'est pas un réglage à moitié fait, c'est une ligne qu'on ne sait pas
 * interpréter, et le mode automatique est alors la seule réponse honnête.
 */
export async function getForecastLocation(
  athleteId: number,
): Promise<ConfiguredForecastLocation | null> {
  const rows = await db
    .select({
      label: athlete.forecastLocationLabel,
      latitudeDeg: athlete.forecastLatitudeDeg,
      longitudeDeg: athlete.forecastLongitudeDeg,
    })
    .from(athlete)
    .where(eq(athlete.id, athleteId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  if (row.label === null || row.latitudeDeg === null || row.longitudeDeg === null) return null;

  return {
    label: row.label,
    coordinates: { latitudeDeg: row.latitudeDeg, longitudeDeg: row.longitudeDeg },
  };
}

/**
 * Le libellé du lieu réglé **par le compte connecté**, `null` en mode
 * automatique (ou sans session).
 *
 * C'est tout ce que l'UI a le droit de savoir du réglage : le nom, jamais les
 * coordonnées — elles sont écrites ici, interrogées par le service, et ne
 * franchissent pas la frontière client.
 */
export async function getForecastLocationLabel(): Promise<string | null> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return null;

  return (await getForecastLocation(athleteId))?.label ?? null;
}

/** La transaction telle que Drizzle la passe — inférée, jamais réécrite à la main. */
type ForecastTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Efface le relevé en cours d'un athlète — **son état et ses jours**.
 *
 * Appelé quand le lieu change, et pour une raison précise : les prévisions en
 * base sont celles d'**un autre endroit**. Les garder le temps du prochain cycle
 * les afficherait sous le nom de la ville qu'on vient de choisir, ce qui serait
 * un mensonge ; et effacer le seul état, sans les jours, produirait exactement
 * la même chose.
 *
 * Effacer l'état suffit par ailleurs à **redemander le relevé** : sans ligne,
 * `isForecastReadingDue` répond « jamais relevé », donc au prochain tour de
 * boucle (la question est posée toutes les minutes). Sans cela, l'ancienne ville
 * resterait affichée jusqu'au lendemain 6 h.
 *
 * L'écran, lui, dit « prévisions pas encore relevées » pendant ce temps-là —
 * une phrase juste, pour une minute.
 */
async function discardForecastReading(tx: ForecastTransaction, athleteId: number): Promise<void> {
  await tx.delete(weatherForecastRuns).where(eq(weatherForecastRuns.athleteId, athleteId));
  await tx.delete(weatherForecasts).where(eq(weatherForecasts.athleteId, athleteId));
}

/**
 * Fixe le lieu des prévisions **du compte connecté**, et périme le relevé en
 * cours.
 *
 * @throws {InvalidForecastLocationError} si le lieu n'est pas enregistrable.
 * @throws {AthleteNotFoundError} si le compte n'a pas d'athlète.
 */
export async function saveForecastLocation(input: ForecastLocationInput): Promise<void> {
  const location = validateForecastLocation(input);

  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(athlete)
      .set({
        forecastLocationLabel: location.label,
        forecastLatitudeDeg: location.coordinates.latitudeDeg,
        forecastLongitudeDeg: location.coordinates.longitudeDeg,
        updatedAt: now,
      })
      .where(eq(athlete.id, athleteId));

    await discardForecastReading(tx, athleteId);
  });
}

/**
 * Revient au mode automatique pour **le compte connecté** : le lieu redevient
 * celui que ses départs récents désignent.
 *
 * @throws {AthleteNotFoundError} si le compte n'a pas d'athlète.
 */
export async function clearForecastLocation(): Promise<void> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new AthleteNotFoundError();

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(athlete)
      .set({
        forecastLocationLabel: null,
        forecastLatitudeDeg: null,
        forecastLongitudeDeg: null,
        updatedAt: now,
      })
      .where(eq(athlete.id, athleteId));

    await discardForecastReading(tx, athleteId);
  });
}

/*
 * Le lieu, déduit des sorties récentes.
 */

/**
 * Les points de départ des dernières sorties **géolocalisées** de l'athlète, du
 * plus récent au plus ancien.
 *
 * Lus dans `activity_weather` et non dans les flux GPS, et c'est un choix de
 * coût autant que de justesse : le relevé de la météo passée y a **déjà** écrit
 * le premier point fixé de chaque séance, arrondi au centième de degré (cf.
 * `COORDINATE_DECIMALS`). Les relire coûte une lecture indexée de quelques
 * dizaines de lignes, là où repasser par `activity_streams` déroulerait autant
 * de tableaux JSONB entiers pour n'en garder que le premier couple.
 *
 * Le filtre porte donc sur la présence des coordonnées, pas sur le statut : une
 * séance dont le relevé a échoué (`failed`) ou a été refusé (`unsupported`) a
 * quand même un point de départ, et il compte autant que les autres pour dire
 * d'où l'athlète part.
 */
export async function listRecentStartCoordinates(
  athleteId: number,
  limit: number,
): Promise<Coordinates[]> {
  if (limit <= 0) return [];

  const rows = await db
    .select({
      latitudeDeg: activityWeather.latitudeDeg,
      longitudeDeg: activityWeather.longitudeDeg,
    })
    .from(activityWeather)
    .innerJoin(
      activities,
      and(eq(activities.id, activityWeather.activityId), eq(activities.athleteId, athleteId)),
    )
    .where(
      and(isNotNull(activityWeather.latitudeDeg), isNotNull(activityWeather.longitudeDeg)),
    )
    .orderBy(desc(activities.startedAt))
    .limit(limit);

  const starts: Coordinates[] = [];
  for (const row of rows) {
    // `isNotNull` filtre déjà en base ; le typage, lui, ne le sait pas — et rien
    // n'oblige à supposer ce que le pilote a rendu.
    if (row.latitudeDeg === null || row.longitudeDeg === null) continue;
    starts.push({ latitudeDeg: row.latitudeDeg, longitudeDeg: row.longitudeDeg });
  }
  return starts;
}

/*
 * L'état du dernier relevé.
 */

/**
 * Où en est le relevé du matin pour cet athlète, `null` s'il n'a jamais eu lieu.
 *
 * C'est cette ligne qui décide s'il y a quelque chose à faire (cf.
 * `isForecastReadingDue`) : sans elle, chaque cycle redemanderait les mêmes
 * prévisions, et un athlète sans sortie géolocalisée relancerait indéfiniment la
 * même recherche de lieu.
 */
export async function getForecastRun(athleteId: number): Promise<ForecastRunState | null> {
  const rows = await db
    .select({
      readingDay: weatherForecastRuns.readingDay,
      status: weatherForecastRuns.status,
      attempts: weatherForecastRuns.attempts,
      lastAttemptAt: weatherForecastRuns.lastAttemptAt,
    })
    .from(weatherForecastRuns)
    .where(eq(weatherForecastRuns.athleteId, athleteId))
    .limit(1);

  return rows[0] ?? null;
}

/*
 * Écriture du relevé.
 */

/**
 * Ce qu'un relevé du matin a donné — le contrat d'écriture du service.
 *
 * Chaque variante porte **exactement** ce que son statut permet d'écrire : il
 * n'existe pas de `forecast` sans jours, ni d'échec sans motif.
 */
export type ForecastReadingOutcome =
  | { status: 'forecast'; coordinates: Coordinates; days: readonly DailyForecast[] }
  | { status: 'no-location' }
  | {
      /** Refus argumenté d'Open-Meteo, ou panne réessayable. */
      status: 'unsupported' | 'failed';
      reason: string;
      /** `null` seulement si l'échec précède la construction de la demande. */
      coordinates: Coordinates | null;
    };

function outcomeCoordinates(outcome: ForecastReadingOutcome): Coordinates | null {
  if (outcome.status === 'forecast') return outcome.coordinates;
  if (outcome.status === 'no-location') return null;
  return outcome.coordinates;
}

/**
 * Enregistre le résultat du relevé du matin.
 *
 * **Une tentative écrit toujours sa ligne d'état**, succès comme échec : c'est
 * elle qui porte le marqueur du matin, donc qui empêche de reprendre le même
 * relevé à chaque cycle.
 *
 * En cas de **succès**, les prévisions de l'athlète sont **remplacées** — toutes
 * effacées, puis réécrites. Une prévision ne s'accumule pas : celle d'hier pour
 * après-demain ne vaut plus rien ce matin, et une écriture ligne à ligne
 * laisserait derrière elle le jour que le nouvel horizon ne couvre plus.
 *
 * En cas d'**échec**, les prévisions déjà en base sont **conservées**. Celles
 * d'hier valent mieux que rien, et `fetched_at` dit à l'écran de quand elles
 * datent : c'est à lui de le montrer, pas à la base de faire le vide.
 *
 * L'ensemble est transactionnel : à aucun instant la table ne doit être vide
 * pour un athlète qui a bien des prévisions.
 */
export async function saveForecastReading(
  athleteId: number,
  readingDay: string,
  outcome: ForecastReadingOutcome,
  now: Date = new Date(),
): Promise<void> {
  const coordinates = outcomeCoordinates(outcome);
  const state = {
    status: outcome.status,
    lastAttemptAt: now,
    latitudeDeg: coordinates?.latitudeDeg ?? null,
    longitudeDeg: coordinates?.longitudeDeg ?? null,
    failureReason: outcome.status === 'forecast' || outcome.status === 'no-location'
      ? null
      : outcome.reason,
  };

  await db.transaction(async (tx) => {
    await tx
      .insert(weatherForecastRuns)
      .values({ athleteId, readingDay, ...state, attempts: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: weatherForecastRuns.athleteId,
        set: {
          readingDay,
          ...state,
          /*
           * Le compteur appartient au **marqueur** : il s'incrémente tant qu'on
           * reprend la même matinée, et repart à 1 dès qu'on en change. Calculé
           * en base contre la ligne existante, et non depuis une lecture
           * préalable : deux relevés concurrents ne peuvent donc pas se recouvrir
           * et faire repartir le compteur en arrière.
           */
          attempts: sql`case when ${weatherForecastRuns.readingDay} = excluded.reading_day then ${weatherForecastRuns.attempts} + 1 else 1 end`,
          updatedAt: now,
        },
      });

    if (outcome.status !== 'forecast') return;

    await tx.delete(weatherForecasts).where(eq(weatherForecasts.athleteId, athleteId));

    if (outcome.days.length === 0) return;

    await tx.insert(weatherForecasts).values(
      outcome.days.map((day) => ({
        athleteId,
        forecastDate: day.date,
        fetchedAt: now,
        weatherCode: day.weatherCode,
        temperatureMaxC: day.temperatureMaxC,
        temperatureMinC: day.temperatureMinC,
        apparentTemperatureMaxC: day.apparentTemperatureMaxC,
        apparentTemperatureMinC: day.apparentTemperatureMinC,
        precipitationSumMm: day.precipitationSumMm,
        precipitationProbabilityMaxPct: day.precipitationProbabilityMaxPct,
        windSpeedMaxKmh: day.windSpeedMaxKmh,
      })),
    );
  });
}

/*
 * Lecture d'écran.
 */

/**
 * Les prévisions telles que l'UI les reçoit.
 *
 * DTO minimal : ni coordonnées, ni `attempts`, ni motif d'échec — de la
 * mécanique de service, ou pire, la position de l'athlète.
 *
 * `status` franchit la frontière parce qu'il **porte du sens pour l'athlète** :
 * sans lui, « aucune sortie géolocalisée, donc aucun lieu » et « Open-Meteo n'a
 * pas répondu » seraient le même vide, qu'on prendrait pour du beau temps.
 */
export type WeatherForecastDto = {
  /** Statut du dernier relevé, `null` si aucun n'a jamais eu lieu. */
  status: WeatherForecastStatus | null;
  /** Instant du dernier relevé — c'est lui qui date la prévision à l'écran. */
  fetchedAt: Date | null;
  /** D'où vient le lieu des prévisions, et son nom quand il en a un. */
  location: ForecastLocationDto;
  /** Jours couverts, du plus proche au plus lointain. Jamais un jour passé. */
  days: DailyForecast[];
};

/**
 * Le lieu, tel que l'écran a le droit de le connaître : **un nom, jamais un
 * point**.
 *
 * Il existe pour une frustration précise — « c'est quelle ville, cette
 * prévision ? ». Un lieu réglé peut répondre, et il le fait. Un lieu déduit des
 * départs, non : on connaît des coordonnées, pas une ville, et les envoyer au
 * navigateur pour qu'il en fasse un nom serait à la fois inventer et exposer la
 * position de l'athlète.
 *
 * Il décrit le **réglage**, pas l'archive du dernier appel — et les deux ne
 * peuvent pas diverger : changer de lieu efface le relevé en cours
 * (`discardForecastReading`).
 */
export type ForecastLocationDto =
  | { source: 'configured'; label: string }
  | { source: 'derived' };

const DERIVED_LOCATION: ForecastLocationDto = { source: 'derived' };

const EMPTY_FORECAST: WeatherForecastDto = {
  status: null,
  fetchedAt: null,
  location: DERIVED_LOCATION,
  days: [],
};

/**
 * Les prévisions d'un athlète **désigné**, à partir de `today`.
 *
 * Lecture primitive, sur le modèle du doublet `selectX(…)` / `getX()` de
 * `./max-hr-suggestion.ts` : l'écran passe par {@link getWeatherForecast}, qui
 * résout l'athlète depuis la session ; le **rappel matinal** (`lib/push`) passe
 * par ici, avec son athlète en paramètre — il tourne hors requête, il n'y a
 * aucune session à interroger. Une seule logique, deux points d'entrée : la
 * notification et le tableau de bord ne peuvent pas annoncer deux météos.
 *
 * Rendues en bloc plutôt que par plage : un relevé compte seize jours au plus,
 * soit une lecture d'un ou deux kilo-octets qu'aucun découpage n'allégerait
 * sérieusement — et un écran qui demanderait sa propre plage pourrait la
 * demander fausse.
 *
 * Les jours **passés** sont écartés en base : entre minuit et le relevé du
 * matin, la veille est encore en table, et une prévision d'hier n'a plus rien à
 * dire — c'est la météo relevée de l'activité qui parle.
 */
export async function selectWeatherForecast(
  athleteId: number,
  today: string = todayCivilDate(),
): Promise<WeatherForecastDto> {
  const [configured, runs, days] = await Promise.all([
    getForecastLocation(athleteId),
    db
      .select({
        status: weatherForecastRuns.status,
        lastAttemptAt: weatherForecastRuns.lastAttemptAt,
      })
      .from(weatherForecastRuns)
      .where(eq(weatherForecastRuns.athleteId, athleteId))
      .limit(1),
    db
      .select({
        date: weatherForecasts.forecastDate,
        fetchedAt: weatherForecasts.fetchedAt,
        weatherCode: weatherForecasts.weatherCode,
        temperatureMaxC: weatherForecasts.temperatureMaxC,
        temperatureMinC: weatherForecasts.temperatureMinC,
        apparentTemperatureMaxC: weatherForecasts.apparentTemperatureMaxC,
        apparentTemperatureMinC: weatherForecasts.apparentTemperatureMinC,
        precipitationSumMm: weatherForecasts.precipitationSumMm,
        precipitationProbabilityMaxPct: weatherForecasts.precipitationProbabilityMaxPct,
        windSpeedMaxKmh: weatherForecasts.windSpeedMaxKmh,
      })
      .from(weatherForecasts)
      .where(
        and(eq(weatherForecasts.athleteId, athleteId), gte(weatherForecasts.forecastDate, today)),
      )
      .orderBy(weatherForecasts.forecastDate),
  ]);

  const run = runs[0];

  return {
    status: run?.status ?? null,
    // Le nom du lieu réglé, jamais ses coordonnées — et rien du tout quand il
    // est déduit des départs (cf. `ForecastLocationDto`).
    location:
      configured === null ? DERIVED_LOCATION : { source: 'configured', label: configured.label },
    /*
     * L'instant du relevé vient des **lignes**, pas de l'état : un relevé en
     * échec ce matin laisse en place les prévisions d'hier, et c'est bien
     * d'hier qu'il faut alors les dater. `lastAttemptAt` ne sert de repli que
     * lorsqu'il n'y a plus une seule ligne à dater.
     */
    fetchedAt: days[0]?.fetchedAt ?? run?.lastAttemptAt ?? null,
    // DTO explicite : l'instant du relevé est porté une fois par la prévision
    // entière, pas répété sur chacun de ses jours.
    days: days.map((day) => ({
      date: day.date,
      weatherCode: day.weatherCode,
      temperatureMaxC: day.temperatureMaxC,
      temperatureMinC: day.temperatureMinC,
      apparentTemperatureMaxC: day.apparentTemperatureMaxC,
      apparentTemperatureMinC: day.apparentTemperatureMinC,
      precipitationSumMm: day.precipitationSumMm,
      precipitationProbabilityMaxPct: day.precipitationProbabilityMaxPct,
      windSpeedMaxKmh: day.windSpeedMaxKmh,
    })),
  };
}

/**
 * Les prévisions **de l'athlète connecté**, à partir d'aujourd'hui — la lecture
 * d'écran. Rien du tout sans session, et sans athlète.
 */
export async function getWeatherForecast(): Promise<WeatherForecastDto> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return EMPTY_FORECAST;

  return selectWeatherForecast(athleteId);
}
