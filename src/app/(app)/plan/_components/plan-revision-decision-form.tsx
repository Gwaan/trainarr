"use client";

import { useActionState } from "react";
import { Check, Loader2, X } from "lucide-react";

import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";

import {
  acceptPlanRevisionAction,
  rejectPlanRevisionAction,
  type PlanRevisionDecisionState,
} from "../_lib/actions";

/**
 * Les deux issues d'une réévaluation proposée : l'accepter, ou la refuser.
 *
 * Même forme que {@link PlanDecisionForm} — deux formulaires distincts plutôt
 * qu'un champ « décision », parce que ce sont deux opérations différentes sur
 * deux Server Actions différentes, et qu'aucune ne doit pouvoir se déclencher à
 * la place de l'autre. Chacune porte l'identifiant de la réévaluation ; l'action
 * le revalide, son endpoint étant public, et le DAL vérifie qu'il désigne bien
 * la proposition en attente de l'athlète.
 *
 * « Accepter » est le CTA accent de ce bloc. Le refus reste en ghost : refuser
 * n'est pas une action destructrice à mettre en garde, c'est le statu quo.
 */

const INITIAL_STATE: PlanRevisionDecisionState = { status: "idle" };

const GENERIC_FAILURE = "La décision n'a pas pu être enregistrée.";

export function PlanRevisionDecisionForm({ revisionId }: { revisionId: number }) {
  const [acceptState, acceptAction, isAccepting] = useActionState(
    acceptPlanRevisionAction,
    INITIAL_STATE,
  );
  const [rejectState, rejectAction, isRejecting] = useActionState(
    rejectPlanRevisionAction,
    INITIAL_STATE,
  );

  // Une décision en cours verrouille l'autre : accepter et refuser la même
  // réévaluation en parallèle n'a pas de sens, et la seconde échouerait de toute
  // façon sur une proposition qui n'existe plus.
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
          <input type="hidden" name="revisionId" value={revisionId} />
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
            {isAccepting ? "Application…" : "Accepter la réévaluation"}
          </Button>
        </form>

        <form action={rejectAction} className="contents">
          <input type="hidden" name="revisionId" value={revisionId} />
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
            {isRejecting ? "Suppression…" : "Garder mon plan"}
          </Button>
        </form>
      </div>

      <p className="text-[0.78rem] leading-relaxed text-fg-faint">
        Accepter remplace les séances à venir non encore réalisées par celles proposées
        ci-dessus, et republie ton calendrier. Refuser ne change rien — ton plan actuel
        continue, et le coach ne te reproposera pas la même chose.
      </p>
    </div>
  );
}
