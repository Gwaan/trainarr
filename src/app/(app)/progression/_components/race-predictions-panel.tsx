import { Timer } from "lucide-react";

import { Panel } from "@/components/panel";
import type { RacePredictionsDto } from "@/data/race-prediction";
import { cn } from "@/lib/utils";

import { MetricInfo } from "../../_components/metric-info";
import { describeRacePredictionUnavailable } from "../../_lib/metric-unavailable";
import {
  CONFIDENCE_MARKS,
  buildRacePredictionRows,
  describePredictionConfidence,
  describeRaceAnchor,
} from "../_lib/race-prediction-model";
import { MetricEmptyState } from "./metric-empty-state";

export type RacePredictionsPanelProps = {
  predictions: RacePredictionsDto;
  /** Jour civil courant : l'âge de l'ancre s'y mesure. */
  today: string;
};

/**
 * Les chronos que le chrono de référence implique sur les quatre distances de
 * route.
 *
 * **Indépendant du filtre de période**, et le méta de la card le dit : c'est un
 * état courant, exactement comme la CTL du jour et la VO₂max de la tuile. Rien
 * ici ne bouge quand on passe de trois mois à un an, et laisser croire le
 * contraire ferait lire une progression là où il n'y a qu'un changement de
 * fenêtre.
 */
export function RacePredictionsPanel({ predictions, today }: RacePredictionsPanelProps) {
  const { anchor, races } = predictions;

  if (anchor === null || races.length === 0) {
    return (
      <Panel title="Prédictions de course" info={<MetricInfo id="race-prediction" />} padded={false}>
        <MetricEmptyState
          icon={Timer}
          {...describeRacePredictionUnavailable(predictions.unavailable)}
        />
      </Panel>
    );
  }

  const rows = buildRacePredictionRows(races);
  const view = describeRaceAnchor(anchor, today);

  return (
    <Panel
      title="Prédictions de course"
      info={<MetricInfo id="race-prediction" />}
      meta={<span>toutes périodes</span>}
      padded={false}
    >
      <table className="w-full text-[0.8rem]">
        <caption className="sr-only">
          Chrono prévu et allure correspondante sur chaque distance de route,
          avec ce que la prédiction vaut.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="eyebrow px-4 py-2 text-left sm:px-5">
              Distance
            </th>
            <th scope="col" className="eyebrow py-2 text-right">
              Temps
            </th>
            <th scope="col" className="eyebrow py-2 text-right">
              Allure
            </th>
            <th scope="col" className="eyebrow px-4 py-2 text-right sm:px-5">
              Fiabilité
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-b-0">
              <th
                scope="row"
                className="num px-4 py-2 text-left font-medium whitespace-nowrap text-fg sm:px-5"
              >
                {row.distance}
              </th>
              <td className="num py-2 text-right whitespace-nowrap text-fg">{row.time}</td>
              <td className="num py-2 text-right whitespace-nowrap text-fg-muted">
                {row.pace}
              </td>
              <td
                className={cn(
                  "px-4 py-2 text-right text-[0.72rem] whitespace-nowrap sm:px-5",
                  CONFIDENCE_MARKS[row.confidence].className,
                )}
              >
                {CONFIDENCE_MARKS[row.confidence].label}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t border-border px-4 py-4 sm:px-5">
        {/* Sur quoi tout ce tableau repose : sans ce chrono, aucune de ces
            lignes n'existe — et une prédiction fondée sur une performance de
            l'hiver ne vaut pas celle d'hier. */}
        <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="eyebrow">Chrono de référence</span>
          <span className="num text-[0.82rem] text-fg">{view.chrono}</span>
        </p>
        <p className="mt-1.5 text-[0.78rem] leading-relaxed text-fg-faint">
          {view.source}
          {view.note === null ? null : ` ${view.note}`}
        </p>
        <p className="mt-2.5 text-[0.78rem] leading-relaxed text-fg-faint">
          {describePredictionConfidence(rows)}
        </p>
      </div>
    </Panel>
  );
}
