/**
 * Lecture d'un fichier FIT d'activité.
 *
 * Module **pur** : il reçoit les octets du fichier et rend une structure ; ni
 * base de données, ni système de fichiers, ni réseau. L'idempotence de l'import
 * repose sur `fileHash`, pendant du `strava_id` côté Strava.
 *
 * Règle du projet : ne jamais approximer. Un champ absent du fichier vaut
 * `null` (ou est absent des streams) — jamais zéro, jamais une valeur déduite.
 * Ce qui empêche de décrire l'activité (fichier corrompu, absence de session)
 * lève une {@link FitParseError} plutôt que de produire une donnée fausse.
 */

import { createHash } from 'node:crypto';

import { Decoder, Stream } from '@garmin/fitsdk';
import type { FitMessages, RecordMesg, SessionMesg } from '@garmin/fitsdk';

import { mapFitSportType, usesFootCadence } from './sport';

/**
 * Séries temporelles d'une activité. Structurellement identique à
 * `StravaStreamSet` (`src/lib/strava/client.ts`) et aligné sur
 * `ACTIVITY_STREAM_TYPES` du schéma : les deux canaux d'import alimentent la
 * même table `activity_streams`. Chaque clé est optionnelle — le capteur peut
 * manquer — et, quand elle est présente, son tableau a la même longueur que les
 * autres : les index sont alignés point à point.
 */
export type FitStreamSet = {
  /** Secondes écoulées depuis `startedAt`. */
  time?: number[];
  distance?: number[];
  heartrate?: number[];
  altitude?: number[];
  cadence?: number[];
  /** Mètres par seconde. */
  velocity?: number[];
  latlng?: Array<[number, number]>;
};

export type ParsedFitActivity = {
  /** Hash SHA-256 hex du fichier — clé d'idempotence de l'import. */
  fileHash: string;
  /**
   * Le profil FIT n'a pas de champ « titre d'activité » : `null` sauf si la
   * séance suivait un entraînement structuré, dont le nom est alors repris.
   * Jamais de titre inventé — c'est à l'appelant de choisir un libellé.
   */
  name: string | null;
  /** Vocabulaire Strava (`Run`, `TrailRun`, `Ride`…), voir `./sport`. */
  sportType: string;
  startedAt: Date;
  distanceM: number;
  /** `total_timer_time` de la session, arrondi à la seconde (colonne entière). */
  movingTimeS: number;
  /** `total_elapsed_time` de la session, arrondi à la seconde (colonne entière). */
  elapsedTimeS: number;
  elevationGainM: number | null;
  avgHrBpm: number | null;
  maxHrBpm: number | null;
  /** Pas par minute : la cadence FIT à pied est doublée, celle du vélo non. */
  avgCadenceSpm: number | null;
  streams: FitStreamSet;
  /**
   * Anomalies non bloquantes rencontrées à la lecture (points hors session,
   * stream troué et donc écarté, sport inconnu du SDK…). Vide pour un fichier
   * nominal. À journaliser ou à remonter à l'utilisateur par l'appelant : le
   * parseur ne masque jamais une perte de données.
   */
  warnings: string[];
};

/** Le fichier n'est pas exploitable comme activité. Message destiné à l'utilisateur. */
export class FitParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FitParseError';
  }
}

/** 2^31 semicercles couvrent 180° : conversion exacte du format FIT. */
const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;

/** Point de mesure aligné sur un message `record`, avant assemblage en streams. */
type RecordPoint = {
  timeS: number;
  distance: number | null;
  heartrate: number | null;
  altitude: number | null;
  cadence: number | null;
  velocity: number | null;
  latlng: [number, number] | null;
};

/** Canaux extraits des `record`, hors `time` qui sert de colonne vertébrale. */
const CHANNELS = ['distance', 'heartrate', 'altitude', 'cadence', 'velocity', 'latlng'] as const;

export function parseFitActivity(buffer: Buffer): ParsedFitActivity {
  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const warnings: string[] = [];

  const messages = decode(buffer);

  const fileType = messages.fileIdMesgs?.[0]?.type;
  if (fileType !== 'activity') {
    throw new FitParseError(
      `Ce fichier FIT n'est pas une activité (type « ${describeFileType(fileType)} »). ` +
        "Seuls les fichiers enregistrés par une montre ou un compteur pendant une séance peuvent être importés.",
    );
  }

  const sessions = messages.sessionMesgs ?? [];
  const session = sessions[0];
  if (session === undefined) {
    throw new FitParseError(
      "Ce fichier FIT ne contient aucune session : impossible d'en déduire une activité. " +
        "L'enregistrement a probablement été interrompu avant d'être clôturé par l'appareil.",
    );
  }
  if (sessions.length > 1) {
    // Les fichiers multisport (triathlon…) sont hors périmètre : on importe la
    // première session et on borne ses points à sa propre fenêtre temporelle.
    warnings.push(
      `Fichier multisport (${sessions.length} sessions) : seule la première a été importée.`,
    );
  }

  const records = messages.recordMesgs ?? [];
  const startedAt = resolveStartedAt(session, records);

  const elapsedTimeS = requireSeconds(session.totalElapsedTime, 'total_elapsed_time');
  const movingTimeS = requireSeconds(session.totalTimerTime, 'total_timer_time');
  const distanceM = requireNumber(session.totalDistance, 'total_distance');

  const { sportType, warning: sportWarning } = mapFitSportType(session.sport, session.subSport);
  if (sportWarning !== null) warnings.push(sportWarning);

  const doubleCadence = usesFootCadence(session.sport);

  const endedAt = sessionEndMs(session, startedAt, elapsedTimeS);
  const points = collectPoints(records, startedAt, endedAt, doubleCadence, warnings);
  const streams = assembleStreams(points, warnings);

  return {
    fileHash,
    name: readWorkoutName(messages),
    sportType,
    startedAt,
    distanceM,
    movingTimeS: Math.round(movingTimeS),
    elapsedTimeS: Math.round(elapsedTimeS),
    elevationGainM: readNumber(session.totalAscent),
    avgHrBpm: readNumber(session.avgHeartRate),
    maxHrBpm: readNumber(session.maxHeartRate),
    avgCadenceSpm: readCadence(session.avgCadence, session.avgFractionalCadence, doubleCadence),
    streams,
    warnings,
  };
}

function decode(buffer: Buffer): FitMessages {
  const stream = Stream.fromBuffer(buffer);

  if (!Decoder.isFIT(stream)) {
    throw new FitParseError(
      "Ce fichier n'est pas au format FIT : son en-tête est invalide ou le fichier est vide.",
    );
  }

  const decoder = new Decoder(stream);
  if (!decoder.checkIntegrity()) {
    throw new FitParseError(
      'Fichier FIT corrompu : le contrôle d’intégrité (CRC) a échoué. ' +
        "Le fichier est probablement tronqué — le retransférer depuis l'appareil.",
    );
  }

  let result: { messages: FitMessages; errors: Error[] };
  try {
    result = decoder.read();
  } catch (error) {
    throw new FitParseError(
      `Lecture du fichier FIT impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
    );
  }

  if (result.errors.length > 0) {
    throw new FitParseError(
      `Fichier FIT illisible : ${result.errors.map((error) => error.message).join(' ; ')}.`,
    );
  }

  return result.messages;
}

function describeFileType(fileType: number | string | undefined): string {
  if (typeof fileType === 'string') return fileType;
  if (typeof fileType === 'number') return `code ${fileType}`;
  return 'inconnu';
}

/**
 * Départ de la session. `start_time` fait autorité ; à défaut on prend
 * l'horodatage du premier point enregistré — jamais `session.timestamp`, qui
 * marque la **fin** de la session.
 */
function resolveStartedAt(session: SessionMesg, records: RecordMesg[]): Date {
  if (session.startTime instanceof Date) return session.startTime;

  for (const record of records) {
    if (record.timestamp instanceof Date) return record.timestamp;
  }

  throw new FitParseError(
    "Ce fichier FIT ne porte aucune date de départ exploitable (ni « start_time » de session, ni horodatage de point).",
  );
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requireNumber(value: unknown, fieldName: string): number {
  const parsed = readNumber(value);
  if (parsed === null) {
    throw new FitParseError(
      `Session FIT incomplète : le champ « ${fieldName} » est absent, l'activité ne peut pas être décrite sans lui.`,
    );
  }
  return parsed;
}

function requireSeconds(value: unknown, fieldName: string): number {
  const parsed = requireNumber(value, fieldName);
  if (parsed < 0) {
    throw new FitParseError(
      `Session FIT incohérente : la durée « ${fieldName} » est négative (${parsed} s).`,
    );
  }
  return parsed;
}

/**
 * Cadence en pas par minute. FIT compte les cycles d'une jambe pour les sports
 * à pied (~87 pour ~174 pas/min) : ×2 à l'ingestion, exactement comme la sync
 * Strava (`src/lib/strava/client.ts`). Le vélo garde ses tours de pédalier.
 */
function readCadence(
  cadence: unknown,
  fractionalCadence: unknown,
  doubleCadence: boolean,
): number | null {
  const whole = readNumber(cadence);
  if (whole === null) return null;

  const total = whole + (readNumber(fractionalCadence) ?? 0);
  return doubleCadence ? total * 2 : total;
}

/** Nom de l'entraînement structuré suivi, seul libellé explicite du profil FIT. */
function readWorkoutName(messages: FitMessages): string | null {
  const name = messages.workoutMesgs?.[0]?.wktName;
  if (typeof name !== 'string') return null;

  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Fin de la fenêtre d'enregistrement de la session, en millisecondes.
 *
 * `total_elapsed_time` ne suffit pas : certains appareils n'y comptent pas les
 * pauses, si bien que `start_time + total_elapsed_time` tombe **avant** le
 * dernier point enregistré et amputait la fin de la séance. `session.timestamp`
 * marque la fin réelle de la session : on retient la plus tardive des deux
 * bornes, jamais moins que la durée annoncée.
 */
function sessionEndMs(session: SessionMesg, startedAt: Date, elapsedTimeS: number): number {
  const fromElapsed = startedAt.getTime() + elapsedTimeS * 1000;
  if (!(session.timestamp instanceof Date)) return fromElapsed;

  return Math.max(fromElapsed, session.timestamp.getTime());
}

/**
 * Convertit les `record` en points datés relativement au départ.
 *
 * Sont écartés : les points sans horodatage (inexploitables) et ceux hors de la
 * fenêtre `[startedAt, endMs]` (cf. {@link sessionEndMs}), qui appartiennent à
 * une autre session du fichier.
 */
function collectPoints(
  records: RecordMesg[],
  startedAt: Date,
  endMs: number,
  doubleCadence: boolean,
  warnings: string[],
): RecordPoint[] {
  const startMs = startedAt.getTime();

  const points: RecordPoint[] = [];
  let discarded = 0;

  for (const record of records) {
    if (!(record.timestamp instanceof Date)) {
      discarded += 1;
      continue;
    }

    const atMs = record.timestamp.getTime();
    if (atMs < startMs || atMs > endMs) {
      discarded += 1;
      continue;
    }

    points.push({
      timeS: Math.round((atMs - startMs) / 1000),
      distance: readNumber(record.distance),
      heartrate: readNumber(record.heartRate),
      altitude: readNumber(record.enhancedAltitude) ?? readNumber(record.altitude),
      cadence: readCadence(record.cadence, record.fractionalCadence, doubleCadence),
      velocity: readNumber(record.enhancedSpeed) ?? readNumber(record.speed),
      latlng: readLatLng(record),
    });
  }

  if (discarded > 0) {
    warnings.push(
      `${discarded} point(s) ignoré(s) : sans horodatage ou hors de la fenêtre temporelle de la session.`,
    );
  }

  return points;
}

/** Semicercles FIT → degrés décimaux, arrondis au millionième (~11 cm). */
function readLatLng(record: RecordMesg): [number, number] | null {
  const lat = readNumber(record.positionLat);
  const long = readNumber(record.positionLong);
  if (lat === null || long === null) return null;

  return [roundDegrees(lat * SEMICIRCLES_TO_DEGREES), roundDegrees(long * SEMICIRCLES_TO_DEGREES)];
}

function roundDegrees(degrees: number): number {
  return Math.round(degrees * 1e6) / 1e6;
}

/** Étendue d'un canal : index de sa première et de sa dernière mesure. */
type ChannelSpan = { channel: (typeof CHANNELS)[number]; first: number; last: number };

/**
 * Étendue d'un canal, ou `null` s'il ne mesure jamais rien (capteur absent du
 * fichier : ce n'est pas une perte, il n'y a rien à signaler).
 */
function channelSpan(
  points: RecordPoint[],
  channel: (typeof CHANNELS)[number],
): ChannelSpan | null {
  let first = -1;
  let last = -1;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index][channel] === null) continue;
    if (first === -1) first = index;
    last = index;
  }

  return first === -1 ? null : { channel, first, last };
}

/**
 * Assemble les streams en garantissant l'alignement des index.
 *
 * Un stream est un tableau dense : il ne sait pas représenter un trou. Deux
 * traitements, dans cet ordre — et l'ordre compte — tous deux signalés dans
 * `warnings` :
 *
 * 1. un capteur troué **au milieu** de son étendue voit son stream écarté ;
 *    l'écarter est la seule option honnête, combler serait inventer des mesures ;
 * 2. les points de tête et de queue auxquels manque un capteur **conservé** sont
 *    retirés de tous les streams restants (cas courant : le GPS n'a pas encore de
 *    fix au départ).
 *
 * Faire le rognage en premier coûterait des points pour rien : une ceinture
 * cardio qui accroche en cours de route amputait le début du GPS avant que son
 * propre stream, troué, ne soit finalement jeté.
 */
function assembleStreams(points: RecordPoint[], warnings: string[]): FitStreamSet {
  if (points.length === 0) return {};

  const spans = CHANNELS.map((channel) => channelSpan(points, channel)).filter(
    (span): span is ChannelSpan => span !== null,
  );

  // 1. Canaux troués au milieu de leur étendue : écartés avant tout rognage.
  const kept: ChannelSpan[] = [];
  for (const span of spans) {
    let gaps = 0;
    for (let index = span.first; index <= span.last; index += 1) {
      if (points[index][span.channel] === null) gaps += 1;
    }

    if (gaps === 0) {
      kept.push(span);
      continue;
    }

    warnings.push(
      `Stream « ${span.channel} » écarté : ${gaps} mesure(s) manquante(s) sur ${span.last - span.first + 1}, les index ne seraient plus alignés.`,
    );
  }

  if (kept.length === 0) {
    return { time: points.map((point) => point.timeS) };
  }

  // 2. Rognage tête/queue, sur les seuls canaux conservés.
  const start = Math.max(...kept.map((span) => span.first));
  const end = Math.min(...kept.map((span) => span.last)) + 1;

  const trimmedCount = points.length - Math.max(end - start, 0);
  if (trimmedCount > 0) {
    warnings.push(
      `${trimmedCount} point(s) retiré(s) en début ou fin de séance : au moins un capteur n'y mesurait rien.`,
    );
  }

  if (start >= end) {
    warnings.push('Aucun point ne porte toutes les mesures : streams non conservés.');
    return {};
  }

  const trimmed = points.slice(start, end);
  const streams: FitStreamSet = { time: trimmed.map((point) => point.timeS) };

  for (const { channel } of kept) {
    // Les `null` viennent d'être exclus, mais seule une reconstruction point à
    // point le prouve au compilateur — préférée à une assertion de type.
    if (channel === 'latlng') {
      const values: Array<[number, number]> = [];
      for (const point of trimmed) {
        if (point.latlng !== null) values.push(point.latlng);
      }
      streams.latlng = values;
    } else {
      const values: number[] = [];
      for (const point of trimmed) {
        const value = point[channel];
        if (value !== null) values.push(value);
      }
      streams[channel] = values;
    }
  }

  return streams;
}
