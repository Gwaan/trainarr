/**
 * Mise en forme des histogrammes de distribution — fonctions pures, testées.
 *
 * Le DAL livre des tranches brutes (`DistributionBin`, du temps par intervalle
 * de valeur) ; ce module en fait des barres prêtes à poser : hauteur, échelle,
 * étiquettes d'axe, couleur de remplissage. Aucun calcul de mesure ici, que de
 * la géométrie et du libellé.
 *
 * ## Ce que porte la hauteur
 *
 * Contrairement aux barres de zones (une longueur sur un rail plein), la hauteur
 * **est** l'information : le fond derrière les barres reste donc transparent —
 * un rail plein dessinerait un maximum qui n'existe pas dans les données.
 *
 * ## Étiquetage
 *
 * Une seule barre porte une étiquette directe : la plus haute (cf. skill
 * dataviz — un nombre sur chaque barre ne se lit pas). Les autres valeurs se
 * lisent sur la grille horizontale et au survol, et restent accessibles au
 * clavier par l'`aria-label` de chaque barre.
 *
 * L'axe des abscisses est **catégoriel** : une tranche = une colonne. Une
 * graduation nomme donc la borne basse de *sa* colonne, posée sous elle, et une
 * colonne sur `n` seulement est étiquetée pour qu'aucune étiquette n'en
 * chevauche une autre.
 */

import { niceStep } from "@/lib/chart/model";
import { hrZoneOf, type DistributionBin } from "@/lib/metrics";

import { formatNumber } from "../../../_lib/format";
import { formatPaceValue } from "./format-detail";
import { zoneBarClass } from "./hr-zones-model";

/** Une colonne de l'histogramme. */
export type DistributionBar = {
  /** Clé de rendu stable dans la liste. */
  key: string;
  /** Tranche en toutes lettres, ex. « 4:45–5:00 /km », « < 3:00 /km ». */
  rangeLabel: string;
  seconds: number;
  /** Part du temps total, en pourcentage (0 à 100). */
  sharePct: number;
  /** Hauteur de la colonne, en pourcentage de l'échelle. */
  heightPct: number;
  /** Classe Tailwind de remplissage — jamais une couleur en dur. */
  fillClass: string;
  /** Repère de zone cardio (« Z3 »), `null` hors distribution cardiaque zonée. */
  zoneLabel: string | null;
  /** Graduation posée sous la colonne, `null` si elle n'en porte pas. */
  tickLabel: string | null;
  /** La colonne la plus longue : la seule à porter une étiquette directe. */
  isPeak: boolean;
};

/** Une graduation horizontale de temps. */
export type DistributionGridLine = {
  seconds: number;
  label: string;
  /** Hauteur dans le panneau, en pourcentage depuis le bas. */
  bottomPct: number;
};

export type DistributionModel = {
  bars: DistributionBar[];
  /** Temps couvert par l'histogramme — l'en-tête du panneau l'affiche. */
  totalSeconds: number;
  gridLines: DistributionGridLine[];
};

const SECONDS_PER_MINUTE = 60;

/** Trois graduations : assez pour donner l'échelle, pas assez pour faire grille. */
const GRID_TARGET_TICKS = 3;

/** Au-delà, les étiquettes d'abscisse se chevauchent quelle que soit la largeur. */
const MAX_X_LABELS = 6;

/**
 * Bande réservée en haut du panneau, en pourcentage de sa hauteur.
 *
 * L'étiquette directe se pose **au-dessus** de la colonne la plus longue : sans
 * cette réserve, une colonne qui touche le sommet de l'échelle la pousserait
 * hors du cadre, où le conteneur défilant la rognerait. Colonnes et graduations
 * partagent le même facteur, sinon la grille ne dirait plus la bonne valeur.
 */
export const LABEL_HEADROOM_PCT = 12;

const PLOT_SCALE = (100 - LABEL_HEADROOM_PCT) / 100;

/**
 * Échelle verticale : un sommet arrondi au pas de graduation supérieur, et les
 * graduations rondes qui le remplissent.
 *
 * Le pas est choisi **en minutes** et non en secondes : `niceStep` rend des pas
 * décimaux (1, 2, 2,5, 5 × 10ⁿ), ronds en minutes mais pas en secondes — un pas
 * de 250 s se lirait « 4,2 min ».
 */
export function distributionScale(peakSeconds: number): {
  topSeconds: number;
  ticks: number[];
} {
  if (!Number.isFinite(peakSeconds) || peakSeconds <= 0) {
    return { topSeconds: 0, ticks: [] };
  }

  const stepS = niceStep(peakSeconds / SECONDS_PER_MINUTE, GRID_TARGET_TICKS) * SECONDS_PER_MINUTE;
  const topSeconds = Math.ceil(peakSeconds / stepS) * stepS;

  const ticks: number[] = [];
  for (let value = stepS; value <= topSeconds + stepS * 1e-6; value += stepS) {
    ticks.push(Math.round(value));
  }
  return { topSeconds, ticks };
}

/**
 * Index des colonnes qui portent une graduation d'abscisse.
 *
 * Une colonne sur `n`, plus toujours la dernière — c'est elle qui dit jusqu'où
 * va l'axe. La graduation régulière qui la précèderait de trop près est retirée
 * plutôt que superposée.
 */
export function tickIndexes(count: number, maxLabels = MAX_X_LABELS): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];

  const every = Math.max(1, Math.ceil(count / maxLabels));
  const indexes: number[] = [];
  for (let index = 0; index < count; index += every) indexes.push(index);

  const last = count - 1;
  if (indexes[indexes.length - 1] !== last) {
    if (last - indexes[indexes.length - 1] < every / 2) indexes.pop();
    indexes.push(last);
  }
  return indexes;
}

/** Milieu d'une tranche. Un bord ouvert n'a qu'une borne finie : c'est elle. */
function binMidpoint(bin: DistributionBin): number {
  if (!Number.isFinite(bin.from)) return bin.to;
  if (!Number.isFinite(bin.to)) return bin.from;
  return (bin.from + bin.to) / 2;
}

/** Tranche en toutes lettres. Les bords ouverts se disent « < x » / « > x ». */
function rangeLabelOf(
  bin: DistributionBin,
  formatValue: (value: number) => string,
  unit: string,
): string {
  if (!Number.isFinite(bin.from)) return `< ${formatValue(bin.to)}${unit}`;
  if (!Number.isFinite(bin.to)) return `> ${formatValue(bin.from)}${unit}`;
  return `${formatValue(bin.from)}–${formatValue(bin.to)}${unit}`;
}

/** Graduation d'abscisse : la borne basse de la colonne, sans unité. */
function tickLabelOf(bin: DistributionBin, formatValue: (value: number) => string): string {
  if (!Number.isFinite(bin.from)) return `< ${formatValue(bin.to)}`;
  if (!Number.isFinite(bin.to)) return `> ${formatValue(bin.from)}`;
  return formatValue(bin.from);
}

/** Remplissage d'une colonne : sa classe et, le cas échéant, sa zone cardio. */
type Fill = { fillClass: string; zoneLabel: string | null };

function buildModel(
  bins: readonly DistributionBin[],
  formatValue: (value: number) => string,
  unit: string,
  fillOf: (bin: DistributionBin) => Fill,
): DistributionModel {
  let totalSeconds = 0;
  let peakSeconds = 0;
  let peakIndex = -1;

  bins.forEach((bin, index) => {
    if (!Number.isFinite(bin.seconds) || bin.seconds <= 0) return;
    totalSeconds += bin.seconds;
    if (bin.seconds > peakSeconds) {
      peakSeconds = bin.seconds;
      peakIndex = index;
    }
  });

  const { topSeconds, ticks } = distributionScale(peakSeconds);
  const labelled = new Set(tickIndexes(bins.length));

  const bars = bins.map((bin, index) => {
    const seconds = Number.isFinite(bin.seconds) && bin.seconds > 0 ? bin.seconds : 0;
    const { fillClass, zoneLabel } = fillOf(bin);

    return {
      key: `${bin.from}:${bin.to}`,
      rangeLabel: rangeLabelOf(bin, formatValue, unit),
      seconds,
      sharePct: totalSeconds > 0 ? (seconds / totalSeconds) * 100 : 0,
      heightPct: topSeconds > 0 ? (seconds / topSeconds) * 100 * PLOT_SCALE : 0,
      fillClass,
      zoneLabel,
      tickLabel: labelled.has(index) ? tickLabelOf(bin, formatValue) : null,
      isPeak: index === peakIndex,
    };
  });

  // Un pas sous la minute (histogramme très court) garde une décimale, sans
  // quoi trois graduations afficheraient toutes « 0 min ».
  const stepS = ticks.length > 0 ? ticks[0] : 0;
  const minuteDigits = stepS % SECONDS_PER_MINUTE === 0 ? 0 : 1;
  const gridLines = ticks.map((seconds) => ({
    seconds,
    label: `${formatNumber(seconds / SECONDS_PER_MINUTE, minuteDigits)} min`,
    bottomPct: (seconds / topSeconds) * 100 * PLOT_SCALE,
  }));

  return { bars, totalSeconds, gridLines };
}

/**
 * Histogramme d'allure. Une seule série, donc une seule couleur : l'accent, qui
 * est la couleur attitrée de l'allure dans toute l'appli.
 */
export function paceDistributionModel(bins: readonly DistributionBin[]): DistributionModel {
  return buildModel(bins, formatPaceValue, " /km", () => ({
    fillClass: "bg-accent",
    zoneLabel: null,
  }));
}

/**
 * Histogramme cardiaque.
 *
 * Avec une FC max au profil, chaque tranche prend la couleur de **sa zone**
 * (rampe séquentielle du design system, zone du milieu de tranche) : la FC est
 * une magnitude ordonnée, et c'est la lecture que l'athlète attend — les zones
 * sautent aux yeux sans lire l'axe. Sans FC max, aucune zone n'est devinée : les
 * barres prennent la couleur de la série FC (`negative`), unie.
 */
export function hrDistributionModel(
  bins: readonly DistributionBin[],
  maxHrBpm: number | null,
): DistributionModel {
  return buildModel(bins, (value) => String(Math.round(value)), " bpm", (bin) => {
    const zone = hrZoneOf(binMidpoint(bin), maxHrBpm);
    return zone === null
      ? { fillClass: "bg-negative", zoneLabel: null }
      : { fillClass: zoneBarClass(zone), zoneLabel: `Z${zone}` };
  });
}
