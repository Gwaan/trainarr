"use client";

import { useState } from "react";

import { edgeAnchor, type EdgeAnchor } from "@/lib/chart/model";
import { cn } from "@/lib/utils";

import type { BucketBarsModel } from "../_lib/bucket-model";

/** Ancre horizontale d'une étiquette, exprimée en position + transformation CSS. */
const ANCHOR_CLASS: Record<EdgeAnchor, string> = {
  start: "left-0",
  center: "left-1/2",
  end: "left-full",
};

const ANCHOR_TRANSFORM: Record<EdgeAnchor, string> = {
  start: "translateX(0)",
  center: "translateX(-50%)",
  end: "translateX(-100%)",
};

/** Gouttière des graduations — la même que les panneaux de courbes, ils s'alignent. */
const GUTTER = "w-9 shrink-0 sm:w-12";

const PLOT_HEIGHT = "h-40 sm:h-48";

/** Marge de rabattement des étiquettes étroites — la même que l'axe des courbes. */
const EDGE_MARGIN = 0.04;

/**
 * Dégagement au-dessus du cadre, pour que l'étiquette du maximum ait où se
 * poser : la barre la plus haute touche la graduation supérieure, et le
 * conteneur défilant rognerait tout ce qui dépasse.
 */
const HEADROOM = "pt-4";

export type BucketBarsProps = {
  model: BucketBarsModel;
  className?: string;
};

/**
 * Histogramme par seau (semaine ISO ou mois civil) : une seule série, donc une
 * seule couleur et pas de légende — le titre du panneau nomme ce qui est mesuré.
 *
 * En HTML plutôt qu'en SVG : des rectangles ancrés à une ligne de base n'ont
 * rien de vectoriel, et des div gardent leurs coins arrondis et leurs cibles
 * tactiles sans se déformer.
 *
 * Le seul chiffre écrit en clair est celui du maximum : une valeur au-dessus de
 * chaque barre est un mur de texte que personne ne lit. Le reste se lit au
 * survol **et au clavier** — chaque seau est un bouton focusable qui porte sa
 * valeur en `aria-label`, pour que rien ne soit accessible au seul pointeur.
 */
export function BucketBars({ model, className }: BucketBarsProps) {
  const [hover, setHover] = useState<number | null>(null);

  // Ne relâcher que si c'est bien ce seau qui était lu : le focus peut être
  // parti sur le suivant avant que le pointeur ne quitte celui-ci.
  const leave = (index: number) =>
    setHover((current) => (current === index ? null : current));

  return (
    <div className={cn("flex gap-2", className)}>
      <div className={cn(GUTTER, HEADROOM)}>
        <div className={cn("relative", PLOT_HEIGHT)}>
          {model.ticks.map((tick) => (
            <span
              key={tick.value}
              style={{ top: `${tick.offsetPct}%` }}
              className="num absolute right-0 -translate-y-1/2 text-[0.62rem] leading-none text-fg-faint"
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>

      {/* Les seaux gardent leur largeur minimale : trop nombreux, le graphe
          défile plutôt que de tasser ses étiquettes jusqu'à l'illisible. */}
      <div className="min-w-0 flex-1 touch-pan-y overflow-x-auto">
        <div className={cn("w-max min-w-full", HEADROOM)}>
          {/* `role="group"` et non `img` : un `img` rendrait tout son sous-arbre
              présentationnel, et les boutons de seau — qui portent les valeurs —
              disparaîtraient des technologies d'assistance. */}
          <div
            role="group"
            aria-label={model.ariaLabel}
            className={cn("relative", PLOT_HEIGHT)}
          >
            {model.ticks.map((tick) => (
              <span
                key={tick.value}
                aria-hidden="true"
                style={{ top: `${tick.offsetPct}%` }}
                className="pointer-events-none absolute inset-x-0 h-px bg-border/40"
              />
            ))}

            <div className="relative flex h-full items-end gap-0.5">
              {model.bars.map((bar, index) => {
                const ratio = (index + 0.5) / model.bars.length;
                // La bulle de survol est large : elle se rabat bien avant le
                // bord. L'étiquette du maximum, étroite, reste centrée plus
                // longtemps sur sa barre.
                const anchor = edgeAnchor(ratio);
                const tight = edgeAnchor(ratio, EDGE_MARGIN);

                return (
                  <button
                    key={`${bar.label}-${index}`}
                    type="button"
                    style={{ minWidth: `${model.minBarPx}px` }}
                    aria-label={bar.ariaLabel}
                    onPointerEnter={() => setHover(index)}
                    onPointerDown={() => setHover(index)}
                    onPointerLeave={() => leave(index)}
                    onFocus={() => setHover(index)}
                    onBlur={() => leave(index)}
                    className="relative flex h-full flex-1 cursor-default items-end justify-center"
                  >
                    {hover === index ? (
                      <span
                        aria-hidden="true"
                        style={{ transform: ANCHOR_TRANSFORM[anchor] }}
                        className={cn(
                          "num pointer-events-none absolute top-0 z-10 rounded-[6px] border border-border bg-surface-2 px-1.5 py-0.5 text-[0.7rem] leading-tight whitespace-nowrap text-fg",
                          ANCHOR_CLASS[anchor],
                        )}
                      >
                        {[bar.label, bar.valueLabel, bar.detail]
                          .filter((part) => part !== null)
                          .join(" · ")}
                      </span>
                    ) : null}

                    {bar.isMax && hover !== index ? (
                      <span
                        aria-hidden="true"
                        style={{
                          bottom: `calc(${bar.heightPct}% + 4px)`,
                          transform: ANCHOR_TRANSFORM[tight],
                        }}
                        className={cn(
                          "num pointer-events-none absolute text-[0.62rem] leading-none whitespace-nowrap text-fg-faint",
                          ANCHOR_CLASS[tight],
                        )}
                      >
                        {bar.valueLabel}
                      </span>
                    ) : null}

                    <span
                      aria-hidden="true"
                      style={{ height: `${bar.heightPct}%` }}
                      className={cn(
                        "block w-full max-w-6 rounded-t-[4px] bg-accent transition-[filter,opacity] duration-150 ease-out",
                        // Seau entamé : la barre est vraie mais pas comparable.
                        bar.partial && "opacity-45",
                        // Même mise en avant au focus qu'au survol : la lecture
                        // au clavier doit se voir autant qu'à la souris.
                        hover === index && "brightness-125",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Étiquettes d'axe : mêmes colonnes que les barres, mais leur texte
              est posé en absolu — sinon un libellé plus large que sa colonne
              élargirait cette rangée seule, et l'axe se décalerait des barres. */}
          <div className="mt-2 flex h-3 gap-0.5">
            {model.bars.map((bar, index) => {
              const anchor = edgeAnchor((index + 0.5) / model.bars.length, EDGE_MARGIN);

              return (
                <span
                  key={`${bar.label}-${index}`}
                  style={{ minWidth: `${model.minBarPx}px` }}
                  className="relative flex-1"
                >
                  {bar.axisLabel === null ? null : (
                    <span
                      style={{ transform: ANCHOR_TRANSFORM[anchor] }}
                      className={cn(
                        "num absolute top-0 text-[0.62rem] leading-none whitespace-nowrap text-fg-faint",
                        ANCHOR_CLASS[anchor],
                      )}
                    >
                      {bar.axisLabel}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
