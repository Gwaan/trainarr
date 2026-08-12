import type { LucideIcon } from "lucide-react";
import { ChevronDown, CircleCheck, CircleDashed, CircleDot } from "lucide-react";

import type { PlanSessionDto } from "@/data/plans";
import { cn } from "@/lib/utils";

import { formatSessionDay } from "../_lib/format-plan";
import { planSessionState, type PlanSessionState } from "../_lib/plan-weeks";
import { planSessionDetail, planSessionSummary } from "../_lib/session-detail";

import { PlanSessionDetailPanel } from "./plan-session-detail";

/**
 * Une séance du plan, dépliable sur son déroulé.
 *
 * `<details>` natif plutôt qu'un état React : le dépliage est clavier et lecteur
 * d'écran d'origine (le `summary` annonce son état), et la page reste
 * entièrement rendue côté serveur. La séance du jour s'ouvre d'office — sur
 * téléphone, c'est elle qu'on vient lire.
 *
 * Son état se lit à trois endroits qui se doublent : la pastille nommée
 * (jamais une couleur seule), le filet accent du jour, l'atténuation d'une
 * séance manquée.
 */

const STATE_BADGES: Record<
  PlanSessionState,
  { label: string; icon: LucideIcon; className: string } | null
> = {
  completed: { label: "Réalisée", icon: CircleCheck, className: "text-positive" },
  today: { label: "Aujourd'hui", icon: CircleDot, className: "text-accent" },
  // Une séance passée sans activité rapprochée n'a pas eu lieu. Ce n'est pas une
  // alerte physiologique : elle reste en gris, pas en `warning`.
  missed: { label: "Manquée", icon: CircleDashed, className: "text-fg-faint" },
  upcoming: null,
};

export function PlanSessionRow({
  session,
  today,
  maxHrBpm,
}: {
  session: PlanSessionDto;
  today: string;
  /**
   * FC max du profil, `null` tant qu'elle n'est pas saisie — elle traduit les
   * zones cardiaques des étapes en battements. Résolue à l'affichage, jamais
   * stockée dans la séance : une correction du profil suit tout le plan.
   */
  maxHrBpm: number | null;
}) {
  const state = planSessionState(session, today);
  const isToday = state === "today";
  const badge = STATE_BADGES[state];

  const detail = planSessionDetail(session, maxHrBpm);
  const summary = planSessionSummary(session, maxHrBpm);
  // Rien à révéler : ni déroulé, ni consigne, ni activité à rejoindre.
  const isExpandable = !detail.isEmpty || session.completedActivityId !== null;

  const heading = (
    <>
      <span
        className={cn(
          "num w-[3.9rem] shrink-0 pt-0.5 text-[0.78rem]",
          isToday ? "text-accent" : "text-fg-faint",
        )}
      >
        {isToday ? <span className="sr-only">Aujourd&apos;hui, </span> : null}
        {formatSessionDay(session.scheduledOn)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="eyebrow">{session.kind}</span>
          {badge === null ? null : (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[0.62rem] font-medium tracking-[0.08em] uppercase",
                badge.className,
              )}
            >
              <badge.icon aria-hidden="true" strokeWidth={2} className="size-3" />
              {badge.label}
            </span>
          )}
        </span>

        <span className="mt-1 block text-[0.9rem] leading-snug font-medium text-fg">
          {session.title}
        </span>

        {summary.length > 0 ? (
          <span className="num mt-1.5 block text-[0.78rem] text-fg-muted">
            {summary.join(" · ")}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <li
      className={cn(
        "border-b border-border last:border-b-0",
        isToday && "border-l-2 border-l-accent",
        // Lisible, mais elle ne dispute pas l'attention aux séances à venir.
        state === "missed" && "opacity-70",
      )}
    >
      {isExpandable ? (
        <details open={isToday} className="group/session">
          <summary
            className={cn(
              "flex cursor-pointer list-none gap-3 px-4 py-3 sm:px-5",
              "transition-colors duration-150 ease-out hover:bg-surface-2",
              "[&::-webkit-details-marker]:hidden",
              isToday && "bg-accent-soft",
            )}
          >
            {heading}
            <ChevronDown
              aria-hidden="true"
              strokeWidth={1.8}
              className="mt-0.5 size-4 shrink-0 text-fg-faint transition-transform duration-150 ease-out group-open/session:rotate-180"
            />
          </summary>

          <PlanSessionDetailPanel
            detail={detail}
            completedActivityId={session.completedActivityId}
          />
        </details>
      ) : (
        <div className={cn("flex gap-3 px-4 py-3 sm:px-5", isToday && "bg-accent-soft")}>
          {heading}
          {/* Réserve la gouttière du chevron : les titres s'alignent d'une
              ligne à l'autre, qu'elle soit dépliable ou non. */}
          <span aria-hidden="true" className="size-4 shrink-0" />
        </div>
      )}
    </li>
  );
}
