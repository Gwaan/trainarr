"use client";

import { useMemo, useState } from "react";

import { SegmentedToggle, type SegmentedOption } from "@/components/chart/segmented-toggle";
import { SyncedMultiPanels } from "@/components/chart/synced-multi-panels";
import { Panel } from "@/components/panel";

import { MetricInfo } from "../../../_components/metric-info";
import {
  buildActivityChartsModel,
  hasDistanceAxis,
  type ChartPoint,
  type PanelKey,
  type SeriesKey,
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
 * Le panneau qui porte la foulée, et la série elle-même. Typés `PanelKey` et
 * `SeriesKey` : une clé qui n'existe plus casse la compilation au lieu de faire
 * disparaître le ⓘ en silence.
 */
const STRIDE_PANEL: PanelKey = "cadence-stride";
const STRIDE_SERIES: SeriesKey = "stride";

/**
 * Graphes empilés de la séance : trois panneaux — allure et FC superposées à
 * double axe, altitude en contexte, cadence et foulée superposées — sur une
 * abscisse commune (distance ou temps), avec un survol synchronisé : le
 * crosshair traverse tous les panneaux et chacun affiche ses valeurs au même X.
 *
 * Le rendu est partagé (`src/components/chart/`) : cette page choisit l'axe,
 * construit le modèle et écrit le repère du curseur.
 */
export function ActivityCharts({ points }: ActivityChartsProps) {
  const canUseDistance = hasDistanceAxis(points);
  const [xKind, setXKind] = useState<XAxisKind>(canUseDistance ? "distance" : "time");

  // Mémoïsation manuelle assumée : le React Compiler n'est pas activé sur ce
  // projet, et sans elle les chemins SVG de toutes les séries de la séance
  // (600 points chacune) seraient reconstruits à chaque mouvement du pointeur.
  const model = useMemo(() => buildActivityChartsModel(points, xKind), [points, xKind]);

  if (model === null) return <NoDetailedData />;

  // La foulée a-t-elle réellement survécu ? Sans capteur, le panneau ne porte
  // plus que la cadence : un ⓘ « Qu'est-ce que la longueur de foulée ? » y
  // ouvrirait une fiche sur une courbe absente de l'écran.
  const hasStride = model.panels.some(
    (panel) =>
      panel.key === STRIDE_PANEL &&
      panel.series.some((series) => series.spec.key === STRIDE_SERIES),
  );

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
      <SyncedMultiPanels
        model={model}
        ariaLabel="Graphes synchronisés de la séance"
        header={(hover) => <CursorReadout points={points} hover={hover} />}
        // Seule la foulée est une grandeur **calculée** parmi les séries de la
        // page : allure, FC, altitude et cadence sortent des capteurs. Le rendu
        // ne pose qu'un ⓘ par panneau, au bout du titre — la fiche se raccroche
        // donc au panneau qui porte la foulée, et son intitulé (« Qu'est-ce que
        // la longueur de foulée ? ») dit de quelle série il parle, y compris
        // pour un lecteur d'écran.
        info={(key) => (hasStride && key === STRIDE_PANEL ? <MetricInfo id="stride" /> : null)}
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
