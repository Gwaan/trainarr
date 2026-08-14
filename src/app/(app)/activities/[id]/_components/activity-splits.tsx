import { Panel } from "@/components/panel";
import { isPartialSplit } from "@/lib/metrics";

import { MetricInfo } from "../../../_components/metric-info";
import { formatHeartRate, formatNumber } from "../../../_lib/format";
import {
  MISSING,
  formatClock,
  formatElevationGain,
  formatPaceValue,
} from "../_lib/format-detail";
import { fastestSplitIndex, paceExtent, splitBarRatio } from "../_lib/splits-model";

/** Un kilomètre de la séance, tel que le découpe le DAL. */
export type SplitRow = {
  /** Numéro du kilomètre, à partir de 1. */
  km: number;
  /** 1000 m, sauf le dernier kilomètre s'il est partiel. */
  distanceM: number;
  timeS: number;
  paceSecPerKm: number;
  avgHrBpm: number | null;
  elevationGainM: number | null;
};

/**
 * Tableau des kilomètres.
 *
 * La barre d'allure se lit relativement à la séance (bornes = plus rapide et
 * plus lent de la sortie) : elle raconte la régularité de l'effort, pas une
 * performance absolue. Le meilleur kilomètre est marqué d'un point accent — la
 * couleur ne porte jamais l'information seule, un `aria-label` la double.
 */
export function ActivitySplits({
  splits,
  className,
}: {
  splits: readonly SplitRow[];
  className?: string;
}) {
  const paces = splits.map((split) => split.paceSecPerKm);
  const extent = paceExtent(paces);
  const best = fastestSplitIndex(paces);

  return (
    <Panel
      title="Kilomètres"
      info={<MetricInfo id="splits" />}
      padded={false}
      meta={<span className="num">{splits.length}</span>}
      className={className}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[0.8rem]">
          <caption className="sr-only">
            Découpage de la séance kilomètre par kilomètre : temps, allure,
            fréquence cardiaque moyenne et dénivelé positif.
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="eyebrow px-4 py-2 text-left sm:px-5">
                Km
              </th>
              {/* `w-full` : cette colonne absorbe la largeur restante, c'est
                  elle qui porte la barre. Les autres se réduisent à leur contenu. */}
              <th scope="col" className="eyebrow w-full py-2 pr-3 text-left">
                Allure
              </th>
              <th
                scope="col"
                className="eyebrow hidden py-2 pr-3 text-right min-[420px]:table-cell"
              >
                Temps
              </th>
              <th scope="col" className="eyebrow py-2 pr-3 text-right">
                FC
              </th>
              <th
                scope="col"
                className="eyebrow hidden px-4 py-2 text-right sm:table-cell sm:px-5"
              >
                D+
              </th>
            </tr>
          </thead>
          <tbody>
            {splits.map((split, index) => {
              const ratio = splitBarRatio(split.paceSecPerKm, extent);

              return (
                <tr key={split.km} className="border-b border-border last:border-b-0">
                  <th
                    scope="row"
                    className="num px-4 py-2 text-left font-medium whitespace-nowrap text-fg sm:px-5"
                  >
                    {index === best ? (
                      <span
                        role="img"
                        aria-label="Meilleur kilomètre"
                        className="mr-1.5 inline-block size-1.5 rounded-full bg-accent align-middle"
                      />
                    ) : null}
                    {split.km}
                    {/* Seuil du module de calcul, pas un seuil d'affichage :
                        un split de 995 m est partiel des deux côtés. */}
                    {isPartialSplit(split.distanceM) ? (
                      <span className="ml-1.5 text-[0.62rem] font-normal text-fg-faint">
                        {formatNumber(split.distanceM / 1000, 2)}
                      </span>
                    ) : null}
                  </th>

                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-2">
                      <span className="num w-[2.6rem] shrink-0 text-fg">
                        {formatPaceValue(split.paceSecPerKm)}
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-1.5 min-w-8 flex-1 rounded-full bg-surface-2"
                      >
                        {ratio === null ? null : (
                          <span
                            className="block h-full rounded-full bg-accent"
                            style={{ width: `${(ratio * 100).toFixed(1)}%` }}
                          />
                        )}
                      </span>
                    </span>
                  </td>

                  <td className="num hidden py-2 pr-3 text-right whitespace-nowrap text-fg-muted min-[420px]:table-cell">
                    {formatClock(split.timeS)}
                  </td>

                  <td className="num py-2 pr-3 text-right whitespace-nowrap text-fg-muted">
                    {split.avgHrBpm === null ? MISSING : formatHeartRate(split.avgHrBpm)}
                  </td>

                  <td className="num hidden px-4 py-2 text-right whitespace-nowrap text-fg-muted sm:table-cell sm:px-5">
                    {split.elevationGainM === null
                      ? MISSING
                      : formatElevationGain(split.elevationGainM)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {extent === null ? null : (
        <p className="border-t border-border px-4 py-2.5 text-[0.72rem] text-fg-faint sm:px-5">
          Barres proportionnelles à l&apos;allure, du plus lent{" "}
          <span className="num">{formatPaceValue(extent.slowest)}</span> au plus rapide{" "}
          <span className="num">{formatPaceValue(extent.fastest)}</span> de cette séance.
        </p>
      )}
    </Panel>
  );
}
