/**
 * Lecture d'un fichier FIT d'activité.
 *
 * Module **pur** : il reçoit les octets du fichier et rend une structure ; ni
 * base de données, ni système de fichiers, ni réseau. L'idempotence de l'import
 * repose sur `fileHash`.
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
 * Séries temporelles d'une activité, alignées sur `ACTIVITY_STREAM_TYPES` du
 * schéma : c'est la forme qu'attend la table `activity_streams`. Chaque clé est
 * optionnelle — le capteur peut manquer du fichier — et, quand elle est
 * présente, son tableau a exactement la longueur de `time` : les index sont
 * alignés point à point.
 *
 * **`null` = le capteur n'a rien mesuré à cet instant.** Voir
 * {@link assembleStreams} : un canal clairsemé est le cas nominal d'un fichier
 * FIT, pas une anomalie. Seul `time` est dense — il est la colonne vertébrale,
 * reconstruite depuis l'horodatage de chaque `record`.
 */
export type FitStreamSet = {
  /** Secondes écoulées depuis `startedAt`. Jamais de trou : c'est l'axe. */
  time?: number[];
  distance?: (number | null)[];
  heartrate?: (number | null)[];
  altitude?: (number | null)[];
  cadence?: (number | null)[];
  /** Mètres par seconde. */
  velocity?: (number | null)[];
  latlng?: Array<[number, number] | null>;
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
  /** Vocabulaire de `activities.sport_type` (`Run`, `TrailRun`, `Ride`…), voir `./sport`. */
  sportType: string;
  startedAt: Date;
  distanceM: number;
  /** `total_timer_time` de la session, arrondi à la seconde (colonne entière). */
  movingTimeS: number;
  /** `total_elapsed_time` de la session, arrondi à la seconde (colonne entière). */
  elapsedTimeS: number;
  /**
   * `total_ascent` de la session, `null` si l'appareil ne l'écrit pas — ce qui
   * est le cas de la montre de l'athlète. Le repli (calcul depuis le flux
   * d'altitude) n'est **pas** fait ici : le parseur rend ce que le fichier dit,
   * l'ingestion complète ce qu'il tait (cf. `./ingest`).
   */
  elevationGainM: number | null;
  /**
   * `total_descent` de la session — le champ existe bel et bien dans le profil
   * FIT, à côté de `total_ascent`, et le SDK Garmin le type
   * (`SessionMesg.totalDescent`). Même politique : `null` quand il est absent,
   * et **jamais** déduit du gain (supposer une boucle serait inventer une
   * donnée).
   *
   * La formule de Greif, qui corrige la distance du dénivelé, a besoin des deux
   * sens : c'est ce qui justifie de le lire et de le persister.
   */
  elevationLossM: number | null;
  avgHrBpm: number | null;
  maxHrBpm: number | null;
  /** Pas par minute : la cadence FIT à pied est doublée, celle du vélo non. */
  avgCadenceSpm: number | null;
  streams: FitStreamSet;
  /**
   * Anomalies non bloquantes rencontrées à la lecture (points hors session,
   * canal écarté faute d'assez de mesures, sport inconnu du SDK…). Vide pour un
   * fichier nominal — un capteur simplement absent du fichier n'en est pas une.
   * À journaliser ou à remonter à l'utilisateur par l'appelant : le parseur ne
   * masque jamais une perte de données.
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
    elevationLossM: readNumber(session.totalDescent),
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
 * à pied (~87 pour ~174 pas/min) : ×2 à la lecture, pour que la colonne
 * `avg_cadence_spm` porte bien des pas. Le vélo garde ses tours de pédalier.
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

/**
 * Nombre minimal de mesures pour qu'un canal soit conservé : **10**.
 *
 * Le critère est **absolu, pas proportionnel** : ce qui rend un canal
 * exploitable — tracer une courbe, calculer une moyenne, remplir des zones —
 * c'est le nombre de mesures qu'il porte, pas la part des points qu'il couvre.
 * Un seuil relatif jetait une ceinture FC en mode économie écrivant toutes les
 * 30 s sur un flux à 1 Hz (3,3 % des points, mais 120 mesures par heure,
 * parfaitement lisibles) tout en laissant passer trois fix GPS sur une séance de
 * 50 points.
 *
 * Dix mesures dessinent déjà une tendance ; trois ne disent rien — c'est la
 * signature d'un capteur qui s'apparie quelques secondes au départ puis
 * décroche, ou d'un GPS qui accroche un fix isolé sous les arbres. Les garder
 * n'apporterait qu'un canal annoncé mais vide à l'écran.
 */
const MIN_CHANNEL_MEASURES = 10;

/**
 * Assemble les streams en garantissant l'alignement des index.
 *
 * **Un canal clairsemé est le cas nominal.** Un fichier FIT n'écrit pas tous les
 * champs dans chaque message `record` : la structure du protocole veut qu'un
 * *definition message* déclare le sous-ensemble de champs que porteront les
 * messages de données qui le suivent, et un appareil change de définition en
 * cours de fichier. Chaque capteur écrit donc à sa propre cadence — le GPS à son
 * taux de fix, la FC à celui de la ceinture. Un `record` sans champ `heart_rate`
 * ne veut pas dire « la FC est en panne », il veut dire « pas de nouvelle mesure
 * de FC à cet instant ».
 *
 * Deux règles, donc, et une seule forme de sortie :
 *
 * 1. tous les canaux sont **alignés sur l'axe `time`**, avec `null` aux points
 *    où le capteur n'a rien dit. Jamais de report de la dernière valeur : un
 *    trou est un trou, le combler serait inventer une mesure ;
 * 2. un canal n'est écarté que s'il porte moins de
 *    {@link MIN_CHANNEL_MEASURES} mesures — capteur réellement mort.
 *
 * Un canal **totalement** absent du fichier ne produit aucun avertissement : une
 * Apple Watch n'écrit jamais de champ `speed`, un tapis de course n'a pas de
 * GPS. Un capteur qu'on n'a pas n'est pas une donnée perdue, et le signaler à
 * chaque import noyait les vraies anomalies sous une ligne d'erreur de routine.
 *
 * Il n'y a plus de rognage tête/queue : un GPS sans fix au départ produit
 * simplement quelques `null` en tête, ce qui ne coûte plus les premiers points
 * des autres canaux. Le seul écartage de points reste celui de
 * {@link collectPoints} — les `record` sans horodatage ou hors session, qui ne
 * sont plaçables sur aucun axe.
 */
function assembleStreams(points: RecordPoint[], warnings: string[]): FitStreamSet {
  if (points.length === 0) return {};

  const streams: FitStreamSet = { time: points.map((point) => point.timeS) };

  for (const channel of CHANNELS) {
    let measured = 0;
    for (const point of points) {
      if (point[channel] !== null) measured += 1;
    }

    // Capteur absent du fichier : silence, pas avertissement.
    if (measured === 0) continue;

    if (measured < MIN_CHANNEL_MEASURES) {
      warnings.push(
        `Stream « ${channel} » écarté : ${measured} mesure(s) sur ${points.length} points, ` +
          `moins de ${MIN_CHANNEL_MEASURES} — capteur muet plutôt qu'échantillonnage clairsemé.`,
      );
      continue;
    }

    if (channel === 'latlng') {
      streams.latlng = points.map((point) => point.latlng);
    } else {
      streams[channel] = points.map((point) => point[channel]);
    }
  }

  return streams;
}
