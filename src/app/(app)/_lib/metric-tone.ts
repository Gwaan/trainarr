/**
 * Mise en forme des indicateurs de charge — fonctions pures, testées.
 *
 * Partagé par le tableau de bord (l'instantané) et la page « Progression »
 * (l'évolution) : les deux affichent la même CTL et le même TSB, ils doivent en
 * donner la même lecture. Un seuil qui diverge d'une page à l'autre, c'est une
 * appli qui se contredit.
 */

import type { StatDelta, StatTone } from "@/components/stat-card";
import type { GaugeBand } from "@/lib/chart/gauge";

import { formatNumber } from "./format";

/**
 * Variation affichée à côté de la valeur. `undefined` quand il n'y a pas de
 * point de comparaison ou que l'écart est nul après arrondi : une flèche « 0 »
 * suggérerait une stagnation mesurée qui n'en est pas une.
 */
export function toDelta(
  value: number | null,
  fractionDigits: number,
  downTone: Extract<StatTone, "warning" | "negative">,
): StatDelta | undefined {
  if (value === null) return undefined;

  const formatted = formatNumber(Math.abs(value), fractionDigits);
  if (Number(formatted.replace(",", ".")) === 0) return undefined;

  return {
    value: formatted,
    direction: value > 0 ? "up" : "down",
    tone: value > 0 ? "positive" : downTone,
  };
}

/**
 * Bornes des bandes de TSB, méthode Coggan. **Source unique** : la glose de
 * {@link readTsb} et l'échelle de la jauge ({@link TSB_GAUGE_BANDS}) les lisent
 * ici, sinon deux affichages du même chiffre finiraient par le juger
 * différemment.
 */
export const TSB_THRESHOLDS = {
  /** En dessous : fatigue marquée. */
  fatigue: -30,
  /** En dessous : en charge, zone de progression. */
  load: -10,
  /** À partir de là : frais. */
  fresh: 5,
} as const;

/**
 * Domaine de la jauge de TSB — fixe, jamais recalculé sur les données.
 *
 * Une échelle qui s'ajuste à la valeur du jour empêcherait de comparer deux
 * jours. Les bornes couvrent l'amplitude utile d'un TSB de coureur : au-delà de
 * −45 on ne distingue plus les degrés de creusement, au-delà de +20 on est
 * simplement désentraîné. Une valeur hors bornes est posée sur la borne
 * (`clamped` du modèle), jamais tronquée en silence.
 */
export const TSB_GAUGE_DOMAIN = { min: -45, max: 20 } as const;

/**
 * Les quatre lectures du TSB, une par registre. **Source unique des phrases** :
 * la glose de {@link readTsb} et les bandes de la jauge ({@link TSB_GAUGE_BANDS})
 * y puisent les mêmes. Deux jeux de libellés finissaient par se contredire sur
 * une valeur posée pile sur une borne — la bande allumée disait « équilibre »
 * pendant que la note annonçait « frais ».
 */
const TSB_NOTES = {
  fatigue: "Fatigue marquée.",
  load: "En charge — zone de progression.",
  balanced: "Charge et forme équilibrées.",
  fresh: "Frais, bien récupéré.",
} as const;

/**
 * Lecture qualitative du TSB (bandes usuelles de la méthode Coggan). Le chiffre
 * affiché reste celui calculé par `lib/metrics` — ceci n'en est qu'une glose.
 *
 * Reste la source des **seuils** et du **ton** : la jauge, elle, tient sa phrase
 * de la bande qu'elle allume (cf. {@link TSB_GAUGE_BANDS}).
 */
export function readTsb(tsb: number): { tone: StatTone; note: string } {
  if (tsb <= TSB_THRESHOLDS.fatigue) return { tone: "negative", note: TSB_NOTES.fatigue };
  if (tsb <= TSB_THRESHOLDS.load) return { tone: "warning", note: TSB_NOTES.load };
  if (tsb < TSB_THRESHOLDS.fresh) return { tone: "default", note: TSB_NOTES.balanced };
  return { tone: "positive", note: TSB_NOTES.fresh };
}

/**
 * Les quatre bandes de la jauge de TSB, dans les couleurs sémantiques du
 * système — la bande neutre en `fg-faint`, qui n'est pas un état mais son
 * absence.
 *
 * Les bornes viennent de {@link TSB_THRESHOLDS} et les phrases de
 * {@link TSB_NOTES} : la jauge et la glose racontent donc la même échelle avec
 * les mêmes mots. Convention de `buildGaugeModel` : la borne appartient à la
 * bande qu'elle ferme — un TSB valant **exactement** +5 allume donc l'équilibre,
 * et c'est cette phrase-là que la tuile affiche, quand `readTsb` l'annoncerait
 * frais. La contradiction n'est plus possible : il n'y a qu'un libellé.
 */
export const TSB_GAUGE_BANDS: readonly GaugeBand[] = [
  { upTo: TSB_THRESHOLDS.fatigue, className: "stroke-negative", label: TSB_NOTES.fatigue },
  { upTo: TSB_THRESHOLDS.load, className: "stroke-warning", label: TSB_NOTES.load },
  { upTo: TSB_THRESHOLDS.fresh, className: "stroke-fg-faint", label: TSB_NOTES.balanced },
  { upTo: TSB_GAUGE_DOMAIN.max, className: "stroke-positive", label: TSB_NOTES.fresh },
];

/**
 * Repère de lecture de la monotonie de Foster.
 *
 * Foster (1998) associe une monotonie durablement **au-delà d'environ 2** à un
 * risque accru de maladie et de surentraînement : au-delà, la semaine ne
 * distingue plus ses jours durs de ses jours faciles. Le seuil vit ici, comme
 * les bandes de TSB, et **jamais** dans `lib/metrics/monotony.ts` — ce module
 * ne rend que des nombres.
 *
 * C'est un repère de **population**, pas un seuil personnalisé : il sort d'un
 * suivi de groupe, aucune donnée de l'athlète ne l'a calé. Une semaine à 2,1
 * n'est pas une alerte, c'est une question. La contrainte, elle, n'a aucun
 * seuil publié — elle ne se lit que contre les semaines précédentes, et c'est
 * pourquoi rien ici ne la juge.
 */
export const MONOTONY_THRESHOLD = 2;

/** Les deux lectures de la monotonie — source unique des phrases. */
const MONOTONY_NOTES = {
  varied: "Semaine alternée : les jours durs et les jours faciles se distinguent.",
  uniform: "Semaine uniforme : peu d'écart entre les jours, repos compris.",
} as const;

/**
 * Lecture qualitative de la monotonie. Le chiffre affiché reste celui calculé
 * par `lib/metrics/monotony` — ceci n'en est qu'une glose.
 *
 * Le ton reste `warning` au pire : une monotonie haute est un signal à
 * regarder, pas une faute — un bloc de reprise à cinq footings identiques la
 * fait monter sans que rien n'aille mal.
 */
export function readMonotony(monotony: number): { tone: StatTone; note: string } {
  return monotony >= MONOTONY_THRESHOLD
    ? { tone: "warning", note: MONOTONY_NOTES.uniform }
    : { tone: "default", note: MONOTONY_NOTES.varied };
}
