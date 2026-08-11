"use client";

import { useActionState } from "react";
import { Check, Loader2, X } from "lucide-react";

import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";

import {
  acceptPlanAction,
  rejectPlanAction,
  type PlanDecisionState,
} from "../_lib/actions";

/**
 * Les deux issues d'une proposition du coach : l'adopter, ou la refuser.
 *
 * Deux formulaires distincts plutôt qu'un seul avec un champ « décision » : ce
 * sont deux opérations différentes, sur deux Server Actions différentes, et
 * aucune ne doit pouvoir se déclencher à la place de l'autre. Chacune porte
 * l'identifiant de la proposition — l'action le revalide, son endpoint étant
 * public, et le DAL vérifie qu'il désigne bien un brouillon de l'athlète.
 *
 * « Adopter » est le seul CTA accent de cet écran : le refus reste en ghost, et
 * les actions du plan en cours affiché plus bas sont en secondary/ghost.
 */

const INITIAL_STATE: PlanDecisionState = { status: "idle" };

const GENERIC_FAILURE = "La décision n'a pas pu être enregistrée.";

export function PlanDecisionForm({
  planId,
  /** Un plan actif sera archivé par l'adoption : il faut le dire avant le clic. */
  replacesActivePlan,
}: {
  planId: number;
  replacesActivePlan: boolean;
}) {
  const [acceptState, acceptAction, isAccepting] = useActionState(
    acceptPlanAction,
    INITIAL_STATE,
  );
  const [rejectState, rejectAction, isRejecting] = useActionState(
    rejectPlanAction,
    INITIAL_STATE,
  );

  // Une décision en cours verrouille l'autre : adopter et refuser la même
  // proposition en parallèle n'a pas de sens, et la seconde échouerait de toute
  // façon sur un brouillon qui n'existe plus.
  const isPending = isAccepting || isRejecting;
  const failed = acceptState.status === "error" || rejectState.status === "error";
  const failure = failed
    ? (acceptState.message ?? rejectState.message ?? GENERIC_FAILURE)
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite" className={failure === null ? "sr-only" : undefined}>
        {failure === null ? null : <Banner tone="negative" title={failure} />}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <form action={acceptAction} className="contents">
          <input type="hidden" name="planId" value={planId} />
          <Button
            type="submit"
            size="lg"
            disabled={isPending}
            aria-busy={isAccepting}
            className="w-full sm:w-auto"
          >
            {isAccepting ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {isAccepting ? "Adoption…" : "Adopter ce plan"}
          </Button>
        </form>

        <form action={rejectAction} className="contents">
          <input type="hidden" name="planId" value={planId} />
          <Button
            type="submit"
            variant="ghost"
            size="lg"
            disabled={isPending}
            aria-busy={isRejecting}
            className="w-full sm:w-auto"
          >
            {isRejecting ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <X aria-hidden="true" />
            )}
            {isRejecting ? "Suppression…" : "Refuser"}
          </Button>
        </form>
      </div>

      <p className="text-[0.78rem] leading-relaxed text-fg-faint">
        {replacesActivePlan
          ? "Adopter cette proposition archive ton plan en cours : ses séances à venir non encore réalisées quittent le calendrier. La refuser ne change rien — ton plan actuel continue."
          : "Rien n'est engagé tant que tu n'as pas adopté cette proposition. La refuser l'efface, et tu pourras en demander une autre."}
      </p>
    </div>
  );
}
