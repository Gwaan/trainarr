"use client";

import { useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";

import { Panel } from "@/components/panel";
import { cn } from "@/lib/utils";

import {
  VIEW_H,
  VIEW_W,
  chipSide,
  clampRatio,
  edgeAnchor,
  nearestIndex,
  normalize,
  type ChartPoint,
  type EdgeAnchor,
  type XAxisKind,
} from "../_lib/chart-model";
import {
  buildChartsModel,
  hasDistanceAxis,
  panelValueAt,
  type ChartsModel,
  type PanelModel,
} from "../_lib/chart-series";
import { formatClock, formatDistanceTick } from "../_lib/format-detail";
import { NoDetailedData } from "./no-detailed-data";

/** Gouttière des étiquettes d'axe Y — identique sur tous les panneaux, ils s'alignent. */
const GUTTER = "w-9 shrink-0 sm:w-12";

/** Ancre horizontale d'une étiquette, exprimée en transformation CSS. */
const ANCHOR_TRANSFORM: Record<EdgeAnchor, string> = {
  start: "translateX(0)",
  center: "translateX(-50%)",
  end: "translateX(-100%)",
};

export type ActivityChartsProps = {
  /** Points déjà décimés par le DAL (600 au maximum) — jamais re-échantillonnés ici. */
  points: readonly ChartPoint[];
};

/**
 * Graphes empilés de la séance : un panneau par mesure, un seul axe Y chacun,
 * une abscisse commune (distance ou temps) et un survol synchronisé — le
 * crosshair traverse tous les panneaux et chacun affiche sa valeur au même X.
 *
 * Superposer allure, FC, altitude et cadence sur deux axes Y rendrait toute
 * comparaison arbitraire : les small multiples sont le seul rendu honnête.
 */
export function ActivityCharts({ points }: ActivityChartsProps) {
  const canUseDistance = hasDistanceAxis(points);
  const [xKind, setXKind] = useState<XAxisKind>(canUseDistance ? "distance" : "time");
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);

  // Mémoïsation manuelle assumée : le React Compiler n'est pas activé sur ce
  // projet, et sans elle les chemins SVG de quatre séries de 600 points
  // seraient reconstruits à chaque mouvement du pointeur.
  const model = useMemo(() => buildChartsModel(points, xKind), [points, xKind]);

  if (model === null) return <NoDetailedData />;

  const moveTo = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return;

    const ratio = clampRatio((clientX - rect.left) / rect.width);
    const span = model.xDomain.max - model.xDomain.min;
    setHover(nearestIndex(model.xs, model.xDomain.min + ratio * span));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    scrubbing.current = true;
    moveTo(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    // Souris : le survol suffit. Doigt et stylet : seulement pendant l'appui —
    // `touch-pan-y` laisse le défilement vertical de la page passer.
    if (event.pointerType === "mouse" || scrubbing.current) moveTo(event.clientX);
  };

  const stopScrub = (event: PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    // Le doigt parti, la lecture reste affichée ; le curseur souris, lui, emporte
    // le crosshair avec lui.
    if (event.pointerType === "mouse") setHover(null);
  };

  const cursor = hover === null ? points[points.length - 1] : points[hover];
  const cursorRatio = hover === null ? 0 : normalize(model.xs[hover], model.xDomain);
  // Repère du curseur : distance **et** temps, quelle que soit l'abscisse
  // choisie — la distance disparaît d'elle-même si la séance n'en porte pas.
  const cursorLabel = [
    cursor.distanceM === null ? null : `${formatDistanceTick(cursor.distanceM, 100)} km`,
    formatClock(cursor.timeS),
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <Panel
      title="Analyse de la séance"
      meta={
        canUseDistance ? <AxisToggle value={xKind} onChange={setXKind} /> : null
      }
    >
      <p className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{hover === null ? "Séance" : "Curseur"}</span>
        <span className="num text-[0.82rem] text-fg">{cursorLabel}</span>
      </p>

      <div
        role="group"
        aria-label="Graphes synchronisés de la séance"
        className="mt-4 flex touch-pan-y flex-col gap-4 select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopScrub}
        onPointerCancel={stopScrub}
        onPointerLeave={stopScrub}
      >
        {model.panels.map((panel, index) => (
          <ChartPanel
            key={panel.spec.key}
            panel={panel}
            hover={hover}
            cursorRatio={cursorRatio}
            // Un seul panneau sert de repère au pointeur : tous ont la même
            // gouttière, donc la même géométrie de tracé.
            plotRef={index === 0 ? plotRef : null}
          />
        ))}

        <XAxis model={model} />
      </div>
    </Panel>
  );
}

function AxisToggle({
  value,
  onChange,
}: {
  value: XAxisKind;
  onChange: (next: XAxisKind) => void;
}) {
  return (
    <span
      role="group"
      aria-label="Axe horizontal"
      className="flex items-center gap-1 rounded-button border border-border p-0.5"
    >
      {(
        [
          ["distance", "Distance (km)"],
          ["time", "Temps"],
        ] as const
      ).map(([kind, label]) => (
        <button
          key={kind}
          type="button"
          aria-pressed={value === kind}
          onClick={() => onChange(kind)}
          className={cn(
            "rounded-[6px] px-2 py-1 text-[0.68rem] font-medium transition-colors duration-150 ease-out",
            value === kind
              ? "bg-accent-soft text-accent"
              : "text-fg-faint hover:text-fg-muted",
          )}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function ChartPanel({
  panel,
  hover,
  cursorRatio,
  plotRef,
}: {
  panel: PanelModel;
  hover: number | null;
  cursorRatio: number;
  plotRef: RefObject<HTMLDivElement | null> | null;
}) {
  const point = hover === null ? null : (panel.projected[hover] ?? null);
  const anchor = edgeAnchor(cursorRatio);
  const side = chipSide(point?.y ?? null);
  const fill = panel.spec.fill;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        {/* Le titre nomme la série : une seule par panneau, donc pas de légende. */}
        <h3 className="eyebrow">{panel.spec.title}</h3>
        <span className="num text-[0.7rem] text-fg-faint">{panel.rangeLabel}</span>
      </div>

      <div className="flex gap-2">
        <div className={cn("relative", GUTTER)}>
          {panel.ticks.map((tick) => (
            <span
              key={tick.value}
              style={{ top: `${tick.offsetPct}%` }}
              className="num absolute right-0 -translate-y-1/2 text-[0.62rem] leading-none text-fg-faint"
            >
              {tick.label}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className={cn("relative min-w-0 flex-1", panel.spec.heightClass)}
        >
          <svg
            role="img"
            aria-label={panel.ariaLabel}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className="size-full"
          >
            {panel.ticks.map((tick) => (
              <line
                key={tick.value}
                x1="0"
                x2={VIEW_W}
                y1={(tick.offsetPct / 100) * VIEW_H}
                y2={(tick.offsetPct / 100) * VIEW_H}
                className="stroke-border"
                strokeOpacity="0.4"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {panel.area !== null && fill !== null ? (
              <path d={panel.area} className={fill.className} fillOpacity={fill.opacity} />
            ) : null}

            <path
              d={panel.line}
              fill="none"
              className={panel.spec.strokeClass}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {hover !== null ? (
            <>
              <span
                aria-hidden="true"
                style={{ left: `${cursorRatio * 100}%` }}
                className="pointer-events-none absolute inset-y-0 w-px bg-fg-faint/60"
              />
              {point !== null ? (
                <span
                  aria-hidden="true"
                  style={{
                    left: `${cursorRatio * 100}%`,
                    top: `${(point.y / VIEW_H) * 100}%`,
                  }}
                  className={cn(
                    "pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                    panel.spec.dotClass,
                  )}
                />
              ) : null}
              <span
                aria-hidden="true"
                style={{
                  left: `${cursorRatio * 100}%`,
                  transform: ANCHOR_TRANSFORM[anchor],
                }}
                className={cn(
                  "num pointer-events-none absolute rounded-[6px] border border-border bg-surface-2 px-1.5 py-0.5 text-[0.7rem] leading-tight text-fg",
                  side === "top" ? "top-0" : "bottom-0",
                )}
              >
                {panelValueAt(panel, hover)}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function XAxis({ model }: { model: ChartsModel }) {
  return (
    <div className="flex gap-2">
      <div className={GUTTER} aria-hidden="true" />
      <div className="relative h-3.5 min-w-0 flex-1">
        {model.xTicks.map((tick) => (
          <span
            key={tick.value}
            style={{
              left: `${tick.offsetPct}%`,
              transform: ANCHOR_TRANSFORM[edgeAnchor(tick.offsetPct / 100, 0.04)],
            }}
            className="num absolute top-0 text-[0.62rem] leading-none text-fg-faint"
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}
