"use client";

import { useMemo } from "react";

import { SyncedPanels } from "@/components/chart/synced-panels";
import { civilDateToMs } from "@/lib/dates/civil";
import type { LoadPoint } from "@/lib/metrics";

import { MetricInfo } from "../../_components/metric-info";
import { isMetricSheetId } from "../../_lib/metric-sheets";

import { buildLoadChartsModel } from "../_lib/load-series";
import { formatFullDay } from "../_lib/date-axis";

export type FitnessChartsProps = {
  /** Série dense, un point par jour de la période. */
  load: readonly LoadPoint[];
};

/**
 * Charge d'entraînement en petits multiples synchronisés : forme (CTL), fatigue
 * (ATL) et fraîcheur (TSB), un panneau chacun, une abscisse commune en dates et
 * un curseur qui les traverse tous.
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
    <SyncedPanels
      model={model}
      ariaLabel="Graphes synchronisés de la charge d'entraînement"
      header={(hover) => <CursorReadout load={load} hover={hover} />}
      // Les trois clés de `LOAD_SPECS` sont exactement `ctl`, `atl` et `tsb` :
      // chaque panneau porte donc la fiche de la métrique qu'il trace.
      info={(key) => (isMetricSheetId(key) ? <MetricInfo id={key} /> : null)}
    />
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
