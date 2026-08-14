import Link from "next/link";
import { Moon, Play } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";
import { SessionTypeLabel } from "@/components/session-type";
import { Button } from "@/components/ui/button";
import type { PlannedSessionDto } from "@/data/dashboard";
import type { WeatherForecastDto } from "@/data/weather-forecast";
import { cn } from "@/lib/utils";

import {
  capitalize,
  formatDistance,
  formatDuration,
  formatPace,
  formatRelativeDay,
  parseCivilDate,
} from "../_lib/format";

import { SessionForecast } from "./session-forecast";

const PANEL_TITLE = "Séance du jour";
const PANEL_SPAN = "lg:col-span-2";

function sessionDay(scheduledOn: string): string | null {
  const date = parseCivilDate(scheduledOn);
  return date ? capitalize(formatRelativeDay(date)) : null;
}

export function TodaySessionPanel({
  session,
  forecast,
  today,
}: {
  session: PlannedSessionDto | null;
  /** Le relevé du matin, tel que le DAL le rend. */
  forecast: WeatherForecastDto;
  /** Jour courant, date civile calculée côté serveur dans le fuseau de l'athlète. */
  today: string;
}) {
  if (!session) {
    return (
      <Panel title={PANEL_TITLE} padded={false} className={PANEL_SPAN}>
        <EmptyState
          className="my-auto"
          icon={Moon}
          title="Aucune séance prévue aujourd'hui"
          description="Journée libre : repos, mobilité, ou une sortie facile si l'envie est là."
          action={
            <Button variant="secondary" asChild>
              <Link href="/plan">Voir le plan</Link>
            </Button>
          }
        />
      </Panel>
    );
  }

  const day = sessionDay(session.scheduledOn);

  const details = [
    { label: "Échauffement", value: session.warmup },
    { label: "Récupération", value: session.recovery },
    { label: "Retour au calme", value: session.cooldown },
  ].filter((detail): detail is { label: string; value: string } => detail.value !== null);

  const summary = [
    session.volumeM !== null
      ? { label: "Volume", value: formatDistance(session.volumeM) }
      : null,
    session.durationS !== null
      ? { label: "Durée", value: formatDuration(session.durationS) }
      : null,
  ].filter((item) => item !== null);

  return (
    <Panel
      title={PANEL_TITLE}
      meta={day ? <span className="num">{day}</span> : undefined}
      className={PANEL_SPAN}
    >
      {/* Le type, écrit et précédé de sa puce de couleur — la même grammaire que
          la ligne de séance du plan. Aucun filet ici : le panneau n'en a pas, et
          la puce est le véhicule prévu par le système pour ce cas. */}
      <SessionTypeLabel kind={session.kind} />

      <p className="mt-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="num text-[1.7rem] leading-none font-semibold text-fg">
          {session.title}
        </span>
        {session.targetPaceSecPerKm !== null ? (
          <span className="num text-[1.05rem] leading-none font-semibold text-accent">
            @ {formatPace(session.targetPaceSecPerKm)}
          </span>
        ) : null}
      </p>

      {details.length > 0 ? (
        <dl className="mt-4 border-t border-border">
          {details.map((detail) => (
            <div
              key={detail.label}
              className="flex items-baseline justify-between gap-3 border-b border-border py-2.5"
            >
              <dt className="text-[0.82rem] text-fg-muted">{detail.label}</dt>
              <dd className="num text-[0.82rem] text-fg">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {summary.length > 0 ? (
        <div
          className={cn(
            "mt-4 grid gap-2",
            summary.length > 1 ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {summary.map((item) => (
            <div key={item.label} className="rounded-button bg-surface-2 px-3 py-2">
              <p className="eyebrow">{item.label}</p>
              <p className="num mt-1.5 text-[0.95rem] font-semibold text-fg">
                {item.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {/* La météo ferme le bloc d'information : c'est du contexte pour la séance,
          pas une consigne d'entraînement. Elle passe donc après les allures, les
          volumes et le déroulé — et avant le seul CTA de l'écran. */}
      <div className="mt-4">
        <SessionForecast forecast={forecast} date={session.scheduledOn} today={today} />
      </div>

      {/* Pousse le CTA en pied de panneau quand la séance est peu détaillée. */}
      <div className="flex-1" />

      {/* Suivi de séance non implémenté : bouton désactivé plutôt qu'un lien mort. */}
      <Button size="lg" disabled className="mt-5 w-full">
        <Play aria-hidden="true" className="size-4 fill-current" />
        Démarrer la séance
      </Button>
    </Panel>
  );
}
