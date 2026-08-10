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
};

export function KeyMetrics({ fitness, vo2max }: KeyMetricsProps) {
  const tsb = fitness ? readTsb(fitness.tsb) : null;

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
          className={fitness ? undefined : "col-span-2 md:col-span-1"}
        />
      ) : (
        <MetricPlaceholder
          icon={Gauge}
          label="VO₂max estimée"
          title="Pas encore d'effort de référence"
          description="Une sortie soutenue d'au moins 1,5 km dans les trente derniers jours suffit à estimer ta VO₂max."
          className="col-span-2 md:col-span-1"
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
      ) : (
        <MetricPlaceholder
          icon={HeartPulse}
          label="Charge & forme"
          title="Profil incomplet"
          description="La charge (CTL, ATL, TSB) se calcule à partir de ta FC max, de ta FC de repos et de ton sexe — les coefficients du modèle en dépendent."
          className="col-span-2"
        />
      )}
    </section>
  );
}
