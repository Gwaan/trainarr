/**
 * Le relevé bien-être, tel qu'il franchit la frontière client.
 *
 * Types et formatage seuls, **sans aucune dépendance serveur** : le DAL rend des
 * nombres et des dates civiles, ce module en fait les chaînes que la tuile du
 * tableau de bord affiche.
 *
 * ## La règle qui gouverne ce fichier
 *
 * **Une mesure absente est dite absente.** Chaque mesure rend soit une valeur,
 * soit une phrase qui nomme ce qui manque (« pas de HRV ») — jamais une chaîne
 * vide, jamais un tiret muet, jamais un zéro. C'est la règle du projet, et elle
 * compte doublement ici : ces mesures viennent de la montre, et un blanc se
 * lirait « l'appli est cassée » alors qu'il veut dire « tu n'avais pas ta montre
 * cette nuit-là ».
 *
 * ## Ce qui n'est jamais coloré
 *
 * Aucune de ces valeurs ne porte de ton `warning` ou `negative` : une HRV basse
 * n'est pas une erreur système, et une FC de repos haute est une information, pas
 * une alarme. Le composant s'en tient aux tokens de texte.
 */

import { hrvLabel, type HrvVariant } from "@/lib/wellness/hrv";

import { formatDuration, formatNumber, formatRelativeDay, parseCivilDate } from "./format";

/** Une mesure prête à rendre : sa valeur, son unité, et sa date si elle n'est pas du jour. */
export type WellnessMeasureView = {
  /** Valeur formatée, ex. `48` ou `7 h 10`. */
  value: string;
  /** Unité affichée à côté de la valeur — vide quand la valeur la porte déjà. */
  unit: string;
  /**
   * Quand la mesure a été prise, en toutes lettres (« hier », « 9 août »).
   * `null` **seulement** si elle date d'aujourd'hui : c'est le cas courant, et
   * l'écrire à côté de chaque valeur ne dirait rien.
   */
  observedOn: string | null;
};

/** Les trois mesures de la tuile, chacune indépendamment absente. */
export type WellnessTileView = {
  restingHr: WellnessMeasureView | null;
  /**
   * Le libellé de la HRV — « HRV (rMSSD) », « HRV (SDNN) », ou « HRV » quand il
   * n'y a rien à montrer.
   *
   * Il vit à côté de la mesure, et non dedans, parce que la tuile l'affiche
   * **aussi** quand la mesure est absente : la colonne garde son titre pour dire
   * « pas de HRV ». Sans variante mesurée, aucune n'est annoncée.
   */
  hrvLabel: string;
  hrv: WellnessMeasureView | null;
  sleep: WellnessMeasureView | null;
};

/** Le DTO du DAL, décrit **structurellement** : ce module ne dépend d'aucun `server-only`. */
type WellnessSummaryLike = {
  today: string;
  restingHr: { value: number; day: string } | null;
  hrv: { value: number; day: string; variant: HrvVariant } | null;
  sleep: { value: number; day: string } | null;
};

/**
 * Le jour d'une mesure, en toutes lettres — `null` quand c'est aujourd'hui.
 *
 * Une date civile qu'on ne saurait pas relire (impossible : elle vient d'une
 * colonne `date`) rend `null` plutôt qu'une chaîne fautive.
 */
function observedOn(day: string, today: string, now: Date): string | null {
  if (day === today) return null;
  const date = parseCivilDate(day);
  return date === null ? null : formatRelativeDay(date, now);
}

function toMeasure(
  measure: { value: number; day: string } | null,
  today: string,
  now: Date,
  format: (value: number) => { value: string; unit: string },
): WellnessMeasureView | null {
  if (measure === null) return null;
  return { ...format(measure.value), observedOn: observedOn(measure.day, today, now) };
}

/** Le résumé du DAL, réduit à ce que la tuile affiche. */
export function toWellnessTileView(
  summary: WellnessSummaryLike,
  now: Date = new Date(),
): WellnessTileView {
  return {
    restingHr: toMeasure(summary.restingHr, summary.today, now, (value) => ({
      value: formatNumber(value, 0),
      unit: "bpm",
    })),
    // La variante est celle de la mesure affichée, jamais une supposition : sans
    // mesure, la colonne s'intitule « HRV » tout court.
    hrvLabel: hrvLabel(summary.hrv?.variant ?? null),
    hrv: toMeasure(summary.hrv, summary.today, now, (value) => ({
      value: formatNumber(value, 0),
      unit: "ms",
    })),
    // `formatDuration` porte déjà son unité (« 7 h 10 », « 48 min ») : en ajouter
    // une seconde donnerait « 7 h 10 h ».
    sleep: toMeasure(summary.sleep, summary.today, now, (value) => ({
      value: formatDuration(value),
      unit: "",
    })),
  };
}

/** `true` quand aucune des trois mesures n'existe : la tuile dit alors autre chose. */
export function isWellnessTileEmpty(view: WellnessTileView): boolean {
  return view.restingHr === null && view.hrv === null && view.sleep === null;
}
