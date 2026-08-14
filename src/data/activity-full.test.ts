import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getActivityFull } from './activities';
import type { Activity, ActivityStream, ActivityStreamType, Athlete } from './db/schema';

// Les modules du DAL commencent par `import 'server-only'`, qui lève hors RSC.
vi.mock('server-only', () => ({}));

/**
 * L'athlète appartient à un compte : le DAL le résout depuis la session
 * (`getCurrentAthleteId`). Les tests de ce fichier travaillent donc sous une
 * session ouverte, sauf ceux qui éprouvent le cas « pas encore d'athlète » —
 * ils appellent `withoutSession()`, et le DAL ne rend alors aucun athlète.
 */
const { sessionState } = vi.hoisted(() => {
  type Session = { userId: string; name: string; email: string } | null;
  const sessionState: { current: Session } = {
    current: { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' },
  };
  return { sessionState };
});

vi.mock('./session', () => ({ getSession: () => Promise.resolve(sessionState.current) }));

/** Personne n'est connecté : aucune lecture du DAL ne rend d'athlète. */
function withoutSession(): void {
  sessionState.current = null;
}

beforeEach(() => {
  sessionState.current = { userId: 'user_1', name: 'Gwen', email: 'gwen@example.test' };
});

/**
 * Aucune base de données : la chaîne de requête est factice et sert les lignes
 * déclarées par table (activité, streams et profil sont lus en parallèle).
 *
 * Les calculs de `@/lib/metrics` ne sont **pas** mockés : ce fichier vérifie
 * l'assemblage réel — le contrat du DTO et la dégradation bloc par bloc — sur
 * des séries construites à la main.
 */
const { queryState } = vi.hoisted(() => ({
  queryState: { rows: {} as Record<string, unknown[]> },
}));

vi.mock('./db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  type Table = Parameters<typeof getTableName>[0];

  type Chain = PromiseLike<unknown[]> & {
    where: () => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
  };

  const chainFor = (table: Table): Chain => {
    const name = getTableName(table);
    const chain: Chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(queryState.rows[name] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };

  return { db: { select: () => ({ from: chainFor }) } };
});

const ATHLETE: Athlete = {
  id: 1,
  userId: 'user_1',
  displayName: 'Gwen',
  sex: 'female',
  maxHrBpm: 190,
  restingHrBpm: 48,
  weightKg: 58,
  birthDate: '1990-05-12',
  intervalsAthleteId: null,
  intervalsApiKeyEncrypted: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** 651 points à 1 Hz, 4 m/s, soit 2 600 m en 650 s. */
const POINT_COUNT = 651;
const SPEED_M_PER_S = 4;

const ACTIVITY: Activity = {
  id: 7,
  athleteId: 1,
  fitFileHash: 'b'.repeat(64),
  name: 'Footing',
  sportType: 'Run',
  startedAt: new Date('2026-08-09T06:00:00.000Z'),
  distanceM: 2_600,
  movingTimeS: 650,
  elapsedTimeS: 700,
  elevationGainM: 12,
  avgHrBpm: 150,
  maxHrBpm: 168,
  avgPaceSecPerKm: 250,
  avgCadenceSpm: 172,
  createdAt: new Date('2026-08-09T07:00:00.000Z'),
};

function indexes(): number[] {
  return Array.from({ length: POINT_COUNT }, (_, index) => index);
}

function stream(type: ActivityStreamType, data: ActivityStream['data']): ActivityStream {
  return { id: 0, activityId: ACTIVITY.id, type, data };
}

/** Jeu complet de streams : temps, distance (décalée), FC, altitude, cadence, vitesse, GPS. */
function fullStreams(): ActivityStream[] {
  const time = indexes();
  return [
    stream('time', time),
    // Cumul FIT démarrant à 420 m : le DTO doit repartir de 0.
    stream('distance', time.map((second) => 420 + second * SPEED_M_PER_S)),
    stream('heartrate', time.map((second) => (second < 300 ? 140 : 160))),
    stream('altitude', time.map((second) => (second < 250 ? 100 : 105))),
    stream('cadence', time.map(() => 172)),
    stream('velocity', time.map(() => SPEED_M_PER_S)),
    stream('latlng', time.map((second): [number, number] => [48.85 + second / 1e5, 2.35])),
  ];
}

/**
 * Jeu de streams « Apple Watch » : chaque canal est aligné sur l'axe des temps
 * et porte `null` là où le capteur se tait — FC un point sur 4, GPS un sur 2,
 * cadence un sur 5 — et **aucun canal de vitesse**, que ces fichiers n'écrivent
 * pas. C'est la forme que le parseur corrigé produit et que la base contient
 * désormais.
 */
function appleWatchStreams(): ActivityStream[] {
  const time = indexes();
  const thin = <T>(values: readonly T[], every: number): (T | null)[] =>
    values.map((value, index) => (index % every === 0 ? value : null));

  return [
    stream('time', time),
    stream('distance', time.map((second) => 420 + second * SPEED_M_PER_S)),
    stream('heartrate', thin(time.map((second) => (second < 300 ? 140 : 160)), 4)),
    stream('altitude', thin(time.map((second) => (second < 250 ? 100 : 105)), 4)),
    stream('cadence', thin(time.map(() => 172), 5)),
    stream('latlng', thin(time.map((second): [number, number] => [48.85 + second / 1e5, 2.35]), 2)),
  ];
}

/**
 * Séance d'une heure à 4 m/s, FC à 140 puis 154 à mi-parcours : assez longue
 * pour que la dérive cardiaque soit calculable (plancher de 20 min), et assez
 * régulière pour que sa valeur soit prévisible à la main.
 */
const LONG_POINT_COUNT = 3_001;

function longStreams(): ActivityStream[] {
  const time = Array.from({ length: LONG_POINT_COUNT }, (_, index) => index);
  return [
    stream('time', time),
    stream('distance', time.map((second) => second * SPEED_M_PER_S)),
    stream('heartrate', time.map((second) => (second < 1_500 ? 140 : 154))),
    stream('velocity', time.map(() => SPEED_M_PER_S)),
    stream('cadence', time.map(() => 170)),
  ];
}

beforeEach(() => {
  queryState.rows = {};
});

describe('getActivityFull', () => {
  it('rend null pour une activité inconnue', async () => {
    withoutSession();
    expect(await getActivityFull(404)).toBeNull();
  });

  it('assemble le détail, les graphes, les splits, les zones et les métriques', async () => {
    queryState.rows = {
      activities: [ACTIVITY],
      activity_streams: fullStreams(),
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);
    expect(full).not.toBeNull();
    if (full === null) return;

    expect(full.detail).toMatchObject({ id: 7, name: 'Footing', distanceM: 2_600 });
    // Le DTO du détail ne laisse pas fuir les champs internes.
    expect(Object.keys(full.detail)).not.toContain('athleteId');
    expect(Object.keys(full.detail)).not.toContain('fitFileHash');

    const charts = full.charts;
    expect(charts).not.toBeNull();
    if (charts === null) return;

    expect(charts.points.length).toBeLessThanOrEqual(600);
    expect(charts.points.length).toBeGreaterThan(1);
    expect(charts.points[0].timeS).toBe(0);
    // Distance rebasée sur le départ de la trace, pas le cumul brut du FIT.
    expect(charts.points[0].distanceM).toBe(0);
    expect(charts.points[charts.points.length - 1].distanceM).toBeCloseTo(2_600, 6);
    // 4 m/s constants → 250 s/km partout, et 60 × 4 / 172 ≈ 1,395 m de foulée.
    for (const point of charts.points) {
      expect(point.paceSecPerKm).toBeCloseTo(250, 6);
      expect(point.cadenceSpm).toBe(172);
      expect(point.strideM).toBeCloseTo((60 * SPEED_M_PER_S) / 172, 9);
    }
    // La trace GPS n'est pas décimée.
    expect(charts.latlng).toHaveLength(POINT_COUNT);

    expect(full.splits.map((split) => split.km)).toEqual([1, 2, 3]);
    expect(full.splits.map((split) => split.distanceM)).toEqual([1000, 1000, 600]);
    expect(full.splits[0].avgHrBpm).toBe(140);
    expect(full.splits.map((split) => split.elevationGainM)).toEqual([0, 5, 0]);

    expect(full.hrZones).not.toBeNull();
    expect(full.hrZones?.map((zone) => zone.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(
      (full.hrZones ?? []).reduce((sum, zone) => sum + zone.share, 0),
    ).toBeCloseTo(1, 12);

    expect(full.trimp).toBeGreaterThan(0);
    expect(full.effectiveVo2max).toBeGreaterThan(20);
    expect(full.profileMaxHrBpm).toBe(190);

    // Distribution d'allure : 250 s/km constants tombent tous dans la tranche
    // [240, 255) de la grille de 15 s ancrée à 3:00/km.
    expect(full.paceDistribution).toEqual([{ from: 240, to: 255, seconds: 650 }]);

    // Distribution de FC : 140 puis 160 bpm, tranches de 5 bpm. Les trois
    // tranches intermédiaires sont émises à zéro — un creux est une information.
    const hrBins = full.hrDistribution ?? [];
    expect(hrBins.map((bin) => bin.from)).toEqual([140, 145, 150, 155, 160]);
    // Le point de bascule 140 → 160 partage sa seconde entre les deux tranches
    // (règle du demi-pas de `cappedSampleDurationsS`) : 299,5 + 350,5 = 650 s.
    expect(hrBins.map((bin) => bin.seconds)).toEqual([299.5, 0, 0, 0, 350.5]);

    // Séance de 650 s : sous le plancher de 20 min de la dérive cardiaque.
    expect(full.decoupling).toBeNull();

    // 2 600 m parcourus : le 5 km n'existe pas dans cette séance.
    expect(full.bestSegments.map((segment) => segment.targetM)).toEqual([
      400, 1000, 1609.34,
    ]);
    expect(full.bestSegments[1].timeS).toBeCloseTo(250, 6);
    expect(full.bestSegments[1].paceSecPerKm).toBeCloseTo(250, 6);
  });

  it('calcule la dérive cardiaque d’une séance assez longue', async () => {
    queryState.rows = {
      activities: [{ ...ACTIVITY, movingTimeS: 3_000, distanceM: 12_000 }],
      activity_streams: longStreams(),
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);
    const decoupling = full?.decoupling ?? null;
    expect(decoupling).not.toBeNull();
    if (decoupling === null) return;

    // Allure constante, FC qui passe de 140 à 154 : l'efficience perd
    // 1 − 140/154 ≈ 9,1 % entre les deux moitiés.
    // La coupure tombe sur un échantillon, pas à la milliseconde : les moyennes
    // approchent 140 et 154 sans les valoir exactement.
    expect(decoupling.firstHalf.avgHrBpm).toBeCloseTo(140, 1);
    expect(decoupling.secondHalf.avgHrBpm).toBeCloseTo(154, 1);
    expect(decoupling.firstHalf.avgSpeedMps).toBeCloseTo(SPEED_M_PER_S, 9);
    expect(decoupling.decouplingPct).toBeCloseTo(9.09, 1);

    // 12 km couverts : toutes les cibles jusqu'au 10 km, pas le semi.
    expect(full?.bestSegments.map((segment) => segment.targetM)).toEqual([
      400, 1000, 1609.34, 5000, 10000,
    ]);
  });

  it('ne prête aucune lecture de coureur à une sortie vélo', async () => {
    queryState.rows = {
      activities: [{ ...ACTIVITY, sportType: 'Ride' }],
      activity_streams: fullStreams(),
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);

    // À vélo, `cadence` compte des tours de pédalier : le quotient
    // vitesse ÷ cadence est un développement, pas une foulée.
    expect(full?.charts?.points.every((point) => point.strideM === null)).toBe(true);
    // Les bornes 3:00–12:00/km sont celles d'un coureur.
    expect(full?.paceDistribution).toBeNull();
    // Pa:Hr compare des allures ; le panneau en afficherait une, absurde ici.
    expect(full?.decoupling).toBeNull();
    expect(full?.bestSegments).toEqual([]);

    // La FC ne présume d'aucun sport : c'est la même mesure partout.
    expect(full?.hrDistribution).not.toBeNull();
    // Le reste de la séance est intact : graphes, splits et zones restent.
    expect(full?.charts?.points.length).toBeGreaterThan(1);
    expect(full?.splits).toHaveLength(3);
    expect(full?.hrZones).not.toBeNull();
  });

  it('calcule la foulée en marche comme en course', async () => {
    // `usesFootCadenceSportType` couvre Run, TrailRun, VirtualRun, Walk et Hike :
    // c'est la cadence en pas qui décide, pas le fait de courir.
    queryState.rows = {
      activities: [{ ...ACTIVITY, sportType: 'Hike' }],
      activity_streams: fullStreams(),
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.charts?.points.every((point) => point.strideM !== null)).toBe(true);
    // Une randonnée n'est pas une course : pas de meilleurs segments pour autant.
    expect(full?.bestSegments).toEqual([]);
    expect(full?.paceDistribution).toBeNull();
  });

  it('dégrade proprement une activité sans aucune série temporelle', async () => {
    queryState.rows = { activities: [ACTIVITY], athlete: [ATHLETE] };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.charts).toBeNull();
    expect(full?.splits).toEqual([]);
    expect(full?.hrZones).toBeNull();
    expect(full?.paceDistribution).toBeNull();
    expect(full?.hrDistribution).toBeNull();
    expect(full?.decoupling).toBeNull();
    expect(full?.bestSegments).toEqual([]);
    // Le TRIMP et la VO₂max viennent des colonnes de l'activité : ils restent.
    expect(full?.trimp).toBeGreaterThan(0);
    expect(full?.effectiveVo2max).toBeGreaterThan(20);
  });

  it('garde les graphes et les splits sans profil athlète', async () => {
    withoutSession();
    queryState.rows = { activities: [ACTIVITY], activity_streams: fullStreams() };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.charts?.points.length).toBeGreaterThan(1);
    expect(full?.splits).toHaveLength(3);
    // Sans FC max ni sexe au profil, rien n'est estimé.
    expect(full?.hrZones).toBeNull();
    expect(full?.profileMaxHrBpm).toBeNull();
    expect(full?.trimp).toBeNull();
    expect(full?.effectiveVo2max).toBeNull();
    // Les distributions ne dépendent d'aucun profil : une répartition brute.
    expect(full?.paceDistribution).not.toBeNull();
    expect(full?.hrDistribution).not.toBeNull();
  });

  it('garde la trace GPS et les zones sans stream de distance', async () => {
    const time = indexes();
    queryState.rows = {
      activities: [ACTIVITY],
      activity_streams: [
        stream('time', time),
        stream('heartrate', time.map(() => 150)),
        stream('latlng', time.map((): [number, number] => [48.85, 2.35])),
      ],
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.splits).toEqual([]);
    expect(full?.charts?.points[0].distanceM).toBeNull();
    expect(full?.charts?.points[0].paceSecPerKm).toBeNull();
    expect(full?.charts?.points[0].hrBpm).toBe(150);
    expect(full?.charts?.latlng).toHaveLength(POINT_COUNT);
    expect(full?.hrZones).not.toBeNull();
  });

  it('exploite une séance Apple Watch aux canaux clairsemés', async () => {
    queryState.rows = {
      activities: [ACTIVITY],
      activity_streams: appleWatchStreams(),
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);
    const charts = full?.charts ?? null;
    expect(charts).not.toBeNull();
    if (charts === null) return;

    // Allure dérivée de distance + temps, le fichier ne portant pas `velocity` :
    // 4 m/s constants → 250 s/km. C'est un calcul, pas une estimation.
    const paced = charts.points.filter((point) => point.paceSecPerKm !== null);
    expect(paced.length).toBeGreaterThan(1);
    for (const point of paced) {
      expect(point.paceSecPerKm).toBeCloseTo(250, 6);
    }

    // Chaque canal garde ses trous : aucune valeur n'est reportée.
    expect(charts.points.some((point) => point.hrBpm === null)).toBe(true);
    expect(charts.points.some((point) => point.hrBpm === 140)).toBe(true);
    expect(charts.points.some((point) => point.cadenceSpm === null)).toBe(true);
    expect(charts.points.some((point) => point.cadenceSpm === 172)).toBe(true);

    // La carte ne reçoit que les fix réels — un point sur deux.
    expect(charts.latlng).toHaveLength(Math.ceil(POINT_COUNT / 2));

    // Splits et zones tombent au même endroit qu'avec des canaux denses : le
    // 2ᵉ km est à cheval sur le changement de FC (140 → 160 à 300 s), sa
    // moyenne pondérée vaut 156 dans les deux cas.
    expect(full?.splits.map((split) => split.km)).toEqual([1, 2, 3]);
    expect(full?.splits.map((split) => split.avgHrBpm)).toEqual([140, 156, 160]);
    expect(full?.splits.map((split) => split.elevationGainM)).toEqual([0, 5, 0]);

    // Le total des zones est le temps **couvert** par la FC, pas le nombre de
    // mesures : 163 mesures espacées de 4 s couvrent 648 des 650 s de la
    // séance (la dernière tombe à 648 s). Compter les mesures aurait annoncé
    // 163 s, soit le quart de la séance.
    const zonesTotal = (full?.hrZones ?? []).reduce((sum, zone) => sum + zone.timeS, 0);
    expect(zonesTotal).toBe(648);
  });

  it('n’estime pas de VO₂max hors course à pied', async () => {
    queryState.rows = {
      activities: [{ ...ACTIVITY, sportType: 'Ride' }],
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.effectiveVo2max).toBeNull();
    expect(full?.trimp).toBeGreaterThan(0);
  });

  it('ignore une série dont la forme ne correspond pas au type déclaré', async () => {
    const time = indexes();
    queryState.rows = {
      activities: [ACTIVITY],
      activity_streams: [
        stream('time', time),
        stream('heartrate', time.map(() => 150)),
        // Écrit par erreur comme une série de couples : rejeté, pas planté.
        stream('latlng', time.map(() => 0)),
      ],
      athlete: [ATHLETE],
    };

    const full = await getActivityFull(ACTIVITY.id);

    expect(full?.charts?.latlng).toBeNull();
    expect(full?.charts?.points[0].hrBpm).toBe(150);
  });
});
