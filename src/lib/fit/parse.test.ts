import { createHash } from 'node:crypto';

import { Encoder, Profile } from '@garmin/fitsdk';
import type {
  Encodable,
  FileIdMesg,
  RecordMesg,
  SessionMesg,
  Types,
  WorkoutMesg,
} from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';

import { FitParseError, parseFitActivity } from './parse';

/**
 * Les fixtures sont encodées par le SDK lui-même : aucun octet écrit à la main,
 * donc aucun risque de tester un format FIT imaginaire. Chaque test construit le
 * fichier minimal dont il a besoin.
 */

const START = new Date('2026-05-01T06:00:00.000Z');

type RecordInput = {
  offsetS: number;
  positionLat?: number;
  positionLong?: number;
  distance?: number;
  heartRate?: number;
  cadence?: number;
  fractionalCadence?: number;
  altitude?: number;
  speed?: number;
};

type SessionInput = {
  sport?: Types.Sport;
  subSport?: Types.SubSport;
  startTime?: Date | null;
  /** Fin de session. Par défaut `START + totalElapsedTime`, comme un appareil nominal. */
  timestamp?: Date;
  totalElapsedTime?: number | null;
  totalTimerTime?: number | null;
  totalDistance?: number | null;
  totalAscent?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgCadence?: number;
  avgFractionalCadence?: number;
};

type FixtureInput = {
  fileType?: Types.File;
  sessions?: SessionInput[];
  records?: RecordInput[];
  workoutName?: string;
};

/** Session par défaut : une course de 1 km en 10 min, entièrement renseignée. */
const DEFAULT_SESSION: SessionInput = {
  sport: 'running',
  subSport: 'street',
  startTime: START,
  totalElapsedTime: 620,
  totalTimerTime: 600,
  totalDistance: 1000,
  totalAscent: 12,
  avgHeartRate: 152,
  maxHeartRate: 171,
  avgCadence: 87,
  avgFractionalCadence: 0.5,
};

/** Retire des champs d'une fixture, pour simuler un capteur absent. */
function omit<T extends object, K extends keyof T>(source: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Retire les champs `null`/`undefined` avant l'encodage : un `null` explicite
 * dans une fixture veut dire « ce champ est absent du fichier FIT ».
 */
function defined<T extends object>(fields: T): { [K in keyof T]?: NonNullable<T[K]> } {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
  ) as { [K in keyof T]?: NonNullable<T[K]> };
}

function buildFit({
  fileType = 'activity',
  sessions = [DEFAULT_SESSION],
  records = [],
  workoutName,
}: FixtureInput = {}): Buffer {
  const encoder = new Encoder();

  const fileId: Encodable<FileIdMesg> = {
    mesgNum: Profile.MesgNum.FILE_ID,
    type: fileType,
    manufacturer: 'garmin',
    serialNumber: 42,
    timeCreated: START,
  };
  encoder.writeMesg(fileId);

  if (workoutName !== undefined) {
    const workout: Encodable<WorkoutMesg> = {
      mesgNum: Profile.MesgNum.WORKOUT,
      wktName: workoutName,
      sport: 'running',
      numValidSteps: 1,
    };
    encoder.writeMesg(workout);
  }

  for (const record of records) {
    const { offsetS, ...fields } = record;
    const mesg: Encodable<RecordMesg> = {
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: new Date(START.getTime() + offsetS * 1000),
      ...defined(fields),
    };
    encoder.writeMesg(mesg);
  }

  for (const session of sessions) {
    const { startTime, timestamp, ...fields } = session;
    const mesg: Encodable<SessionMesg> = {
      mesgNum: Profile.MesgNum.SESSION,
      ...defined(fields),
      ...(startTime instanceof Date ? { startTime } : {}),
      timestamp: timestamp ?? new Date(START.getTime() + (session.totalElapsedTime ?? 0) * 1000),
      event: 'session',
      eventType: 'stop',
    };
    encoder.writeMesg(mesg);
  }

  return Buffer.from(encoder.close());
}

/**
 * Points complets, toutes mesures présentes à chaque `record`.
 *
 * Douze points : au-delà du plancher de mesures d'un canal
 * (`MIN_CHANNEL_MEASURES`), pour que la fixture nominale reste nominale.
 */
const FULL_POINT_COUNT = 12;

const FULL_RECORDS: RecordInput[] = Array.from({ length: FULL_POINT_COUNT }, (_, index) => ({
  offsetS: index,
  positionLat: 582863000 + index * 1000,
  positionLong: 28000000 + index * 1000,
  distance: index * 4,
  heartRate: 140 + index,
  cadence: 87,
  // Une seconde sur deux avec demi-tour de jambe : 175 puis 174 pas/min.
  fractionalCadence: index % 2 === 0 ? 0.5 : 0,
  altitude: 100 + index,
  speed: [3.2, 3.3, 3.4][index % 3],
}));

/** Axe des temps de la fixture complète : 0, 1, … 11. */
const FULL_TIME = Array.from({ length: FULL_POINT_COUNT }, (_, index) => index);

/**
 * Session courte servant les fixtures à échantillonnage clairsemé : 60 points à
 * 1 Hz, 4 m/s, soit 236 m en 59 s.
 */
const SPARSE_SESSION: SessionInput = {
  sport: 'running',
  subSport: 'street',
  startTime: START,
  totalElapsedTime: 59,
  totalTimerTime: 59,
  totalDistance: 236,
  avgHeartRate: 150,
  maxHeartRate: 165,
};

const SPARSE_POINT_COUNT = 60;

/**
 * Fixture « Apple Watch ».
 *
 * Reproduit ce qu'on observe dans les fichiers de Gwen : chaque `record` porte
 * son horodatage et sa distance, mais les autres capteurs écrivent à leur propre
 * cadence — FC un point sur 4, GPS un sur 2, cadence un sur 5 — et le champ
 * `speed` est purement absent. C'est le cas nominal du protocole FIT (chaque
 * message ne porte que les champs déclarés par sa définition), pas un fichier
 * abîmé.
 */
const APPLE_WATCH_RECORDS: RecordInput[] = Array.from(
  { length: SPARSE_POINT_COUNT },
  (_, index) => ({
    offsetS: index,
    distance: index * 4,
    ...(index % 4 === 0 ? { heartRate: 140 + (index % 20) } : {}),
    ...(index % 2 === 0 ? { positionLat: 582863000 + index * 1000, positionLong: 28000000 } : {}),
    ...(index % 5 === 0 ? { cadence: 87, fractionalCadence: 0 } : {}),
  }),
);

describe('parseFitActivity — fichier nominal', () => {
  const parsed = parseFitActivity(buildFit({ records: FULL_RECORDS }));

  it('reprend les scalaires de la session sans rien inventer', () => {
    expect(parsed).toMatchObject({
      name: null,
      sportType: 'Run',
      startedAt: START,
      distanceM: 1000,
      movingTimeS: 600,
      elapsedTimeS: 620,
      elevationGainM: 12,
      avgHrBpm: 152,
      maxHrBpm: 171,
    });
    expect(parsed.warnings).toEqual([]);
  });

  it('exprime le stream « time » en secondes depuis le départ', () => {
    expect(parsed.streams.time).toEqual(FULL_TIME);
  });

  it('convertit les semicercles en degrés arrondis au millionième', () => {
    expect(parsed.streams.latlng).toHaveLength(FULL_POINT_COUNT);
    expect(parsed.streams.latlng?.slice(0, 3)).toEqual([
      [48.855012, 2.346933],
      [48.855096, 2.347017],
      [48.85518, 2.347101],
    ]);
  });

  it('rend les autres streams alignés sur « time »', () => {
    expect(parsed.streams.heartrate).toHaveLength(FULL_POINT_COUNT);
    expect(parsed.streams.heartrate?.slice(0, 3)).toEqual([140, 141, 142]);
    expect(parsed.streams.distance?.slice(0, 3)).toEqual([0, 4, 8]);
    expect(parsed.streams.altitude?.slice(0, 3)).toEqual([100, 101, 102]);
    expect(parsed.streams.velocity?.slice(0, 4)).toEqual([3.2, 3.3, 3.4, 3.2]);
  });
});

describe('parseFitActivity — hash du fichier', () => {
  it('rend le SHA-256 du buffer, stable d’un appel à l’autre', () => {
    const buffer = buildFit({ records: FULL_RECORDS });
    const expected = createHash('sha256').update(buffer).digest('hex');

    expect(parseFitActivity(buffer).fileHash).toBe(expected);
    expect(parseFitActivity(Buffer.from(buffer)).fileHash).toBe(expected);
    expect(expected).toHaveLength(64);
  });

  it('change dès qu’un octet du fichier change', () => {
    const one = parseFitActivity(buildFit({ records: FULL_RECORDS })).fileHash;
    const other = parseFitActivity(
      buildFit({ records: [...FULL_RECORDS, { ...FULL_RECORDS[2], offsetS: 20 }] }),
    ).fileHash;

    expect(one).not.toBe(other);
  });
});

describe('parseFitActivity — cadence', () => {
  it('double la cadence en course (une jambe → pas par minute)', () => {
    const parsed = parseFitActivity(buildFit({ records: FULL_RECORDS }));

    // Session : 87 + 0.5 tours/min → 175 pas/min.
    expect(parsed.avgCadenceSpm).toBe(175);
    expect(parsed.streams.cadence?.slice(0, 4)).toEqual([175, 174, 175, 174]);
  });

  it('double aussi la cadence en marche et en randonnée', () => {
    for (const sport of ['walking', 'hiking'] satisfies Types.Sport[]) {
      const parsed = parseFitActivity(
        buildFit({ sessions: [{ ...DEFAULT_SESSION, sport, subSport: 'generic' }] }),
      );
      expect(parsed.avgCadenceSpm).toBe(175);
    }
  });

  it('laisse la cadence du vélo en tours de pédalier par minute', () => {
    const parsed = parseFitActivity(
      buildFit({
        sessions: [
          { ...DEFAULT_SESSION, sport: 'cycling', subSport: 'road', avgFractionalCadence: 0 },
        ],
        records: FULL_RECORDS,
      }),
    );

    expect(parsed.sportType).toBe('Ride');
    expect(parsed.avgCadenceSpm).toBe(87);
    expect(parsed.streams.cadence?.slice(0, 4)).toEqual([87.5, 87, 87.5, 87]);
  });

  it('rend null quand la session ne porte aucune cadence', () => {
    const parsed = parseFitActivity(
      buildFit({
        sessions: [{ ...DEFAULT_SESSION, avgCadence: undefined, avgFractionalCadence: undefined }],
      }),
    );

    expect(parsed.avgCadenceSpm).toBeNull();
  });
});

describe('parseFitActivity — capteurs absents', () => {
  it('omet le stream de FC, sans avertissement : un capteur qu’on n’a pas n’est pas une perte', () => {
    const parsed = parseFitActivity(
      buildFit({
        sessions: [{ ...DEFAULT_SESSION, avgHeartRate: undefined, maxHeartRate: undefined }],
        records: FULL_RECORDS.map((record) => omit(record, 'heartRate')),
      }),
    );

    expect(parsed.avgHrBpm).toBeNull();
    expect(parsed.maxHrBpm).toBeNull();
    expect(parsed.streams.heartrate).toBeUndefined();
    expect(parsed.streams.time).toEqual(FULL_TIME);
    expect(parsed.streams.latlng).toHaveLength(FULL_POINT_COUNT);
    expect(parsed.warnings).toEqual([]);
  });

  it('omet le stream GPS sans toucher aux autres (tapis de course)', () => {
    const parsed = parseFitActivity(
      buildFit({
        records: FULL_RECORDS.map((record) => omit(record, 'positionLat', 'positionLong')),
      }),
    );

    expect(parsed.streams.latlng).toBeUndefined();
    expect(parsed.streams.heartrate).toHaveLength(FULL_POINT_COUNT);
    expect(parsed.warnings).toEqual([]);
  });

  it('laisse le dénivelé à null quand la session ne le porte pas', () => {
    const parsed = parseFitActivity(
      buildFit({ sessions: [{ ...DEFAULT_SESSION, totalAscent: undefined }] }),
    );

    expect(parsed.elevationGainM).toBeNull();
  });
});

describe('parseFitActivity — alignement des streams', () => {
  it('garde les points de tête auxquels le GPS manque encore, avec un trou explicite', () => {
    const parsed = parseFitActivity(
      buildFit({
        records: [
          omit(FULL_RECORDS[0], 'positionLat', 'positionLong'),
          ...FULL_RECORDS.slice(1),
        ],
      }),
    );

    // Le GPS sans fix au départ ne coûte plus les mesures des autres capteurs.
    expect(parsed.streams.time).toEqual(FULL_TIME);
    expect(parsed.streams.heartrate?.slice(0, 3)).toEqual([140, 141, 142]);
    expect(parsed.streams.latlng?.slice(0, 2)).toEqual([null, [48.855096, 2.347017]]);
    expect(parsed.warnings).toEqual([]);
  });

  it('conserve un stream troué en milieu de séance en l’alignant sur « time »', () => {
    const parsed = parseFitActivity(
      buildFit({
        records: [
          FULL_RECORDS[0],
          omit(FULL_RECORDS[1], 'heartRate'),
          ...FULL_RECORDS.slice(2),
        ],
      }),
    );

    expect(parsed.streams.heartrate?.slice(0, 3)).toEqual([140, null, 142]);
    expect(parsed.streams.time).toEqual(FULL_TIME);
    expect(parsed.streams.distance?.slice(0, 3)).toEqual([0, 4, 8]);
    expect(parsed.warnings).toEqual([]);
  });

  it('ne comble jamais un trou par report de la dernière valeur', () => {
    const records = [
      FULL_RECORDS[0],
      omit(FULL_RECORDS[1], 'heartRate'),
      omit(FULL_RECORDS[2], 'heartRate'),
      ...FULL_RECORDS.slice(3),
    ];

    const parsed = parseFitActivity(buildFit({ records }));

    expect(parsed.streams.heartrate?.slice(0, 4)).toEqual([140, null, null, 143]);
  });

  it('écarte le canal d’un capteur qui n’a parlé que neuf fois', () => {
    // 60 points, la ceinture n'accroche que sur les neuf premiers : ce n'est
    // plus un échantillonnage clairsemé, c'est un capteur mort.
    const records: RecordInput[] = Array.from({ length: 60 }, (_, index) => ({
      offsetS: index,
      distance: index * 4,
      ...(index < 9 ? { heartRate: 140 } : {}),
    }));

    const parsed = parseFitActivity(
      buildFit({ sessions: [SPARSE_SESSION], records }),
    );

    expect(parsed.streams.heartrate).toBeUndefined();
    expect(parsed.streams.distance).toHaveLength(60);
    expect(parsed.warnings).toContain(
      'Stream « heartrate » écarté : 9 mesure(s) sur 60 points, ' +
        "moins de 10 — capteur muet plutôt qu'échantillonnage clairsemé.",
    );
  });

  it('conserve un canal dès la dixième mesure', () => {
    const records: RecordInput[] = Array.from({ length: 60 }, (_, index) => ({
      offsetS: index,
      distance: index * 4,
      ...(index < 10 ? { heartRate: 140 } : {}),
    }));

    const parsed = parseFitActivity(
      buildFit({ sessions: [SPARSE_SESSION], records }),
    );

    expect(parsed.streams.heartrate).toHaveLength(60);
    expect(parsed.streams.heartrate?.filter((beats) => beats !== null)).toHaveLength(10);
    expect(parsed.warnings).toEqual([]);
  });

  it('conserve une ceinture lente mais vivante, que le seuil relatif jetait', () => {
    // Mode économie : une mesure toutes les 30 s sur un flux à 1 Hz. Soit 3,3 %
    // des points — mais dix mesures parfaitement exploitables.
    const records: RecordInput[] = Array.from({ length: 300 }, (_, index) => ({
      offsetS: index,
      distance: index * 4,
      ...(index % 30 === 0 ? { heartRate: 140 } : {}),
    }));

    const parsed = parseFitActivity(
      buildFit({
        sessions: [
          { ...SPARSE_SESSION, totalElapsedTime: 299, totalTimerTime: 299, totalDistance: 1196 },
        ],
        records,
      }),
    );

    expect(parsed.streams.heartrate).toHaveLength(300);
    expect(parsed.streams.heartrate?.filter((beats) => beats !== null)).toHaveLength(10);
    expect(parsed.warnings).toEqual([]);
  });

  it('ignore les points hors de la fenêtre temporelle de la session', () => {
    const parsed = parseFitActivity(
      buildFit({
        records: [
          { ...FULL_RECORDS[0], offsetS: -30 },
          ...FULL_RECORDS,
          { ...FULL_RECORDS[2], offsetS: 900 },
        ],
      }),
    );

    expect(parsed.streams.time).toEqual(FULL_TIME);
    expect(parsed.warnings).toEqual([
      '2 point(s) ignoré(s) : sans horodatage ou hors de la fenêtre temporelle de la session.',
    ]);
  });

  it('conserve la queue d’enregistrement quand les pauses ne sont pas comptées', () => {
    // `total_elapsed_time` (620 s) exclut ici les pauses : la séance s'est
    // réellement terminée à `session.timestamp` (900 s). Se fier à la seule
    // durée écoulée écartait tous les points enregistrés après.
    const parsed = parseFitActivity(
      buildFit({
        sessions: [{ ...DEFAULT_SESSION, timestamp: new Date(START.getTime() + 900_000) }],
        records: [
          ...FULL_RECORDS.slice(0, FULL_POINT_COUNT - 1),
          { ...FULL_RECORDS[FULL_POINT_COUNT - 1], offsetS: 700 },
        ],
      }),
    );

    expect(parsed.streams.time).toEqual([...FULL_TIME.slice(0, FULL_POINT_COUNT - 1), 700]);
    expect(parsed.warnings).toEqual([]);
  });

  it('borne quand même la fenêtre à la durée annoncée si la session finit plus tôt', () => {
    const parsed = parseFitActivity(
      buildFit({
        // Fin de session antérieure à start + total_elapsed_time : on retient la
        // plus tardive des deux bornes, jamais moins que la durée annoncée.
        sessions: [{ ...DEFAULT_SESSION, timestamp: new Date(START.getTime() + 100_000) }],
        records: [FULL_RECORDS[0], { ...FULL_RECORDS[1], offsetS: 600 }],
      }),
    );

    expect(parsed.streams.time).toEqual([0, 600]);
  });

  it('rend des streams vides quand le fichier ne contient aucun point', () => {
    const parsed = parseFitActivity(buildFit());

    expect(parsed.streams).toEqual({});
    expect(parsed.distanceM).toBe(1000);
  });
});

describe('parseFitActivity — fixture « Apple Watch » (échantillonnage clairsemé)', () => {
  const parsed = parseFitActivity(
    buildFit({ sessions: [SPARSE_SESSION], records: APPLE_WATCH_RECORDS }),
  );

  it('conserve les quatre canaux présents, alignés sur l’axe des temps', () => {
    expect(parsed.streams.time).toHaveLength(SPARSE_POINT_COUNT);
    expect(parsed.streams.distance).toHaveLength(SPARSE_POINT_COUNT);
    expect(parsed.streams.heartrate).toHaveLength(SPARSE_POINT_COUNT);
    expect(parsed.streams.cadence).toHaveLength(SPARSE_POINT_COUNT);
    expect(parsed.streams.latlng).toHaveLength(SPARSE_POINT_COUNT);
  });

  it('place les null exactement aux index où le capteur se tait', () => {
    const measured = (values: readonly unknown[] | undefined): number[] =>
      (values ?? []).flatMap((value, index) => (value === null ? [] : [index]));

    // FC un point sur 4, GPS un sur 2, cadence un sur 5.
    expect(measured(parsed.streams.heartrate)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56]);
    expect(measured(parsed.streams.latlng)).toEqual(
      Array.from({ length: 30 }, (_, index) => index * 2),
    );
    expect(measured(parsed.streams.cadence)).toEqual(
      Array.from({ length: 12 }, (_, index) => index * 5),
    );
    // La distance, elle, est écrite à chaque record.
    expect(measured(parsed.streams.distance)).toHaveLength(SPARSE_POINT_COUNT);
  });

  it('rend les valeurs mesurées, jamais une valeur reportée', () => {
    expect(parsed.streams.heartrate?.slice(0, 5)).toEqual([140, null, null, null, 144]);
    // Cadence FIT doublée : 87 tours de jambe → 174 pas/min.
    expect(parsed.streams.cadence?.slice(0, 6)).toEqual([174, null, null, null, null, 174]);
    expect(parsed.streams.latlng?.slice(0, 3)).toEqual([
      [48.855012, 2.346933],
      null,
      [48.85518, 2.346933],
    ]);
  });

  it('n’invente pas le canal de vitesse absent du fichier, et ne s’en plaint pas', () => {
    // Aucune Apple Watch n'écrit `speed` : signaler ce canal à chaque import
    // ferait passer un import nominal pour un import dégradé.
    expect(parsed.streams.velocity).toBeUndefined();
    expect(parsed.streams.altitude).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
  });
});

describe('parseFitActivity — sous-sports et titre', () => {
  it('distingue le trail de la course sur route', () => {
    const parsed = parseFitActivity(
      buildFit({ sessions: [{ ...DEFAULT_SESSION, subSport: 'trail' }] }),
    );

    expect(parsed.sportType).toBe('TrailRun');
  });

  it('reprend le nom de l’entraînement structuré suivi, sinon null', () => {
    expect(parseFitActivity(buildFit({ workoutName: '6 × 800 m' })).name).toBe('6 × 800 m');
    expect(parseFitActivity(buildFit()).name).toBeNull();
  });

  it('n’importe que la première session d’un fichier multisport', () => {
    const parsed = parseFitActivity(
      buildFit({
        sessions: [
          { ...DEFAULT_SESSION, sport: 'swimming', subSport: 'openWater', totalDistance: 1500 },
          { ...DEFAULT_SESSION, sport: 'cycling', subSport: 'road', totalDistance: 40000 },
        ],
      }),
    );

    expect(parsed.sportType).toBe('Swim');
    expect(parsed.distanceM).toBe(1500);
    expect(parsed.warnings).toContain(
      'Fichier multisport (2 sessions) : seule la première a été importée.',
    );
  });
});

describe('parseFitActivity — fichiers refusés', () => {
  it('refuse un fichier qui n’est pas au format FIT', () => {
    expect(() => parseFitActivity(Buffer.from('ceci nest pas un fichier FIT', 'utf8'))).toThrow(
      FitParseError,
    );
    expect(() => parseFitActivity(Buffer.alloc(0))).toThrow(/pas au format FIT/);
  });

  it('refuse un fichier FIT tronqué', () => {
    const buffer = buildFit({ records: FULL_RECORDS });
    const truncated = buffer.subarray(0, Math.floor(buffer.length / 2));

    expect(() => parseFitActivity(truncated)).toThrow(FitParseError);
    expect(() => parseFitActivity(truncated)).toThrow(/corrompu/);
  });

  it('refuse un fichier FIT dont le contenu a été altéré', () => {
    const buffer = buildFit({ records: FULL_RECORDS });
    const altered = Buffer.from(buffer);
    altered[30] ^= 0xff;

    expect(() => parseFitActivity(altered)).toThrow(FitParseError);
  });

  it('refuse un fichier FIT qui n’est pas une activité', () => {
    expect(() => parseFitActivity(buildFit({ fileType: 'settings' }))).toThrow(
      /n'est pas une activité/,
    );
  });

  it('refuse un fichier d’activité sans session', () => {
    expect(() => parseFitActivity(buildFit({ sessions: [], records: FULL_RECORDS }))).toThrow(
      /aucune session/,
    );
  });

  it('refuse une session amputée d’une durée ou de sa distance', () => {
    expect(() =>
      parseFitActivity(buildFit({ sessions: [{ ...DEFAULT_SESSION, totalDistance: null }] })),
    ).toThrow(/total_distance/);
    expect(() =>
      parseFitActivity(buildFit({ sessions: [{ ...DEFAULT_SESSION, totalTimerTime: null }] })),
    ).toThrow(/total_timer_time/);
  });

  it('retombe sur le premier point quand la session n’a pas de « start_time »', () => {
    const parsed = parseFitActivity(
      buildFit({
        sessions: [{ ...DEFAULT_SESSION, startTime: null }],
        records: FULL_RECORDS.map((record) => ({ ...record, offsetS: record.offsetS + 5 })),
      }),
    );

    expect(parsed.startedAt).toEqual(new Date(START.getTime() + 5000));
    expect(parsed.streams.time).toEqual(FULL_TIME);
  });

  it('refuse un fichier sans aucune date exploitable', () => {
    expect(() => parseFitActivity(buildFit({ sessions: [{ ...DEFAULT_SESSION, startTime: null }] }))).toThrow(
      /date de départ/,
    );
  });
});
