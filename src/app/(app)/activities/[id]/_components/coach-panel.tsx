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
import { CoachFeedbackSkeleton } from "./coach-feedback-skeleton";

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
 *
 * Le contenu est rendu ici, côté serveur, y compris quand il passe en `children`
 * de l'îlot client : celui-ci ne porte que l'attente de la génération.
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
        <ExistingFeedback
          activityId={activityId}
          feedback={feedback}
          availability={availability}
        />
      )}
    </Panel>
  );
}

/**
 * Un feedback est en base : il s'affiche quoi qu'il arrive. Coach joignable, il
 * passe sous l'îlot client qui saura le remplacer par un squelette le temps de
 * la régénération ; injoignable, le pied dit simplement pourquoi.
 */
function ExistingFeedback({
  activityId,
  feedback,
  availability,
}: {
  activityId: number;
  feedback: ActivityFeedbackDto;
  availability: AiAvailability;
}) {
  const body = <MarkdownLite source={feedback.content} />;
  const meta = <GeneratedAt feedback={feedback} />;

  if (availability.available) {
    return (
      <CoachFeedbackForm activityId={activityId} mode="regenerate" meta={meta}>
        {body}
      </CoachFeedbackForm>
    );
  }

  return (
    <>
      {body}
      {/* Même pied que le mode `regenerate` de `coach-feedback-form.tsx`. */}
      <footer className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3">
        {meta}
        <UnavailableNote reason={availability.reason} />
      </footer>
    </>
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
    <CoachFeedbackForm activityId={activityId} mode="create">
      <EmptyState
        icon={MessageSquareQuote}
        title="Pas encore de feedback"
        description="Demande au coach son regard sur cette séance : allure, cardio, comparaison avec tes sorties similaires."
        // Compact : c'est un panneau parmi d'autres, pas un écran vide. Le bouton
        // et la respiration verticale vivent hors de l'état vide, que le squelette
        // d'attente remplace en bloc.
        className="px-0 py-0 sm:py-0"
      />
    </CoachFeedbackForm>
  );
}

/** Provenance du texte affiché : quand il a été écrit, et par quel modèle. */
function GeneratedAt({ feedback }: { feedback: ActivityFeedbackDto }) {
  return (
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
      <CoachFeedbackSkeleton className="p-4 sm:p-5" />
    </div>
  );
}
