"use client";

import { useState, useTransition } from "react";
import { HeartPulse, Loader2 } from "lucide-react";

import { Banner } from "@/components/banner";
import { Button } from "@/components/ui/button";
// Le module précis, pas le tonneau `@/lib/metrics` : ce composant est client, il
// n'a aucune raison d'embarquer tous les calculs physio dans le bundle.
import { LTHR_WINDOW_DAYS } from "@/lib/metrics/lthr";
import { cn } from "@/lib/utils";

import { resolveLthrSuggestionAction } from "../_lib/lthr-actions";
import { LTHR_SUGGESTION_IDLE, type LthrSuggestionView } from "../_lib/lthr-suggestion";

/**
 * « Tes séances de seuil disent où est ton seuil : on cale tes zones dessus ? »
 *
 * La troisième carte de proposition cardiaque, sur les mêmes deux surfaces que
 * ses aînées — le tableau de bord et l'onglet « Profil » des réglages — avec le
 * même contrat : une seule proposition, une seule lecture du DAL, un seul
 * composant.
 *
 * ## Ce qu'elle dit de plus que les deux autres
 *
 * **La conséquence, en toutes lettres.** Accepter une FC max ou une FC de repos
 * corrige une valeur dans une formule ; accepter une FC seuil **change
 * l'ancrage des zones cardiaques** — leur définition, pas seulement leur
 * position. Une rupture pareille s'annonce avant le clic, pas après.
 *
 * **D'où sort la valeur, et ce que dit l'autre source.** Une médiane de séances
 * de seuil et un test chronométré sont deux mesures indépendantes : quand les
 * deux existent, les afficher ensemble est la meilleure raison d'accepter (elles
 * concordent) ou de regarder de plus près (elles divergent).
 *
 * ## Ce qu'elle n'est pas
 *
 * **Pas une alerte.** Aucun jeton `warning`, aucun `negative`, quel que soit le
 * sens de l'écart : c'est une mesure de terrain, pas un diagnostic.
 */

export type LthrSuggestionCardProps = {
  suggestion: LthrSuggestionView;
  /**
   * `accent` réservé à la surface qui n'a pas déjà son CTA accent. Sur le
   * tableau de bord, c'est cette carte qui le prend quand plusieurs propositions
   * cardiaques coexistent (cf. la page) ; dans les réglages, c'est
   * « Enregistrer » qui l'a.
   */
  emphasis?: "accent" | "secondary";
  className?: string;
};

/** D'où sort la valeur — et, s'il y en a une, ce que dit la seconde mesure. */
function provenance(suggestion: LthrSuggestionView): string {
  const second =
    suggestion.source === "threshold-blocks" && suggestion.timeTrialBpm !== null
      ? ` Ton dernier test chronométré, lui, donnait ${suggestion.timeTrialBpm} bpm.`
      : "";

  if (suggestion.source === "threshold-blocks") {
    return (
      `Médiane de ${suggestion.sessionCount} séances de seuil des ${LTHR_WINDOW_DAYS} derniers ` +
      `jours, relevée sur la seconde moitié de chaque bloc — le temps que ton cœur ` +
      `atteigne son plateau.${second}`
    );
  }

  return (
    "FC moyenne des 20 dernières minutes de ton dernier test chronométré, couru à fond. " +
    "C'est une mesure ponctuelle : elle laissera la place à la médiane de tes séances de " +
    "seuil dès que tu en auras couru assez."
  );
}

/** La phrase qui situe la mesure par rapport au profil, sens compris. */
function comparison(suggestion: LthrSuggestionView): string {
  if (suggestion.direction === "first" || suggestion.profileBpm === null) {
    return "Ton profil n’en porte pas encore : tes zones sont calées sur ta FC max.";
  }

  const way = suggestion.direction === "down" ? "de moins" : "de plus";
  return `Soit ${suggestion.deltaBpm} bpm ${way} que la FC seuil de ton profil (${suggestion.profileBpm} bpm).`;
}

export function LthrSuggestionCard({
  suggestion,
  emphasis = "secondary",
  className,
}: LthrSuggestionCardProps) {
  const [state, setState] = useState(LTHR_SUGGESTION_IDLE);
  const [isPending, startTransition] = useTransition();

  const decide = (intent: "accept" | "dismiss") => {
    startTransition(async () => {
      const next = await resolveLthrSuggestionAction(state, {
        intent,
        bpm: suggestion.bpm,
      });
      setState(next);
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
            FC seuil mesurée : <span className="num">{suggestion.bpm}</span> bpm
          </h2>

          <p className="mt-1.5 text-[0.85rem] leading-relaxed text-fg-muted">
            {provenance(suggestion)} {comparison(suggestion)}
          </p>

          {/* La conséquence avant le clic : c'est la définition des zones qui
              change, pas seulement une valeur de profil. */}
          <p className="mt-2 text-[0.85rem] leading-relaxed text-fg-muted">
            L’adopter <span className="font-medium text-fg">ancre tes zones cardiaques sur
            ton seuil</span> au lieu de ta FC max : leur définition change, et toutes tes
            répartitions passées seront relues dans ce nouveau cadre.
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
              Ancrer mes zones sur ce seuil
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
