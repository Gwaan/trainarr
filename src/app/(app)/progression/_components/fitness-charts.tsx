"use client";

import { useMemo } from "react";

import { SyncedMultiPanels } from "@/components/chart/synced-multi-panels";
import { civilDateToMs } from "@/lib/dates/civil";
import type { LoadPoint } from "@/lib/metrics";

import { MetricInfo } from "../../_components/metric-info";
import { metricSheet, type MetricSheetId } from "../../_lib/metric-sheets";

import { buildLoadChartsModel } from "../_lib/load-series";
import { formatFullDay } from "../_lib/date-axis";

export type FitnessChartsProps = {
  /** Série dense, un point par jour de la période. */
  load: readonly LoadPoint[];
};

/** Les trois métriques tracées, dans l'ordre des séries du panneau. */
const LOAD_SHEETS: readonly MetricSheetId[] = ["ctl", "atl", "tsb"];

/**
 * Charge d'entraînement en un seul graphe : forme (CTL), fatigue (ATL) et
 * fraîcheur (TSB) superposées sur un axe commun — elles se comptent toutes en
 * unités TRIMP par jour, et c'est leur écart qui porte la lecture.
 */
export function FitnessCharts({ load }: FitnessChartsProps) {
  // Mémoïsation manuelle assumée : sans elle, les chemins des trois séries
  // seraient reconstruits à chaque mouvement du pointeur.
  const model = useMemo(() => buildLoadChartsModel(load), [load]);

  if (model === null) {
    return (
      <p className="text-[0.82rem] leading-relaxed text-fg-muted">
        Il faut au moins deux jours de charge sur la période pour tracer une
        évolution.
      </p>
    );
  }

  return (
    <SyncedMultiPanels
      model={model}
      ariaLabel="Graphe synchronisé de la charge d'entraînement"
      header={(hover) => <CursorReadout load={load} hover={hover} />}
      // Le slot ⓘ est par **panneau**, et il n'y en a plus qu'un pour trois
      // métriques : les trois fiches se posent donc groupées au bout du titre,
      // chacune derrière son abréviation — trois ⓘ nus ne diraient pas lequel
      // ouvre quoi.
      info={() => <LoadMetricSheets />}
    />
  );
}

/** Les trois déclencheurs de fiches, chacun annoncé par son abréviation. */
function LoadMetricSheets() {
  return (
    <span className="ms-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      {LOAD_SHEETS.map((id) => (
        <span key={id} className="flex items-center gap-1">
          {metricSheet(id).abbreviation}
          <MetricInfo id={id} />
        </span>
      ))}
    </span>
  );
}

/** Repère du curseur : la date lue, ou le dernier jour de la période au repos. */
function CursorReadout({
  load,
  hover,
}: {
  load: readonly LoadPoint[];
  hover: number | null;
}) {
  const point = hover === null ? load[load.length - 1] : load[hover];

  return (
    <p className="flex items-baseline justify-between gap-3">
      <span className="eyebrow">{hover === null ? "Dernier jour" : "Curseur"}</span>
      <span className="num text-[0.82rem] text-fg">
        {formatFullDay(civilDateToMs(point.date))}
      </span>
    </p>
  );
}
