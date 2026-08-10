import Link from "next/link";
import { Moon, Play } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import type { PlannedSessionDto } from "@/data/dashboard";
import { cn } from "@/lib/utils";

import {
  capitalize,
  formatDistance,
  formatDuration,
  formatPace,
  formatRelativeDay,
  parseCivilDate,
} from "../_lib/format";

const PANEL_TITLE = "Séance du jour";
const PANEL_SPAN = "lg:col-span-2";

function sessionDay(scheduledOn: string): string | null {
  const date = parseCivilDate(scheduledOn);
  return date ? capitalize(formatRelativeDay(date)) : null;
}

export function TodaySessionPanel({ session }: { session: PlannedSessionDto | null }) {
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
      <p className="eyebrow">{session.kind}</p>

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
