/**
 * Les quatre séries du panneau « Bien-être », prêtes à tracer.
 *
 * Module pur : il reçoit les journées du DAL et rend, pour chaque mesure, la
 * suite des valeurs **réellement mesurées** plus les quelques chaînes que le
 * panneau affiche. Aucun accès serveur, aucun composant — donc testable seul.
 *
 * ## Deux décisions à connaître avant de lire une courbe
 *
 * 1. **Les nuits sans mesure ne sont pas comblées.** Ni report de la veille, ni
 *    interpolation, ni zéro : la série ne contient que ce qui a été mesuré.
 * 2. **La courbe est donc une suite de mesures, pas un axe de temps.** Trois
 *    nuits sans montre au milieu du mois ne creusent aucun trou dans le tracé,
 *    elles rapprochent simplement deux points. C'est le prix à payer pour ne rien
 *    inventer, et c'est pourquoi le panneau affiche toujours **le nombre de
 *    nuits mesurées** à côté de la courbe : sans lui, une série de six points
 *    aurait l'air d'un mois complet.
 */

import { formatDuration, formatNumber } from "../../_lib/format";
import type { MetricSheetId } from "../../_lib/metric-sheets";

/** Une journée de relevé, décrite structurellement (aucun import `server-only`). */
export type WellnessDayLike = {
  day: string;
  restingHrBpm: number | null;
  hrvRmssdMs: number | null;
  sleepTimeS: number | null;
  weightKg: number | null;
};

/** Une mesure et sa série, telles que le panneau les rend. */
export type WellnessSeriesView = {
  key: "resting-hr" | "hrv" | "sleep" | "weight";
  label: string;
  /** Fiche ⓘ, quand la mesure en a une. */
  sheet: MetricSheetId | null;
  /** Valeurs mesurées, de la plus ancienne à la plus récente. */
  values: number[];
  /** Dernière valeur, formatée avec son unité — `null` si rien n'a été mesuré. */
  latest: string | null;
  /** Amplitude de la période, ex. `46 → 54 bpm`. `null` sous deux mesures. */
  range: string | null;
  /** Ce qu'on écrit à la place de la courbe quand elle n'existe pas. */
  absent: string;
};

/** Ce qui distingue une mesure d'une autre : où la lire, comment l'écrire. */
type SeriesSpec = {
  key: WellnessSeriesView["key"];
  label: string;
  sheet: MetricSheetId | null;
  read: (day: WellnessDayLike) => number | null;
  format: (value: number) => string;
  absent: string;
};

const SERIES: readonly SeriesSpec[] = [
  {
    key: "resting-hr",
    label: "FC de repos",
    sheet: "resting-hr",
    read: (day) => day.restingHrBpm,
    format: (value) => `${formatNumber(value, 0)} bpm`,
    absent: "Aucune FC de repos mesurée sur la période.",
  },
  {
    key: "hrv",
    label: "HRV (rMSSD)",
    sheet: "hrv",
    read: (day) => day.hrvRmssdMs,
    format: (value) => `${formatNumber(value, 0)} ms`,
    absent: "Aucune HRV mesurée sur la période.",
  },
  {
    key: "sleep",
    label: "Sommeil",
    sheet: null,
    read: (day) => day.sleepTimeS,
    // `formatDuration` porte son unité (« 7 h 10 ») : rien à ajouter derrière.
    format: (value) => formatDuration(value),
    absent: "Aucune nuit mesurée sur la période.",
  },
  {
    key: "weight",
    label: "Poids",
    sheet: null,
    read: (day) => day.weightKg,
    format: (value) => `${formatNumber(value, 1)} kg`,
    // La seule des quatre qui ne vient pas de la montre : le dire évite de
    // chercher pourquoi la courbe est vide alors que le reste est plein.
    absent: "Aucune pesée sur la période.",
  },
];

/** L'amplitude d'une série, de la plus petite à la plus grande valeur. */
function rangeOf(values: readonly number[], format: (value: number) => string): string | null {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // Série parfaitement plate : « 48 → 48 bpm » ne dirait rien de plus que la
  // dernière valeur, déjà affichée juste à côté.
  return min === max ? null : `${format(min)} → ${format(max)}`;
}

/**
 * Les quatre séries, dans l'ordre où le panneau les montre.
 *
 * `days` est attendu **du plus ancien au plus récent** — c'est l'ordre dans
 * lequel le DAL les rend, et celui dans lequel une courbe se lit.
 */
export function buildWellnessSeries(days: readonly WellnessDayLike[]): WellnessSeriesView[] {
  return SERIES.map((spec) => {
    const values: number[] = [];
    for (const day of days) {
      const value = spec.read(day);
      if (value !== null) values.push(value);
    }

    const last = values[values.length - 1];

    return {
      key: spec.key,
      label: spec.label,
      sheet: spec.sheet,
      values,
      latest: last === undefined ? null : spec.format(last),
      range: rangeOf(values, spec.format),
      absent: spec.absent,
    };
  });
}

/** `true` quand aucune des quatre mesures n'existe : le panneau dit alors autre chose. */
export function hasNoWellnessMeasure(series: readonly WellnessSeriesView[]): boolean {
  return series.every((entry) => entry.values.length === 0);
}
