"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { requestFeedbackAction, type CoachFeedbackState } from "../_lib/coach-actions";

/**
 * Le seul îlot client du panneau « Coach » : un bouton, son état d'attente, et
 * le message d'échec de l'action. Le feedback lui-même est rendu côté serveur.
 *
 * L'attente n'est pas une seconde mais plusieurs minutes avec un modèle local :
 * le bouton se désactive et la page le dit, faute de quoi un écran silencieux
 * passerait pour un clic perdu.
 */

const INITIAL_STATE: CoachFeedbackState = { status: "idle" };

const PENDING_NOTE =
  "Le coach analyse ta séance — jusqu'à quelques minutes avec un modèle local.";

export type CoachFeedbackFormProps = {
  activityId: number;
  /** `regenerate` : un feedback existe déjà et sera remplacé. */
  mode: "create" | "regenerate";
};

export function CoachFeedbackForm({ activityId, mode }: CoachFeedbackFormProps) {
  const [state, formAction, isPending] = useActionState(
    requestFeedbackAction,
    INITIAL_STATE,
  );

  const regenerate = mode === "regenerate";
  const error = state.status === "error" ? state.message : undefined;

  return (
    <form
      action={formAction}
      // Centré dans l'état vide (qui l'est aussi), aligné à gauche de son bloc
      // dans le pied du feedback existant.
      className={cn(
        "flex min-w-0 flex-col gap-2",
        regenerate ? "items-start" : "items-center",
      )}
    >
      {/* L'identifiant transite par le formulaire : l'action le revalide. */}
      <input type="hidden" name="activityId" value={activityId} />

      <Button
        type="submit"
        variant={regenerate ? "ghost" : "secondary"}
        size="sm"
        disabled={isPending}
        aria-busy={isPending}
      >
        {isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
        {isPending ? "Analyse en cours…" : regenerate ? "Régénérer" : "Demander un feedback"}
      </Button>

      {/*
        Région live permanente : elle doit exister avant sa mise à jour pour que
        l'attente puis l'échec soient annoncés. Sans message, `sr-only` la sort
        du flux, donc de l'espacement du panneau.
      */}
      <p
        aria-live="polite"
        className={cn(
          "text-[0.74rem] leading-snug",
          error === undefined ? "text-fg-faint" : "text-negative",
          !isPending && error === undefined && "sr-only",
        )}
      >
        {isPending ? PENDING_NOTE : error}
      </p>
    </form>
  );
}
