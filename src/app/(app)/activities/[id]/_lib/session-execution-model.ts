/**
 * Mise en forme des « Objectifs de la séance » — fonctions pures, testées.
 *
 * Le modèle de comparaison est calculé par `lib/metrics/session-execution` :
 * ici, on ne fait que **l'écrire et le mettre en géométrie**. Aucune règle
 * physio, aucun arrondi de comparaison — la valeur affichée est celle que le
 * modèle a déjà arrêtée, faute de quoi l'écran pourrait contredire son propre
 * verdict.
 *
 * ## Des barres de type *bullet*, et rien qui juge par la couleur
 *
 * Chaque cible devient une barre : la **bande visée** en fond, le **réalisé** en
 * marqueur par-dessus. Toutes les bandes ont le même habillage, quelle que soit
 * la mesure — courir plus vite que la bande d'un footing n'est pas « vert », et
 * une FC au-dessus de la sienne n'est pas « rouge » : ce sont deux écarts, que
 * la position et le texte disent. Le seul jeton sémantique employé est
 * `positive`, et seulement en **coche** sur les lignes dans la bande (cf.
 * `.claude/rules/design.md`).
 *
 * Chaque barre porte donc son étiquette écrite — la valeur, la cible, l'écart —
 * parce que la position d'un marqueur ne se lit pas au pixel près et que la
 * couleur ne porte jamais l'information seule.
 */

import type {
  ExecutionBand,
  ExecutionGap,
  ExecutionRow,
  SessionExecution,
} from "@/lib/metrics";
import { executionSummary } from "@/lib/metrics";

import { formatDistance, formatHeartRate, formatNumber, formatPace } from "../../../_lib/format";
import { formatClock, formatPaceValue } from "./format-detail";

/**
 * Largeur minimale d'une bande à l'écran, en pourcentage du rail.
 *
 * Même intention que l'amorce des barres de zones : une bande écrasée par un
 * écart énorme doit rester perceptible. C'est un plancher de **rendu**, pas une
 * retouche de la donnée — la valeur exacte reste écrite sous la barre.
 */
export const MIN_BAND_WIDTH_PCT = 2;

/** La géométrie d'une barre, en pourcentages du rail. */
export type ExecutionBarGeometry =
  | {
      kind: "band";
      /** Bord gauche de la bande visée. */
      bandStartPct: number;
      bandWidthPct: number;
      /** Position du réalisé. */
      markerPct: number;
    }
  | {
      kind: "target";
      /** Étendue prescrite, depuis zéro. */
      targetWidthPct: number;
      /** Position du réalisé. */
      markerPct: number;
    };

/** Une barre prête à peindre : ses textes, sa géométrie, son verdict. */
export type ExecutionBar = {
  key: string;
  /** « Répétition 3 », « Allure moyenne », « Distance ». */
  label: string;
  /** Le réalisé, dans son unité : « 4:32/km ». */
  value: string;
  /** La consigne : « cible 4:20–4:25/km », « prescrit 10,0 km ». */
  target: string;
  /** L'écart signé (« +7 s/km »), `null` quand le réalisé est dans la bande. */
  delta: string | null;
  inBand: boolean;
  geometry: ExecutionBarGeometry;
};

/** Le libellé d'une ligne. Les répétitions sont numérotées dans l'ordre couru. */
function rowLabel(row: ExecutionRow, repeatCount: number): string {
  if (row.repetition !== null) {
    return repeatCount === 1 ? "Bloc d'effort" : `Répétition ${row.repetition}`;
  }

  switch (row.metric) {
    case "pace":
      return "Allure moyenne";
    case "heart-rate":
      return "FC moyenne";
    case "distance":
      return "Distance";
    default:
      return "Durée";
  }
}

/** Une valeur, dans l'unité de sa mesure. */
function formatMeasure(metric: ExecutionRow["metric"], value: number): string {
  switch (metric) {
    case "pace":
      return formatPace(value);
    case "heart-rate":
      return formatHeartRate(value);
    case "distance":
      return formatDistance(value);
    default:
      return formatClock(value);
  }
}

/**
 * Une bande, écrite comme le plan écrit ses cibles : `4:20–4:25/km`,
 * `124–150 bpm` — l'unité une seule fois, au bout.
 */
function formatBand(metric: ExecutionRow["metric"], band: ExecutionBand): string {
  if (metric === "pace") return `${formatPaceValue(band.min)}–${formatPace(band.max)}`;
  if (metric === "heart-rate") return `${band.min}–${band.max} bpm`;

  return `${formatMeasure(metric, band.min)}–${formatMeasure(metric, band.max)}`;
}

/** La consigne de la ligne : une bande visée, ou une valeur prescrite. */
function formatTarget(row: ExecutionRow): string {
  if (row.band !== null) return `cible ${formatBand(row.metric, row.band)}`;
  return `prescrit ${formatMeasure(row.metric, row.target ?? row.actual)}`;
}

/** Un entier signé, signe moins typographique compris : `+7`, `−12`. */
function signed(value: number, digits = 0): string {
  return value > 0 ? `+${formatNumber(value, digits)}` : formatNumber(value, digits);
}

/**
 * L'écart, dans l'unité de la mesure — `null` dans la bande, où il vaut zéro et
 * où la coche le dit mieux qu'un « +0 ».
 *
 * L'écart d'une allure se compte en **secondes par kilomètre** et pas en
 * pourcentage : c'est l'unité dans laquelle un coureur pense sa séance.
 */
function formatDelta(row: ExecutionRow): string | null {
  if (row.delta === 0) return null;

  switch (row.metric) {
    case "pace":
      return `${signed(row.delta)} s/km`;
    case "heart-rate":
      return `${signed(row.delta)} bpm`;
    case "distance":
      return Math.abs(row.delta) < 1000
        ? `${signed(row.delta)} m`
        : `${signed(row.delta / 1000, 1)} km`;
    default: {
      const clock = formatClock(Math.abs(row.delta));
      return row.delta > 0 ? `+${clock}` : `−${clock}`;
    }
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * La géométrie d'une ligne à bande.
 *
 * Le domaine tient la bande **et** le réalisé, avec de la marge de chaque côté :
 * un quart de l'écart total, jamais moins que la demi-largeur de la bande. Il
 * n'est donc jamais tronqué — un réalisé très loin de la cible écrase la bande
 * plutôt que de sortir du rail, ce qui est exactement ce qu'il faut voir.
 */
function bandGeometry(band: ExecutionBand, actual: number): ExecutionBarGeometry {
  const low = Math.min(band.min, actual);
  const high = Math.max(band.max, actual);
  const pad = Math.max((high - low) / 4, (band.max - band.min) / 2, 1);

  const from = low - pad;
  const width = high + pad - from;
  if (!(width > 0)) {
    return { kind: "band", bandStartPct: 0, bandWidthPct: 100, markerPct: 50 };
  }

  const bandStartPct = clamp(((band.min - from) / width) * 100);
  const bandEndPct = clamp(((band.max - from) / width) * 100);

  return {
    kind: "band",
    bandStartPct,
    bandWidthPct: Math.max(MIN_BAND_WIDTH_PCT, bandEndPct - bandStartPct),
    markerPct: clamp(((actual - from) / width) * 100),
  };
}

/**
 * La géométrie d'une ligne à valeur unique : l'étendue prescrite se remplit
 * depuis zéro, le réalisé est le marqueur posé dessus.
 *
 * Le même partage des rôles que sur une ligne à bande — l'aplat est **ce qui
 * était demandé**, le marqueur **ce qui a été fait**. L'inverser d'une ligne à
 * l'autre ferait lire deux choses différentes au même habillage.
 *
 * L'échelle part de zéro parce qu'un volume est une quantité : la couper
 * exagérerait un écart de 2 % jusqu'à lui faire ressembler à une séance ratée.
 */
function targetGeometry(target: number, actual: number): ExecutionBarGeometry {
  const top = Math.max(target, actual) * 1.06;
  if (!(top > 0)) return { kind: "target", targetWidthPct: 0, markerPct: 0 };

  return {
    kind: "target",
    targetWidthPct: clamp((target / top) * 100),
    markerPct: clamp((actual / top) * 100),
  };
}

/** Les barres du panneau, dans l'ordre où le modèle les rend. */
export function executionBars(execution: SessionExecution): ExecutionBar[] {
  const repeatCount = execution.repeats?.count ?? 0;

  return execution.rows.map((row, index) => ({
    key: `${row.metric}-${row.repetition ?? index}`,
    label: rowLabel(row, repeatCount),
    value: formatMeasure(row.metric, row.actual),
    target: formatTarget(row),
    delta: formatDelta(row),
    inBand: row.standing === "in-band",
    geometry:
      row.band === null
        ? targetGeometry(row.target ?? row.actual, row.actual)
        : bandGeometry(row.band, row.actual),
  }));
}

/**
 * Le résumé qui ouvre le panneau — `null` quand aucune ligne ne porte de bande
 * (un volume prescrit se lit à son écart, pas à un compte).
 */
export function executionHeadline(execution: SessionExecution): string | null {
  const summary = executionSummary(execution);
  if (summary === null) return null;

  const { scope, total, inBand } = summary;

  if (scope === "repetitions") {
    if (total === 1) {
      return inBand === 1
        ? "Le bloc d'effort est dans la bande d'allure."
        : "Le bloc d'effort est hors de la bande d'allure.";
    }
    const plural = inBand > 1 ? "répétitions" : "répétition";
    return `${inBand} ${plural} sur ${total} dans la bande d'allure.`;
  }

  if (total === 1) {
    const row = execution.rows.find((candidate) => candidate.band !== null);
    const label = row === undefined ? "La cible" : rowLabel(row, 0);
    return inBand === 1 ? `${label} dans la bande.` : `${label} hors de la bande.`;
  }

  const plural = inBand > 1 ? "cibles" : "cible";
  return `${inBand} ${plural} sur ${total} dans la bande.`;
}

/**
 * Ce qu'une comparaison manquante a le droit de dire — une phrase par motif, et
 * jamais de comparaison approchée à la place.
 *
 * `Record` volontaire : un motif ajouté au modèle casse la compilation ici tant
 * qu'il n'a pas sa phrase.
 */
export const EXECUTION_GAP_TEXTS: Record<ExecutionGap, string> = {
  "streams-missing":
    "Les blocs prescrits n'ont pas pu être retrouvés : cette séance n'a pas de trace détaillée.",
  "repetitions-in-duration":
    "Les blocs sont prescrits en durée : la trace ne se fouille qu'en distance, ils ne se localisent pas.",
  "repetitions-uneven":
    "Les blocs prescrits n'ont pas tous la même longueur ni la même cible : les retrouver serait ambigu.",
  "repetitions-not-located":
    "Les blocs prescrits ne se retrouvent pas dans la trace — séance écourtée, ou courue très différemment de ce qui était prévu.",
  "repetitions-coverage":
    "Le capteur de distance a trop de trous sur les blocs retrouvés : leur allure moyenne ne les décrirait pas.",
  "pace-targets-uneven":
    "Les étapes ne visent pas toutes la même allure : la séance n'a pas de cible d'ensemble à comparer.",
  "pace-not-measured": "Une allure était prescrite, mais cette séance n'en porte aucune.",
  "heart-rate-not-measured":
    "Une cible cardiaque était prescrite, mais aucune fréquence cardiaque n'a été enregistrée.",
  "heart-rate-not-anchored":
    "La cible cardiaque prescrite ne se résout pas en battements : il manque une FC max, ou une FC seuil, à ton profil.",
};

/** Les phrases des motifs, dans l'ordre où le modèle les a rendus. */
export function executionGapTexts(execution: SessionExecution): string[] {
  return execution.gaps.map((gap) => EXECUTION_GAP_TEXTS[gap]);
}
