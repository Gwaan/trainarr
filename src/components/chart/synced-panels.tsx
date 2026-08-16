"use client";

import { type ReactNode, type RefObject } from "react";

import {
  VIEW_H,
  VIEW_W,
  chipSide,
  edgeAnchor,
} from "@/lib/chart/model";
import { panelValueAt, type ChartsModel, type PanelModel, type Tick } from "@/lib/chart/series";
import { cn } from "@/lib/utils";

import { ANCHOR_TRANSFORM, GUTTER } from "./geometry";
import { useScrub } from "./use-scrub";

export type SyncedPanelsProps<P> = {
  model: ChartsModel<P>;
  /** Description du groupe de graphes pour les lecteurs d'écran. */
  ariaLabel: string;
  /**
   * Ligne de repère posée au-dessus des panneaux. Reçoit l'index survolé
   * (`null` hors survol) : le libellé du curseur est propre à chaque page.
   */
  header?: (hover: number | null) => ReactNode;
  /**
   * Déclencheur d'explication posé au bout du titre d'une série, appelé avec la
   * clé de la série (`"ctl"`, `"stride"`…). Une fonction plutôt qu'un champ de
   * `SeriesSpec` : le rendu de graphe est partagé et n'a pas à connaître le
   * catalogue des fiches de métriques.
   */
  info?: (seriesKey: string) => ReactNode;
  className?: string;
};

/**
 * Graphes empilés à survol synchronisé, **une série par panneau** : un seul axe
 * Y chacun, une abscisse commune — le crosshair traverse tous les panneaux et
 * chacun affiche sa valeur au même X.
 *
 * Rendu de l'ancien modèle, conservé pour les pages non migrées. Les graphes
 * qui superposent plusieurs séries passent par `SyncedMultiPanels`.
 */
export function SyncedPanels<P>({
  model,
  ariaLabel,
  header,
  info,
  className,
}: SyncedPanelsProps<P>) {
  const { hover, cursorRatio, plotRef, handlers } = useScrub(model);

  return (
    <>
      {header?.(hover)}

      <div
        role="group"
        aria-label={ariaLabel}
        className={cn("mt-4 flex touch-pan-y flex-col gap-4 select-none", className)}
        {...handlers}
      >
        {model.panels.map((panel, index) => (
          <ChartPanel
            key={panel.spec.key}
            panel={panel}
            hover={hover}
            cursorRatio={cursorRatio}
            info={info?.(panel.spec.key)}
            // Un seul panneau sert de repère au pointeur : tous ont la même
            // gouttière, donc la même géométrie de tracé.
            plotRef={index === 0 ? plotRef : null}
          />
        ))}

        <XAxis ticks={model.xTicks} />
      </div>
    </>
  );
}

export type ChartPanelProps<P> = {
  panel: PanelModel<P>;
  /** Index du point survolé, `null` hors survol. */
  hover: number | null;
  /** Position du crosshair dans le panneau, 0..1. */
  cursorRatio: number;
  /** Renseigné sur le seul panneau qui sert de repère au pointeur. */
  plotRef: RefObject<HTMLDivElement | null> | null;
  /** Déclencheur d'explication posé au bout du titre de la série. */
  info?: ReactNode;
};

/**
 * Un panneau : ses graduations en gouttière, sa grille, sa courbe (et son
 * remplissage), le crosshair et la valeur survolée.
 */
export function ChartPanel<P>({
  panel,
  hover,
  cursorRatio,
  plotRef,
  info,
}: ChartPanelProps<P>) {
  const point = hover === null ? null : (panel.projected[hover] ?? null);
  const anchor = edgeAnchor(cursorRatio);
  const side = chipSide(point?.y ?? null);
  const fill = panel.spec.fill;
  const diverging = panel.spec.diverging;
  const areas = panel.diverging;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        {/* Le titre nomme la série : une seule par panneau, donc pas de légende. */}
        <h3 className="eyebrow flex min-w-0 items-center gap-1.5">
          {panel.spec.title}
          {info}
        </h3>
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

            {areas !== null && diverging !== undefined ? (
              <>
                <path
                  d={areas.above}
                  className={diverging.positiveClass}
                  fillOpacity={diverging.opacity}
                />
                <path
                  d={areas.below}
                  className={diverging.negativeClass}
                  fillOpacity={diverging.opacity}
                />
                {/* Ligne de zéro : c'est une référence, pas une graduation — elle
                    porte donc le trait plein, plus marqué que la grille à 40 %. */}
                <line
                  x1="0"
                  x2={VIEW_W}
                  y1={(areas.zeroOffsetPct / 100) * VIEW_H}
                  y2={(areas.zeroOffsetPct / 100) * VIEW_H}
                  className="stroke-border"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              </>
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

/** Graduations de l'abscisse, alignées sous la gouttière des panneaux. */
export function XAxis({
  ticks,
  rightGutter = false,
}: {
  ticks: readonly Tick[];
  /** Espaceur droit, quand les panneaux réservent une seconde gouttière. */
  rightGutter?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <div className={GUTTER} aria-hidden="true" />
      <div className="relative h-3.5 min-w-0 flex-1">
        {ticks.map((tick) => (
          <span
            key={tick.value}
            style={{
              left: `${tick.offsetPct}%`,
              transform: ANCHOR_TRANSFORM[edgeAnchor(tick.offsetPct / 100, 0.04)],
            }}
            /* `whitespace-nowrap` : une étiquette rabattue sur le bord droit
               n'a plus que quelques pixels de largeur disponible, et « 30 juil. »
               passerait à la ligne au milieu. */
            className="num absolute top-0 whitespace-nowrap text-[0.62rem] leading-none text-fg-faint"
          >
            {tick.label}
          </span>
        ))}
      </div>
      {rightGutter ? <div className={GUTTER} aria-hidden="true" /> : null}
    </div>
  );
}
