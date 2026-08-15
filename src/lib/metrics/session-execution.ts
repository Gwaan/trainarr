/**
 * **Objectifs de la séance** : confronter ce qui était prescrit à ce qui a été
 * couru.
 *
 * Module **pur** — ni base, ni réseau, ni horloge. Il prend le déroulé prescrit
 * (`lib/plan-steps/schema`), les flux de l'activité et ses agrégats, et rend un
 * modèle de comparaison que l'affichage met en barres. Rien n'est stocké : la
 * comparaison se recalcule à chaque lecture, comme les zones — corriger sa FC
 * max ou adopter une FC seuil relit tout l'historique dans le nouveau cadre.
 *
 * ## Deux façons de comparer, et ce qui les sépare
 *
 * **La séance simple** (footing, récupération, sortie longue) se compare au
 * niveau de la séance : son allure moyenne, sa FC moyenne, son volume. C'est
 * légitime parce qu'elle se court d'un seul tenant — la moyenne *est* ce que la
 * prescription visait.
 *
 * **La séance à blocs** (seuil, VMA, répétitions) ne se compare pas en moyenne :
 * l'allure moyenne d'un 6 × 800 m mélange les efforts, les récupérations,
 * l'échauffement et le retour au calme, et ne ressemble à aucune cible. Chaque
 * répétition est donc retrouvée dans la trace et comparée pour elle-même. Le
 * modèle ne produit **aucune** ligne d'allure au niveau séance dans ce cas :
 * elle serait une moyenne de choses différentes, c'est-à-dire un mensonge.
 *
 * ## Où sont les blocs ? La même mécanique que la détection du seuil
 *
 * Un fichier FIT ne porte aucun marqueur « ici commence la troisième
 * répétition » : les tours sont ce que l'auto-lap a découpé, pas ce que
 * l'athlète a couru. Le seul repère honnête est celui qu'utilise déjà la mesure
 * de FC seuil (`data/lthr-suggestion.ts`) : la **portion la plus rapide de la
 * longueur prescrite** ({@link fastestSegmentWindow}). Pour N répétitions, on
 * répète la recherche sur ce qui reste, hors des fenêtres déjà retenues — N
 * fenêtres **disjointes**, prises de la plus rapide à la plus lente puis
 * remises dans l'ordre du chrono.
 *
 * Une différence avec la mesure de seuil, et elle est voulue : là-bas seule la
 * **seconde moitié** du bloc est mesurée, parce que la fréquence cardiaque met
 * deux à trois minutes à rejoindre son plateau. Ici on compare une **allure**,
 * qui n'a pas d'inertie : c'est le bloc entier qui se compare à sa cible, comme
 * l'athlète l'a couru.
 *
 * ## L'honnêteté prime sur l'exhaustivité
 *
 * Trois règles, appliquées sans exception :
 *
 * - une cible **absente** ne produit pas de ligne (un footing sans cible
 *   cardiaque n'affiche rien sur la FC), et ne produit pas non plus de motif :
 *   il n'y a rien à expliquer ;
 * - une cible **prescrite mais non comparable** (pas de FC mesurée, pas de
 *   référence au profil, blocs introuvables) produit un **motif**
 *   ({@link ExecutionGap}) et jamais une comparaison approchée ;
 * - la localisation des blocs est **tout ou rien** : cinq fenêtres sur six ne
 *   sont pas « cinq répétitions », c'est une localisation ratée dont on ne sait
 *   pas laquelle manque. Le modèle rend alors le motif, pas un sous-ensemble.
 *
 * ## La comparaison se fait sur la valeur affichée
 *
 * Le réalisé est arrondi à l'unité d'affichage (la seconde par kilomètre, le
 * battement, le mètre) **avant** d'être confronté à la bande. Sans cela une
 * allure de 265,4 s/km s'afficherait « 4:25 » tout en étant annoncée hors d'une
 * bande qui monte à 4:25 — l'écran contredirait alors sa propre légende.
 */

import { fastestSegmentWindow } from './best-segments';
import type { HrZoneAnchor } from './hr-zones';
import type { HrTargetBpm } from './hr-targets';
// Le même seuil de couverture, et pour la même raison, que la mesure de seuil
// et le découplage : sous 70 %, une moyenne ne décrit plus la fenêtre mais le
// fragment où le capteur a parlé. Une troisième copie de la constante aurait
// fini par diverger des deux autres.
import { LTHR_MIN_COVERAGE, type TimeWindow } from './lthr';
import { paceSecPerKm } from './pace';
import { cappedSampleDurationsS } from './series';
import { stepHrPercentBand, stepHrTargetBpm } from '../plan-steps/hr-target';
import {
  flattenSteps,
  sessionStepsTotals,
  type PlanSessionSteps,
  type PlanStep,
} from '../plan-steps/schema';

/** Ce qu'une ligne de comparaison mesure. L'unité en découle. */
export const EXECUTION_METRICS = ['pace', 'heart-rate', 'distance', 'duration'] as const;

export type ExecutionMetric = (typeof EXECUTION_METRICS)[number];

/**
 * Une bande prescrite, dans l'unité de la mesure — secondes par kilomètre,
 * battements, mètres, secondes. Bornes **incluses**.
 */
export type ExecutionBand = { min: number; max: number };

/** Où le réalisé tombe par rapport à ce qui était prescrit. */
export const EXECUTION_STANDINGS = ['in-band', 'under', 'over', 'no-band'] as const;

export type ExecutionStanding = (typeof EXECUTION_STANDINGS)[number];

/**
 * Une ligne de comparaison : une cible prescrite, ce qui a été fait, l'écart.
 *
 * `under` et `over` décrivent la **valeur**, pas une réussite : une allure sous
 * la bande d'un footing veut dire « couru plus vite que prescrit », ce qui est
 * un écart comme un autre. Le modèle ne porte aucun jugement, et l'affichage
 * n'en ajoute pas.
 */
export type ExecutionRow = {
  metric: ExecutionMetric;
  /**
   * Numéro de la répétition (à partir de 1), dans l'ordre du chrono. `null`
   * pour une ligne qui parle de la séance entière.
   */
  repetition: number | null;
  /** La bande prescrite, `null` quand la cible est une valeur unique. */
  band: ExecutionBand | null;
  /** La cible unique prescrite, `null` quand la cible est une bande. */
  target: number | null;
  /** Le réalisé, arrondi à l'unité d'affichage de la mesure. */
  actual: number;
  /**
   * Écart signé, dans l'unité de la mesure : au **bord de bande le plus
   * proche** (donc 0 dans la bande), ou à la cible unique. Positif = au-dessus
   * de la valeur prescrite.
   */
  delta: number;
  standing: ExecutionStanding;
};

/**
 * Ce qui n'a pas pu être comparé, et pourquoi.
 *
 * Un code, pas une phrase : la formulation appartient à l'écran (l'appli parle
 * français, ce module ne parle qu'en données). Chaque code correspond à une
 * cible réellement prescrite — ce qui n'a jamais été demandé n'a pas de motif.
 */
export const EXECUTION_GAPS = [
  /** Aucun flux de distance ni de temps : les blocs ne se localisent pas. */
  'streams-missing',
  /** Blocs prescrits en durée : la trace ne se fouille qu'en distance. */
  'repetitions-in-duration',
  /** Blocs de longueurs ou de cibles différentes : appariement ambigu. */
  'repetitions-uneven',
  /** Pas assez de fenêtres disjointes de la longueur prescrite dans la trace. */
  'repetitions-not-located',
  /** Fenêtres trouvées mais trop mal couvertes pour qu'une allure les décrive. */
  'repetitions-coverage',
  /** Étapes de course visant des allures différentes : pas de cible d'ensemble. */
  'pace-targets-uneven',
  /** Allure prescrite, mais l'activité n'en porte aucune. */
  'pace-not-measured',
  /** FC prescrite, mais aucune FC moyenne mesurée. */
  'heart-rate-not-measured',
  /** FC prescrite, mais rien ne permet de la résoudre en battements. */
  'heart-rate-not-anchored',
] as const;

export type ExecutionGap = (typeof EXECUTION_GAPS)[number];

/** Le format de répétitions prescrit par la séance. */
export type ExecutionRepeats = {
  /** Nombre de répétitions prescrites. 1 = un bloc continu. */
  count: number;
  /** Longueur d'une répétition, en mètres. */
  distanceM: number;
};

/** Ce que la séance prescrivait, ce qui en a été fait, et ce qui manque. */
export type SessionExecution = {
  /** Le format des blocs, `null` quand la séance n'en prescrit pas. */
  repeats: ExecutionRepeats | null;
  /** Les lignes comparables, dans l'ordre d'affichage. */
  rows: ExecutionRow[];
  /** Les cibles prescrites qui n'ont pas pu être comparées. */
  gaps: ExecutionGap[];
};

/** Les agrégats de l'activité réalisée — l'en-tête du fichier FIT. */
export type ExecutionActuals = {
  distanceM: number;
  movingTimeS: number;
  /** `null` quand l'activité ne porte pas d'allure moyenne. */
  avgPaceSecPerKm: number | null;
  /** `null` sans ceinture cardio. */
  avgHrBpm: number | null;
};

/** Les deux flux dont la localisation des blocs a besoin, alignés par index. */
export type ExecutionStreams = {
  /** Distance cumulée, en mètres. `null` là où le capteur s'est tu. */
  distance: readonly (number | null)[];
  /** Instants, en secondes depuis le départ. */
  time: readonly (number | null)[];
};

export type SessionExecutionInput = {
  /** Le déroulé structuré prescrit, `null` pour une séance historique. */
  steps: PlanSessionSteps | null;
  /** Allure cible de la séance, en s/km — une valeur unique, pas une bande. */
  targetPaceSecPerKm: number | null;
  /** Volume prescrit, en mètres. */
  volumeM: number | null;
  /** Durée prescrite, en secondes. */
  durationS: number | null;
  /**
   * L'ancrage cardiaque **du profil** — FC seuil si l'athlète en a adopté une,
   * FC max sinon. Sans lui, aucune cible cardiaque ne se résout en battements.
   */
  hrAnchor: HrZoneAnchor | null;
  actual: ExecutionActuals;
  /** Les flux, `null` quand l'activité n'en a pas d'exploitable. */
  streams: ExecutionStreams | null;
};

/**
 * La comparaison de la séance réalisée à la séance prescrite — `null` quand la
 * séance ne prescrit rien du tout (ni cible, ni volume, ni durée) : il n'y a
 * alors pas de panneau à afficher, et pas de motif à donner non plus.
 */
export function sessionExecution(input: SessionExecutionInput): SessionExecution | null {
  const flattened = input.steps === null ? [] : flattenSteps(input.steps);
  const runs = flattened.filter((step) => step.role === 'run');

  const rows: ExecutionRow[] = [];
  const gaps: ExecutionGap[] = [];

  const blocks = prescribedBlocks(flattened, runs);
  let repeats: ExecutionRepeats | null = null;

  if (blocks === null) {
    appendSessionTargets(input, runs, rows, gaps);
  } else if (typeof blocks === 'string') {
    gaps.push(blocks);
  } else {
    repeats = blocks.repeats;
    appendRepetitions(input, blocks, rows, gaps);
  }

  appendVolume(input, rows);

  if (rows.length === 0 && gaps.length === 0) return null;
  return { repeats, rows, gaps };
}

/**
 * Le résumé qui ouvre le panneau : « 5 répétitions sur 6 dans la bande »,
 * « 2 cibles sur 3 dans la bande ». `null` quand aucune ligne ne porte de bande
 * — un volume prescrit se lit à son écart, pas à un compte.
 *
 * Le dénominateur des répétitions est le nombre **prescrit** et non le nombre de
 * lignes : les deux sont égaux par construction (la localisation est tout ou
 * rien), et le dire ainsi évite qu'un jour un sous-ensemble se compte comme un
 * total.
 */
export function executionSummary(
  execution: SessionExecution,
): { scope: 'repetitions' | 'targets'; total: number; inBand: number } | null {
  const repetitions = execution.rows.filter((row) => row.repetition !== null);
  if (execution.repeats !== null && repetitions.length > 0) {
    return {
      scope: 'repetitions',
      total: execution.repeats.count,
      inBand: repetitions.filter((row) => row.standing === 'in-band').length,
    };
  }

  const banded = execution.rows.filter((row) => row.band !== null);
  if (banded.length === 0) return null;

  return {
    scope: 'targets',
    total: banded.length,
    inBand: banded.filter((row) => row.standing === 'in-band').length,
  };
}

/*
 * Lecture de la prescription.
 */

/**
 * Le format de blocs prescrit, un motif de refus, ou `null` quand la séance ne
 * se lit pas en blocs.
 *
 * Deux conditions, et il faut les deux :
 *
 * - **toutes** les étapes de course portent une bande d'allure — c'est ce
 *   qu'écrit le post-traitement des allures sur une séance de qualité, où la FC
 *   ne dirait rien de juste (elle met une à deux minutes à monter, un 400 m est
 *   fini avant) ;
 * - la séance porte au moins une étape **qui n'est pas de la course**
 *   (échauffement, récupération, retour au calme). Sans elle, l'effort *est* la
 *   séance : la fenêtre la plus rapide de la longueur prescrite couvre alors
 *   toute la trace, et prétendre l'avoir « localisée » ferait passer une allure
 *   moyenne pour un bloc retrouvé. Une séance de ce genre se compare au niveau
 *   séance, ce que fait l'autre branche.
 */
function prescribedBlocks(
  flattened: readonly PlanStep[],
  runs: readonly PlanStep[],
): PrescribedBlocks | ExecutionGap | null {
  if (runs.length === 0 || runs.length === flattened.length) return null;
  if (!runs.every(hasPaceBand)) return null;

  if (runs.every((step) => step.distanceM === null)) return 'repetitions-in-duration';

  const [first] = runs;
  const { distanceM, paceMinSecPerKm, paceMaxSecPerKm } = first;
  if (distanceM === null || paceMinSecPerKm === null || paceMaxSecPerKm === null) {
    return 'repetitions-uneven';
  }

  if (!runs.every((step) => sameEffort(step, first))) return 'repetitions-uneven';

  return {
    repeats: { count: runs.length, distanceM },
    band: { min: paceMinSecPerKm, max: paceMaxSecPerKm },
  };
}

/** Deux étapes d'effort identiques : même longueur, même bande d'allure. */
function sameEffort(step: PlanStep, reference: PlanStep): boolean {
  return (
    step.distanceM === reference.distanceM &&
    step.paceMinSecPerKm === reference.paceMinSecPerKm &&
    step.paceMaxSecPerKm === reference.paceMaxSecPerKm
  );
}

/** Le format des blocs et leur bande d'allure — la lecture faite une fois. */
type PrescribedBlocks = { repeats: ExecutionRepeats; band: ExecutionBand };

/** L'étape porte-t-elle ses deux bornes d'allure ? (le contrat les exige ensemble) */
function hasPaceBand(step: PlanStep): boolean {
  return step.paceMinSecPerKm !== null && step.paceMaxSecPerKm !== null;
}

/** L'étape porte-t-elle une cible cardiaque, résoluble ou non ? */
function hasHrTarget(step: PlanStep): boolean {
  return stepHrPercentBand(step) !== null || step.hrZone !== null;
}

/**
 * La bande d'allure de la séance entière — `null` quand aucune n'est prescrite,
 * `'uneven'` quand les étapes de course n'en visent pas toutes la même.
 *
 * Pas d'enveloppe ici, contrairement à la fréquence cardiaque : deux bandes
 * d'allure différentes ne sont pas deux nuances d'une même intensité mais deux
 * intensités (le bloc à allure objectif d'une sortie longue, par exemple). Les
 * envelopper donnerait une plage si large que l'allure moyenne y tomberait quoi
 * qu'il arrive — une comparaison qui ne peut pas échouer n'en est pas une.
 */
function paceTarget(runs: readonly PlanStep[]): ExecutionBand | 'uneven' | null {
  if (runs.length === 0 || !runs.every(hasPaceBand)) return null;

  const [first] = runs;
  const { paceMinSecPerKm, paceMaxSecPerKm } = first;
  if (paceMinSecPerKm === null || paceMaxSecPerKm === null) return null;

  const same = runs.every(
    (step) =>
      step.paceMinSecPerKm === paceMinSecPerKm && step.paceMaxSecPerKm === paceMaxSecPerKm,
  );
  return same ? { min: paceMinSecPerKm, max: paceMaxSecPerKm } : 'uneven';
}

/**
 * L'enveloppe des cibles cardiaques des étapes de course, en battements —
 * `null` quand aucune n'est prescrite, `'unresolved'` quand elles le sont mais
 * qu'aucune ne se résout (pas de référence au profil, ou rang de zone sans
 * bornes publiées).
 */
function hrEnvelope(
  runs: readonly PlanStep[],
  anchor: HrZoneAnchor | null,
): HrTargetBpm | 'unresolved' | null {
  if (runs.length === 0 || !runs.every(hasHrTarget)) return null;

  let minBpm = Number.POSITIVE_INFINITY;
  let maxBpm = Number.NEGATIVE_INFINITY;
  for (const step of runs) {
    const target = stepHrTargetBpm(step, anchor);
    if (target === null) return 'unresolved';
    minBpm = Math.min(minBpm, target.minBpm);
    maxBpm = Math.max(maxBpm, target.maxBpm);
  }

  return { minBpm, maxBpm };
}

/*
 * Les lignes.
 */

/** Les cibles d'une séance simple : allure moyenne, puis FC moyenne. */
function appendSessionTargets(
  input: SessionExecutionInput,
  runs: readonly PlanStep[],
  rows: ExecutionRow[],
  gaps: ExecutionGap[],
): void {
  const prescribed = paceTarget(runs);
  if (prescribed === 'uneven') {
    gaps.push('pace-targets-uneven');
  } else {
    const band = prescribed;
    const target = band === null ? input.targetPaceSecPerKm : null;

    if (band !== null || target !== null) {
      if (input.actual.avgPaceSecPerKm === null) gaps.push('pace-not-measured');
      else rows.push(compare('pace', null, band, target, input.actual.avgPaceSecPerKm));
    }
  }

  const hr = hrEnvelope(runs, input.hrAnchor);
  if (hr === 'unresolved') {
    gaps.push('heart-rate-not-anchored');
    return;
  }
  if (hr === null) return;

  if (input.actual.avgHrBpm === null) gaps.push('heart-rate-not-measured');
  else {
    rows.push(
      compare('heart-rate', null, { min: hr.minBpm, max: hr.maxBpm }, null, input.actual.avgHrBpm),
    );
  }
}

/** Une ligne par répétition localisée, dans l'ordre du chrono. */
function appendRepetitions(
  input: SessionExecutionInput,
  blocks: PrescribedBlocks,
  rows: ExecutionRow[],
  gaps: ExecutionGap[],
): void {
  const { repeats, band } = blocks;

  if (input.streams === null) {
    gaps.push('streams-missing');
    return;
  }

  const { distance, time } = input.streams;
  const windows = locateRepetitions(distance, time, repeats.distanceM, repeats.count);
  if (windows === null) {
    gaps.push('repetitions-not-located');
    return;
  }

  const paces: number[] = [];
  for (const window of windows) {
    if (windowCoverage(distance, time, window) < LTHR_MIN_COVERAGE) {
      gaps.push('repetitions-coverage');
      return;
    }

    const pace = paceSecPerKm(repeats.distanceM, window.toS - window.fromS);
    if (pace === null) {
      gaps.push('repetitions-not-located');
      return;
    }
    paces.push(pace);
  }

  paces.forEach((pace, index) => {
    rows.push(compare('pace', index + 1, band, null, pace));
  });
}

/**
 * Le volume : distance prescrite, ou durée à défaut.
 *
 * Une seule des deux, et la distance d'abord : une séance mesurée en distance
 * porte souvent aussi une durée estimée, et afficher les deux ferait passer une
 * estimation pour une consigne. Les totaux du déroulé priment sur les colonnes
 * de la séance — ils sont la somme de ce qui a réellement été prescrit, quand
 * `volumeM` peut n'être qu'un résumé.
 */
function appendVolume(input: SessionExecutionInput, rows: ExecutionRow[]): void {
  const totals = input.steps === null ? null : sessionStepsTotals(input.steps);

  const distanceM = totals?.distanceM ?? input.volumeM;
  if (distanceM !== null && distanceM > 0) {
    rows.push(compare('distance', null, null, distanceM, input.actual.distanceM));
    return;
  }

  const durationS = totals?.durationS ?? input.durationS;
  if (durationS !== null && durationS > 0) {
    rows.push(compare('duration', null, null, durationS, input.actual.movingTimeS));
  }
}

/**
 * Une ligne : arrondi à l'unité d'affichage, position par rapport à la bande,
 * écart signé au bord le plus proche.
 *
 * L'arrondi vient **avant** la comparaison (cf. l'en-tête) : c'est la valeur que
 * l'athlète lit qui doit être dans la bande, ou en dehors.
 */
function compare(
  metric: ExecutionMetric,
  repetition: number | null,
  band: ExecutionBand | null,
  target: number | null,
  raw: number,
): ExecutionRow {
  const actual = Math.round(raw);

  if (band === null) {
    const reference = target === null ? actual : Math.round(target);
    return {
      metric,
      repetition,
      band: null,
      target: reference,
      actual,
      delta: actual - reference,
      standing: 'no-band',
    };
  }

  const min = Math.round(band.min);
  const max = Math.round(band.max);

  if (actual < min) {
    return { metric, repetition, band: { min, max }, target: null, actual, delta: actual - min, standing: 'under' };
  }
  if (actual > max) {
    return { metric, repetition, band: { min, max }, target: null, actual, delta: actual - max, standing: 'over' };
  }
  return { metric, repetition, band: { min, max }, target: null, actual, delta: 0, standing: 'in-band' };
}

/*
 * Localisation des blocs dans la trace.
 */

/**
 * `count` fenêtres **disjointes** de `targetM` mètres, dans l'ordre du chrono —
 * `null` s'il n'en existe pas autant.
 *
 * Glouton, du plus rapide au plus lent : on retient la portion la plus rapide de
 * la longueur prescrite ({@link fastestSegmentWindow}), puis on recommence
 * séparément sur ce qui la précède et sur ce qui la suit. Sur une séance courue
 * comme prescrite, ces fenêtres **sont** les répétitions — toute fenêtre décalée
 * mordrait sur une récupération, donc serait plus lente. Sur une séance courue
 * autrement, ce ne sont que les portions les plus rapides, et c'est pour cela
 * que le panneau dit d'où elles sortent.
 *
 * Les bornes de segment sont des **index** : la fenêtre rendue par
 * `fastestSegmentWindow` est en instants (sa borne de départ est interpolée), on
 * la reporte donc sur l'échantillon qui la précède et sur celui qui la termine.
 * Le segment de gauche s'arrête avant le premier échantillon de la fenêtre,
 * celui de droite reprend après le dernier : aucune fenêtre suivante ne peut
 * chevaucher une fenêtre déjà retenue.
 */
export function locateRepetitions(
  distance: readonly (number | null)[],
  time: readonly (number | null)[],
  targetM: number,
  count: number,
): TimeWindow[] | null {
  if (!Number.isInteger(count) || count < 1) return null;
  if (!Number.isFinite(targetM) || targetM <= 0) return null;

  const length = Math.min(distance.length, time.length);
  if (length < 2) return null;

  let segments: { from: number; to: number }[] = [{ from: 0, to: length }];
  const found: TimeWindow[] = [];

  for (let round = 0; round < count; round += 1) {
    let best: TimeWindow | null = null;
    let bestSegment = -1;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const window = fastestSegmentWindow(
        distance.slice(segment.from, segment.to),
        time.slice(segment.from, segment.to),
        targetM,
      );
      if (window === null) continue;
      if (best === null || window.toS - window.fromS < best.toS - best.fromS) {
        best = window;
        bestSegment = index;
      }
    }

    if (best === null) return null;
    found.push(best);

    const segment = segments[bestSegment];
    const bounds = windowIndexBounds(time, segment, best);
    segments = [
      ...segments.slice(0, bestSegment),
      { from: segment.from, to: bounds.first },
      { from: bounds.last + 1, to: segment.to },
      ...segments.slice(bestSegment + 1),
    ].filter((part) => part.to - part.from >= 2);
  }

  return found.sort((a, b) => a.fromS - b.fromS);
}

/**
 * Les index du premier et du dernier échantillon que la fenêtre couvre, dans le
 * segment où elle a été trouvée.
 *
 * L'échantillon qui précède la borne de départ interpolée reste au segment de
 * gauche : il n'appartient pas à la fenêtre, et l'en priver couperait un
 * échantillon utile à la recherche suivante.
 */
function windowIndexBounds(
  time: readonly (number | null)[],
  segment: { from: number; to: number },
  window: TimeWindow,
): { first: number; last: number } {
  let first = segment.to;
  let last = segment.from;

  for (let index = segment.from; index < segment.to; index += 1) {
    const instant = time[index];
    if (instant === null || !Number.isFinite(instant)) continue;
    if (instant < window.fromS || instant > window.toS) continue;
    if (index < first) first = index;
    if (index > last) last = index;
  }

  return first > last ? { first: segment.from, last: segment.to - 1 } : { first, last };
}

/**
 * Part de la fenêtre réellement couverte par des mesures de distance, dans
 * [0, 1].
 *
 * Le calcul est celui de la mesure de seuil : les durées viennent du **sous-axe
 * des instants mesurés**, plafonnées comme partout ailleurs — un canal
 * clairsemé (une mesure toutes les 10 s) couvre bien 100 % de sa fenêtre, un
 * décrochage de deux minutes y creuse un trou que personne ne comble.
 */
export function windowCoverage(
  distance: readonly (number | null)[],
  time: readonly (number | null)[],
  window: TimeWindow,
): number {
  const spanS = window.toS - window.fromS;
  if (!Number.isFinite(spanS) || spanS <= 0) return 0;

  const instants: number[] = [];
  const count = Math.min(distance.length, time.length);
  for (let index = 0; index < count; index += 1) {
    const instant = time[index];
    const mark = distance[index];
    if (instant === null || !Number.isFinite(instant)) continue;
    if (instant < window.fromS || instant > window.toS) continue;
    if (mark === null || !Number.isFinite(mark)) continue;
    if (instants.length > 0 && instant < instants[instants.length - 1]) continue;

    instants.push(instant);
  }
  if (instants.length === 0) return 0;

  let coveredS = 0;
  for (const duration of cappedSampleDurationsS(instants)) coveredS += duration;

  return coveredS / spanS;
}
