"use client";

import { useMemo, useState } from "react";

import { SegmentedToggle, type SegmentedOption } from "@/components/chart/segmented-toggle";
import { SyncedPanels } from "@/components/chart/synced-panels";
import { Panel } from "@/components/panel";

import { MetricInfo } from "../../../_components/metric-info";
import { isMetricSheetId } from "../../../_lib/metric-sheets";
import {
  buildActivityChartsModel,
  hasDistanceAxis,
  type ChartPoint,
  type XAxisKind,
} from "../_lib/chart-series";
import { formatClock, formatDistanceTick } from "../_lib/format-detail";
import { NoDetailedData } from "./no-detailed-data";

const X_AXIS_OPTIONS: readonly SegmentedOption<XAxisKind>[] = [
  { value: "distance", label: "Distance (km)" },
  { value: "time", label: "Temps" },
];

export type ActivityChartsProps = {
  /** Points déjà décimés par le DAL (600 au maximum) — jamais re-échantillonnés ici. */
  points: readonly ChartPoint[];
};

/**
 * Graphes empilés de la séance : un panneau par mesure, un seul axe Y chacun,
 * une abscisse commune (distance ou temps) et un survol synchronisé — le
 * crosshair traverse tous les panneaux et chacun affiche sa valeur au même X.
 *
 * Le rendu est partagé (`src/components/chart/`) : cette page choisit l'axe,
 * construit le modèle et écrit le repère du curseur.
 */
export function ActivityCharts({ points }: ActivityChartsProps) {
  const canUseDistance = hasDistanceAxis(points);
  const [xKind, setXKind] = useState<XAxisKind>(canUseDistance ? "distance" : "time");

  // Mémoïsation manuelle assumée : le React Compiler n'est pas activé sur ce
  // projet, et sans elle les chemins SVG de cinq séries de 600 points
  // seraient reconstruits à chaque mouvement du pointeur.
  const model = useMemo(() => buildActivityChartsModel(points, xKind), [points, xKind]);

  if (model === null) return <NoDetailedData />;

  return (
    <Panel
      title="Analyse de la séance"
      meta={
        canUseDistance ? (
          <SegmentedToggle
            options={X_AXIS_OPTIONS}
            value={xKind}
            onChange={setXKind}
            ariaLabel="Axe horizontal"
          />
        ) : null
      }
    >
      <SyncedPanels
        model={model}
        ariaLabel="Graphes synchronisés de la séance"
        header={(hover) => <CursorReadout points={points} hover={hover} />}
        // Seule la foulée est une grandeur **calculée** parmi ces cinq séries :
        // allure, FC, altitude et cadence sortent des capteurs. Le garde ne
        // laisse donc passer qu'elle, et n'a rien à savoir des autres clés.
        info={(key) => (isMetricSheetId(key) ? <MetricInfo id={key} /> : null)}
      />
    </Panel>
  );
}

/**
 * Repère du curseur : distance **et** temps, quelle que soit l'abscisse
 * choisie — la distance disparaît d'elle-même si la séance n'en porte pas.
 */
function CursorReadout({
  points,
  hover,
}: {
  points: readonly ChartPoint[];
  hover: number | null;
}) {
  const cursor = hover === null ? points[points.length - 1] : points[hover];
  const label = [
    cursor.distanceM === null ? null : `${formatDistanceTick(cursor.distanceM, 100)} km`,
    formatClock(cursor.timeS),
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <p className="flex items-baseline justify-between gap-3">
      <span className="eyebrow">{hover === null ? "Séance" : "Curseur"}</span>
      <span className="num text-[0.82rem] text-fg">{label}</span>
    </p>
  );
}
