import { Gauge } from "@/components/chart/gauge";
import { STAT_CARD_SURFACE, StatCard } from "@/components/stat-card";
import { buildGaugeModel } from "@/lib/chart/gauge";
import { cn } from "@/lib/utils";

import { formatLoad } from "../_lib/format";
import { TSB_GAUGE_BANDS, TSB_GAUGE_DOMAIN, readTsb } from "../_lib/metric-tone";
import { MetricInfo } from "./metric-info";

/**
 * La tuile de forme (TSB), en jauge.
 *
 * Partagée par le tableau de bord et la page « Progression » : les deux
 * affichent le même chiffre, ils doivent en donner la **même** lecture — même
 * échelle, mêmes bandes, même glose (cf. `_lib/metric-tone`). Seul le libellé
 * diffère, chaque page nommant l'indicateur comme le reste de sa grille.
 *
 * Un TSB n'a pas d'échelle naturelle : « −12 » ne dit rien à qui ne connaît pas
 * les bandes de Coggan. La jauge les montre, ce que la tuile chiffrée ne
 * pouvait faire qu'en couleur.
 */
export function TsbGauge({
  tsb,
  label,
  className,
}: {
  tsb: number;
  /** « Forme TSB » sur le tableau de bord, « Fraîcheur TSB » sur Progression. */
  label: string;
  className?: string;
}) {
  const reading = readTsb(tsb);
  const value = formatLoad(tsb);
  const info = <MetricInfo id="tsb" />;

  const model = buildGaugeModel({
    value: tsb,
    min: TSB_GAUGE_DOMAIN.min,
    max: TSB_GAUGE_DOMAIN.max,
    bands: TSB_GAUGE_BANDS,
  });

  // Le domaine est fixe et non dégénéré : le modèle ne peut manquer que sur un
  // TSB non fini, qui n'a alors rien à faire dans une jauge. La tuile chiffrée
  // reste la façon honnête de l'afficher.
  if (model === null) {
    return (
      <StatCard
        label={label}
        info={info}
        value={value}
        tone={reading.tone}
        note={reading.note}
        className={className}
      />
    );
  }

  // La note vient de la **bande allumée**, jamais d'une glose calculée à côté :
  // c'est la seule façon que le dessin et la phrase ne se contredisent pas sur
  // une valeur posée pile sur une borne (cf. `_lib/metric-tone`).
  //
  // Une valeur hors de l'échelle est posée sur la borne (`clamped`) : sans le
  // dire, un TSB de +40 se lirait « +40 » avec l'aiguille de +20, comme si la
  // reprise après blessure tombait juste au bout de l'arc.
  const note = model.clamped
    ? `${model.activeBand.label} Hors échelle — l'aiguille est posée sur la borne.`
    : model.activeBand.label;

  return (
    <article className={cn(STAT_CARD_SURFACE, className)}>
      <Gauge
        model={model}
        value={value}
        label={label}
        info={info}
        note={note}
        // La note **est** la lecture de la bande allumée : la répéter sous un
        // autre nom ferait bégayer l'annonce.
        ariaLabel={`${label} : ${value}. ${note}`}
      />
    </article>
  );
}
