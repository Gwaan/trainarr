import 'server-only';

import { and, desc, eq, notInArray, sql } from 'drizzle-orm';

import { isoWeekNumber, isoWeekStart, toCivilDate } from '@/lib/dates/civil';
import type { FitStreamSet, ParsedFitActivity } from '@/lib/fit/parse';
import { defaultActivityName, usesFootCadenceSportType } from '@/lib/fit/sport';
import {
  computeBestSegments,
  computeDecoupling,
  computeHrZones,
  computeSplits,
  computeTrimp,
  deriveVelocity,
  estimateEffectiveVo2max,
  hrDistribution,
  paceDistribution,
  paceSecPerKm,
  resamplePoints,
  smoothPace,
  strideSeries,
  type BestSegment,
  type Decoupling,
  type DistributionBin,
  type SeriesSample,
} from '@/lib/metrics';

import { getAthleteProfile } from './athlete';
import { db } from './db/client';
import {
  ACTIVITY_STREAM_TYPES,
  activities,
  activityStreams,
  type Activity,
  type ActivityStream,
  type ActivityStreamType,
  type NewActivityStream,
} from './db/schema';
import { isRunning } from './training-metrics';

/**
 * DTOs des activités exposés à l'UI.
 *
 * Déclarés explicitement (pas de `typeof row`) : `fitFileHash`, `athleteId` et
 * `createdAt` sont des champs internes et ne franchissent pas la frontière.
 */
export type ActivitySummaryDto = {
  id: number;
  name: string;
  sportType: string;
  startedAt: Date;
  distanceM: number;
  movingTimeS: number;
  elevationGainM: number | null;
  avgHrBpm: number | null;
  avgPaceSecPerKm: number | null;
};

export type ActivityDetailDto = ActivitySummaryDto & {
  elapsedTimeS: number;
  maxHrBpm: number | null;
  avgCadenceSpm: number | null;
};

/** Une semaine ISO d'entraînement, telle que l'affiche la page « Activités ». */
export type WeekOfActivities = {
  /** Numéro de semaine ISO, ex. « S32 ». */
  weekLabel: string;
  totalDistanceM: number;
  totalMovingTimeS: number;
  /** Activités de la semaine, de la plus récente à la plus ancienne. */
  activities: ActivitySummaryDto[];
};

export function toActivitySummaryDto(row: Activity): ActivitySummaryDto {
  return {
    id: row.id,
    name: row.name,
    sportType: row.sportType,
    startedAt: row.startedAt,
    distanceM: row.distanceM,
    movingTimeS: row.movingTimeS,
    elevationGainM: row.elevationGainM,
    avgHrBpm: row.avgHrBpm,
    avgPaceSecPerKm: row.avgPaceSecPerKm,
  };
}

export function toActivityDetailDto(row: Activity): ActivityDetailDto {
  return {
    ...toActivitySummaryDto(row),
    elapsedTimeS: row.elapsedTimeS,
    maxHrBpm: row.maxHrBpm,
    avgCadenceSpm: row.avgCadenceSpm,
  };
}

/** Les N activités les plus récentes, de la plus récente à la plus ancienne. */
export async function listRecentActivities(limit = 20): Promise<ActivitySummaryDto[]> {
  const rows = await db
    .select()
    .from(activities)
    .orderBy(desc(activities.startedAt))
    .limit(limit);
  return rows.map(toActivitySummaryDto);
}

/**
 * Regroupe des activités par semaine ISO et retourne les `limit` semaines les
 * plus récentes **ayant au moins une activité** (les semaines de repos ne
 * produisent pas de groupe vide), de la plus récente à la plus ancienne.
 *
 * Le regroupement se fait sur le lundi de la semaine, pas sur son numéro : deux
 * semaines 1 d'années différentes ne doivent pas fusionner.
 *
 * Fonction pure, exportée pour les tests.
 */
export function groupActivitiesByWeek(
  items: readonly ActivitySummaryDto[],
  limit: number,
): WeekOfActivities[] {
  if (limit <= 0) return [];

  // Tri défensif : le regroupement ne dépend pas de l'ordre de la requête.
  const sorted = [...items].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  const weeks = new Map<string, WeekOfActivities>();
  for (const activity of sorted) {
    const day = toCivilDate(activity.startedAt);
    const key = isoWeekStart(day);

    let week = weeks.get(key);
    if (!week) {
      if (weeks.size === limit) continue;
      week = {
        weekLabel: `S${isoWeekNumber(day)}`,
        totalDistanceM: 0,
        totalMovingTimeS: 0,
        activities: [],
      };
      weeks.set(key, week);
    }

    week.totalDistanceM += activity.distanceM;
    week.totalMovingTimeS += activity.movingTimeS;
    week.activities.push(activity);
  }

  // L'insertion suit l'ordre décroissant du tri : les semaines le sont aussi.
  return [...weeks.values()];
}

/**
 * Les `limit` dernières semaines ayant des activités, regroupées.
 *
 * L'historique est lu en entier : les semaines à retenir ne forment pas une
 * plage de dates calculable à l'avance (une semaine sans sortie ne compte pas),
 * et une ligne d'activité est légère — les séries temporelles vivent à part.
 */
export async function listActivitiesByWeek(limit: number): Promise<WeekOfActivities[]> {
  if (limit <= 0) return [];

  const rows = await db.select().from(activities).orderBy(desc(activities.startedAt));
  return groupActivitiesByWeek(rows.map(toActivitySummaryDto), limit);
}

/** Une activité par son id interne. `null` si elle n'existe pas. */
export async function getActivityById(id: number): Promise<ActivityDetailDto | null> {
  const rows = await db.select().from(activities).where(eq(activities.id, id)).limit(1);
  const row = rows[0];
  return row ? toActivityDetailDto(row) : null;
}

/*
 * Détail complet d'une activité : ce que la page de séance affiche.
 *
 * Chaque bloc est indépendamment nullable — même principe que le dashboard. Une
 * séance sans GPS garde ses splits et ses zones, une séance sans ceinture garde
 * sa trace et son profil altimétrique : rien n'est estimé pour combler un trou.
 */

export type ActivityChartsDto = {
  /** Points rééchantillonnés (~600 max) pour les graphes, alignés entre séries. */
  points: Array<{
    /** Secondes depuis le départ. */
    timeS: number;
    /** Mètres depuis le départ, null si pas de stream distance. */
    distanceM: number | null;
    /** Allure lissée en s/km, null si vitesse inexploitable à ce point. */
    paceSecPerKm: number | null;
    hrBpm: number | null;
    altitudeM: number | null;
    cadenceSpm: number | null;
    /** Longueur de foulée en mètres, null si vitesse ou cadence manque ici. */
    strideM: number | null;
  }>;
  /**
   * Trace GPS complète (pas rééchantillonnée), `null` si absente.
   *
   * **Compactée** : les points où le GPS n'a rien mesuré sont retirés, alors que
   * le stream stocké les porte en `null` pour rester aligné sur l'axe des temps.
   * Une polyligne n'a pas de notion de « pas de position ici » — elle relie deux
   * fix consécutifs, ce qui est exactement le tracé attendu — et aucun affichage
   * ne corrèle aujourd'hui la carte à l'index temporel.
   */
  latlng: Array<[number, number]> | null;
};

export type ActivitySplitDto = {
  /** Numéro du km, 1-indexé ; le dernier peut être partiel. */
  km: number;
  /** 1000, sauf pour le dernier split s'il est partiel. */
  distanceM: number;
  timeS: number;
  paceSecPerKm: number;
  avgHrBpm: number | null;
  elevationGainM: number | null;
};

export type HrZoneDto = {
  zone: 1 | 2 | 3 | 4 | 5;
  timeS: number;
  /** Part de la durée totale, dans [0, 1]. */
  share: number;
};

export type ActivityFullDto = {
  detail: ActivityDetailDto;
  /** `null` si l'activité n'a aucune série temporelle exploitable. */
  charts: ActivityChartsDto | null;
  /** Vide si l'activité n'a pas de stream de distance. */
  splits: ActivitySplitDto[];
  /** `null` sans stream de FC ou sans FC max au profil. */
  hrZones: HrZoneDto[] | null;
  /**
   * FC max **du profil athlète**, distincte de `detail.maxHrBpm` (le maximum
   * atteint pendant cette séance). C'est elle qui découpe les zones : l'affichage
   * en a besoin pour colorer une tranche d'histogramme dans la rampe des zones,
   * et il n'a pas d'autre chemin vers le profil.
   */
  profileMaxHrBpm: number | null;
  /** Temps par tranche d'allure. `null` sans vitesse mesurée ni dérivable. */
  paceDistribution: DistributionBin[] | null;
  /** Temps par tranche de FC. `null` sans stream de FC. */
  hrDistribution: DistributionBin[] | null;
  /** Dérive cardiaque. `null` sous 20 min ou si un capteur couvre mal une moitié. */
  decoupling: Decoupling | null;
  /** Meilleurs efforts sur les distances de référence — course à pied uniquement. */
  bestSegments: BestSegment[];
  trimp: number | null;
  /** Course à pied uniquement. */
  effectiveVo2max: number | null;
};

/**
 * Streams scalaires d'une activité, indexés par type.
 *
 * `null` par point = le capteur n'a rien mesuré à cet instant (échantillonnage
 * clairsemé, cf. `ActivityStreamData`). Les index restent alignés entre séries.
 */
type NumericStreams = Partial<Record<Exclude<ActivityStreamType, 'latlng'>, (number | null)[]>>;

/*
 * Le contenu des colonnes JSONB est typé côté schéma (`$type<ActivityStreamData>`)
 * mais rien ne le garantit à la lecture : Postgres rend ce qui y a été écrit,
 * éventuellement par une version antérieure du code. On vérifie donc la forme au
 * lieu de l'affirmer par une assertion de type.
 */

function isNumberSeries(data: readonly unknown[]): data is (number | null)[] {
  return data.every((value) => value === null || typeof value === 'number');
}

function isLatLngSeries(data: readonly unknown[]): data is Array<[number, number] | null> {
  return data.every(
    (value) =>
      value === null ||
      (Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === 'number' &&
        typeof value[1] === 'number'),
  );
}

/** Range les lignes de `activity_streams` par type. Les séries vides sont ignorées. */
function collectStreams(rows: readonly ActivityStream[]): {
  numeric: NumericStreams;
  latlng: Array<[number, number] | null> | null;
} {
  const numeric: NumericStreams = {};
  let latlng: Array<[number, number] | null> | null = null;

  for (const row of rows) {
    const { data } = row;
    if (data.length === 0) continue;

    if (row.type === 'latlng') {
      if (isLatLngSeries(data)) latlng = data;
      continue;
    }
    if (isNumberSeries(data)) numeric[row.type] = data;
  }

  return { numeric, latlng };
}

/**
 * Axe des temps, ou `null` s'il est inexploitable.
 *
 * C'est le seul canal qui ne tolère **aucun** trou : tous les autres se lisent
 * par rapport à lui, et une durée d'échantillon ne se calcule pas autour d'un
 * instant inconnu. Le parseur FIT le garantit dense (il ne retient que les
 * `record` horodatés) ; on le vérifie quand même, la base pouvant contenir ce
 * qu'y a écrit une version antérieure du code.
 */
function denseTimeAxis(time: (number | null)[] | undefined): number[] | null {
  if (time === undefined) return null;

  const axis: number[] = [];
  for (const instant of time) {
    if (instant === null || !Number.isFinite(instant)) return null;
    axis.push(instant);
  }
  return axis.length > 0 ? axis : null;
}

/**
 * Nombre de points exploitables en commun.
 *
 * Le parseur FIT écrit des streams de longueur identique (tous alignés sur
 * l'axe `time`, `null` compris) ; on retient malgré tout la plus courte, parce
 * qu'un désalignement d'index attribuerait la FC d'un instant à un autre — une
 * donnée fausse est pire qu'une donnée tronquée.
 */
function alignedLength(numeric: NumericStreams): number {
  let shortest = Number.POSITIVE_INFINITY;
  for (const type of ACTIVITY_STREAM_TYPES) {
    if (type === 'latlng') continue;
    const stream = numeric[type];
    if (stream !== undefined) shortest = Math.min(shortest, stream.length);
  }
  return Number.isFinite(shortest) ? shortest : 0;
}

/** Première valeur mesurée d'un canal clairsemé, `null` s'il n'en a aucune. */
function firstMeasured(values: readonly (number | null)[]): number | null {
  for (const value of values) {
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Vitesse instantanée de la séance, en m/s, alignée sur l'axe des temps.
 *
 * Le canal `velocity` du fichier prime toujours : c'est une mesure. Quand il est
 * absent (cas des Apple Watch, qui n'écrivent pas `speed` dans leurs `record`)
 * mais que `distance` est là, la vitesse est calculée par `deriveVelocity`.
 * C'est une division entre deux mesures réelles, pas une estimation — et elle
 * vaut pour tout l'historique déjà en base, puisqu'elle se fait à la lecture.
 * Le stream stocké, lui, reste ce que le fichier contenait.
 *
 * `undefined` quand la séance ne porte ni vitesse ni distance : rien à dériver.
 *
 * Calculée **une fois** par lecture et partagée : l'allure des graphes, la
 * foulée, la distribution d'allure et la dérive cardiaque lisent toutes cette
 * série-là.
 */
function activitySpeeds(
  numeric: NumericStreams,
  time: number[] | null,
): (number | null)[] | undefined {
  const { velocity, distance } = numeric;
  if (velocity !== undefined) return velocity;
  if (distance === undefined || time === null) return undefined;
  return deriveVelocity(distance, time);
}

/**
 * Séries prêtes pour les graphes.
 *
 * L'axe des temps (`time`) est la colonne vertébrale : sans lui, aucun point
 * n'est plaçable. La trace GPS, elle, est renvoyée entière — une carte a besoin
 * de tous ses points pour ne pas couper les virages, et une paire de flottants
 * pèse bien moins qu'un point de graphe.
 *
 * La vitesse arrive de {@link activitySpeeds} : allure, foulée et distributions
 * doivent lire exactement la même série, sans quoi deux blocs de la page
 * décriraient la même séance différemment.
 */
function buildCharts(
  numeric: NumericStreams,
  time: number[] | null,
  sparseLatlng: Array<[number, number] | null> | null,
  speeds: (number | null)[] | undefined,
  footCadence: boolean,
): ActivityChartsDto | null {
  const { distance, heartrate, altitude, cadence } = numeric;
  const count = time === null ? 0 : alignedLength(numeric);

  const path = sparseLatlng?.filter((fix): fix is [number, number] => fix !== null) ?? null;
  const latlng = path === null || path.length === 0 ? null : path;

  if (time === null || count === 0) {
    return latlng === null ? null : { points: [], latlng };
  }

  const paces = speeds === undefined ? null : smoothPace(speeds, time);

  // Foulée : vitesse ÷ cadence, sur la **même** vitesse que l'allure. Ni l'une
  // ni l'autre n'est reportée sur un point où son capteur s'est tu.
  //
  // Sports à pied uniquement : ailleurs, `cadence` compte des tours de pédalier
  // (le parseur ne double que la cadence des sports à pied, cf. `usesFootCadence`)
  // et le quotient donnerait un développement — 5,65 m à vélo — affiché comme
  // une foulée. Une grandeur juste sous un mauvais nom reste une donnée fausse.
  const strides =
    !footCadence || speeds === undefined || cadence === undefined
      ? null
      : strideSeries(speeds, cadence);

  // Le cumul de distance du FIT ne repart pas de zéro : la page affiche des
  // mètres depuis le départ de la trace, donc depuis sa première mesure.
  const startDistance = distance === undefined ? 0 : (firstMeasured(distance) ?? 0);

  const samples: SeriesSample[] = new Array<SeriesSample>(count);
  for (let index = 0; index < count; index += 1) {
    const mark = distance === undefined ? null : distance[index];
    samples[index] = {
      timeS: time[index],
      distanceM: mark === null ? null : mark - startDistance,
      paceSecPerKm: paces === null ? null : paces[index],
      hrBpm: heartrate === undefined ? null : heartrate[index],
      altitudeM: altitude === undefined ? null : altitude[index],
      cadenceSpm: cadence === undefined ? null : cadence[index],
      strideM: strides === null ? null : strides[index],
    };
  }

  return { points: resamplePoints(samples), latlng };
}

/**
 * Tout ce que la page de détail d'une activité affiche, en une lecture.
 *
 * `null` si l'activité n'existe pas. Sinon, chaque bloc se dégrade seul : pas de
 * streams → `charts` à `null` mais le détail et le TRIMP restent ; pas de FC max
 * au profil → pas de zones, mais les splits sont là.
 *
 * Distributions, dérive cardiaque et meilleurs segments se calculent **ici**, sur
 * les streams entiers : les points des graphes sont décimés (600 au plus), et un
 * histogramme de temps bâti dessus compterait le temps de la décimation, pas
 * celui de la séance.
 */
export async function getActivityFull(id: number): Promise<ActivityFullDto | null> {
  const [activityRows, streamRows, profile] = await Promise.all([
    db.select().from(activities).where(eq(activities.id, id)).limit(1),
    db.select().from(activityStreams).where(eq(activityStreams.activityId, id)),
    getAthleteProfile(),
  ]);

  const row = activityRows[0];
  if (!row) return null;

  const { numeric, latlng } = collectStreams(streamRows);
  const { distance, heartrate, altitude } = numeric;
  const time = denseTimeAxis(numeric.time);
  const maxHrBpm = profile?.maxHrBpm ?? null;
  const speeds = activitySpeeds(numeric, time);

  // Deux questions distinctes, et deux prédicats distincts : « est-ce de la
  // course ? » (les lectures d'allure) et « la cadence compte-t-elle des pas ? »
  // (la foulée, vraie aussi en marche et en randonnée).
  const running = isRunning(row.sportType);
  const footCadence = usesFootCadenceSportType(row.sportType);

  const splits =
    time !== null && distance !== undefined
      ? computeSplits(distance, time, heartrate, altitude)
      : [];

  const hrZones =
    time !== null && heartrate !== undefined && maxHrBpm !== null
      ? computeHrZones(heartrate, time, maxHrBpm)
      : [];

  const trimp =
    profile !== null && profile.sex !== null
      ? computeTrimp({
          movingTimeS: row.movingTimeS,
          avgHrBpm: row.avgHrBpm,
          restingHrBpm: profile.restingHrBpm,
          maxHrBpm,
          sex: profile.sex,
        })
      : null;

  const effectiveVo2max = running
    ? estimateEffectiveVo2max({
        distanceM: row.distanceM,
        movingTimeS: row.movingTimeS,
        avgHrBpm: row.avgHrBpm,
        maxHrBpm,
      })
    : null;

  // Course à pied seulement : l'axe d'allure de `paceDistribution` est borné à
  // 3:00–12:00/km, des bornes de coureur. Une sortie vélo à 8 m/s tomberait tout
  // entière dans le bin de bord « < 3:00 » — un histogramme d'une seule barre,
  // qui n'apprendrait rien et prétendrait pourtant décrire la séance.
  const paceBins =
    running && time !== null && speeds !== undefined
      ? paceDistribution(speeds, time)
      : null;

  // La FC, elle, ne présume d'aucun sport : c'est la même mesure partout.
  const hrBins = time !== null && heartrate !== undefined ? hrDistribution(heartrate, time) : null;

  // Course à pied seulement : la méthode Pa:Hr de Friel compare des allures, et
  // le panneau affiche une ligne « Allure » — à vélo elle annoncerait 2:05/km.
  const decoupling =
    running && time !== null && speeds !== undefined && heartrate !== undefined
      ? computeDecoupling(speeds, heartrate, time)
      : null;

  // Un « record » à l'allure n'a pas de sens à vélo : les meilleurs efforts sont
  // une lecture de course à pied, comme la VO₂max effective au-dessus.
  const bestSegments =
    running && time !== null && distance !== undefined
      ? computeBestSegments(distance, time)
      : [];

  return {
    detail: toActivityDetailDto(row),
    charts: buildCharts(numeric, time, latlng, speeds, footCadence),
    splits,
    hrZones: hrZones.length > 0 ? hrZones : null,
    profileMaxHrBpm: maxHrBpm,
    paceDistribution: paceBins,
    hrDistribution: hrBins,
    decoupling,
    bestSegments,
    trimp,
    effectiveVo2max,
  };
}

/*
 * Écritures de l'import FIT (`src/lib/fit/ingest.ts`).
 */

/** Colonnes entières du schéma : le FIT renvoie des moyennes flottantes. */
function toIntegerBpm(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/**
 * Remplace les séries temporelles d'une activité.
 *
 * **Unités** : les séries sont stockées telles quelles, dans les unités du
 * schéma. En particulier la cadence est en **pas par minute** pour les sports à
 * pied (comme la colonne `avg_cadence_spm`), en tours de pédalier par minute
 * pour le vélo : c'est à l'appelant de convertir avant d'écrire — le FIT livre
 * les cycles d'une seule jambe.
 *
 * Upsert sur `(activity_id, type)` — l'index unique du schéma garantit une seule
 * ligne par type, même si deux imports de la même activité se croisent (le
 * delete + insert d'avant en produisait deux jeux). Les types absents de la
 * nouvelle réponse sont purgés à la fin, pour que la fonction reste un
 * remplacement complet sans jamais laisser l'activité sans streams entre-temps.
 *
 * Le tout dans une transaction : une réimportation ne doit pas laisser un état
 * partiel derrière elle.
 *
 * **Remplacement, pas complétion.** Contrairement aux colonnes de `activities`
 * (qui ne se complètent que sur leurs trous, cf. {@link completableFields}), les
 * séries sont intégralement réécrites à chaque appel : elles ne sont pas
 * éditables à la main, leur seule source est le fichier, et c'est ce qui permet
 * à une correction du parseur de réparer un import passé au simple redépôt du
 * fichier.
 *
 * Les streams vides sont ignorés : une ligne sans point n'apporte rien.
 */
export async function saveActivityStreams(
  activityId: number,
  streams: FitStreamSet,
): Promise<void> {
  const rows: NewActivityStream[] = [];
  for (const type of ACTIVITY_STREAM_TYPES) {
    const data = streams[type];
    if (!data || data.length === 0) continue;
    rows.push({ activityId, type, data });
  }

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(activityStreams)
        .values(rows)
        .onConflictDoUpdate({
          target: [activityStreams.activityId, activityStreams.type],
          set: { data: sql`excluded.data` },
        });
    }

    const written = rows.map((row) => row.type);
    await tx
      .delete(activityStreams)
      .where(
        written.length === 0
          ? eq(activityStreams.activityId, activityId)
          : and(
              eq(activityStreams.activityId, activityId),
              notInArray(activityStreams.type, written),
            ),
      );
  });
}

/** Colonnes nullables qu'un redépôt du même fichier peut venir combler. */
type CompletableColumns = Pick<
  Activity,
  'elevationGainM' | 'avgHrBpm' | 'maxHrBpm' | 'avgPaceSecPerKm' | 'avgCadenceSpm'
>;

/** Résultat d'un import, du point de vue de la ligne d'activité. */
export type FitUpsertResult = {
  activityId: number;
  /** `true` si la ligne n'existait pas et vient d'être insérée. */
  created: boolean;
};

/**
 * Les champs que l'import apporte et qui manquent (`null`) à la ligne existante.
 *
 * On ne **complète** que les trous : une valeur déjà en base n'est jamais
 * écrasée. C'est ce qui rend un redépôt inoffensif — une mesure affinée depuis
 * (ou un nom corrigé à la main) survit — tout en laissant un fichier relu par
 * une version plus complète du parseur remplir ce qui manquait.
 *
 * Fonction pure, exportée pour les tests.
 */
export function completableFields(
  existing: CompletableColumns,
  incoming: CompletableColumns,
): Partial<CompletableColumns> {
  const completion: Partial<CompletableColumns> = {};
  if (existing.elevationGainM === null && incoming.elevationGainM !== null) {
    completion.elevationGainM = incoming.elevationGainM;
  }
  if (existing.avgHrBpm === null && incoming.avgHrBpm !== null) {
    completion.avgHrBpm = incoming.avgHrBpm;
  }
  if (existing.maxHrBpm === null && incoming.maxHrBpm !== null) {
    completion.maxHrBpm = incoming.maxHrBpm;
  }
  if (existing.avgPaceSecPerKm === null && incoming.avgPaceSecPerKm !== null) {
    completion.avgPaceSecPerKm = incoming.avgPaceSecPerKm;
  }
  if (existing.avgCadenceSpm === null && incoming.avgCadenceSpm !== null) {
    completion.avgCadenceSpm = incoming.avgCadenceSpm;
  }
  return completion;
}

/**
 * Colonnes du schéma dérivées d'un FIT parsé.
 *
 * - `avgPaceSecPerKm` est dérivée ici : elle reste `null` si distance ou durée
 *   ne la permettent pas ;
 * - `name` : le format FIT n'a pas de champ « titre » (le parseur ne le renseigne
 *   que si la séance suivait un entraînement structuré). La colonne étant
 *   obligatoire, on retombe sur le libellé français de la discipline — factuel,
 *   que Gwen pourra renommer — plutôt que d'inventer un titre.
 */
function fitColumns(parsed: ParsedFitActivity) {
  return {
    name: parsed.name ?? defaultActivityName(parsed.sportType),
    sportType: parsed.sportType,
    startedAt: parsed.startedAt,
    distanceM: parsed.distanceM,
    movingTimeS: parsed.movingTimeS,
    elapsedTimeS: parsed.elapsedTimeS,
    elevationGainM: parsed.elevationGainM,
    avgHrBpm: toIntegerBpm(parsed.avgHrBpm),
    maxHrBpm: toIntegerBpm(parsed.maxHrBpm),
    avgPaceSecPerKm: paceSecPerKm(parsed.distanceM, parsed.movingTimeS),
    avgCadenceSpm: parsed.avgCadenceSpm,
  };
}

/**
 * `SET col = coalesce(activities.col, excluded.col)` : la même politique que
 * {@link completableFields}, mais exprimée en SQL pour le `ON CONFLICT`.
 *
 * Les colonnes obligatoires (nom, sport, distance, durées) en sont absentes :
 * elles ne sont jamais `null`, donc jamais à compléter — les réécrire ferait
 * perdre un nom corrigé à la main au moindre redépôt du même fichier.
 */
const FIT_HASH_CONFLICT_SET = {
  elevationGainM: sql`coalesce(${activities.elevationGainM}, excluded.elevation_gain_m)`,
  avgHrBpm: sql`coalesce(${activities.avgHrBpm}, excluded.avg_hr_bpm)`,
  maxHrBpm: sql`coalesce(${activities.maxHrBpm}, excluded.max_hr_bpm)`,
  avgPaceSecPerKm: sql`coalesce(${activities.avgPaceSecPerKm}, excluded.avg_pace_sec_per_km)`,
  avgCadenceSpm: sql`coalesce(${activities.avgCadenceSpm}, excluded.avg_cadence_spm)`,
};

/**
 * Insère ou met à jour l'activité décrite par un fichier FIT.
 *
 * Deux chemins, dans cet ordre :
 *
 * 1. **Déjà importée depuis ce même fichier** (`fit_file_hash` connu) → seuls les
 *    trous de la ligne sont comblés (cf. {@link completableFields}) ; rien de ce
 *    qui est déjà renseigné n'est écrasé.
 * 2. Sinon → insertion. Le `ON CONFLICT (fit_file_hash)` couvre la course entre
 *    deux imports simultanés du même fichier, avec la même politique qu'en 1 :
 *    c'est la contrainte unique, et non la lecture préalable, qui porte
 *    l'idempotence.
 */
export async function upsertActivityFromFit(
  parsed: ParsedFitActivity,
  athleteId: number,
): Promise<FitUpsertResult> {
  const values = fitColumns(parsed);

  const sameFile = await db
    .select()
    .from(activities)
    .where(eq(activities.fitFileHash, parsed.fileHash))
    .limit(1);

  const existing = sameFile[0];
  if (existing) {
    const completion = completableFields(existing, values);
    if (Object.keys(completion).length > 0) {
      await db.update(activities).set(completion).where(eq(activities.id, existing.id));
    }

    return { activityId: existing.id, created: false };
  }

  const rows = await db
    .insert(activities)
    .values({ athleteId, fitFileHash: parsed.fileHash, ...values })
    .onConflictDoUpdate({ target: activities.fitFileHash, set: FIT_HASH_CONFLICT_SET })
    .returning({ id: activities.id });

  const row = rows[0];
  if (!row) {
    throw new Error(`Upsert de l'activité FIT ${parsed.fileHash} sans ligne retournée.`);
  }
  return { activityId: row.id, created: true };
}
