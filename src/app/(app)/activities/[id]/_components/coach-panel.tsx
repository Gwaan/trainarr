import { MessageSquareQuote } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { MarkdownLite } from "@/components/markdown-lite";
import { Panel } from "@/components/panel";
import { Skeleton } from "@/components/ui/skeleton";
import type { ActivityFeedbackDto } from "@/data/activity-feedback";
import type { AiAvailability } from "@/lib/ai/availability";
import type { AiUnavailableReason } from "@/lib/ai/errors";

import { COACH_UNAVAILABLE } from "../_lib/coach-messages";
import { formatDateTimeStamp } from "../_lib/format-detail";
import { CoachFeedbackForm } from "./coach-feedback-form";

/**
 * Regard du coach IA sur la séance.
 *
 * Trois situations, un seul panneau :
 * - un feedback existe → il est rendu, **toujours**, que le coach réponde ou non
 *   aujourd'hui ; seule sa régénération dépend de la disponibilité ;
 * - aucun feedback et coach joignable → une phrase et un bouton ;
 * - aucun feedback et coach injoignable → une note qui dit pourquoi, sans bouton
 *   mort. Ce n'est pas une panne de l'application : l'écran ne s'excuse pas sur
 *   toute sa hauteur, il l'indique en une ligne.
 */

export type CoachPanelProps = {
  activityId: number;
  feedback: ActivityFeedbackDto | null;
  availability: AiAvailability;
};

export function CoachPanel({ activityId, feedback, availability }: CoachPanelProps) {
  return (
    <Panel title="Coach">
      {feedback === null ? (
        <NoFeedback activityId={activityId} availability={availability} />
      ) : (
        <>
          <MarkdownLite source={feedback.content} />

          <footer className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3">
            <p className="text-[0.72rem] text-fg-faint">
              Généré le{" "}
              <span className="num">{formatDateTimeStamp(new Date(feedback.createdAt))}</span>
              {feedback.model === null ? null : (
                <>
                  {" · "}
                  <span className="num">{feedback.model}</span>
                </>
              )}
            </p>

            {availability.available ? (
              <CoachFeedbackForm activityId={activityId} mode="regenerate" />
            ) : (
              <UnavailableNote reason={availability.reason} />
            )}
          </footer>
        </>
      )}
    </Panel>
  );
}

/** Coach joignable : on propose. Sinon : on explique. */
function NoFeedback({
  activityId,
  availability,
}: {
  activityId: number;
  availability: AiAvailability;
}) {
  if (!availability.available) {
    return (
      <div className="py-1">
        <UnavailableNote reason={availability.reason} />
      </div>
    );
  }

  return (
    <EmptyState
      icon={MessageSquareQuote}
      title="Pas encore de feedback"
      description="Demande au coach son regard sur cette séance : allure, cardio, comparaison avec tes sorties similaires."
      // Compact : c'est un panneau parmi d'autres, pas un écran vide.
      action={<CoachFeedbackForm activityId={activityId} mode="create" />}
      className="px-0 py-4 sm:py-6"
    />
  );
}

function UnavailableNote({ reason }: { reason: AiUnavailableReason }) {
  return (
    <p className="text-[0.74rem] leading-snug text-fg-faint">{COACH_UNAVAILABLE[reason]}</p>
  );
}

/** Squelette du panneau, à la géométrie de son état le plus courant (un feedback). */
export function CoachPanelSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement du feedback du coach"
      className="rounded-card border border-border bg-surface"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="flex flex-col gap-2.5 p-4 sm:p-5">
        <Skeleton className="h-3.5 w-52 max-w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-9/12" />
      </div>
    </div>
  );
}
