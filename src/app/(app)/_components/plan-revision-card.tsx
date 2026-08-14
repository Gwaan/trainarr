import Link from "next/link";
import { ArrowRight, Scale } from "lucide-react";

import type { PlanRevisionDto } from "@/data/plan-revisions";
import { cn } from "@/lib/utils";

import {
  PLAN_REVISION_DIRECTIONS,
  PLAN_REVISION_SOURCE_LABELS,
  formatRevisionIntensity,
  formatRevisionVolume,
} from "../_lib/plan-revision-view";

/**
 * « Le coach propose de réévaluer ton plan. »
 *
 * Même cadre et même esprit que la {@link MaxHrSuggestionCard} : une carte qui
 * n'existe que tant qu'un état l'exige, posée sous l'en-tête du tableau de bord,
 * et qui disparaît une fois la décision prise. Elle ne clignote pas pendant le
 * chargement — tout ce bloc est suspendu derrière `connection()`, et le squelette
 * ne réserve rien pour elle.
 *
 * ## Ce qu'elle porte, et ce qu'elle ne porte **pas**
 *
 * Elle porte le **sens** (plus ou moins de charge), la **raison** courte, et les
 * **totaux** qui la justifient. Elle ne porte **aucun bouton Accepter/Refuser**,
 * et c'est la différence avec la proposition de FC max : là-bas la valeur se
 * juge d'un coup d'œil (« 191 bpm tenus 30 s, le 12 août »), ici la décision
 * porte sur trois semaines de séances réécrites. Accepter cela sans l'avoir vu
 * serait un mauvais réflexe à encourager — la carte renvoie donc à la page du
 * plan, où les semaines proposées se lisent avant qu'on tranche.
 *
 * ## Pas d'alerte, pas de code couleur
 *
 * Aucun jeton `negative` ni `positive` : baisser la charge n'est pas une erreur,
 * la monter n'est pas une récompense. Le sens se dit d'un signe et d'une phrase
 * (cf. `_lib/plan-revision-view.ts`).
 */
export function PlanRevisionCard({
  revision,
  className,
}: {
  revision: PlanRevisionDto;
  className?: string;
}) {
  const direction = PLAN_REVISION_DIRECTIONS[revision.direction];
  const intensity = formatRevisionIntensity(revision.before, revision.after);

  return (
    <section
      className={cn(
        "rounded-card border border-accent/30 bg-accent-soft p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex items-start gap-3.5">
        <span className="hidden size-10 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-bg/40 sm:flex">
          <Scale aria-hidden="true" strokeWidth={1.7} className="size-5 text-accent" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="eyebrow">{PLAN_REVISION_SOURCE_LABELS[revision.source]}</p>

          <h2 className="mt-1 flex items-baseline gap-2 text-[1rem] leading-tight font-semibold text-fg">
            {/* Le signe double la phrase, il ne la remplace pas : masqué aux
                lecteurs d'écran, qui n'ont pas à annoncer « flèche vers le haut ». */}
            <span aria-hidden="true" className="num text-[1.15rem] text-accent">
              {direction.sign}
            </span>
            {direction.label}
          </h2>

          <p className="num mt-1.5 text-[0.85rem] text-fg-muted">
            {formatRevisionVolume(revision.before, revision.after, revision.weeks)}
            {intensity === null ? null : <> · {intensity}</>}
          </p>

          <p className="mt-2 text-[0.85rem] leading-relaxed text-fg-muted">{revision.reason}</p>

          <Link
            href="/plan"
            className="mt-3.5 inline-flex items-center gap-1.5 text-[0.85rem] font-semibold text-accent underline-offset-2 hover:underline"
          >
            Voir les semaines proposées
            <ArrowRight aria-hidden="true" strokeWidth={2} className="size-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
