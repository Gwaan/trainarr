import { ChartSpline } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";
import { Sparkline } from "@/components/sparkline";
import type { LoadWeekDto } from "@/data/dashboard";

import { formatLoad } from "../_lib/format";
import { MetricInfo } from "./metric-info";

const PANEL_TITLE = "Charge d'entraînement";
const PANEL_SPAN = "lg:col-span-3";

export function TrainingLoadPanel({ weeks }: { weeks: LoadWeekDto[] }) {
  // Une courbe demande deux points : avec moins, `Sparkline` ne rend rien et le
  // panneau resterait un cadre vide.
  if (weeks.length < 2) {
    return (
      <Panel title={PANEL_TITLE} padded={false} className={PANEL_SPAN}>
        <EmptyState
          className="my-auto"
          icon={ChartSpline}
          title="Pas encore de courbe de charge"
          description="Il faut au moins deux semaines d'activités pour tracer l'évolution de ta charge chronique."
        />
      </Panel>
    );
  }

  const series = weeks.map((week) => week.ctl);
  const first = formatLoad(series[0]);
  const last = formatLoad(series[series.length - 1]);

  return (
    <Panel
      title={PANEL_TITLE}
      info={<MetricInfo id="ctl" />}
      meta={<span className="num">{weeks.length} semaines</span>}
      className={PANEL_SPAN}
    >
      <Sparkline
        className="max-h-72 min-h-32 flex-1 sm:min-h-40"
        data={series}
        label={`Charge chronique (CTL) sur ${weeks.length} semaines, de ${first} à ${last}`}
      />
      <div className="mt-3 flex justify-between">
        {weeks.map((week) => (
          <span key={week.weekLabel} className="eyebrow num">
            {week.weekLabel}
          </span>
        ))}
      </div>
      <p className="mt-4 border-t border-border pt-3 text-[0.78rem] leading-snug text-fg-faint md:mt-auto">
        CTL — charge d&apos;entraînement chronique, lissée sur 42 jours.
      </p>
    </Panel>
  );
}
