import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { APP_TIME_ZONE } from '@/config/time';
import {
  civilDateToMs,
  civilDaysBetween,
  isoWeekEnd,
  isoWeekNumber,
  isoWeekStart,
  shiftCivilDate,
  toCivilDate,
} from '@/lib/dates/civil';
import {
  computeLoadSeries,
  computeMonotonySeries,
  type LoadPoint,
  type MonotonyPoint,
} from '@/lib/metrics';

import { countPendingElevation } from './activities';
import { getCurrentAthlete } from './athlete';
import { db } from './db/client';
import { activities, type Activity } from './db/schema';
import {
  NEUTRAL_VO2MAX_CORRECTION,
  getVo2maxCorrection,
  type Vo2maxCorrectionDto,
} from './vo2max-correction';
import { listWellnessDays, type WellnessDayDto } from './wellness';
import {
  VO2MAX_WINDOW_DAYS,
  buildDailyTrimp,
  buildFitness,
  buildFitnessUnavailable,
  buildVo2max,
  buildVo2maxUnavailable,
  collectRunVo2max,
  type FitnessDto,
  type FitnessUnavailableDto,
  type RunVo2maxSample,
  type Vo2maxDto,
  type Vo2maxUnavailableDto,
} from './training-metrics';

/**
 * Contrat de la page « Progression » : l'évolution des indicateurs sur une
 * période choisie, là où le tableau de bord n'en montre que l'instantané.
 *
 * Même discipline que `dashboard.ts` : chaque bloc est indépendamment nullable
 * et s'accompagne du DTO qui **dit pourquoi** il manque — jamais un cadre vide
 * sans explication, jamais une valeur inventée pour combler un trou.
 */

/**
 * L'instantané de la page reprend mot pour mot les indicateurs du tableau de
 * bord : leurs DTOs sont ré-exportés ici pour que l'UI de « Progression » n'ait
 * pas à importer le contrat d'une autre page.
 */
export type {
  FitnessDto,
  FitnessUnavailableDto,
  Vo2maxDto,
  Vo2maxUnavailableDto,
} from './training-metrics';

export type ProgressionRange = '3m' | '6m' | '1y' | 'all';

/** Semaine ISO pour les périodes courtes, mois civil au-delà. */
export type BucketKind = 'week' | 'month';

/** VO₂max effective d'une course, ou valeur de la tendance à une date donnée. */
export type Vo2maxPointDto = { date: string; value: number };

export type Vo2maxTrendDto = {
  /** Un point par course exploitable de la période, du plus ancien au plus récent. */
  points: Vo2maxPointDto[];
  /**
   * Moyenne glissante sur 30 jours pondérée par le temps de déplacement — la
   * même agrégation que l'indicateur du tableau de bord, calculée jour par jour.
   * Un point par jour ayant au moins une course dans sa fenêtre.
   */
  trend: Vo2maxPointDto[];
};

export type BucketTrimpDto = {
  /** Étiquette d'axe : « S32 » pour une semaine, « août » / « août 25 » pour un mois. */
  label: string;
  trimp: number;
  /** Seau entamé mais pas terminé : sa valeur n'est pas comparable aux autres. */
  partial: boolean;
};

export type BucketVolumeDto = {
  label: string;
  distanceKm: number;
  movingTimeS: number;
  /** Nombre de séances du seau. */
  count: number;
  partial: boolean;
};

export type ProgressionDto = {
  range: ProgressionRange;
  /** Premier jour affiché (date civile). */
  from: string;
  /** Dernier jour affiché : aujourd'hui. */
  to: string;
  bucketKind: BucketKind;
  /** `false` tant que l'onboarding n'a pas eu lieu : rien n'est calculable. */
  hasProfile: boolean;
  /**
   * Charge du jour et VO₂max courante — l'instantané, identique à celui du
   * tableau de bord et **indépendant de la période** : « où j'en suis » ne
   * change pas parce qu'on regarde six mois plutôt que trois.
   */
  current: { fitness: FitnessDto | null; vo2max: Vo2maxDto | null };
  /**
   * Série ATL/CTL/TSB **tronquée** à la période, mais calculée sur l'historique
   * complet (cf. {@link getProgression}).
   */
  load: LoadPoint[];
  /**
   * Monotonie et contrainte de Foster, **tronquées** à la période comme
   * {@link ProgressionDto.load} et calculées comme elle sur l'historique
   * complet : la fenêtre glissante fait sept jours, et démarrer le calcul au
   * premier jour affiché rendrait `null` les six premiers points par pure
   * construction — un trou qui ne dirait rien de l'entraînement.
   *
   * Même série TRIMP quotidienne que la charge : les deux panneaux décrivent la
   * même semaine, l'un par ce qu'elle pèse, l'autre par la façon dont elle
   * alterne.
   */
  monotony: MonotonyPoint[];
  /** `null` quand aucune course de la période n'est exploitable. */
  vo2max: Vo2maxTrendDto | null;
  /**
   * TRIMP cumulé par seau, seaux vides compris (une semaine de repos est une
   * donnée). Le seau est celui de `bucketKind` — semaine ISO ou mois civil :
   * ne pas lire ce champ comme une série hebdomadaire.
   */
  trimpBuckets: BucketTrimpDto[];
  volume: BucketVolumeDto[];
  /**
   * Pourquoi la charge manque — non-`null` exactement quand `current.fitness`
   * l'est et qu'un athlète existe. Explique du même coup la série `load` vide
   * **et** des `trimpBuckets` sans relief : les trois viennent de la même série
   * de TRIMP, qui renonce dès qu'un champ de profil manque.
   */
  fitnessUnavailable: FitnessUnavailableDto | null;
  /**
   * Pourquoi la VO₂max manque — non-`null` exactement quand `current.vo2max`
   * l'est et qu'un athlète existe. La fenêtre la plus courte de la page étant de
   * trois mois, un graphe vide implique un indicateur vide : le même message
   * couvre les deux.
   */
  vo2maxUnavailable: Vo2maxUnavailableDto | null;
  /**
   * Le **facteur correctif** appliqué aux VO₂max de cette page, son origine, et
   * l'historique des courses qui le calibrent.
   *
   * Il est ici plutôt que dans une lecture à part parce qu'il n'est pas
   * seulement une donnée d'affichage : c'est lui qui a multiplié
   * {@link ProgressionDto.vo2max} et {@link ProgressionDto.current}. Les montrer
   * sans lui, ou lui sans eux, laisserait un écran expliquer un chiffre qu'un
   * autre appel aurait pu calculer autrement.
   *
   * **Indépendant du filtre de période**, comme les records : une course de l'an
   * dernier calibre toujours, et le facteur ne change pas parce qu'on regarde
   * trois mois.
   */
  vo2maxCorrection: Vo2maxCorrectionDto;
  /**
   * Nombre de séances dont le **dénivelé** reste à établir (cf.
   * `countPendingElevation`). Tant qu'il est non nul, tout ce que cette page dit
   * de la VO₂max est **provisoire**, et l'écran doit le dire.
   *
   * Ce n'est pas une coquetterie : entre la migration qui a créé les colonnes de
   * dénivelé et le passage de `pnpm db:backfill:elevation`, les séances récentes
   * portent la correction d'altitude et l'historique ne la porte pas. Le nuage
   * mêle alors deux grandeurs sur le même axe, et l'écart à 30 jours compare une
   * fenêtre corrigée à une fenêtre qui ne l'est pas — soit un artefact
   * d'ingestion affiché comme une progression.
   *
   * **Indépendant du filtre de période**, comme les records : le rattrapage
   * porte sur tout l'historique, pas sur la fenêtre regardée.
   */
  pendingElevationActivities: number;
  /**
   * Les tendances de bien-être, sur une fenêtre **fixe** de
   * {@link WELLNESS_TREND_DAYS} jours.
   *
   * Indépendante du filtre de période, comme l'instantané en tête de page, et
   * pour la même raison : ces mesures se lisent sur quelques semaines — au-delà,
   * une HRV d'il y a six mois ne dit plus rien de la forme d'aujourd'hui, et une
   * courbe d'un an écraserait la seule variation qui compte. La fenêtre est
   * annoncée à l'écran, elle ne se devine pas.
   *
   * Les journées sont rendues telles quelles, trous compris : c'est le panneau
   * qui décide quoi faire d'une nuit sans mesure, et il le dit.
   */
  wellness: { from: string; to: string; days: WellnessDayDto[] };
};

/**
 * Fenêtre des tendances de bien-être : trente jours, aujourd'hui compris.
 *
 * Un mois, parce que c'est l'horizon sur lequel une HRV ou une FC de repos se
 * lisent : assez pour qu'une tendance se dessine au-delà du bruit d'une nuit,
 * assez court pour qu'un changement récent se voie encore.
 */
export const WELLNESS_TREND_DAYS = 30;

/**
 * Étendue de chaque période, en jours révolus avant aujourd'hui. Des jours et
 * non des mois civils : les seaux, eux, sont calendaires — c'est la fenêtre
 * glissante qui borne les courbes, et un « 3 mois » qui dure tantôt 89 tantôt
 * 92 jours ferait bouger la CTL de bord de fenêtre sans qu'aucune séance change.
 */
const RANGE_DAYS: Record<Exclude<ProgressionRange, 'all'>, number> = {
  '3m': 90,
  '6m': 182,
  '1y': 365,
};

/**
 * Garde-fou : un fichier FIT peut porter une date aberrante (horloge de montre
 * non synchronisée), et `all` remonterait alors jusqu'à elle. Au-delà, ce sont
 * les seaux les plus **anciens** qui sautent — les récents sont ceux qu'on lit.
 */
const MAX_BUCKETS = 260;

const monthFormatter = new Intl.DateTimeFormat('fr-FR', {
  month: 'short',
  timeZone: APP_TIME_ZONE,
});

const monthYearFormatter = new Intl.DateTimeFormat('fr-FR', {
  month: 'short',
  year: '2-digit',
  timeZone: APP_TIME_ZONE,
});

/*
 * Seaux calendaires.
 *
 * Un seau est identifié par son premier jour (lundi ISO ou 1er du mois) : deux
 * « S1 » d'années différentes ne fusionnent pas, deux « août » non plus.
 */

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function shiftMonthStart(start: string, months: number): string {
  const year = Number(start.slice(0, 4));
  const month = Number(start.slice(5, 7));
  const total = year * 12 + (month - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

function bucketStartOf(date: string, kind: BucketKind): string {
  return kind === 'week' ? isoWeekStart(date) : monthStart(date);
}

function bucketEndOf(start: string, kind: BucketKind): string {
  return kind === 'week' ? isoWeekEnd(start) : shiftCivilDate(shiftMonthStart(start, 1), -1);
}

function shiftBucketStart(start: string, buckets: number, kind: BucketKind): string {
  return kind === 'week'
    ? shiftCivilDate(start, 7 * buckets)
    : shiftMonthStart(start, buckets);
}

function bucketCount(first: string, last: string, kind: BucketKind): number {
  if (kind === 'week') return Math.floor(civilDaysBetween(first, last) / 7) + 1;

  const months =
    (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
    (Number(last.slice(5, 7)) - Number(first.slice(5, 7)));
  return months + 1;
}

type Bucket = { start: string; label: string; partial: boolean };

/**
 * Seaux couvrant `[from, today]`, seaux sans activité compris — une semaine de
 * repos vaut zéro et doit occuper sa place, sinon l'axe des temps ment.
 *
 * Le premier seau est pris **entier**, même s'il déborde à gauche de la
 * fenêtre : une semaine amputée de trois jours produirait une barre basse qu'on
 * lirait comme une semaine légère.
 */
function buildBuckets(from: string, today: string, kind: BucketKind): Bucket[] {
  const last = bucketStartOf(today, kind);
  let first = bucketStartOf(from, kind);
  if (first > last) return [];

  const excess = bucketCount(first, last, kind) - MAX_BUCKETS;
  if (excess > 0) first = shiftBucketStart(first, excess, kind);

  const starts: string[] = [];
  for (let start = first; start <= last; start = shiftBucketStart(start, 1, kind)) {
    starts.push(start);
  }

  // L'année n'apparaît que si elle lève une ambiguïté : « août » suffit sur une
  // seule année, « août 25 » est indispensable dès qu'il y en a deux.
  const multiYear = starts[0].slice(0, 4) !== starts[starts.length - 1].slice(0, 4);

  return starts.map((start) => ({
    start,
    label: bucketLabel(start, kind, multiYear),
    partial: bucketEndOf(start, kind) > today,
  }));
}

/**
 * **Précondition de fuseau** : `civilDateToMs` rend minuit **UTC** du jour
 * civil, que ces formateurs relisent dans `APP_TIME_ZONE`. Le mois affiché n'est
 * le bon que parce que ce fuseau est toujours en avance sur UTC (Europe/Paris,
 * +1/+2). Sous un fuseau à décalage négatif, minuit UTC retomberait la veille et
 * tous les libellés glisseraient d'un jour — un 1er août deviendrait « juil. ».
 */
function bucketLabel(start: string, kind: BucketKind, multiYear: boolean): string {
  if (kind === 'week') return `S${isoWeekNumber(start)}`;

  const instant = new Date(civilDateToMs(start));
  return (multiYear ? monthYearFormatter : monthFormatter).format(instant);
}

function bucketIndexes(buckets: readonly Bucket[]): Map<string, number> {
  return new Map(buckets.map((bucket, index) => [bucket.start, index]));
}

function buildTrimpBuckets(
  daily: readonly { date: string; trimp: number }[],
  buckets: readonly Bucket[],
  kind: BucketKind,
): BucketTrimpDto[] {
  const indexes = bucketIndexes(buckets);
  const totals = buckets.map(() => 0);

  for (const day of daily) {
    const index = indexes.get(bucketStartOf(day.date, kind));
    if (index === undefined) continue;
    totals[index] += day.trimp;
  }

  return buckets.map((bucket, index) => ({
    label: bucket.label,
    trimp: totals[index],
    partial: bucket.partial,
  }));
}

/**
 * Volume par seau, **tous sports confondus** — comme le TRIMP juste au-dessus :
 * les deux graphes doivent décrire la même semaine d'entraînement, et une sortie
 * vélo compte dans la charge comme dans le volume.
 */
function buildVolumeBuckets(
  rows: readonly Activity[],
  buckets: readonly Bucket[],
  kind: BucketKind,
  today: string,
): BucketVolumeDto[] {
  const indexes = bucketIndexes(buckets);
  const totals = buckets.map(() => ({ distanceM: 0, movingTimeS: 0, count: 0 }));

  for (const row of rows) {
    const day = toCivilDate(row.startedAt);
    if (day > today) continue;

    const index = indexes.get(bucketStartOf(day, kind));
    if (index === undefined) continue;

    totals[index].distanceM += row.distanceM;
    totals[index].movingTimeS += row.movingTimeS;
    totals[index].count += 1;
  }

  return buckets.map((bucket, index) => ({
    label: bucket.label,
    distanceKm: totals[index].distanceM / 1000,
    movingTimeS: totals[index].movingTimeS,
    count: totals[index].count,
    partial: bucket.partial,
  }));
}

/*
 * VO₂max : nuage des séances et tendance glissante.
 */

/**
 * Moyenne glissante sur 30 jours de la VO₂max effective, un point par jour de
 * `[from, to]` ayant au moins une course dans sa fenêtre `]j−30, j]`.
 *
 * `samples` couvre l'historique **entier** : la tendance du premier jour affiché
 * doit connaître les courses du mois qui le précède, sinon elle démarrerait plus
 * bas qu'elle ne l'était. Sommes préfixées plutôt qu'accumulateur glissant :
 * additions et soustractions se compensent exactement, une fenêtre qui se vide
 * puis se remplit ne laisse aucun résidu derrière elle.
 */
function buildVo2maxTrend(
  samples: readonly RunVo2maxSample[],
  from: string,
  to: string,
): Vo2maxPointDto[] {
  const weightedSums = [0];
  const weights = [0];
  for (const sample of samples) {
    weightedSums.push(weightedSums[weightedSums.length - 1] + sample.value * sample.weightS);
    weights.push(weights[weights.length - 1] + sample.weightS);
  }

  const trend: Vo2maxPointDto[] = [];
  let low = 0;
  let high = 0;

  for (let offset = 0; offset <= civilDaysBetween(from, to); offset += 1) {
    const day = shiftCivilDate(from, offset);
    const windowStart = shiftCivilDate(day, -VO2MAX_WINDOW_DAYS);

    while (high < samples.length && samples[high].date <= day) high += 1;
    while (low < high && samples[low].date <= windowStart) low += 1;

    const weight = weights[high] - weights[low];
    if (weight > 0) {
      trend.push({ date: day, value: (weightedSums[high] - weightedSums[low]) / weight });
    }
  }

  return trend;
}

/*
 * Lecture.
 */

function emptyProgression(range: ProgressionRange, today: string): ProgressionDto {
  return {
    range,
    from: today,
    to: today,
    bucketKind: bucketKindFor(range),
    hasProfile: false,
    current: { fitness: null, vo2max: null },
    load: [],
    monotony: [],
    vo2max: null,
    trimpBuckets: [],
    volume: [],
    // Sans athlète, il n'y a pas de cause à expliquer : c'est l'onboarding qui parle.
    fitnessUnavailable: null,
    vo2maxUnavailable: null,
    // Sans athlète, il n'y a ni course déclarée ni réglage : le neutre.
    vo2maxCorrection: NEUTRAL_VO2MAX_CORRECTION,
    // Sans athlète, aucune séance : rien qui reste à balayer.
    pendingElevationActivities: 0,
    // Sans athlète, aucun relevé bien-être n'a jamais été rapatrié.
    wellness: { from: today, to: today, days: [] },
  };
}

function bucketKindFor(range: ProgressionRange): BucketKind {
  return range === '3m' || range === '6m' ? 'week' : 'month';
}

/** Jour civil de l'activité la plus ancienne, `null` si l'historique est vide. */
function firstActivityDay(rows: readonly Activity[], today: string): string | null {
  let first: string | null = null;
  for (const row of rows) {
    const day = toCivilDate(row.startedAt);
    if (day > today) continue;
    if (first === null || day < first) first = day;
  }
  return first;
}

/**
 * Tout ce que la page « Progression » affiche, en une lecture de la table des
 * activités (lignes légères : les séries temporelles vivent à part).
 *
 * **La charge est calculée sur l'historique complet, puis tronquée.** La CTL est
 * une moyenne mobile sur 42 jours : la démarrer à zéro au premier jour affiché
 * inventerait une montée en charge qui n'a pas eu lieu. Même principe pour la
 * tendance de VO₂max, dont la fenêtre de 30 jours déborde à gauche de la
 * période.
 */
export async function getProgression(range: ProgressionRange): Promise<ProgressionDto> {
  const profile = await getCurrentAthlete();
  const today = toCivilDate(new Date());
  if (!profile) return emptyProgression(range, today);

  const wellnessFrom = shiftCivilDate(today, -(WELLNESS_TREND_DAYS - 1));

  const [rows, wellnessRows, vo2maxCorrection, pendingElevationActivities] = await Promise.all([
    db
      .select()
      .from(activities)
      .where(eq(activities.athleteId, profile.id))
      .orderBy(desc(activities.startedAt)),
    listWellnessDays(profile.id, wellnessFrom, today),
    // Le facteur correctif, calibré sur les courses déclarées. La page l'affiche
    // *et* l'applique : le nuage de points, la courbe de tendance et la tuile
    // passent par le même nombre que le détail de chaque séance.
    getVo2maxCorrection(profile.id),
    // Un `count(*)` sous le prédicat du rattrapage : ce que la page affiche de
    // la VO₂max n'est comparable dans le temps que s'il est nul, et le lire ici
    // évite à l'écran de le supposer.
    countPendingElevation(profile.id),
  ]);

  const daily = buildDailyTrimp(rows, profile, today);
  const loadSeries = daily.length > 0 ? computeLoadSeries(daily) : [];
  const monotonySeries = daily.length > 0 ? computeMonotonySeries(daily) : [];
  const fitness = buildFitness(loadSeries);
  const currentVo2max = buildVo2max(rows, profile, today, vo2maxCorrection.factor);

  const firstDay = firstActivityDay(rows, today);
  const from =
    range === 'all'
      ? (firstDay ?? today)
      : shiftCivilDate(today, -RANGE_DAYS[range]);

  const bucketKind = bucketKindFor(range);
  // Les seaux ne remontent pas avant la première séance : afficher des mois de
  // zéros antérieurs à toute donnée ferait passer « pas encore d'appli » pour
  // « pas d'entraînement ».
  const buckets =
    firstDay === null ? [] : buildBuckets(firstDay > from ? firstDay : from, today, bucketKind);

  const samples = collectRunVo2max(rows, profile, vo2maxCorrection.factor);
  const points = samples
    .filter((sample) => sample.date >= from && sample.date <= today)
    .map(({ date, value }) => ({ date, value }));

  return {
    range,
    from,
    to: today,
    bucketKind,
    hasProfile: true,
    current: { fitness, vo2max: currentVo2max },
    load: loadSeries.filter((point) => point.date >= from),
    monotony: monotonySeries.filter((point) => point.date >= from),
    vo2max:
      points.length > 0 ? { points, trend: buildVo2maxTrend(samples, from, today) } : null,
    trimpBuckets: buildTrimpBuckets(daily, buckets, bucketKind),
    volume: buildVolumeBuckets(rows, buckets, bucketKind, today),
    fitnessUnavailable: fitness ? null : buildFitnessUnavailable(rows, profile, today),
    vo2maxUnavailable: currentVo2max
      ? null
      : buildVo2maxUnavailable(rows, profile, today),
    vo2maxCorrection,
    pendingElevationActivities,
    wellness: { from: wellnessFrom, to: today, days: wellnessRows },
  };
}
