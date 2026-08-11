import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

import { formatDistance } from "../../_lib/format";
import type { PlanWeekView } from "../_lib/plan-weeks";

import { PlanSessionRow } from "./plan-session-row";

/**
 * Une semaine du plan, dans une carte repliable.
 *
 * `<details>` plutôt qu'un état React : le repli des semaines passées est du
 * ressort du navigateur, et cette page reste ainsi entièrement rendue côté
 * serveur. Les semaines à venir et celle en cours s'ouvrent d'office — sur
 * téléphone, c'est la semaine courante qui doit être lisible sans un geste.
 */
export function PlanWeekCard({ week, today }: { week: PlanWeekView; today: string }) {
  return (
    <details
      open={week.status !== "past"}
      className={cn(
        "group overflow-hidden rounded-card border border-border bg-surface",
        week.status === "past" && "opacity-70",
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 sm:px-5",
          "transition-colors duration-150 ease-out hover:bg-surface-2",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={cn("eyebrow", week.status === "current" && "text-fg")}>
            Semaine {week.number}
          </span>
          <span className="num text-[0.7rem] text-fg-faint">{week.label}</span>
          {week.status === "current" ? (
            <span className="rounded-[6px] bg-accent-soft px-1.5 py-0.5 text-[0.62rem] font-medium tracking-[0.08em] text-accent uppercase">
              Cette semaine
            </span>
          ) : null}
        </span>

        <span className="flex shrink-0 items-center gap-2.5 text-[0.7rem] text-fg-faint">
          {week.totalVolumeM === null ? null : (
            <span className="num text-fg-muted">{formatDistance(week.totalVolumeM)}</span>
          )}
          <ChevronDown
            aria-hidden="true"
            strokeWidth={1.8}
            className="size-4 transition-transform duration-150 ease-out group-open:rotate-180"
          />
        </span>
      </summary>

      {week.sessions.length > 0 ? (
        <ul className="border-t border-border">
          {week.sessions.map((session) => (
            <PlanSessionRow key={session.id} session={session} today={today} />
          ))}
        </ul>
      ) : (
        <p className="border-t border-border px-4 py-5 text-center text-[0.82rem] text-fg-faint sm:px-5">
          Aucune séance cette semaine — repos complet.
        </p>
      )}
    </details>
  );
}
