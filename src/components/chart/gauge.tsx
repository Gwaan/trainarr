import type { ReactNode } from "react";

import {
  GAUGE_BAND_WIDTH,
  GAUGE_CENTER_X,
  GAUGE_CENTER_Y,
  GAUGE_HUB_RADIUS,
  GAUGE_VIEW,
  type GaugeModel,
} from "@/lib/chart/gauge";
import { cn } from "@/lib/utils";

export type GaugeProps = {
  /** Géométrie calculée par `buildGaugeModel` — côté serveur, jamais ici. */
  model: GaugeModel;
  /** Valeur **déjà formatée**, rendue en mono comme toute donnée de l'appli. */
  value: string;
  label: string;
  /**
   * Déclencheur d'explication posé à droite du libellé (un ⓘ). Un `ReactNode`
   * comme sur `StatCard` et `Panel` : cette primitive n'a pas à connaître le
   * catalogue des fiches métriques.
   */
  info?: ReactNode;
  /** Courte lecture de la position, ex. « vs tes 90 derniers jours (18 séances) ». */
  note?: string;
  /**
   * Ce que la jauge dit, en une phrase : valeur **et** lecture qualitative. Le
   * dessin est décoratif pour un lecteur d'écran — cette phrase est la donnée.
   */
  ariaLabel: string;
  className?: string;
};

/**
 * Jauge en arc : une valeur, l'échelle qui la juge, et où elle y tombe.
 *
 * Composant serveur (aucun état) : la géométrie arrive toute faite du modèle
 * pur `lib/chart/gauge`, il ne fait que la rendre.
 *
 * La position se lit **deux fois** — l'aiguille pointe la valeur exacte, la
 * bande où elle tombe s'allume pendant que les autres s'estompent. C'est ce qui
 * permet de lire la jauge d'un coup d'œil sans lire le chiffre, et de ne jamais
 * faire porter le sens à la seule couleur : la bande active est aussi nommée
 * dans la note et dans l'étiquette accessible.
 *
 * Le chiffre et la note sont `aria-hidden` : `ariaLabel` les reprend mot pour
 * mot, les lire trois fois n'apporterait rien. Le libellé, lui, reste dans le
 * flux — il nomme la tuile et porte le ⓘ, qui doit rester atteignable.
 */
export function Gauge({
  model,
  value,
  label,
  info,
  note,
  ariaLabel,
  className,
}: GaugeProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      <h3 className="eyebrow flex items-center gap-1.5">
        {label}
        {info}
      </h3>

      {/* Ratio fixe : un arc étiré n'est plus un arc (cf. `lib/chart/gauge`).
          Le chiffre se pose dans l'ouverture du bas, là où l'arc laisse la
          place — au centre, il croiserait l'aiguille. */}
      <div className="relative mx-auto mt-3 w-full max-w-[10rem]">
        <svg
          viewBox={`0 0 ${GAUGE_VIEW} ${GAUGE_VIEW}`}
          className="block w-full"
          role="img"
          aria-label={ariaLabel}
        >
          {model.bands.map((band) => (
            <path
              key={band.path}
              d={band.path}
              fill="none"
              strokeWidth={GAUGE_BAND_WIDTH}
              strokeLinecap="butt"
              className={cn(band.className, band.active ? "opacity-100" : "opacity-45")}
            />
          ))}

          <path
            d={model.needlePath}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            className="stroke-fg"
          />
          <circle
            cx={GAUGE_CENTER_X}
            cy={GAUGE_CENTER_Y}
            r={GAUGE_HUB_RADIUS}
            className="fill-fg"
          />
        </svg>

        <span
          aria-hidden="true"
          className="num absolute inset-x-0 bottom-0 text-center text-[1.5rem] leading-none font-semibold text-fg sm:text-[1.7rem]"
        >
          {value}
        </span>
      </div>

      {note ? (
        <p
          aria-hidden="true"
          className="mt-2.5 text-center text-[0.78rem] leading-snug text-fg-muted"
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}
