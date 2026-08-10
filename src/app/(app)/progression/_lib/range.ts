/**
 * Période affichée par la page « Progression » — lecture et validation du
 * paramètre d'URL, fonctions pures, testées.
 *
 * Le filtre est **serveur** : c'est l'URL qui porte la période, pas un état
 * React. Tous les blocs de la page se recalculent donc sur la même période, et
 * un lien partagé (ou un retour arrière) retombe sur ce qu'on regardait. Le
 * paramètre venant du navigateur, il est validé comme n'importe quelle entrée
 * externe — une valeur inconnue retombe sur le défaut plutôt que d'échouer.
 */

import { z } from "zod";

import type { ProgressionRange } from "@/data/progression";

/** Nom du paramètre d'URL, en français comme le reste de l'interface. */
export const RANGE_PARAM = "periode";

export type RangeParam = "3m" | "6m" | "1a" | "tout";

const DEFAULT_RANGE: RangeParam = "6m";

/**
 * Six mois par défaut : assez long pour qu'un bloc d'entraînement entier tienne
 * dans le cadre, assez court pour que la semaine reste le seau de lecture.
 */
const rangeSchema = z.enum(["3m", "6m", "1a", "tout"]).catch(DEFAULT_RANGE);

export const RANGE_OPTIONS: readonly { param: RangeParam; label: string }[] = [
  { param: "3m", label: "3 mois" },
  { param: "6m", label: "6 mois" },
  { param: "1a", label: "1 an" },
  { param: "tout", label: "Tout" },
];

/** Le paramètre `searchParams` peut être absent, répété, ou n'importe quoi. */
export function parseRangeParam(value: unknown): RangeParam {
  return rangeSchema.parse(value);
}

const DAL_RANGES: Record<RangeParam, ProgressionRange> = {
  "3m": "3m",
  "6m": "6m",
  "1a": "1y",
  tout: "all",
};

/** L'URL est en français, le contrat du DAL en anglais comme tout le code. */
export function toProgressionRange(param: RangeParam): ProgressionRange {
  return DAL_RANGES[param];
}

/** Lien du filtre — le défaut ne porte pas de paramètre, l'URL reste propre. */
export function rangeHref(param: RangeParam): string {
  return param === DEFAULT_RANGE ? "/progression" : `/progression?${RANGE_PARAM}=${param}`;
}
