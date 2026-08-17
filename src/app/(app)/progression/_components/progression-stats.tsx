import { Gauge, HeartPulse } from "lucide-react";

import { StatCard } from "@/components/stat-card";
import type {
  FitnessDto,
  FitnessUnavailableDto,
  Vo2maxDto,
  Vo2maxUnavailableDto,
} from "@/data/progression";

import { MetricInfo } from "../../_components/metric-info";
import { MetricPlaceholder } from "../../_components/metric-placeholder";
import { TsbGauge } from "../../_components/tsb-gauge";
import { formatLoad, formatVo2max } from "../../_lib/format";
import { toDelta } from "../../_lib/metric-tone";
import {
  describeFitnessUnavailable,
  describeVo2maxUnavailable,
} from "../../_lib/metric-unavailable";
import { vo2maxTileNote } from "../../_lib/pending-elevation";

export type ProgressionStatsProps = {
  fitness: FitnessDto | null;
  vo2max: Vo2maxDto | null;
  fitnessUnavailable: FitnessUnavailableDto | null;
  vo2maxUnavailable: Vo2maxUnavailableDto | null;
  /**
   * Séances dont le dénivelé reste à établir : tant qu'il y en a, la valeur
   * **et** son écart à 30 jours sont une lecture provisoire (cf.
   * `_lib/pending-elevation`).
   */
  pendingElevationActivities: number;
  /** `false` quand aucun athlète n'existe encore : l'onboarding n'a pas eu lieu. */
  hasProfile: boolean;
};

/**
 * Où l'athlète en est **aujourd'hui**, en tête des courbes qui racontent
 * comment elle y est arrivée. Volontairement identique au tableau de bord :
 * mêmes valeurs, mêmes seuils, mêmes couleurs (cf. `_lib/metric-tone`).
 *
 * Ces trois chiffres ne dépendent pas de la période choisie — l'écart de CTL est
 * toujours à sept jours, celui de VO₂max à trente : ce sont les fenêtres qui
 * font sens physiologiquement, pas celle qu'on regarde.
 */
export function ProgressionStats({
  fitness,
  vo2max,
  fitnessUnavailable,
  vo2maxUnavailable,
  pendingElevationActivities,
  hasProfile,
}: ProgressionStatsProps) {
  return (
    <section aria-label="Indicateurs du jour" className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {fitness ? (
        <>
          <StatCard
            label="Forme CTL"
            info={<MetricInfo id="ctl" />}
            value={formatLoad(fitness.ctl)}
            delta={toDelta(fitness.ctlDelta7d, 0, "warning")}
            note="Charge chronique, lissée sur 42 jours."
          />
          <TsbGauge tsb={fitness.tsb} label="Fraîcheur TSB" />
        </>
      ) : hasProfile ? (
        <MetricPlaceholder
          icon={HeartPulse}
          label="Charge & forme"
          className="col-span-2"
          {...describeFitnessUnavailable(fitnessUnavailable)}
        />
      ) : null}

      {vo2max ? (
        <StatCard
          label="VO₂max estimée"
          info={<MetricInfo id="vo2max" />}
          value={formatVo2max(vo2max.value)}
          delta={toDelta(vo2max.delta30d, 1, "negative")}
          note={vo2maxTileNote(pendingElevationActivities, "Moyenne des 30 derniers jours.")}
          className="col-span-2 md:col-span-1"
        />
      ) : (
        <MetricPlaceholder
          icon={Gauge}
          label="VO₂max estimée"
          info={<MetricInfo id="vo2max" />}
          className="col-span-2 md:col-span-1"
          {...describeVo2maxUnavailable(vo2maxUnavailable)}
        />
      )}
    </section>
  );
}
