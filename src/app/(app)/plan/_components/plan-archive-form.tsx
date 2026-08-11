"use client";

import { useActionState, useState } from "react";
import { Archive, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { archivePlanAction, type PlanArchiveState } from "../_lib/actions";
import { ARCHIVE_CONFIRMATION } from "../_lib/form-options";

/**
 * Archivage du plan actif.
 *
 * Action destructive : elle se confirme en deux temps (armer, puis confirmer)
 * plutôt que par une boîte de dialogue native, qui ne se thème pas et coupe la
 * page. Le jeton de confirmation part avec le formulaire — l'action le vérifie,
 * son endpoint étant public.
 */
const INITIAL_STATE: PlanArchiveState = { status: "idle" };

export function PlanArchiveForm() {
  const [state, formAction, isPending] = useActionState(archivePlanAction, INITIAL_STATE);
  const [armed, setArmed] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="confirm" value={ARCHIVE_CONFIRMATION} />

      {/*
        Les `key` ne sont pas décoratives : sans elles, la confirmation ne
        confirme rien. React déballe un fragment de tête sans clé, si bien que le
        bouton « Archiver » et le bouton « Confirmer » occupent la même position
        de réconciliation : React réutilise alors le même nœud `<button>` et se
        contente d'y remplacer `type="button"` par `type="submit"` — pendant que
        le clic est encore en cours de traitement. Le navigateur exécute ensuite
        le comportement d'activation sur ce nœud devenu bouton de soumission, et
        archive le plan au premier clic. Des clés distinctes forcent le
        remplacement du nœud : celui qui a été cliqué se retrouve détaché, sans
        formulaire propriétaire, et ne soumet rien.
      */}
      <div className="flex flex-wrap items-center gap-2">
        {armed ? (
          <>
            <Button
              key="confirm"
              type="submit"
              variant="secondary"
              disabled={isPending}
              aria-busy={isPending}
            >
              {isPending ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Archive aria-hidden="true" />
              )}
              {isPending ? "Archivage…" : "Confirmer l'archivage"}
            </Button>
            <Button key="cancel" type="button" variant="ghost" onClick={() => setArmed(false)}>
              Annuler
            </Button>
          </>
        ) : (
          <Button key="arm" type="button" variant="ghost" onClick={() => setArmed(true)}>
            <Archive aria-hidden="true" />
            Archiver ce plan
          </Button>
        )}
      </div>

      <p
        aria-live="polite"
        className={cn(
          "text-[0.76rem] leading-relaxed",
          state.status === "error" ? "text-negative" : "text-fg-faint",
        )}
      >
        {state.status === "error"
          ? (state.message ?? "Le plan n'a pas pu être archivé.")
          : armed
            ? "Le plan quitte cet écran et tu repars sur une création. Tes activités et les séances déjà réalisées restent dans ton historique."
            : "Tu pourras créer un nouveau plan juste après."}
      </p>
    </form>
  );
}
