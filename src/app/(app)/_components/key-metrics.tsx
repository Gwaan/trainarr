import { Gauge, HeartPulse } from "lucide-react";

import { StatCard, type StatDelta, type StatTone } from "@/components/stat-card";
import type { FitnessDto, Vo2maxDto } from "@/data/dashboard";

import { formatLoad, formatNumber, formatVo2max } from "../_lib/format";
import { MetricPlaceholder } from "./metric-placeholder";

/**
 * Variation affichée à côté de la valeur. `undefined` quand il n'y a pas de
 * point de comparaison ou que l'écart est nul après arrondi : une flèche « 0 »
 * suggérerait une stagnation mesurée qui n'en est pas une.
 */
function toDelta(
  value: number | null,
  fractionDigits: number,
  downTone: Extract<StatTone, "warning" | "negative">,
): StatDelta | undefined {
  if (value === null) return undefined;

  const formatted = formatNumber(Math.abs(value), fractionDigits);
  if (Number(formatted.replace(",", ".")) === 0) return undefined;

  return {
    value: formatted,
    direction: value > 0 ? "up" : "down",
    tone: value > 0 ? "positive" : downTone,
  };
}

/**
 * Lecture qualitative du TSB (bandes usuelles de la méthode Coggan). Le chiffre
 * affiché reste celui calculé par `lib/metrics` — ceci n'en est qu'une glose.
 */
function readTsb(tsb: number): { tone: StatTone; note: string } {
  if (tsb <= -30) return { tone: "negative", note: "Fatigue marquée." };
  if (tsb <= -10) return { tone: "warning", note: "En charge — zone de progression." };
  if (tsb < 5) return { tone: "default", note: "Charge et forme équilibrées." };
  return { tone: "positive", note: "Frais, bien récupéré." };
}

export type KeyMetricsProps = {
  fitness: FitnessDto | null;
  vo2max: Vo2maxDto | null;
  /** `false` quand aucun athlète n'existe encore : l'onboarding n'a pas eu lieu. */
  hasProfile: boolean;
};

export function KeyMetrics({ fitness, vo2max, hasProfile }: KeyMetricsProps) {
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
          value={formatVo2max(vo2max.value)}
          delta={toDelta(vo2max.delta30d, 1, "negative")}
          className={fitness ? undefined : vo2maxSpan}
        />
      ) : (
        <MetricPlaceholder
          icon={Gauge}
          label="VO₂max estimée"
          title="Pas encore d'effort de référence"
          description="Une sortie soutenue d'au moins 1,5 km dans les trente derniers jours suffit à estimer ta VO₂max."
          className={vo2maxSpan}
        />
      )}

      {fitness && tsb ? (
        <>
          <StatCard
            label="Fitness CTL"
            value={formatLoad(fitness.ctl)}
            delta={toDelta(fitness.ctlDelta7d, 0, "warning")}
          />
          <StatCard
            label="Forme TSB"
            value={formatLoad(fitness.tsb)}
            tone={tsb.tone}
            note={tsb.note}
            className={vo2max ? "col-span-2 md:col-span-1" : undefined}
          />
        </>
      ) : showLoadPlaceholder ? (
        /*
         * Le composant ne reçoit qu'un `fitness` absent : il ne sait pas si le
         * profil est incomplet, si aucune séance n'est importée, ou si aucune
         * ne porte de fréquence cardiaque. Le message énonce donc les deux
         * conditions sans accuser l'athlète d'en avoir manqué une.
         */
        <MetricPlaceholder
          icon={HeartPulse}
          label="Charge & forme"
          title="Charge indisponible"
          description="La charge (CTL, ATL, TSB) se calcule dès que ton profil est complet — FC max, FC repos, sexe — et que des séances avec fréquence cardiaque sont importées."
          className="col-span-2"
        />
      ) : null}
    </section>
  );
}
