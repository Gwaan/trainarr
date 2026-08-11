import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  PlanSessionDetail,
  PlanStepBlockView,
  PlanStepView,
} from "../_lib/session-detail";

/**
 * Le déroulé d'une séance, révélé sous sa ligne.
 *
 * Trois strates, dans l'ordre où on les lit avant de partir courir : les blocs
 * d'étapes, les consignes en texte libre (seules données des plans d'avant le
 * déroulé structuré), puis le récapitulatif chiffré.
 *
 * Une étape se lit en deux colonnes : à gauche ce qu'on fait (rôle, consigne),
 * à droite ce qui se mesure (mesure puis cible, empilées et alignées à droite —
 * sur téléphone, une seule ligne ne tiendrait pas). Toutes les valeurs sont en
 * mono tabulaire : d'un bloc à l'autre, les chiffres restent en colonne.
 */
export function PlanSessionDetailPanel({
  detail,
  completedActivityId,
}: {
  detail: PlanSessionDetail;
  completedActivityId: number | null;
}) {
  const hasBlocks = detail.blocks.length > 0;

  return (
    <div className="border-t border-border bg-surface-2 px-4 py-3.5 sm:px-5">
      {hasBlocks ? (
        <>
          <p className="eyebrow">Déroulé</p>
          <ol className="mt-2.5 flex flex-col gap-2.5">
            {detail.blocks.map((block, index) => (
              <Block key={index} block={block} />
            ))}
          </ol>
        </>
      ) : null}

      {detail.notes.length > 0 ? (
        <dl
          className={cn(
            "flex flex-col gap-2.5",
            hasBlocks && "mt-3.5 border-t border-border pt-3",
          )}
        >
          {detail.notes.map((note) => (
            <div key={note.label}>
              <dt className="eyebrow">{note.label}</dt>
              <dd className="mt-1 text-[0.82rem] leading-snug text-fg-muted">
                {note.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {detail.totals.length > 0 ? (
        <ul
          className={cn(
            "flex flex-wrap gap-x-4 gap-y-1.5",
            (hasBlocks || detail.notes.length > 0) &&
              "mt-3.5 border-t border-border pt-3",
          )}
        >
          {detail.totals.map((total) => (
            <li key={total.label} className="flex items-baseline gap-1.5">
              <span className="eyebrow">{total.label}</span>
              <span className="num text-[0.82rem] font-medium text-fg">{total.value}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {completedActivityId === null ? null : (
        <Button asChild variant="secondary" size="sm" className="mt-3.5 bg-surface">
          <Link href={`/activities/${completedActivityId}`}>
            Voir l&apos;activité
            <ArrowRight aria-hidden="true" strokeWidth={1.8} />
          </Link>
        </Button>
      )}
    </div>
  );
}

/**
 * Un bloc d'étapes. Répété, il porte son compteur `6 ×` et ses étapes sont
 * décalées derrière un filet : la répétition se voit avant d'être lue.
 */
function Block({ block }: { block: PlanStepBlockView }) {
  const steps = (
    <ol className="flex min-w-0 flex-1 flex-col gap-1.5">
      {block.steps.map((step, index) => (
        <Step key={index} step={step} />
      ))}
    </ol>
  );

  if (block.repeat === 1) return <li className="flex">{steps}</li>;

  return (
    <li className="flex gap-2.5">
      <span className="num shrink-0 pt-px text-[0.8rem] font-medium text-fg">
        {block.repeat} ×
      </span>
      <div className="flex min-w-0 flex-1 border-l border-border pl-2.5">{steps}</div>
    </li>
  );
}

function Step({ step }: { step: PlanStepView }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-[0.82rem] leading-snug",
            // Le corps de séance porte l'intention ; l'échauffement, la récup et
            // le retour au calme l'accompagnent.
            step.role === "run" ? "font-medium text-fg" : "text-fg-muted",
          )}
        >
          {step.roleLabel}
        </span>
        {step.note === null ? null : (
          <span className="mt-0.5 block text-[0.75rem] leading-snug text-fg-faint">
            {step.note}
          </span>
        )}
      </span>

      <span className="flex shrink-0 flex-col items-end">
        {step.measure === null ? null : (
          <span className="num text-[0.82rem] text-fg">{step.measure}</span>
        )}
        {step.target === null ? null : (
          <span className="num text-[0.75rem] text-fg-faint">{step.target}</span>
        )}
      </span>
    </li>
  );
}
