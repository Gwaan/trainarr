/**
 * Les quatre tendances du panneau « Bien-être » : FC de repos, HRV, sommeil,
 * poids — décrites dans le vocabulaire de graphe de la page.
 *
 * Module pur : il reçoit les journées du DAL et rend le modèle que
 * `SyncedPanels` consomme (`src/lib/chart/series.ts`), plus les phrases à écrire
 * pour les mesures qui n'ont pas de courbe. Aucun accès serveur, aucun
 * composant — donc testable seul.
 *
 * ## Trois décisions à connaître avant de lire une courbe
 *
 * 1. **L'abscisse est une vraie échelle de dates** ({@link DATE_AXIS}), commune
 *    aux quatre panneaux et parcourue par un seul curseur. C'est ce qui permet
 *    la lecture croisée qui fait tout l'intérêt de ces mesures — « HRV basse
 *    **et** FC de repos haute la même nuit » — et c'est ce que la page fait déjà
 *    pour la charge. (Avant, ces séries étaient des suites de valeurs sans axe :
 *    trois nuits sans montre rapprochaient simplement deux points, et il fallait
 *    afficher le nombre de mesures pour qu'on ne lise pas six points comme un
 *    mois plein. L'axe des dates rend ce garde-fou inutile : le trou se voit.)
 * 2. **Les nuits sans mesure ne sont pas comblées.** Ni report de la veille, ni
 *    interpolation, ni zéro : la courbe se **coupe** sur un trou (`linePath`), et
 *    le survol d'un jour sans mesure affiche « — » plutôt qu'une valeur voisine
 *    (`panelValueAt`). Une mesure absente est dite absente, jusque dans le
 *    curseur.
 * 3. **Une mesure sans tendance n'est pas tracée** : sous deux nuits mesurées, il
 *    n'y a pas de ligne à tirer, et le panneau écrit ce qui manque
 *    ({@link WellnessTrends.absences}) au lieu d'un cadre vide.
 *
 * ## La HRV, et laquelle
 *
 * Deux grandeurs se cachent derrière « HRV » (cf. `src/lib/wellness/hrv.ts`).
 * Une série n'en mélange **jamais** deux : elle trace la variante majoritaire de
 * la fenêtre, l'annonce dans son titre (« HRV (SDNN) »), et les nuits de l'autre
 * variante sortent de la courbe comme des trous — les convertir serait inventer
 * une mesure, les empiler ferait une chute qui n'a pas eu lieu.
 */

import { buildChartsModel, type ChartsModel, type SeriesSpec } from "@/lib/chart/series";
import { civilDateToMs } from "@/lib/dates/civil";
import { hrvLabel, majorityHrvVariant, readHrv, type HrvVariant } from "@/lib/wellness/hrv";

import { formatDuration, formatNumber } from "../../_lib/format";
import type { MetricSheetId } from "../../_lib/metric-sheets";
import { DATE_AXIS } from "./date-axis";

/** Une journée de relevé, décrite structurellement (aucun import `server-only`). */
export type WellnessDayLike = {
  day: string;
  restingHrBpm: number | null;
  hrvRmssdMs: number | null;
  hrvSdnnMs: number | null;
  sleepTimeS: number | null;
  weightKg: number | null;
};

/** Ce qu'on écrit à la place d'une courbe qui n'existe pas. */
export type WellnessAbsence = {
  /** Clé de la série concernée — celle du panneau qu'elle remplace. */
  key: string;
  message: string;
};

export type WellnessTrends = {
  /** Les panneaux traçables et leur survol synchronisé. `null` s'il n'y en a aucun. */
  charts: ChartsModel<WellnessDayLike> | null;
  /** Une phrase par mesure sans courbe, dans l'ordre des séries. */
  absences: readonly WellnessAbsence[];
};

/**
 * Graduation de sommeil : `7 h` sur l'heure ronde, `7 h 10` sinon.
 *
 * `formatDuration` écrirait « 7 h 00 » — deux caractères de plus dans une
 * gouttière large de 36 px sur téléphone, pour une information nulle.
 */
function formatSleepTick(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
}

/** Une série et la phrase qui la remplace quand elle n'a pas de quoi se tracer. */
type WellnessSeries = {
  spec: SeriesSpec<WellnessDayLike>;
  absent: string;
};

/**
 * La série de HRV, construite autour de la variante que la fenêtre porte.
 *
 * `variant` à `null` (aucune HRV du tout) donne une série vide : `read` ne rend
 * rien, le panneau n'est pas tracé, et le titre n'annonce aucune grandeur qu'on
 * n'aurait pas mesurée.
 */
function hrvSeries(variant: HrvVariant | null): WellnessSeries {
  return {
    spec: {
      key: "hrv",
      title: hrvLabel(variant),
      strokeClass: "stroke-chart-cadence",
      dotClass: "bg-chart-cadence",
      fill: null,
      invertY: false,
      stepKind: "decimal",
      hasZero: true,
      targetTicks: 3,
      heightClass: "h-24 sm:h-28",
      format: (value) => `${formatNumber(value, 0)} ms`,
      formatTick: (value) => formatNumber(value, 0),
      read: (day) => {
        const measure = readHrv(day);
        // La nuit mesurée dans l'autre variante est un trou, pas une valeur : on
        // ne convertit pas un SDNN en rMSSD, personne ne le sait faire.
        return measure === null || measure.variant !== variant ? null : measure.value;
      },
    },
    absent: "Aucune HRV mesurée sur la période.",
  };
}

/** Les quatre séries, dans l'ordre où le panneau les empile. */
function wellnessSeries(days: readonly WellnessDayLike[]): WellnessSeries[] {
  return [
    {
      spec: {
        key: "resting-hr",
        title: "FC de repos",
        // La FC porte `negative` partout dans l'appli (cf. le détail d'activité) :
        // c'est un code de série, pas une alarme — rien n'est jugé ici.
        strokeClass: "stroke-negative",
        dotClass: "bg-negative",
        fill: null,
        invertY: false,
        stepKind: "decimal",
        hasZero: true,
        targetTicks: 3,
        heightClass: "h-24 sm:h-28",
        format: (value) => `${formatNumber(value, 0)} bpm`,
        formatTick: (value) => formatNumber(value, 0),
        read: (day) => day.restingHrBpm,
      },
      absent: "Aucune FC de repos mesurée sur la période.",
    },
    hrvSeries(majorityHrvVariant(days)),
    {
      spec: {
        key: "sleep",
        title: "Sommeil",
        strokeClass: "stroke-chart-stride",
        dotClass: "bg-chart-stride",
        fill: null,
        invertY: false,
        // Sexagésimal : un pas de 2,5 min ne se lit pas, 30 min si.
        stepKind: "time",
        hasZero: true,
        targetTicks: 3,
        heightClass: "h-24 sm:h-28",
        format: formatDuration,
        formatTick: formatSleepTick,
        read: (day) => day.sleepTimeS,
      },
      absent: "Aucune nuit mesurée sur la période.",
    },
    {
      spec: {
        key: "weight",
        title: "Poids",
        strokeClass: "stroke-fg-muted",
        dotClass: "bg-fg-muted",
        fill: null,
        invertY: false,
        stepKind: "decimal",
        hasZero: true,
        targetTicks: 3,
        heightClass: "h-24 sm:h-28",
        format: (value) => `${formatNumber(value, 1)} kg`,
        formatTick: (value) => formatNumber(value, 1),
        read: (day) => day.weightKg,
      },
      // La seule des quatre qui ne vient pas de la montre : le dire évite de
      // chercher pourquoi la courbe est vide alors que le reste est plein.
      absent: "Aucune pesée sur la période.",
    },
  ];
}

/** La fiche ⓘ d'une série, quand la mesure en a une. */
export function wellnessSheetOf(key: string): MetricSheetId | null {
  if (key === "hrv") return "hrv";
  if (key === "resting-hr") return "resting-hr";
  return null;
}

/**
 * Le modèle du panneau : ce qui se trace, et ce qui s'écrit à la place.
 *
 * `days` est attendu **du plus ancien au plus récent** — c'est l'ordre dans
 * lequel le DAL les rend, celui dans lequel une courbe se lit, et celui dont
 * dépend la recherche du point sous le curseur (`nearestIndex`, dichotomique).
 */
export function buildWellnessTrends(days: readonly WellnessDayLike[]): WellnessTrends {
  const series = wellnessSeries(days);
  const specs = series.map((entry) => entry.spec);
  const absences: WellnessAbsence[] = [];

  for (const entry of series) {
    const values: number[] = [];
    for (const day of days) {
      const value = entry.spec.read(day);
      if (value !== null) values.push(value);
    }

    // Deux mesures pour une ligne : c'est aussi le seuil de `buildChartsModel`,
    // qui écarte le panneau. Les deux décisions ne peuvent pas diverger sans
    // laisser une mesure sans courbe **et** sans phrase.
    if (values.length >= 2) continue;

    absences.push({
      key: entry.spec.key,
      message:
        values.length === 0
          ? entry.absent
          : // Une seule mesure ne fait pas une tendance : on la donne quand même,
            // plutôt que de tracer un point isolé qui aurait l'air d'une droite.
            `${entry.spec.title} : une seule mesure sur la période (${entry.spec.format(values[0])}) — pas encore de tendance.`,
    });
  }

  return {
    charts: buildChartsModel({
      points: days,
      xs: days.map((day) => civilDateToMs(day.day)),
      axis: DATE_AXIS,
      specs,
    }),
    absences,
  };
}

/**
 * `true` quand la fenêtre ne porte **aucune** mesure : le panneau dit alors
 * autre chose (et la page s'en sert avant même de construire un modèle).
 */
export function hasNoWellnessMeasure(days: readonly WellnessDayLike[]): boolean {
  return days.every(
    (day) =>
      day.restingHrBpm === null &&
      readHrv(day) === null &&
      day.sleepTimeS === null &&
      day.weightKg === null,
  );
}
