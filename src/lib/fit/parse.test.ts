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

/** Trois points complets, toutes mesures présentes. */
const FULL_RECORDS: RecordInput[] = [
  {
    offsetS: 0,
    positionLat: 582863000,
    positionLong: 28000000,
    distance: 0,
    heartRate: 140,
    cadence: 87,
    fractionalCadence: 0.5,
    altitude: 100,
    speed: 3.2,
  },
  {
    offsetS: 1,
    positionLat: 582864000,
    positionLong: 28001000,
    distance: 3.2,
    heartRate: 145,
    cadence: 88,
    fractionalCadence: 0,
    altitude: 101,
    speed: 3.3,
  },
  {
    offsetS: 2,
    positionLat: 582864000,
    positionLong: 28001000,
    distance: 6.5,
    heartRate: 150,
    cadence: 88,
    fractionalCadence: 0.5,
    altitude: 103,
    speed: 3.4,
  },
];

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
    expect(parsed.streams.time).toEqual([0, 1, 2]);
  });

  it('convertit les semicercles en degrés arrondis au millionième', () => {
    expect(parsed.streams.latlng).toEqual([
      [48.855012, 2.346933],
      [48.855096, 2.347017],
      [48.855096, 2.347017],
    ]);
  });

  it('rend les autres streams alignés sur « time »', () => {
    expect(parsed.streams.heartrate).toEqual([140, 145, 150]);
    expect(parsed.streams.distance).toEqual([0, 3.2, 6.5]);
    expect(parsed.streams.altitude).toEqual([100, 101, 103]);
    expect(parsed.streams.velocity).toEqual([3.2, 3.3, 3.4]);
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
      buildFit({ records: [...FULL_RECORDS, { ...FULL_RECORDS[2], offsetS: 3 }] }),
    ).fileHash;

    expect(one).not.toBe(other);
  });
});

describe('parseFitActivity — cadence', () => {
  it('double la cadence en course (une jambe → pas par minute)', () => {
    const parsed = parseFitActivity(buildFit({ records: FULL_RECORDS }));

    // Session : 87 + 0.5 tours/min → 175 pas/min.
    expect(parsed.avgCadenceSpm).toBe(175);
    expect(parsed.streams.cadence).toEqual([175, 176, 177]);
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
    expect(parsed.streams.cadence).toEqual([87.5, 88, 88.5]);
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
  it('omet le stream de FC et laisse les FC de session à null', () => {
    const parsed = parseFitActivity(
      buildFit({
        sessions: [{ ...DEFAULT_SESSION, avgHeartRate: undefined, maxHeartRate: undefined }],
        records: FULL_RECORDS.map((record) => omit(record, 'heartRate')),
      }),
    );

    expect(parsed.avgHrBpm).toBeNull();
    expect(parsed.maxHrBpm).toBeNull();
    expect(parsed.streams.heartrate).toBeUndefined();
    expect(parsed.streams.time).toEqual([0, 1, 2]);
    expect(parsed.streams.latlng).toHaveLength(3);
    expect(parsed.warnings).toEqual([]);
  });

  it('omet le stream GPS sans toucher aux autres (tapis de course)', () => {
    const parsed = parseFitActivity(
      buildFit({
        records: FULL_RECORDS.map((record) => omit(record, 'positionLat', 'positionLong')),
      }),
    );

    expect(parsed.streams.latlng).toBeUndefined();
    expect(parsed.streams.heartrate).toEqual([140, 145, 150]);
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
  it('rogne les points de tête auxquels le GPS manque encore', () => {
    const parsed = parseFitActivity(
      buildFit({
        records: [
          omit(FULL_RECORDS[0], 'positionLat', 'positionLong'),
          FULL_RECORDS[1],
          FULL_RECORDS[2],
        ],
      }),
    );

    expect(parsed.streams.time).toEqual([1, 2]);
    expect(parsed.streams.heartrate).toEqual([145, 150]);
    expect(parsed.streams.latlng).toHaveLength(2);
    expect(parsed.warnings).toEqual([
      "1 point(s) retiré(s) en début ou fin de séance : au moins un capteur n'y mesurait rien.",
    ]);
  });

  it('écarte un stream troué en milieu de séance plutôt que de le désaligner', () => {
    const parsed = parseFitActivity(
      buildFit({
        records: [
          FULL_RECORDS[0],
          omit(FULL_RECORDS[1], 'heartRate'),
          FULL_RECORDS[2],
        ],
      }),
    );

    expect(parsed.streams.heartrate).toBeUndefined();
    expect(parsed.streams.time).toEqual([0, 1, 2]);
    expect(parsed.streams.distance).toEqual([0, 3.2, 6.5]);
    expect(parsed.warnings).toEqual([
      'Stream « heartrate » écarté : 1 mesure(s) manquante(s) sur 3, les index ne seraient plus alignés.',
    ]);
  });

  it('n’ampute pas les autres canaux à cause d’un canal qui finira écarté', () => {
    // Ceinture cardio qui accroche en retard *et* décroche en cours de route :
    // son stream est de toute façon inexploitable. Rogner d'abord la tête aurait
    // coûté les premiers points de GPS et de distance pour rien.
    const records = [
      omit(FULL_RECORDS[0], 'heartRate'),
      omit(FULL_RECORDS[1], 'heartRate'),
      FULL_RECORDS[2],
      omit({ ...FULL_RECORDS[0], offsetS: 3 }, 'heartRate'),
      { ...FULL_RECORDS[1], offsetS: 4 },
    ];

    const parsed = parseFitActivity(buildFit({ records }));

    expect(parsed.streams.heartrate).toBeUndefined();
    expect(parsed.streams.time).toEqual([0, 1, 2, 3, 4]);
    expect(parsed.streams.latlng).toHaveLength(5);
    expect(parsed.streams.distance).toHaveLength(5);
    expect(parsed.warnings).toEqual([
      'Stream « heartrate » écarté : 1 mesure(s) manquante(s) sur 3, les index ne seraient plus alignés.',
    ]);
  });

  it('ignore les points hors de la fenêtre temporelle de la session', () => {
    const parsed = parseFitActivity(
      buildFit({
        records: [
          { ...FULL_RECORDS[0], offsetS: -30 },
          FULL_RECORDS[0],
          FULL_RECORDS[1],
          { ...FULL_RECORDS[2], offsetS: 900 },
        ],
      }),
    );

    expect(parsed.streams.time).toEqual([0, 1]);
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
        records: [FULL_RECORDS[0], { ...FULL_RECORDS[1], offsetS: 700 }],
      }),
    );

    expect(parsed.streams.time).toEqual([0, 700]);
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
    expect(parsed.streams.time).toEqual([0, 1, 2]);
  });

  it('refuse un fichier sans aucune date exploitable', () => {
    expect(() => parseFitActivity(buildFit({ sessions: [{ ...DEFAULT_SESSION, startTime: null }] }))).toThrow(
      /date de départ/,
    );
  });
});
