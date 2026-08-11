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

/**
 * Géométrie d'une étape : le segment de rail (3 px), puis l'air avant le texte.
 *
 * `minmax(0,1fr)` et non `1fr` : sans ça une consigne longue sans espace
 * pousserait la colonne et déborderait sur téléphone.
 */
const RAIL_ROW = "grid grid-cols-[3px_minmax(0,1fr)] gap-x-3";

/** Espacement d'une étape à l'autre — le rail se voit dans cet interstice. */
const STEP_GAP = "flex min-w-0 flex-col gap-3";

/** Micro-label d'étape : la forme de `.eyebrow`, la couleur du rôle. */
const ROLE_LABEL =
  "text-[0.68rem] leading-[1.1] font-medium tracking-[0.1em] uppercase";

/**
 * Le déroulé d'une séance, révélé sous sa ligne.
 *
 * La forme est une **timeline verticale** : un fil continu descend le long des
 * étapes, chacune posant sur ce fil son segment coloré. La couleur ne vit plus
 * que là — plus aucun aplat de fond teinté, plus aucune brique. Ce qui reste
 * fort à l'œil, c'est la mesure : `800 m`, `90 s`, en mono et en tokens texte,
 * là où on la cherche en enfilant ses chaussures.
 *
 * Trois strates, dans l'ordre où on les lit avant de partir courir : le déroulé
 * (blocs d'étapes, puis consignes en texte libre pour les plans d'avant le
 * déroulé structuré — même grammaire visuelle), puis le récapitulatif chiffré.
 *
 * Le rôle est toujours écrit à côté de son segment : la couleur double
 * l'information, elle ne la porte jamais seule.
 */
export function PlanSessionDetailPanel({
  detail,
  completedActivityId,
}: {
  detail: PlanSessionDetail;
  completedActivityId: number | null;
}) {
  const hasBlocks = detail.blocks.length > 0;
  const hasNotes = detail.notes.length > 0;
  const hasTimeline = hasBlocks || hasNotes;

  return (
    <div className="border-t border-border bg-surface-2 px-4 py-4 sm:px-5">
      {hasTimeline ? (
        <>
          <p className="eyebrow">Déroulé</p>
          <div className="mt-3 flex flex-col gap-4">
            {hasBlocks ? (
              <ol className="flex min-w-0 flex-col gap-4">
                {detail.blocks.map((block, index) => (
                  <Block key={index} block={block} />
                ))}
              </ol>
            ) : null}

            {hasNotes ? (
              <div className="relative min-w-0">
                <Thread />
                <dl className={STEP_GAP}>
                  {detail.notes.map((note) => (
                    <Note key={note.label} note={note} />
                  ))}
                </dl>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {detail.totals.length > 0 ? (
        <ul
          className={cn(
            "flex flex-wrap gap-x-4 gap-y-1.5",
            hasTimeline && "mt-4 border-t border-border pt-3",
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
        <Button asChild variant="secondary" size="sm" className="mt-4 bg-surface">
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
 * Le fil de la séance : un cheveu neutre centré sous les segments colorés.
 *
 * Il court sur toute la hauteur de la liste mais ne se voit que dans les
 * interstices — les segments le recouvrent. `left-[1px] w-px` le centre sur les
 * 3 px du segment ; `fg-faint/20` plutôt que `border`, qui disparaîtrait
 * complètement sur `surface-2`. Décoratif : les étapes portent l'information.
 */
function Thread() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-[1px] w-px bg-fg-faint/20"
    />
  );
}

/**
 * Un bloc d'étapes.
 *
 * Répété, il s'annonce par son compteur `6 ×` sur un filet qui traverse la
 * largeur, puis serre ses étapes dans un crochet : on voit d'un coup d'œil où la
 * boucle commence et où elle s'arrête — ce que l'indentation seule ne disait
 * pas. Le crochet reste neutre : la couleur appartient aux étapes.
 */
function Block({ block }: { block: PlanStepBlockView }) {
  // Le fil vit sur un conteneur et non sur la liste : `<ol>` n'accepte que des
  // `<li>` pour enfants, un `<span>` décoratif n'y a pas sa place.
  const steps = (
    <div className="relative min-w-0">
      <Thread />
      <ol className={STEP_GAP}>
        {block.steps.map((step, index) => (
          <Step key={index} step={step} />
        ))}
      </ol>
    </div>
  );

  if (block.repeat === 1) return <li className="min-w-0">{steps}</li>;

  return (
    <li className="min-w-0">
      <div className="flex items-center gap-2.5">
        <span className="num text-[0.8rem] leading-none font-medium text-fg">
          {block.repeat} ×
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-fg-faint/20" />
      </div>

      <div className="relative mt-2.5 min-w-0 pl-3.5">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-2 rounded-l-[5px] border-y border-l border-fg-faint/20"
        />
        {steps}
      </div>
    </li>
  );
}

function Step({ step }: { step: PlanStepView }) {
  const style = PLAN_STEP_ROLE_STYLES[step.role];
  // Sans mesure, la cible prend la vedette : une étape « Z2 » nue ne doit pas
  // s'afficher en second rôle sous un libellé qui, lui, serait seul en lumière.
  const lead = step.measure ?? step.target;
  const trailing = step.measure === null ? null : step.target;

  return (
    <li className={cn(RAIL_ROW, "min-w-0")}>
      <span aria-hidden="true" className={cn("relative rounded-full", style.rail)} />

      <div className="min-w-0 py-0.5">
        <p className={cn(ROLE_LABEL, style.label)}>{step.roleLabel}</p>

        {lead === null ? null : (
          <p className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="num text-[0.95rem] leading-tight font-medium text-fg">
              {lead}
            </span>
            {trailing === null ? null : (
              <span className="num text-[0.78rem] leading-tight text-fg-muted">
                {trailing}
              </span>
            )}
          </p>
        )}

        {/* `fg-faint` tient 4,6:1 sur `surface-2` — la brique teintée d'avant le
            faisait tomber sous le seuil, plus maintenant. */}
        {step.note === null ? null : (
          <p className="mt-1 text-[0.75rem] leading-snug text-fg-faint">{step.note}</p>
        )}
      </div>
    </li>
  );
}

/**
 * Une consigne en texte libre — même segment, même micro-label que les étapes.
 *
 * Seule différence : la valeur est une phrase, pas une mesure. Elle se pose donc
 * en `fg-muted` à la taille du corps, là où une étape mettrait ses chiffres.
 */
function Note({ note }: { note: PlanSessionNote }) {
  const style = PLAN_STEP_ROLE_STYLES[note.role];

  return (
    <div className={cn(RAIL_ROW, "min-w-0")}>
      <span aria-hidden="true" className={cn("relative rounded-full", style.rail)} />

      <div className="min-w-0 py-0.5">
        <dt className={cn(ROLE_LABEL, style.label)}>{note.label}</dt>
        <dd className="mt-1.5 text-[0.82rem] leading-snug text-fg-muted">{note.value}</dd>
      </div>
    </div>
  );
}
