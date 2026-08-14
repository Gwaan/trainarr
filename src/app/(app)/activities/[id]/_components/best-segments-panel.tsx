import { Panel } from "@/components/panel";
import type { BestSegment } from "@/lib/metrics";

import { MetricInfo } from "../../../_components/metric-info";
import { formatNumber } from "../../../_lib/format";
import { formatClock, formatPaceValue } from "../_lib/format-detail";

/**
 * Libellés des distances de référence.
 *
 * Une cible inconnue de cette table retombe sur ses kilomètres plutôt que de
 * disparaître : ajouter une distance à `BEST_SEGMENT_TARGETS_M` ne doit pas
 * escamoter une ligne en silence.
 */
const TARGET_LABELS = new Map<number, string>([
  [400, "400 m"],
  [1000, "1 km"],
  [1609.34, "1 mile"],
  [5000, "5 km"],
  [10000, "10 km"],
  [21097.5, "Semi"],
]);

function targetLabel(targetM: number): string {
  return TARGET_LABELS.get(targetM) ?? `${formatNumber(targetM / 1000, 1)} km`;
}

/**
 * Meilleurs efforts de la séance.
 *
 * Le temps est celui de la **portion continue la plus rapide**, pas d'un tour :
 * le meilleur 1 000 m d'un fractionné peut chevaucher deux répétitions. Seules
 * les distances réellement couvertes apparaissent — un 10 km n'existe pas dans
 * une séance de 8 km.
 */
export function BestSegmentsPanel({
  segments,
  className,
}: {
  segments: readonly BestSegment[];
  className?: string;
}) {
  return (
    <Panel
      title="Meilleurs segments"
      info={<MetricInfo id="best-segments" />}
      padded={false}
      meta={<span className="num">{segments.length}</span>}
      className={className}
    >
      <table className="w-full text-[0.8rem]">
        <caption className="sr-only">
          Temps le plus rapide de la séance sur chaque distance de référence, et
          l&apos;allure correspondante.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="eyebrow px-4 py-2 text-left sm:px-5">
              Distance
            </th>
            <th scope="col" className="eyebrow py-2 text-right">
              Temps
            </th>
            <th scope="col" className="eyebrow px-4 py-2 text-right sm:px-5">
              Allure
            </th>
          </tr>
        </thead>
        <tbody>
          {segments.map((segment) => (
            <tr key={segment.targetM} className="border-b border-border last:border-b-0">
              <th
                scope="row"
                className="num px-4 py-2 text-left font-medium whitespace-nowrap text-fg sm:px-5"
              >
                {targetLabel(segment.targetM)}
              </th>
              <td className="num py-2 text-right whitespace-nowrap text-fg">
                {formatClock(segment.timeS)}
              </td>
              <td className="num px-4 py-2 text-right whitespace-nowrap text-fg-muted sm:px-5">
                {formatPaceValue(segment.paceSecPerKm)}/km
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
