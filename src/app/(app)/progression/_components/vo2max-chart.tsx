"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";

import {
  VIEW_H,
  VIEW_W,
  clampRatio,
  edgeAnchor,
  nearestIndex,
  type EdgeAnchor,
} from "@/lib/chart/model";
import { cn } from "@/lib/utils";

import { buildVo2maxChartModel, type Vo2maxPoint } from "../_lib/vo2max-model";

const ANCHOR_TRANSFORM: Record<EdgeAnchor, string> = {
  start: "translateX(0)",
  center: "translateX(-50%)",
  end: "translateX(-100%)",
};

/** Gouttière identique aux panneaux de courbes : les axes Y de la page s'alignent. */
const GUTTER = "w-9 shrink-0 sm:w-12";

export type Vo2maxChartProps = {
  /** Une estimation par course de la période. */
  points: readonly Vo2maxPoint[];
  /** Moyenne glissante sur 30 jours, un point par jour couvert. */
  trend: readonly Vo2maxPoint[];
};

/**
 * VO₂max effective : le nuage des séances et sa tendance à 30 jours.
 *
 * Les séances sont des pastilles HTML et non des `<circle>` : le repère du SVG
 * est étiré (`preserveAspectRatio="none"`), un cercle y deviendrait une ellipse
 * d'autant plus écrasée que le panneau est large. Seuls les tracés, corrigés par
 * `vector-effect`, y survivent.
 *
 * La cible du survol est toute la largeur du panneau, pas les pastilles : on
 * cherche un moment dans le temps, et la course la plus proche de ce moment
 * répond — viser un point de 6 px au doigt serait un jeu d'adresse.
 */
export function Vo2maxChart({ points, trend }: Vo2maxChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);

  // Mémoïsation manuelle assumée : le React Compiler n'est pas activé sur ce
  // projet, et le modèle serait reconstruit à chaque mouvement du pointeur.
  const model = useMemo(() => buildVo2maxChartModel(points, trend), [points, trend]);

  if (model === null) {
    return (
      <p className="text-[0.82rem] leading-relaxed text-fg-muted">
        Il faut au moins deux courses estimables, à deux dates différentes, pour
        tracer une évolution.
      </p>
    );
  }

  const moveTo = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return;

    const ratio = clampRatio((clientX - rect.left) / rect.width);
    const span = model.xDomain.max - model.xDomain.min;
    setHover(nearestIndex(model.xs, model.xDomain.min + ratio * span));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    // Souris : le survol suffit. Doigt et stylet : seulement pendant l'appui —
    // `touch-pan-y` laisse le défilement vertical de la page passer.
    if (event.pointerType === "mouse" || scrubbing.current) moveTo(event.clientX);
  };

  const stopScrub = (event: PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    if (event.pointerType === "mouse") setHover(null);
  };

  const cursor = hover === null ? null : model.dots[hover];
  const cursorRatio = cursor?.leftPct ?? 0;
  const anchor = edgeAnchor(cursorRatio / 100);

  return (
    <div
      className="flex touch-pan-y flex-col gap-2 select-none"
      onPointerDown={(event) => {
        scrubbing.current = true;
        moveTo(event.clientX);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={stopScrub}
      onPointerCancel={stopScrub}
      onPointerLeave={stopScrub}
    >
      <div className="flex gap-2">
        <div className={cn("relative", GUTTER, "h-40 sm:h-52")}>
          {model.yTicks.map((tick) => (
            <span
              key={tick.value}
              style={{ top: `${tick.offsetPct}%` }}
              className="num absolute right-0 -translate-y-1/2 text-[0.62rem] leading-none text-fg-faint"
            >
              {tick.label}
            </span>
          ))}
        </div>

        <div ref={plotRef} className="relative h-40 min-w-0 flex-1 sm:h-52">
          <svg
            role="img"
            aria-label={model.ariaLabel}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className="size-full"
          >
            {model.yTicks.map((tick) => (
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

            <path
              d={model.trendPath}
              fill="none"
              className="stroke-accent"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {model.dots.map((dot, index) => (
            <span
              key={dot.key}
              aria-hidden="true"
              style={{ left: `${dot.leftPct}%`, top: `${dot.topPct}%` }}
              className={cn(
                "pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150 ease-out",
                // La tendance porte l'accent : le nuage reste en retrait, sinon
                // le bruit des séances prendrait le pas sur ce qu'il résume.
                hover === index ? "size-2 bg-fg" : "bg-fg-faint/60",
              )}
            />
          ))}

          {hover !== null && cursor !== undefined ? (
            <>
              <span
                aria-hidden="true"
                style={{ left: `${cursorRatio}%` }}
                className="pointer-events-none absolute inset-y-0 w-px bg-fg-faint/60"
              />
              <span
                aria-hidden="true"
                style={{
                  left: `${cursorRatio}%`,
                  transform: ANCHOR_TRANSFORM[anchor],
                }}
                className="num pointer-events-none absolute top-0 rounded-[6px] border border-border bg-surface-2 px-1.5 py-0.5 text-[0.7rem] leading-tight whitespace-nowrap text-fg"
              >
                {model.readouts[hover]}
              </span>
            </>
          ) : null}
        </div>
      </div>

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
              className="num absolute top-0 whitespace-nowrap text-[0.62rem] leading-none text-fg-faint"
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
