/**
 * La jauge de charge d'une séance — modèle pur, testé.
 *
 * Le TRIMP nu ne se lit pas : « 112 » n'est ni beaucoup ni peu tant qu'on ne
 * sait pas à quoi le comparer. L'échelle est donc celle de l'athlète — les
 * quartiles de ses trois derniers mois, calculés par le DAL — et jamais un
 * barème universel : sans référentiel, la page garde la tuile chiffrée.
 */

import type { TrimpContextDto } from "@/data/activities";
import { buildGaugeModel, type GaugeBand, type GaugeModel } from "@/lib/chart/gauge";

import { capitalize } from "../../../_lib/format";
import { formatTrimp } from "./format-detail";

/**
 * Les quatre registres, dans la rampe d'intensité Z1 → Z4 du design system.
 *
 * Une charge est une **magnitude ordonnée** : elle emprunte la rampe des zones,
 * qui l'est aussi. Z5 est laissée de côté — le dernier registre est déjà
 * « au-dessus de trois séances sur quatre », pas un maximum absolu.
 */
const BAND_STYLES = [
  { className: "stroke-zone-1", label: "légère" },
  { className: "stroke-zone-2", label: "habituelle" },
  { className: "stroke-zone-3", label: "soutenue" },
  { className: "stroke-zone-4", label: "très élevée" },
] as const;

/** Tout ce que la jauge de charge affiche, prêt à rendre. */
export type TrimpGaugeView = {
  model: GaugeModel;
  /** TRIMP formaté, en mono comme toute donnée. */
  value: string;
  note: string;
  ariaLabel: string;
};

/**
 * Modèle de la jauge de charge, ou `null` si l'échelle est indéfendable (par
 * exemple un référentiel entièrement nul — le DAL ne devrait pas en produire).
 *
 * Le domaine part de 0 (pas de charge) et monte jusqu'à la séance la plus
 * chargée de la fenêtre, ou jusqu'à celle-ci si elle la dépasse : une séance
 * record doit pousser l'aiguille au bout de l'arc, pas hors de l'arc.
 */
export function trimpGaugeModel(trimp: number, context: TrimpContextDto): GaugeModel | null {
  const max = Math.max(context.max, trimp);
  const bounds = [context.p25, context.p50, context.p75, max];

  const bands: GaugeBand[] = BAND_STYLES.map((style, index) => ({
    upTo: bounds[index],
    className: style.className,
    label: style.label,
  }));

  return buildGaugeModel({ value: trimp, min: 0, max, bands });
}

/**
 * La jauge de charge de cette séance, ou `null` quand il n'y a rien à situer :
 * pas de TRIMP (profil incomplet, séance sans FC), TRIMP nul, ou pas de
 * référentiel (historique trop court). Dans tous les cas la page retombe sur la
 * tuile chiffrée — une jauge sans échelle réelle mentirait sur ce qu'elle mesure.
 *
 * La charge nulle est écartée pour la **même raison** que le référentiel écarte
 * les siennes (`trimpContextOf`, `data/activities`) : une FC moyenne sous la FC
 * de repos est une aberration de mesure, pas une séance sans effort. Une jauge
 * « 0 — Légère » lui donnerait le crédit d'un registre.
 *
 * La glose nomme le registre (la couleur ne porte jamais l'information seule)
 * et l'effectif qui fonde l'échelle : un référentiel de six séances ne vaut pas
 * celui d'un trimestre complet, et l'athlète doit pouvoir en juger. Les 90 jours
 * sont ceux de `TRIMP_CONTEXT_DAYS` (DAL) : la phrase les répète plutôt que
 * d'importer un module `server-only` dans un composant d'écran.
 */
export function trimpGaugeView(
  trimp: number | null,
  context: TrimpContextDto | null,
): TrimpGaugeView | null {
  if (trimp === null || trimp <= 0 || context === null) return null;

  const model = trimpGaugeModel(trimp, context);
  if (model === null) return null;

  const value = formatTrimp(trimp);
  const window = `tes 90 derniers jours (${context.sampleSize} séances)`;

  return {
    model,
    value,
    note: `${capitalize(model.activeBand.label)} — vs ${window}`,
    ariaLabel: `Charge de la séance : TRIMP ${value}, charge ${model.activeBand.label} au regard de ${window}.`,
  };
}
