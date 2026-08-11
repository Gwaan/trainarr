import { ChevronDown, Moon } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";

import { formatWeekSummary, type PlanWeekView } from "../_lib/plan-weeks";

import { PlanSessionRow } from "./plan-session-row";

/**
 * Une semaine du plan, dans une carte repliable.
 *
 * `<details>` plutôt qu'un état React : le repli est du ressort du navigateur,
 * et cette page reste ainsi entièrement rendue côté serveur. L'ouverture par
 * défaut est calculée dans `plan-weeks` — sur téléphone, une pile de douze
 * semaines ouvertes n'est pas lisible.
 *
 * La semaine en cours se distingue par son filet accent et son en-tête surélevé,
 * sans rien emprunter au CTA de la page : c'est la même grammaire que l'item
 * actif de la navigation.
 */
export function PlanWeekCard({ week, today }: { week: PlanWeekView; today: string }) {
  const isCurrent = week.status === "current";
  const summary = formatWeekSummary(week);

  return (
    <details
      open={week.expanded}
      className={cn(
        "group overflow-hidden rounded-card border border-border bg-surface",
        isCurrent && "border-l-2 border-l-accent",
        week.status === "past" && "opacity-70",
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 sm:px-5",
          "transition-colors duration-150 ease-out hover:bg-surface-2",
          "[&::-webkit-details-marker]:hidden",
          isCurrent && "bg-accent-soft",
        )}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={cn("eyebrow", isCurrent && "text-fg")}>
              Semaine {week.number}
            </span>
            <span className="num text-[0.7rem] text-fg-faint">{week.label}</span>
            {isCurrent ? (
              <span className="rounded-[6px] bg-accent-soft px-1.5 py-0.5 text-[0.62rem] font-medium tracking-[0.08em] text-accent uppercase">
                Cette semaine
              </span>
            ) : null}
          </span>

          {summary === null ? null : (
            <span className="num text-[0.74rem] text-fg-muted">{summary}</span>
          )}
        </span>

        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.8}
          className="mt-0.5 size-4 shrink-0 text-fg-faint transition-transform duration-150 ease-out group-open:rotate-180"
        />
      </summary>

      {week.sessions.length > 0 ? (
        <ul className="border-t border-border">
          {week.sessions.map((session) => (
            <PlanSessionRow key={session.id} session={session} today={today} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={Moon}
          title="Semaine de repos"
          description="Aucune séance planifiée : le plan laisse la semaine libre."
          // Compact : c'est une carte parmi douze, pas un écran vide.
          className="border-t border-border px-4 py-8 sm:py-10"
        />
      )}
    </details>
  );
}
