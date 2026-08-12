"use client";

import { useActionState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { resyncIntervalsAction, type PlanSyncState } from "../_lib/actions";

/**
 * Republication manuelle du calendrier intervals.icu.
 *
 * Volontairement discret, en pied de la carte d'identité du plan : c'est un
 * outil de rattrapage, pas une action du quotidien — le calendrier se
 * resynchronise tout seul à chaque changement de plan. Il sert quand c'est le
 * **format** des séances poussées qui a changé, sans que le plan, lui, ait bougé.
 *
 * Le bouton se désactive pendant l'appel : c'est la première défense contre le
 * double-clic, qui lancerait deux remplacements concurrents du calendrier. La
 * seconde est côté serveur, l'action étant un endpoint public.
 */
const INITIAL_STATE: PlanSyncState = { status: "idle" };

const IDLE_NOTE = "Republie les séances à venir sur intervals.icu.";

export function PlanSyncForm() {
  // Le type de la charge utile est donné explicitement : l'action n'ayant aucun
  // paramètre, il n'y a rien à en inférer.
  const [state, formAction, isPending] = useActionState<PlanSyncState, FormData>(
    resyncIntervalsAction,
    INITIAL_STATE,
  );

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button type="submit" variant="ghost" size="sm" disabled={isPending} aria-busy={isPending}>
        {isPending ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
        {isPending ? "Resynchronisation…" : "Resynchroniser le calendrier intervals"}
      </Button>

      <p
        aria-live="polite"
        className={cn(
          "text-[0.72rem] leading-relaxed",
          state.status === "error" ? "text-negative" : "text-fg-faint",
        )}
      >
        {state.status === "idle" ? IDLE_NOTE : (state.message ?? IDLE_NOTE)}
      </p>
    </form>
  );
}
