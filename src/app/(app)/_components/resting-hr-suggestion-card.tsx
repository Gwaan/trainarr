"use client";

import { useState, useTransition } from "react";
import { HeartPulse, Loader2 } from "lucide-react";

import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";
// Le module précis, pas le tonneau `@/lib/metrics` : ce composant est client, il
// n'a aucune raison d'embarquer tous les calculs physio dans le bundle.
import { RESTING_HR_WINDOW_DAYS } from "@/lib/metrics/resting-hr";
import { cn } from "@/lib/utils";

import { resolveRestingHrSuggestionAction } from "../_lib/resting-hr-actions";
import {
  RESTING_HR_SUGGESTION_IDLE,
  type RestingHrSuggestionView,
} from "../_lib/resting-hr-suggestion";

/**
 * « Ta FC de repos a bougé : on met le profil à jour ? »
 *
 * Le pendant de la {@link MaxHrSuggestionCard}, sur les mêmes deux surfaces — le
 * tableau de bord et l'onglet « Profil » des réglages — avec le même contrat :
 * une seule proposition, une seule lecture du DAL, un seul composant.
 *
 * ## Ce qu'elle dit de plus que celle de la FC max
 *
 * **Le sens de l'écart.** Une FC de repos baisse quand la forme monte et remonte
 * sinon : « 5 bpm de moins » et « 5 bpm de plus » ne se lisent pas pareil, et
 * afficher un nombre sans son sens laisserait l'athlète faire la soustraction.
 *
 * **La taille de l'échantillon.** La valeur proposée est une **médiane**, pas
 * une mesure : dire sur combien de nuits elle est calculée est ce qui la rend
 * acceptable — sans ça, c'est un chiffre tombé du ciel.
 *
 * ## Ce qu'elle n'est pas
 *
 * **Pas une alerte.** Aucun jeton `warning`, aucun `negative`, même quand la FC
 * de repos monte : c'est une mesure de montre, pas un diagnostic, et le seul
 * geste proposé est de mettre un champ de profil à jour.
 */

export type RestingHrSuggestionCardProps = {
  suggestion: RestingHrSuggestionView;
  /**
   * `accent` réservé à la surface qui n'a pas déjà son CTA accent. Sur le
   * tableau de bord, la carte de FC max le prend quand les deux coexistent (cf.
   * la page) ; dans les réglages, c'est « Enregistrer » qui l'a.
   */
  emphasis?: "accent" | "secondary";
  /** Appelé avec la valeur acceptée — au formulaire hôte de refléter son champ. */
  onAccepted?: (bpm: number) => void;
  className?: string;
};

/** La phrase qui situe la médiane par rapport au profil, sens compris. */
function comparison(suggestion: RestingHrSuggestionView): string {
  if (suggestion.direction === "first" || suggestion.profileBpm === null) {
    return "Ton profil n’en porte pas encore : c’est cette valeur qu’il attend.";
  }

  const way = suggestion.direction === "down" ? "de moins" : "de plus";
  return `Soit ${suggestion.deltaBpm} bpm ${way} que la FC de repos de ton profil (${suggestion.profileBpm} bpm).`;
}

export function RestingHrSuggestionCard({
  suggestion,
  emphasis = "secondary",
  onAccepted,
  className,
}: RestingHrSuggestionCardProps) {
  const [state, setState] = useState(RESTING_HR_SUGGESTION_IDLE);
  const [isPending, startTransition] = useTransition();

  const decide = (intent: "accept" | "dismiss") => {
    startTransition(async () => {
      const next = await resolveRestingHrSuggestionAction(state, {
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
            FC de repos mesurée : <span className="num">{suggestion.bpm}</span> bpm
          </h2>

          <p className="mt-1.5 text-[0.85rem] leading-relaxed text-fg-muted">
            Médiane des {RESTING_HR_WINDOW_DAYS} derniers jours, sur{" "}
            {suggestion.measuredNights} nuit
            {suggestion.measuredNights > 1 ? "s" : ""} mesurée
            {suggestion.measuredNights > 1 ? "s" : ""} par ta montre.{" "}
            {comparison(suggestion)} L’accepter recalcule ta charge
            d’entraînement sur tout ton historique.
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
