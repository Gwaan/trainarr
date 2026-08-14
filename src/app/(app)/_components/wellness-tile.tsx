import type { ReactNode } from "react";
import { HeartPulse } from "lucide-react";

import { cn } from "@/lib/utils";

import { MetricInfo } from "./metric-info";
import { MetricPlaceholder } from "./metric-placeholder";
import {
  isWellnessTileEmpty,
  type WellnessMeasureView,
  type WellnessTileView,
} from "../_lib/wellness-view";

/**
 * Les dernières mesures de la montre — FC de repos, HRV, sommeil — dans la
 * grille des indicateurs clés.
 *
 * ## Une tuile, trois mesures
 *
 * Elles vont ensemble : ce sont les trois chiffres de la même nuit, et c'est
 * leur lecture croisée qui dit quelque chose (« HRV basse **et** FC de repos
 * haute »). Trois cartes séparées auraient triplé la place occupée par des
 * valeurs que Trainarr ne calcule même pas.
 *
 * ## Ce que cette tuile ne fait jamais
 *
 * - **Colorer.** Aucun `warning`, aucun `negative` : une HRV basse n'est pas une
 *   erreur système, et transformer une mesure de sommeil en alarme rouge sur un
 *   tableau de bord d'entraînement serait un jugement que rien ici n'autorise.
 * - **Laisser un blanc.** Une mesure absente est **dite** absente. Un vide se
 *   lirait comme une panne alors qu'il veut dire « pas de montre cette nuit-là ».
 * - **Conclure.** Elle affiche et date, elle ne recommande rien : c'est le coach
 *   qui met ces valeurs en regard de l'entraînement.
 */

export type WellnessTileProps = {
  wellness: WellnessTileView;
  className?: string;
};

/** Une mesure dans la tuile : son libellé (et son ⓘ), sa valeur, sa date. */
function Measure({
  label,
  info,
  measure,
  absent,
}: {
  label: string;
  info?: ReactNode;
  measure: WellnessMeasureView | null;
  /** Ce qu'on écrit quand la mesure n'existe pas, ex. « pas de HRV ». */
  absent: string;
}) {
  return (
    <div className="min-w-0">
      {/* Pas la classe `eyebrow` ici : elle porte déjà le titre de la tuile
          juste au-dessus, et deux niveaux de capitales empilés se
          concurrenceraient. */}
      <dt className="flex items-center gap-1 text-[0.72rem] leading-snug text-fg-faint">
        {label}
        {info}
      </dt>
      {measure === null ? (
        <dd className="mt-2 text-[0.82rem] leading-snug text-fg-faint">{absent}</dd>
      ) : (
        <dd className="mt-2">
          <span className="num text-[1.45rem] leading-none font-semibold text-fg sm:text-[1.6rem]">
            {measure.value}
          </span>
          {measure.unit === "" ? null : (
            <span className="ml-1 text-[0.78rem] text-fg-muted">{measure.unit}</span>
          )}
          {/* La date n'apparaît que si la mesure n'est pas du jour : sinon elle
              répéterait « aujourd'hui » sous chacune des trois valeurs. */}
          {measure.observedOn === null ? null : (
            <p className="mt-1 text-[0.72rem] leading-snug text-fg-faint">
              {measure.observedOn}
            </p>
          )}
        </dd>
      )}
    </div>
  );
}

export function WellnessTile({ wellness, className }: WellnessTileProps) {
  if (isWellnessTileEmpty(wellness)) {
    return (
      <MetricPlaceholder
        icon={HeartPulse}
        label="Bien-être"
        info={<MetricInfo id="hrv" />}
        title="Aucun relevé"
        description="HRV, FC de repos et sommeil sont mesurés par ta montre et rapatriés depuis intervals.icu. Il faut une clé API enregistrée, et une nuit portée."
        action={{ href: "/profile", label: "Régler intervals.icu" }}
        className={className}
      />
    );
  }

  return (
    <article
      className={cn(
        "rounded-card border border-border bg-surface p-4 transition-colors duration-150 ease-out hover:border-fg-faint/25 sm:p-5",
        className,
      )}
    >
      <h3 className="eyebrow">Bien-être</h3>
      <dl className="mt-3 grid grid-cols-3 gap-3 sm:gap-4">
        <Measure
          label="FC repos"
          info={<MetricInfo id="resting-hr" />}
          measure={wellness.restingHr}
          absent="pas de FC de repos"
        />
        <Measure
          label={wellness.hrvLabel}
          info={<MetricInfo id="hrv" />}
          measure={wellness.hrv}
          absent="pas de HRV"
        />
        <Measure label="Sommeil" measure={wellness.sleep} absent="pas de sommeil" />
      </dl>
    </article>
  );
}
