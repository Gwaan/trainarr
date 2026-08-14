"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { HeartPulse, Loader2 } from "lucide-react";

import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";
// Le module précis, pas le tonneau `@/lib/metrics` : ce composant est client, il
// n'a aucune raison d'embarquer tous les calculs physio dans le bundle.
import { SUSTAINED_HR_WINDOW_S } from "@/lib/metrics/sustained-hr";
import { cn } from "@/lib/utils";

import { resolveMaxHrSuggestionAction } from "../_lib/max-hr-actions";
import {
  MAX_HR_SUGGESTION_IDLE,
  type MaxHrSuggestionView,
} from "../_lib/max-hr-suggestion";

/**
 * « Tu es montée plus haut que ton profil : on met à jour ? »
 *
 * La même carte sur les **deux** surfaces qui la montrent — le tableau de bord
 * (où elle se voit sans qu'on l'ait cherchée) et l'onglet « Profil » des
 * réglages (où elle se pose contre le champ qu'elle propose de changer). Une
 * seule proposition, une seule lecture du DAL, un seul composant : deux
 * formulations divergeraient au premier changement.
 *
 * ## Ce qu'elle dit, et pourquoi
 *
 * Elle **source sa valeur** : la date, le nom de la séance, et un lien vers
 * elle. Une proposition inexplicable serait refusée par principe — et elle le
 * mériterait, puisqu'accepter réécrit la lecture de tout l'historique (TRIMP,
 * zones, VO₂max se recalculent depuis le profil).
 *
 * ## Ce qu'elle n'est pas
 *
 * **Pas une alerte.** Aucun jeton `warning`, aucun `negative` : dépasser sa FC
 * max de profil est une bonne nouvelle, pas une panne. Le cadre reprend celui de
 * l'`OnboardingCard` — une carte qui n'existe que tant qu'un état l'exige, et
 * qui disparaît ensuite.
 *
 * ## Pourquoi `useTransition` et non `useActionState`
 *
 * Dans les réglages, cet encart vit **à l'intérieur** du formulaire de profil,
 * au plus près du champ « FC max ». Un `<form>` ne s'imbrique pas dans un autre :
 * les deux gestes ne peuvent donc pas être des soumissions. Ils appellent
 * l'action directement, dans une transition — ce qui permet en prime de prévenir
 * le formulaire hôte de la valeur acceptée ({@link MaxHrSuggestionCardProps.onAccepted}),
 * dont le champ contrôlé garderait sinon l'ancienne.
 */

export type MaxHrSuggestionCardProps = {
  suggestion: MaxHrSuggestionView;
  /**
   * `accent` réservé à la surface qui n'a pas déjà son CTA accent : le tableau de
   * bord n'en porte aucun, les réglages en ont un (« Enregistrer »).
   */
  emphasis?: "accent" | "secondary";
  /** Appelé avec la valeur acceptée — au formulaire hôte de refléter son champ. */
  onAccepted?: (bpm: number) => void;
  className?: string;
};

export function MaxHrSuggestionCard({
  suggestion,
  emphasis = "secondary",
  onAccepted,
  className,
}: MaxHrSuggestionCardProps) {
  const [state, setState] = useState(MAX_HR_SUGGESTION_IDLE);
  const [isPending, startTransition] = useTransition();

  const decide = (intent: "accept" | "dismiss") => {
    startTransition(async () => {
      const next = await resolveMaxHrSuggestionAction(state, {
        intent,
        bpm: suggestion.bpm,
      });
      setState(next);
      if (next.status === "accepted") onAccepted?.(suggestion.bpm);
    });
  };

  return (
    <section
      className={cn(
        "rounded-card border border-accent/30 bg-accent-soft p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex items-start gap-3.5">
        <span className="hidden size-10 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-bg/40 sm:flex">
          <HeartPulse
            aria-hidden="true"
            strokeWidth={1.7}
            className="size-5 text-accent"
          />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-[1rem] leading-tight font-semibold text-fg">
            FC max observée : <span className="num">{suggestion.bpm}</span> bpm
          </h2>

          <p className="mt-1.5 text-[0.85rem] leading-relaxed text-fg-muted">
            Tenue au moins {SUSTAINED_HR_WINDOW_S} s d’affilée le{" "}
            {suggestion.observedOn}, pendant{" "}
            <Link
              href={`/activities/${suggestion.activityId}`}
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              {suggestion.activityName}
            </Link>{" "}
            — au-dessus de la FC max de ton profil. L’accepter recalcule ta charge,
            tes zones et ta VO₂max sur tout ton historique.
          </p>

          {/* Pas de conteneur `aria-live` : `Banner` porte déjà son `role`, et
              l'annonce se ferait deux fois. */}
          {state.status === "error" ? (
            <Banner
              tone="negative"
              title={state.message ?? "Impossible pour l’instant."}
              className="mt-3"
            />
          ) : null}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant={emphasis}
              disabled={isPending}
              aria-busy={isPending}
              onClick={() => decide("accept")}
              className="w-full sm:w-auto"
            >
              {isPending ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : null}
              Mettre mon profil à jour
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={isPending}
              onClick={() => decide("dismiss")}
              className="w-full sm:w-auto"
            >
              Ignorer
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
