"use client";

import { type ReactNode, type RefObject } from "react";

import { VIEW_H, VIEW_W, chipSide, edgeAnchor } from "@/lib/chart/model";
import {
  multiPanelValueAt,
  type MultiChartsModel,
  type MultiPanelModel,
  type Tick,
} from "@/lib/chart/series";
import { cn } from "@/lib/utils";

import { ANCHOR_TRANSFORM, GUTTER } from "./geometry";
import { XAxis } from "./synced-panels";
import { useScrub } from "./use-scrub";

export type SyncedMultiPanelsProps<P> = {
  model: MultiChartsModel<P>;
  /** Description du groupe de graphes pour les lecteurs d'écran. */
  ariaLabel: string;
  /**
   * Ligne de repère posée au-dessus des panneaux. Reçoit l'index survolé
   * (`null` hors survol) : le libellé du curseur est propre à chaque page.
   */
  header?: (hover: number | null) => ReactNode;
  /**
   * Déclencheur d'explication posé au bout du titre d'un panneau, appelé avec
   * sa clé. Une fonction plutôt qu'un champ du descripteur : le rendu de graphe
   * est partagé et n'a pas à connaître le catalogue des fiches de métriques.
   */
  info?: (panelKey: string) => ReactNode;
  className?: string;
};

/**
 * Graphes empilés à survol synchronisé, **plusieurs séries par panneau** et
 * jusqu'à deux axes Y.
 *
 * Même geste que `SyncedPanels` — un crosshair unique traverse tous les
 * panneaux — mais chaque panneau superpose ses séries, les nomme dans une
 * légende, et peut graduer une seconde échelle dans une gouttière droite.
 *
 * Quand au moins un panneau porte un axe droit, la gouttière droite est
 * réservée sur **tous** : sans cela, les tracés de deux panneaux voisins
 * n'auraient pas la même largeur et la même abscisse ne tomberait pas au même
 * endroit — ce qui ruinerait la lecture croisée que l'empilement sert.
 */
export function SyncedMultiPanels<P>({
  model,
  ariaLabel,
  header,
  info,
  className,
}: SyncedMultiPanelsProps<P>) {
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
          <MultiChartPanel
            key={panel.key}
            panel={panel}
            hover={hover}
            cursorRatio={cursorRatio}
            rightGutter={model.hasRightGutter}
            info={info?.(panel.key)}
            // Un seul panneau sert de repère au pointeur : tous ont les mêmes
            // gouttières, donc la même géométrie de tracé.
            plotRef={index === 0 ? plotRef : null}
          />
        ))}

        <XAxis ticks={model.xTicks} rightGutter={model.hasRightGutter} />
      </div>
    </>
  );
}

export type MultiChartPanelProps<P> = {
  panel: MultiPanelModel<P>;
  /** Index du point survolé, `null` hors survol. */
  hover: number | null;
  /** Position du crosshair dans le panneau, 0..1. */
  cursorRatio: number;
  /** Gouttière droite réservée sur tous les panneaux du graphe. */
  rightGutter: boolean;
  /** Renseigné sur le seul panneau qui sert de repère au pointeur. */
  plotRef: RefObject<HTMLDivElement | null> | null;
  /** Déclencheur d'explication posé au bout du titre du panneau. */
  info?: ReactNode;
};

/**
 * Un panneau multi-séries : ses graduations en gouttières, sa grille, ses
 * séries superposées, le crosshair et la lecture au survol.
 */
export function MultiChartPanel<P>({
  panel,
  hover,
  cursorRatio,
  rightGutter,
  plotRef,
  info,
}: MultiChartPanelProps<P>) {
  // La première série sert de référence de placement : c'est elle que le titre
  // du panneau désigne en premier, et la puce doit se poser au même endroit
  // d'un point à l'autre plutôt que sauter de série en série.
  const lead = panel.series[0];
  const leadPoint = hover === null ? null : (lead.projected[hover] ?? null);
  const anchor = edgeAnchor(cursorRatio);
  const side = chipSide(leadPoint?.y ?? null);
  const showLegend = panel.series.length > 1;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="eyebrow flex min-w-0 items-center gap-1.5">
          {panel.title}
          {info}
        </h3>
        {showLegend ? (
          // Plusieurs séries : c'est la légende qui les nomme. L'étendue du
          // panneau ne s'affiche plus — celle d'une seule des séries, sans dire
          // laquelle, se lirait comme celle du panneau entier.
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            {panel.series.map((series) => (
              <span
                key={series.spec.key}
                className="flex items-center gap-1.5 text-[0.7rem] leading-none text-fg-muted"
              >
                <span
                  aria-hidden="true"
                  className={cn("size-2 shrink-0 rounded-full", series.spec.legendClass)}
                />
                {series.spec.label}
              </span>
            ))}
          </div>
        ) : (
          <span className="num text-[0.7rem] text-fg-faint">{panel.rangeLabel}</span>
        )}
      </div>

      <div className="flex gap-2">
        <AxisGutter ticks={panel.leftAxis.ticks} side="left" />

        <div ref={plotRef} className={cn("relative min-w-0 flex-1", panel.heightClass)}>
          <svg
            role="img"
            aria-label={panel.ariaLabel}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className="size-full"
          >
            {/* Grille sur les seules graduations de l'axe gauche : deux trames
                superposées ne se lisent plus comme un repère. */}
            {panel.leftAxis.ticks.map((tick) => (
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

            {/* Deux passes : tous les remplissages, puis tous les traits. Sinon
                l'aire d'une série masquerait la courbe de la précédente. */}
            {panel.series.map((series) => {
              const fill = series.spec.fill;
              const diverging = series.spec.diverging;
              const areas = series.diverging;

              return (
                <g key={series.spec.key}>
                  {series.area !== null && fill !== null ? (
                    <path d={series.area} className={fill.className} fillOpacity={fill.opacity} />
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
                      {/* Ligne de zéro : c'est une référence, pas une graduation —
                          elle porte donc le trait plein, plus marqué que la
                          grille à 40 %. */}
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
                </g>
              );
            })}

            {panel.series.map((series) => (
              <path
                key={series.spec.key}
                d={series.line}
                fill="none"
                className={series.spec.strokeClass}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>

          {hover !== null ? (
            <>
              <span
                aria-hidden="true"
                style={{ left: `${cursorRatio * 100}%` }}
                className="pointer-events-none absolute inset-y-0 w-px bg-fg-faint/60"
              />

              {/* Un point par série, chacun sur sa propre projection : deux séries
                  d'axes différents ne se croisent pas là où leurs valeurs se
                  croisent. */}
              {panel.series.map((series) => {
                const point = series.projected[hover] ?? null;
                if (point === null) return null;

                return (
                  <span
                    key={series.spec.key}
                    aria-hidden="true"
                    style={{
                      left: `${cursorRatio * 100}%`,
                      top: `${(point.y / VIEW_H) * 100}%`,
                    }}
                    className={cn(
                      "pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                      series.spec.dotClass,
                    )}
                  />
                );
              })}

              {/* Une seule étiquette pour tout le panneau : une par série se
                  chevaucherait dès que deux courbes se rapprochent. */}
              <span
                aria-hidden="true"
                style={{
                  left: `${cursorRatio * 100}%`,
                  transform: ANCHOR_TRANSFORM[anchor],
                }}
                className={cn(
                  "num pointer-events-none absolute flex items-center gap-2 rounded-[6px] border border-border bg-surface-2 px-1.5 py-0.5 text-[0.7rem] leading-tight whitespace-nowrap text-fg",
                  side === "top" ? "top-0" : "bottom-0",
                )}
              >
                {panel.series.map((series) => (
                  <span key={series.spec.key} className="flex items-center gap-1">
                    {showLegend ? (
                      <span
                        className={cn("size-1.5 shrink-0 rounded-full", series.spec.legendClass)}
                      />
                    ) : null}
                    {multiPanelValueAt(panel, series.spec.key, hover)}
                  </span>
                ))}
              </span>
            </>
          ) : null}
        </div>

        {rightGutter ? (
          <AxisGutter ticks={panel.rightAxis?.ticks ?? []} side="right" />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Une gouttière de graduations. Même largeur des deux côtés et sur tous les
 * panneaux : c'est ce qui garantit que la même abscisse tombe au même pixel
 * d'un panneau à l'autre.
 */
function AxisGutter({ ticks, side }: { ticks: readonly Tick[]; side: "left" | "right" }) {
  return (
    <div className={cn("relative", GUTTER)} aria-hidden={ticks.length === 0 ? "true" : undefined}>
      {ticks.map((tick) => (
        <span
          key={tick.value}
          style={{ top: `${tick.offsetPct}%` }}
          className={cn(
            "num absolute -translate-y-1/2 text-[0.62rem] leading-none text-fg-faint",
            side === "left" ? "right-0" : "left-0",
          )}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}
