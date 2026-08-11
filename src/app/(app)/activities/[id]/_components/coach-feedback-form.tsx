"use client";

import { useActionState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { requestFeedbackAction, type CoachFeedbackState } from "../_lib/coach-actions";
import { CoachFeedbackSkeleton } from "./coach-feedback-skeleton";

/**
 * Îlot client du panneau « Coach » : il porte la demande, l'attente et l'échec
 * de l'action — jamais le contenu. Le feedback (ou l'état vide) reste rendu côté
 * serveur et lui arrive en `children` ; l'îlot se contente de lui substituer un
 * squelette pendant la génération.
 *
 * L'attente n'est pas une seconde mais plusieurs minutes avec un modèle local :
 * un bouton grisé ne suffit pas. La zone où le feedback atterrira montre qu'un
 * texte s'écrit (squelette + `aria-busy`), et la région live dit pourquoi c'est
 * long — faute de quoi un écran silencieux passerait pour un clic perdu.
 */

const INITIAL_STATE: CoachFeedbackState = { status: "idle" };

const PENDING_NOTE =
  "Le coach analyse ta séance — jusqu'à quelques minutes avec un modèle local.";

export type CoachFeedbackFormProps = {
  activityId: number;
  /** `regenerate` : un feedback existe déjà et sera remplacé. */
  mode: "create" | "regenerate";
  /** Contenu au repos, rendu côté serveur : le feedback existant ou l'état vide. */
  children: ReactNode;
  /**
   * Ligne « Généré le… » du pied (mode `regenerate`). Masquée pendant l'attente :
   * elle décrit le feedback affiché, or celui-ci a cédé la place au squelette.
   */
  meta?: ReactNode;
};

export function CoachFeedbackForm({
  activityId,
  mode,
  children,
  meta,
}: CoachFeedbackFormProps) {
  const [state, formAction, isPending] = useActionState(
    requestFeedbackAction,
    INITIAL_STATE,
  );

  const regenerate = mode === "regenerate";
  const error = state.status === "error" ? state.message : undefined;

  const actions = (
    <div
      // Aligné à gauche de son bloc dans le pied d'un feedback existant, centré
      // sous l'état vide (qui l'est aussi). `text-center` est nécessaire ici :
      // le formulaire n'est plus un enfant de l'EmptyState, il n'hérite donc
      // plus du sien — sans lui, la note d'attente multiligne ferrerait à
      // gauche sous un bouton centré.
      className={cn(
        "flex min-w-0 flex-col gap-2",
        regenerate ? "items-start" : "items-center text-center",
      )}
    >
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
    </div>
  );

  return (
    <form
      action={formAction}
      // En mode `create`, le formulaire englobe l'état vide : c'est lui qui porte
      // la respiration verticale, pour que le squelette d'attente hérite de la
      // même sans que le bouton ne saute.
      className={cn("flex min-w-0 flex-col", !regenerate && "py-4 sm:py-6")}
    >
      {/* L'identifiant transite par le formulaire : l'action le revalide. */}
      <input type="hidden" name="activityId" value={activityId} />

      {/*
        Zone de contenu : c'est ici qu'atterrira le feedback, donc ici que
        l'attente doit se voir. Le squelette prend la place du texte précédent
        plutôt que de s'y ajouter — l'ancien feedback n'est plus celui affiché.
      */}
      <div aria-busy={isPending} className="min-w-0">
        {isPending ? <CoachFeedbackSkeleton /> : children}
      </div>

      {regenerate ? (
        // Même pied que la variante « coach injoignable » de `coach-panel.tsx` :
        // toute retouche de l'un se répercute sur l'autre.
        <footer className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3">
          {isPending ? null : meta}
          {actions}
        </footer>
      ) : (
        <div className="mt-6">{actions}</div>
      )}
    </form>
  );
}
