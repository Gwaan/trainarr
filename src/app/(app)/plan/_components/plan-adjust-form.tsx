"use client";

import { useActionState, useId, useState } from "react";
import { Loader2, PencilLine } from "lucide-react";

import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { updatePlanAction, type PlanUpdateState } from "../_lib/actions";
import { GenerationProgressBar, useGenerationProgress } from "./generation-progress";

/**
 * Ajustement du plan par instruction en langage naturel.
 *
 * Même contrat d'attente que la génération : le bouton se désactive et dit ce
 * qui se passe. La saisie est contrôlée pour survivre à une erreur, et vidée
 * seulement quand l'ajustement a abouti.
 */

const PENDING_MESSAGE =
  "Le coach retravaille ton plan — jusqu'à quelques minutes avec un modèle local.";

const MAX_CHARS = 500;

const INITIAL_STATE: PlanUpdateState = { status: "idle" };

export function PlanAdjustForm() {
  const [state, formAction, isPending] = useActionState(updatePlanAction, INITIAL_STATE);
  const [instruction, setInstruction] = useState("");
  const [handledState, setHandledState] = useState(state);
  const uid = useId();

  // Ajustement du champ pendant le rendu (pattern React, pas d'effet) : chaque
  // retour d'action est un objet neuf, la comparaison d'identité repère donc
  // aussi deux succès consécutifs. Une erreur, elle, conserve la saisie —
  // l'attente a pu durer plusieurs minutes.
  if (state !== handledState) {
    setHandledState(state);
    if (state.status === "success") setInstruction("");
  }

  const { submitWithProgress, progress } = useGenerationProgress(isPending, formAction);

  const fieldId = `${uid}-instruction`;
  const error = state.fieldErrors?.instruction;
  const hasFeedback = isPending || state.status === "error";

  // Suivi de la progression par l'action enveloppante — cf. `plan-create-dialog.tsx`.
  return (
    <form action={submitWithProgress} noValidate className="flex flex-col gap-3">
      <div aria-live="polite" className={hasFeedback ? undefined : "sr-only"}>
        {isPending ? (
          <Banner tone="neutral" title={PENDING_MESSAGE}>
            {progress === null ? null : <GenerationProgressBar progress={progress} />}
          </Banner>
        ) : null}
        {!isPending && state.status === "error" ? (
          <Banner
            tone="negative"
            title={state.message ?? "L'ajustement n'a pas abouti."}
          />
        ) : null}
      </div>

      <label htmlFor={fieldId} className="text-[0.85rem] font-medium text-fg">
        Ce que tu veux changer
      </label>

      <textarea
        id={fieldId}
        name="instruction"
        rows={3}
        maxLength={MAX_CHARS}
        placeholder="Ex. : je préfère courir 3 fois par semaine au lieu de 4"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        className={cn(
          "w-full resize-y rounded-button border border-border bg-surface-2 px-3 py-2.5",
          // 16 px minimum : même raison que l'Input partagé — sous ce seuil,
          // iOS zoome à la prise de focus, sans retour possible en PWA.
          "text-base leading-relaxed text-fg transition-colors duration-150 ease-out",
          "placeholder:text-fg-faint hover:border-fg-faint/35 aria-invalid:border-negative/60",
        )}
      />

      {error ? (
        <p id={`${fieldId}-error`} className="text-[0.76rem] leading-snug text-negative">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Button
          type="submit"
          variant="secondary"
          disabled={isPending}
          aria-busy={isPending}
          className="w-full sm:w-auto"
        >
          {isPending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <PencilLine aria-hidden="true" />
          )}
          {isPending ? "Ajustement en cours…" : "Demander l'ajustement"}
        </Button>
        <p className="text-[0.76rem] leading-relaxed text-fg-faint">
          Seules les séances à venir sont réécrites : celles que tu as déjà courues
          ne bougent pas.
        </p>
      </div>
    </form>
  );
}
