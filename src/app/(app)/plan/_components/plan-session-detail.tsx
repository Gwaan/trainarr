import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  PLAN_STEP_ROLE_STYLES,
  type PlanSessionDetail,
  type PlanSessionNote,
  type PlanStepBlockView,
  type PlanStepView,
} from "../_lib/session-detail";

/** Filet gauche + fond doux : la géométrie de la brique, sa couleur vient du rôle. */
const BRICK = "rounded-r-[6px] border-l-[3px] py-1.5 pr-2.5 pl-2";

/**
 * Le déroulé d'une séance, révélé sous sa ligne.
 *
 * Trois strates, dans l'ordre où on les lit avant de partir courir : les blocs
 * d'étapes, les consignes en texte libre (seules données des plans d'avant le
 * déroulé structuré), puis le récapitulatif chiffré.
 *
 * Chaque brique est un bloc codé par couleur selon son rôle (cf.
 * `PLAN_STEP_ROLE_STYLES`) : filet coloré à gauche, fond de la même teinte à
 * 10 %, libellé du rôle en couleur pleine. La couleur ne porte jamais
 * l'information seule — le rôle est toujours écrit.
 *
 * Une étape se lit en deux colonnes : à gauche ce qu'on fait (rôle, consigne),
 * à droite ce qui se mesure (mesure puis cible, empilées et alignées à droite —
 * sur téléphone, une seule ligne ne tiendrait pas). Les valeurs restent en tokens
 * texte et en mono tabulaire : jamais de donnée écrite en couleur de rôle, et
 * d'un bloc à l'autre les chiffres restent en colonne.
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
            "flex flex-col gap-1.5",
            hasBlocks && "mt-3.5 border-t border-border pt-3",
          )}
        >
          {detail.notes.map((note) => (
            <Note key={note.label} note={note} />
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
 * Un bloc d'étapes. Répété, il annonce son compteur `6 ×` au-dessus de ses
 * étapes, décalées derrière un filet neutre : la répétition se voit avant d'être
 * lue, et le compteur ne mange plus la largeur des briques sur téléphone.
 */
function Block({ block }: { block: PlanStepBlockView }) {
  const steps = (
    <ol className="flex min-w-0 flex-col gap-1.5">
      {block.steps.map((step, index) => (
        <Step key={index} step={step} />
      ))}
    </ol>
  );

  if (block.repeat === 1) return <li className="min-w-0">{steps}</li>;

  return (
    <li className="min-w-0">
      <p className="num text-[0.8rem] leading-none font-medium text-fg">
        {block.repeat} ×
      </p>
      <div className="mt-1.5 min-w-0 border-l border-border pl-2.5">{steps}</div>
    </li>
  );
}

function Step({ step }: { step: PlanStepView }) {
  const style = PLAN_STEP_ROLE_STYLES[step.role];

  return (
    <li className={cn("flex items-baseline justify-between gap-3", BRICK, style.block)}>
      <span className="min-w-0 flex-1">
        {/* La couleur du rôle remplace l'ancien contraste de graisse : toutes les
            étapes portent le même poids, c'est la teinte qui les distingue. */}
        <span className={cn("block text-[0.82rem] leading-snug font-medium", style.label)}>
          {step.roleLabel}
        </span>
        {step.note === null ? null : (
          <span className="mt-0.5 block text-[0.75rem] leading-snug text-fg-muted">
            {step.note}
          </span>
        )}
      </span>

      {/* `fg-muted` et non `fg-faint` pour le second niveau : sur le fond teinté,
          `fg-faint` tombait sous les 4,5:1 de WCAG (4,2:1 sur la brique accent). */}
      <span className="flex shrink-0 flex-col items-end">
        {step.measure === null ? null : (
          <span className="num text-[0.82rem] text-fg">{step.measure}</span>
        )}
        {step.target === null ? null : (
          <span className="num text-[0.75rem] text-fg-muted">{step.target}</span>
        )}
      </span>
    </li>
  );
}

/**
 * Une consigne en texte libre — même brique colorée que les étapes.
 *
 * Le libellé reprend la forme de `.eyebrow` mais pas sa couleur : l'utilitaire
 * fixe `fg-faint`, or c'est ici la teinte du rôle qui doit s'appliquer (même
 * parti pris que les badges de `plan-session-row`).
 */
function Note({ note }: { note: PlanSessionNote }) {
  const style = PLAN_STEP_ROLE_STYLES[note.role];

  return (
    <div className={cn(BRICK, style.block)}>
      <dt
        className={cn(
          "text-[0.68rem] leading-[1.1] font-medium tracking-[0.1em] uppercase",
          style.label,
        )}
      >
        {note.label}
      </dt>
      <dd className="mt-1 text-[0.82rem] leading-snug text-fg-muted">{note.value}</dd>
    </div>
  );
}
