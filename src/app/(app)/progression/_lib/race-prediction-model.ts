/**
 * Tableau des chronos prévus : le modèle que le panneau affiche — fonctions
 * pures, testées.
 *
 * Deux choses y sont construites, et la seconde compte autant que la première :
 * les lignes du tableau, et **ce que ces lignes valent**. Le socle
 * (`lib/metrics/race-prediction`) accompagne chaque chrono d'un niveau de
 * confiance ; le laisser dans la donnée sans le montrer reviendrait à présenter
 * une conjecture marathon avec la même autorité qu'un 5 km calibré.
 *
 * La réserve se dit deux fois, et pas quatre : une **marque discrète par
 * ligne** (un mot, en couleur de texte — jamais une couleur de série, jamais un
 * jeton d'état : une extrapolation n'est pas une erreur), et **une** phrase
 * sous le tableau qui explique d'où vient la limite. Répéter l'explication à
 * chaque ligne la rendrait invisible.
 */

import { civilDaysBetween } from "@/lib/dates/civil";
import { REFERENCE_UPDATE_MIN_GAP_DAYS } from "@/lib/metrics/fitness-test";
import {
  CALIBRATED_WINDOW_MIN,
  paceSecPerKm,
  type PredictionConfidence,
  type RacePrediction,
} from "@/lib/metrics";
import type { RaceAnchorDto } from "@/data/race-prediction";

import { REFERENCE_DISTANCE_LABELS } from "../../_lib/distance-labels";
import { formatCivilFullDate, formatClock, formatPace } from "../../_lib/format";

/** Valeur absente : tiret cadratin, jamais une case vide ni un zéro inventé. */
const MISSING = "—";

/**
 * Le mot qui marque chaque ligne, et sa nuance de gris.
 *
 * Une échelle de **clarté**, pas de teinte : le niveau de confiance qualifie la
 * lecture, il ne décrit pas un état de l'athlète — `warning` ou `negative`
 * feraient passer un marathon prédit pour un problème.
 */
export const CONFIDENCE_MARKS: Record<
  PredictionConfidence,
  { label: string; className: string }
> = {
  calibrated: { label: "calibré", className: "text-fg-muted" },
  extrapolated: { label: "extrapolé", className: "text-fg-faint" },
  speculative: { label: "spéculatif", className: "text-fg-faint" },
};

export type RacePredictionRow = {
  /** Clé de rendu : une distance n'apparaît qu'une fois. */
  key: string;
  /** « Semi », « Marathon »… */
  distance: string;
  /** Chrono prévu, ex. `1:52:04`. */
  time: string;
  /** Allure correspondante, ex. `5:19/km`. */
  pace: string;
  confidence: PredictionConfidence;
};

/**
 * Les lignes du tableau, dans l'ordre du socle (5 km → marathon).
 *
 * Une distance dont la prédiction n'est pas encadrée est simplement absente de
 * `races` : elle ne produit donc aucune ligne, plutôt qu'une ligne à zéro.
 */
export function buildRacePredictionRows(
  races: readonly RacePrediction[],
): RacePredictionRow[] {
  return races.map((race) => {
    // Jamais `null` en pratique — les deux grandeurs sont strictement
    // positives —, mais une allure ne s'invente pas : le tiret reste le seul
    // repli honnête.
    const pace = paceSecPerKm(race.distanceM, race.timeS);

    return {
      key: race.distance,
      distance: REFERENCE_DISTANCE_LABELS[race.distance],
      time: formatClock(race.timeS),
      pace: pace === null ? MISSING : formatPace(pace),
      confidence: race.confidence,
    };
  });
}

/**
 * La phrase qui explique les marques, **une fois**, et seulement pour les
 * niveaux réellement présents dans le tableau.
 *
 * La fenêtre citée sort de {@link CALIBRATED_WINDOW_MIN} plutôt que d'être
 * recopiée : si le socle la déplaçait, cette phrase la suivrait.
 */
export function describePredictionConfidence(
  rows: readonly RacePredictionRow[],
): string {
  const levels = new Set(rows.map((row) => row.confidence));

  const parts = [
    `Le modèle de Daniels n'est ajusté que sur des efforts de ${CALIBRATED_WINDOW_MIN.from} à ${CALIBRATED_WINDOW_MIN.to} minutes : au-delà, il est prolongé.`,
  ];

  if (levels.has("extrapolated")) {
    parts.push(
      "Une prédiction extrapolée garde son ordre de grandeur, pas sa minute.",
    );
  }
  if (levels.has("speculative")) {
    parts.push(
      "Une prédiction spéculative ignore l'épuisement du glycogène et la thermorégulation : elle lit trop vite, et c'est le cas d'un marathon à tout niveau.",
    );
  }

  return parts.join(" ");
}

/** Ce que l'écran dit de l'ancre : sur quoi la prédiction repose, et depuis quand. */
export type RaceAnchorView = {
  /** « 10 km · 48:30 » — le chrono qui calcule tout le tableau. */
  chrono: string;
  /** D'où il vient et de quand il date. */
  source: string;
  /** La cadence de recalibration de Daniels est dépassée, `null` sinon. */
  note: string | null;
};

/**
 * Âge d'une date, en français. Jours jusqu'à deux semaines, semaines ensuite —
 * un seul changement d'unité, et c'est celle dans laquelle la cadence de
 * recalibration se compte.
 */
function describeAge(days: number): string {
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return "hier";
  if (days < 14) return `il y a ${days} jours`;
  return `il y a ${Math.round(days / 7)} semaines`;
}

/**
 * Ce que la prédiction repose, mis en français.
 *
 * **La date affichée est nommée pour ce qu'elle est.** Quand elle vient d'un
 * test, `plans.reference_updated_on` marque le dernier test **évalué**, pas le
 * chrono retenu : une recalibration refusée fait avancer le marqueur sans
 * toucher au chrono. La phrase dit donc « dernier test », jamais « chrono du
 * … » — l'ancre réelle est au plus vieille que cette date, et l'âge annoncé
 * reste alors un minorant honnête.
 */
export function describeRaceAnchor(anchor: RaceAnchorDto, today: string): RaceAnchorView {
  const chrono = `${REFERENCE_DISTANCE_LABELS[anchor.distance]} · ${formatClock(anchor.timeS)}`;
  const day = formatCivilFullDate(anchor.since, today);
  const days = civilDaysBetween(anchor.since, today);
  const age = describeAge(days);

  const source =
    day === null
      ? anchor.fromTest
        ? "Relevé par un test chronométré."
        : "Chrono de référence déclaré à l'ouverture de ton plan."
      : anchor.fromTest
        ? `Dernier test chronométré évalué le ${day}, ${age}.`
        : `Chrono de référence déclaré à l'ouverture de ton plan, le ${day}, ${age}.`;

  return {
    chrono,
    source,
    note:
      days > REFERENCE_UPDATE_MIN_GAP_DAYS
        ? `Daniels recommande de recaler la référence toutes les ${REFERENCE_UPDATE_MIN_GAP_DAYS / 7} semaines : ces chronos décrivent la forme de cette date-là, pas celle d'aujourd'hui.`
        : null,
  };
}
