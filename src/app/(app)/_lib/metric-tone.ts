/**
 * Mise en forme des indicateurs de charge — fonctions pures, testées.
 *
 * Partagé par le tableau de bord (l'instantané) et la page « Progression »
 * (l'évolution) : les deux affichent la même CTL et le même TSB, ils doivent en
 * donner la même lecture. Un seuil qui diverge d'une page à l'autre, c'est une
 * appli qui se contredit.
 */

import type { StatDelta, StatTone } from "@/components/stat-card";

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
 * Lecture qualitative du TSB (bandes usuelles de la méthode Coggan). Le chiffre
 * affiché reste celui calculé par `lib/metrics` — ceci n'en est qu'une glose.
 */
export function readTsb(tsb: number): { tone: StatTone; note: string } {
  if (tsb <= -30) return { tone: "negative", note: "Fatigue marquée." };
  if (tsb <= -10) return { tone: "warning", note: "En charge — zone de progression." };
  if (tsb < 5) return { tone: "default", note: "Charge et forme équilibrées." };
  return { tone: "positive", note: "Frais, bien récupéré." };
}
