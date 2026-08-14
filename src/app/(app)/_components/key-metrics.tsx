import { Gauge, HeartPulse } from "lucide-react";

import { StatCard } from "@/components/stat-card";
import type {
  FitnessDto,
  FitnessUnavailableDto,
  Vo2maxDto,
  Vo2maxUnavailableDto,
} from "@/data/dashboard";

import { formatLoad, formatVo2max } from "../_lib/format";
import { readTsb, toDelta } from "../_lib/metric-tone";
import {
  describeFitnessUnavailable,
  describeVo2maxUnavailable,
} from "../_lib/metric-unavailable";
import { MetricInfo } from "./metric-info";
import { MetricPlaceholder } from "./metric-placeholder";
import { WellnessTile } from "./wellness-tile";
import type { WellnessTileView } from "../_lib/wellness-view";

export type KeyMetricsProps = {
  fitness: FitnessDto | null;
  /** Cause réelle de l'absence de charge — non-`null` quand `fitness` l'est. */
  fitnessUnavailable: FitnessUnavailableDto | null;
  vo2max: Vo2maxDto | null;
  /** Cause réelle de l'absence de VO₂max — non-`null` quand `vo2max` l'est. */
  vo2maxUnavailable: Vo2maxUnavailableDto | null;
  /**
   * Les dernières mesures de la montre. `null` sans profil : la grille se
   * réduit alors à ce que l'onboarding permet de dire.
   */
  wellness: WellnessTileView | null;
  /** `false` quand aucun athlète n'existe encore : l'onboarding n'a pas eu lieu. */
  hasProfile: boolean;
};

export function KeyMetrics({
  fitness,
  fitnessUnavailable,
  vo2max,
  vo2maxUnavailable,
  wellness,
  hasProfile,
}: KeyMetricsProps) {
  const tsb = fitness ? readTsb(fitness.tsb) : null;

  /*
   * Sans profil du tout, la carte d'accueil en tête du tableau de bord porte
   * déjà l'invitation : répéter « Profil incomplet » ici ferait doublon. La
   * VO₂max, seule rescapée, prend alors toute la largeur.
   */
  const showLoadPlaceholder = hasProfile;
  const vo2maxSpan =
    fitness || showLoadPlaceholder
      ? "col-span-2 md:col-span-1"
      : "col-span-2 md:col-span-3";

  return (
    <section
      aria-label="Indicateurs clés"
      className="grid grid-cols-2 gap-3 md:grid-cols-3"
    >
      {vo2max ? (
        <StatCard
          label="VO₂max estimée"
          info={<MetricInfo id="vo2max" />}
          value={formatVo2max(vo2max.value)}
          delta={toDelta(vo2max.delta30d, 1, "negative")}
          className={fitness ? undefined : vo2maxSpan}
        />
      ) : (
        <MetricPlaceholder
          icon={Gauge}
          label="VO₂max estimée"
          info={<MetricInfo id="vo2max" />}
          className={vo2maxSpan}
          {...describeVo2maxUnavailable(vo2maxUnavailable)}
        />
      )}

      {fitness && tsb ? (
        <>
          <StatCard
            label="Fitness CTL"
            info={<MetricInfo id="ctl" />}
            value={formatLoad(fitness.ctl)}
            delta={toDelta(fitness.ctlDelta7d, 0, "warning")}
          />
          <StatCard
            label="Forme TSB"
            info={<MetricInfo id="tsb" />}
            value={formatLoad(fitness.tsb)}
            tone={tsb.tone}
            note={tsb.note}
            className={vo2max ? "col-span-2 md:col-span-1" : undefined}
          />
        </>
      ) : showLoadPlaceholder ? (
        <MetricPlaceholder
          icon={HeartPulse}
          label="Charge & forme"
          className="col-span-2"
          {...describeFitnessUnavailable(fitnessUnavailable)}
        />
      ) : null}

      {/* Deuxième rangée, pleine largeur : ces trois mesures-là ne sont pas
          calculées par l'application et n'ont pas à s'intercaler entre deux
          indicateurs qui le sont. Les tenir ensemble est aussi la seule façon de
          les lire (« HRV basse *et* FC de repos haute »). */}
      {wellness === null ? null : (
        <WellnessTile wellness={wellness} className="col-span-2 md:col-span-3" />
      )}
    </section>
  );
}
