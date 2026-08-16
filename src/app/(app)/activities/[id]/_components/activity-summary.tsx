import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { Gauge } from "@/components/chart/gauge";
import { Panel } from "@/components/panel";
import type { TrimpContextDto } from "@/data/activities";
import { cn } from "@/lib/utils";
import { defaultActivityName } from "@/lib/fit/sport";

import { MetricInfo } from "../../../_components/metric-info";
import type { MetricSheetId } from "../../../_lib/metric-sheets";
import { formatDistance, formatHeartRate, formatPace, formatVo2max } from "../../../_lib/format";
import {
  MISSING,
  formatCadence,
  formatClock,
  formatElevationGain,
  formatFullDateTime,
  formatTrimp,
} from "../_lib/format-detail";
import { trimpGaugeView } from "../_lib/trimp-gauge-model";

/** Chiffres de la séance : ce que la page affiche en tête, tel que le DAL le livre. */
export type ActivitySummaryData = {
  name: string;
  sportType: string;
  startedAt: Date;
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  avgPaceSecPerKm: number | null;
  avgHrBpm: number | null;
  maxHrBpm: number | null;
  elevationGainM: number | null;
  avgCadenceSpm: number | null;
  trimp: number | null;
  /**
   * Les quartiles de charge de l'athlète, quand son historique récent en porte
   * assez pour en établir. `null` sinon : le TRIMP reste alors une tuile
   * chiffrée, faute d'échelle à laquelle le rapporter.
   */
  trimpContext: TrimpContextDto | null;
  effectiveVo2max: number | null;
};

/** En-tête : d'où l'on vient, quand la séance a eu lieu, comment elle s'appelle. */
export function ActivityHeader({ activity }: { activity: ActivitySummaryData }) {
  return (
    <div className="min-w-0">
      <Link
        href="/activities"
        className="inline-flex items-center gap-0.5 rounded-button text-[0.75rem] text-fg-faint transition-colors duration-150 ease-out hover:text-accent"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        Calendrier
      </Link>

      <h1 className="mt-2 text-[1.6rem] leading-tight font-extrabold tracking-[-0.035em] text-fg sm:text-[1.9rem]">
        {activity.name}
      </h1>

      <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <span className="rounded-button border border-border bg-surface-2 px-2 py-0.5 text-[0.68rem] font-medium tracking-[0.06em] text-fg-muted uppercase">
          {defaultActivityName(activity.sportType)}
        </span>
        <span className="num text-[0.78rem] text-fg-muted">
          {formatFullDateTime(activity.startedAt)}
        </span>
      </p>
    </div>
  );
}

/**
 * Une tuile. `sheet` n'est renseigné que sur les grandeurs **calculées** : une
 * distance ou un temps écoulé sortent du fichier tels quels, un ⓘ n'y aurait
 * rien à expliquer.
 */
type Stat = { label: string; value: string; sheet?: MetricSheetId };

/**
 * Chiffres clés, en mono comme toute donnée de l'appli.
 *
 * Une mesure absente s'affiche en tiret : la tuile reste à sa place — la grille
 * ne doit pas se réorganiser d'une séance à l'autre — et rien n'est approximé.
 *
 * Le TRIMP est la seule exception : quand la jauge le montre en pied de
 * panneau, sa tuile disparaît. Le répéter à deux endroits ne dirait pas deux
 * fois plus, et la jauge en dit strictement plus.
 */
function statsOf(activity: ActivitySummaryData, withTrimpTile: boolean): Stat[] {
  return [
    { label: "Distance", value: formatDistance(activity.distanceM) },
    { label: "Durée", value: formatClock(activity.movingTimeS) },
    {
      label: "Allure moy.",
      value:
        activity.avgPaceSecPerKm === null ? MISSING : formatPace(activity.avgPaceSecPerKm),
    },
    {
      label: "FC moy.",
      value: activity.avgHrBpm === null ? MISSING : formatHeartRate(activity.avgHrBpm),
    },
    {
      label: "FC max",
      value: activity.maxHrBpm === null ? MISSING : formatHeartRate(activity.maxHrBpm),
    },
    {
      label: "D+",
      value:
        activity.elevationGainM === null
          ? MISSING
          : formatElevationGain(activity.elevationGainM),
    },
    {
      label: "Cadence",
      value:
        activity.avgCadenceSpm === null ? MISSING : formatCadence(activity.avgCadenceSpm),
    },
    ...(withTrimpTile
      ? [
          {
            label: "TRIMP",
            value: activity.trimp === null ? MISSING : formatTrimp(activity.trimp),
            sheet: "trimp",
          } satisfies Stat,
        ]
      : []),
    {
      label: "VO₂max eff.",
      value:
        activity.effectiveVo2max === null
          ? MISSING
          : formatVo2max(activity.effectiveVo2max),
      sheet: "vo2max",
    },
    { label: "Temps écoulé", value: formatClock(activity.elapsedTimeS) },
  ];
}

export function ActivityStatsPanel({
  activity,
  className,
  gridClassName,
}: {
  activity: ActivitySummaryData;
  className?: string;
  /** La grille se resserre quand une carte partage la rangée. */
  gridClassName?: string;
}) {
  const gauge = trimpGaugeView(activity.trimp, activity.trimpContext);

  return (
    <Panel title="Chiffres de la séance" className={className}>
      <dl className={cn("grid grid-cols-2 gap-x-4 gap-y-4", gridClassName)}>
        {statsOf(activity, gauge === null).map((stat) => (
          <div key={stat.label} className="min-w-0">
            <dt className="eyebrow flex items-center gap-1.5">
              {stat.label}
              {stat.sheet === undefined ? null : <MetricInfo id={stat.sheet} />}
            </dt>
            <dd className="num mt-1.5 truncate text-[1.05rem] leading-none font-semibold text-fg">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* La jauge ferme le panneau plutôt que d'occuper une case de la grille :
          un arc dans une tuile de 4 cm serait illisible, et la charge est une
          synthèse de la séance — elle se lit après les mesures, pas parmi
          elles. La séparation en filet la sort de la liste sans ouvrir un
          second panneau, qui déséquilibrerait la rangée de la carte. */}
      {gauge === null ? null : (
        <div className="mt-5 border-t border-border pt-4">
          <Gauge
            model={gauge.model}
            value={gauge.value}
            label="Charge de la séance"
            info={<MetricInfo id="trimp" />}
            note={gauge.note}
            ariaLabel={gauge.ariaLabel}
          />
        </div>
      )}
    </Panel>
  );
}
