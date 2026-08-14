"use client";

import { useState } from "react";

import { Panel } from "@/components/panel";
import { cn } from "@/lib/utils";

import { MetricInfo } from "../../../_components/metric-info";
import type { MetricSheetId } from "../../../_lib/metric-sheets";
import { formatNumber } from "../../../_lib/format";
import type { DistributionModel } from "../_lib/distribution-model";
import { formatBinTime } from "../_lib/format-detail";

/** Gouttière des graduations de temps — même largeur que celle des graphes. */
const GUTTER = "w-9 shrink-0 sm:w-12";

/** Hauteur de la zone tracée, étiquettes d'abscisse exclues. */
const PLOT_HEIGHT = "h-32 sm:h-36";

export type DistributionPanelProps = {
  title: string;
  /**
   * Fiche ouverte par le ⓘ de l'en-tête. Un identifiant plutôt qu'un
   * `ReactNode` : ce composant est déjà client, il instancie le déclencheur
   * lui-même, et une simple chaîne suffit à traverser la frontière.
   */
  sheet: MetricSheetId;
  model: DistributionModel;
  /** Ce que la hauteur des colonnes raconte, en une ligne. */
  hint: string;
  className?: string;
};

/**
 * Histogramme « temps passé par tranche ».
 *
 * Colonnes verticales : la **hauteur** porte l'information, donc le fond reste
 * transparent — un rail plein derrière chaque colonne (comme sous les barres de
 * zones) dessinerait un maximum qui n'existe pas dans les données.
 *
 * Une seule étiquette directe, sur la colonne la plus longue ; les autres
 * valeurs se lisent sur la grille de temps, au survol, et au clavier —
 * chaque colonne est un bouton focusable qui porte sa valeur en `aria-label`,
 * pour que rien ne soit accessible au seul pointeur.
 *
 * Le modèle (hauteurs, couleurs, libellés) est calculé côté serveur : ce
 * composant n'est client que pour l'état de survol.
 */
export function DistributionPanel({
  title,
  sheet,
  model,
  hint,
  className,
}: DistributionPanelProps) {
  const [hover, setHover] = useState<number | null>(null);

  const { bars, gridLines, totalSeconds } = model;
  const hovered = hover === null ? null : (bars[hover] ?? null);
  const last = bars.length - 1;

  const leave = (index: number) =>
    setHover((current) => (current === index ? null : current));

  return (
    <Panel
      title={title}
      info={<MetricInfo id={sheet} />}
      meta={<span className="num">{formatBinTime(totalSeconds)}</span>}
      className={className}
    >
      {/* Bande de lecture à hauteur fixe : la puce du survol y apparaît sans
          jamais décaler le graphe sous elle. */}
      <p className="flex min-h-6 items-center justify-end">
        {hovered === null ? null : (
          <span className="num rounded-[6px] border border-border bg-surface-2 px-1.5 py-0.5 text-[0.7rem] leading-tight text-fg">
            {[
              hovered.rangeLabel,
              hovered.zoneLabel,
              formatBinTime(hovered.seconds),
              `${formatNumber(hovered.sharePct, 0)} %`,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </span>
        )}
      </p>

      <div className="mt-1 flex gap-2">
        <div className={cn("relative", GUTTER, PLOT_HEIGHT)} aria-hidden="true">
          {gridLines.map((line) => (
            <span
              key={line.seconds}
              style={{ bottom: `${line.bottomPct}%` }}
              className="num absolute right-0 translate-y-1/2 text-[0.62rem] leading-none text-fg-faint"
            >
              {line.label}
            </span>
          ))}
        </div>

        {/* Chaque colonne garde 24 px de large pour rester atteignable au doigt :
            au-delà d'une quinzaine de tranches sur un écran étroit, c'est le
            graphe qui défile, pas les cibles qui rétrécissent. */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          {/* `w-max` : sans lui, ce bloc resterait à la largeur du conteneur et
              seule la rangée de colonnes déborderait — les graduations d'abscisse
              ne seraient plus alignées sous leurs colonnes. */}
          <div className="w-max min-w-full">
            <div className={cn("relative flex gap-0.5", PLOT_HEIGHT)}>
              {gridLines.map((line) => (
                <span
                  key={line.seconds}
                  aria-hidden="true"
                  style={{ bottom: `${line.bottomPct}%` }}
                  className="pointer-events-none absolute inset-x-0 h-px bg-border/40"
                />
              ))}

              {bars.map((bar, index) => (
                <button
                  key={bar.key}
                  type="button"
                  onPointerEnter={() => setHover(index)}
                  onPointerLeave={() => leave(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => leave(index)}
                  aria-label={[
                    bar.rangeLabel,
                    bar.zoneLabel,
                    formatBinTime(bar.seconds),
                    `${formatNumber(bar.sharePct, 0)} %`,
                  ]
                    .filter((part) => part !== null)
                    .join(", ")}
                  className="relative flex min-w-6 flex-1 cursor-default flex-col justify-end"
                >
                  {/* Coin supérieur arrondi, base carrée : la colonne pousse
                      depuis la ligne de base, elle n'y flotte pas. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mx-auto block w-full max-w-6 rounded-t-[4px] transition-[filter] duration-150 ease-out",
                      bar.fillClass,
                      hover === index && "brightness-125",
                    )}
                    style={{ height: `${bar.heightPct.toFixed(2)}%` }}
                  />

                  {bar.isPeak ? (
                    <span
                      aria-hidden="true"
                      style={{ bottom: `calc(${bar.heightPct.toFixed(2)}% + 0.25rem)` }}
                      className={cn(
                        "num pointer-events-none absolute text-[0.62rem] leading-none whitespace-nowrap text-fg-muted",
                        // Les colonnes de bord ancrent leur étiquette vers
                        // l'intérieur : centrée, elle serait rognée par le
                        // conteneur défilant.
                        index === 0 && "left-0",
                        index === last && last > 0 && "right-0",
                        index !== 0 && index !== last && "left-1/2 -translate-x-1/2",
                      )}
                    >
                      {formatBinTime(bar.seconds)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            {/* Axe catégoriel : une graduation nomme la borne basse de sa
                colonne. Les étiquettes débordent sur les colonnes voisines,
                qui sont vides — sauf aux deux bords, ancrés vers l'intérieur
                pour ne pas passer sous le bord du conteneur défilant. */}
            <div className="mt-1.5 flex gap-0.5" aria-hidden="true">
              {bars.map((bar, index) => (
                <span
                  key={bar.key}
                  className={cn(
                    "num min-w-6 flex-1 text-[0.62rem] leading-none whitespace-nowrap text-fg-faint",
                    index === 0 ? "text-left" : index === last ? "text-right" : "text-center",
                  )}
                >
                  {bar.tickLabel}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className="mt-3 text-[0.72rem] leading-snug text-fg-faint">{hint}</p>
    </Panel>
  );
}
