import { Check } from "lucide-react";

// Le format d'une distance d'étape appartient au plan, et c'est bien la même
// mesure qui est citée ici (« 6 × 800 m ») : un second format aurait fini par
// écrire « 0,8 km » à côté du déroulé qui écrit « 800 m ».
import { formatStepDistance } from "@/app/(app)/plan/_lib/session-detail";
import { Panel } from "@/components/panel";
import type { SessionExecution } from "@/lib/metrics";
import { cn } from "@/lib/utils";

import { MetricInfo } from "../../../_components/metric-info";
import {
  executionBars,
  executionGapTexts,
  executionHeadline,
  type ExecutionBar,
} from "../_lib/session-execution-model";

/**
 * Ce que la séance du plan demandait, et ce qui en a été fait.
 *
 * Une barre de type *bullet* par cible : la **bande visée** en aplat sourd, le
 * **réalisé** en marqueur clair par-dessus, et sous la barre la cible et l'écart
 * écrits en toutes lettres. Sur une séance à blocs, une barre par répétition,
 * précédée du compte de celles qui sont tombées dans la bande.
 *
 * ## Ce que la couleur ne fait pas ici
 *
 * Toutes les barres portent le même habillage, quelle que soit la mesure, et
 * aucune ne change de couleur selon le résultat : courir plus vite que la bande
 * d'un footing est un écart au même titre que courir plus lentement, et le
 * peindre en vert (ou en rouge) serait un jugement que les données ne portent
 * pas. Le seul jeton sémantique employé est `positive`, en **coche** sur les
 * lignes dans la bande — jamais en remplissage (cf. `.claude/rules/design.md`).
 *
 * L'aplat est en `fg-faint` et le rail en `bg` : c'est ce couple qui tient les
 * 3:1 de WCAG 1.4.11 pour un élément graphique porteur d'information, et le
 * marqueur en `fg` se détache des deux.
 */
export function SessionGoalsPanel({
  execution,
  className,
}: {
  execution: SessionExecution;
  className?: string;
}) {
  const bars = executionBars(execution);
  const headline = executionHeadline(execution);
  const gaps = executionGapTexts(execution);
  const { repeats } = execution;

  return (
    <Panel
      title="Objectifs de la séance"
      info={<MetricInfo id="session-goals" />}
      meta={
        repeats === null ? null : (
          <span className="num">
            {repeats.count} × {formatStepDistance(repeats.distanceM)}
          </span>
        )
      }
      className={className}
    >
      {/* Le résumé avant le détail : ce que l'œil doit emporter s'il ne lit
          qu'une ligne. */}
      {headline === null ? null : (
        <p className="text-[0.85rem] leading-snug text-fg">{headline}</p>
      )}

      {bars.length === 0 ? null : (
        <ul className={cn("flex flex-col gap-4", headline !== null && "mt-4")}>
          {bars.map((bar) => (
            <GoalBar key={bar.key} bar={bar} />
          ))}
        </ul>
      )}

      {gaps.length === 0 ? null : (
        <ul
          // Le filet ne sépare que s'il y a quelque chose à séparer : sous
          // l'en-tête du panneau, il ferait une seconde ligne pour rien.
          className={cn(
            "flex flex-col gap-1.5",
            (headline !== null || bars.length > 0) && "mt-4 border-t border-border pt-3",
          )}
        >
          {gaps.map((gap) => (
            <li key={gap} className="text-[0.72rem] leading-relaxed text-fg-faint">
              {gap}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Une cible : son libellé, son réalisé, sa barre, sa légende écrite. */
function GoalBar({ bar }: { bar: ExecutionBar }) {
  return (
    <li className="flex flex-col gap-1.5">
      <p className="flex items-baseline justify-between gap-3">
        <span className="text-[0.78rem] font-medium text-fg-muted">{bar.label}</span>
        <span className="num shrink-0 text-[0.82rem] text-fg">{bar.value}</span>
      </p>

      {/* Rail en `bg` — le fond le plus profond de la palette, celui contre
          lequel l'aplat garde ses 3:1. La barre est décorative : tout ce
          qu'elle montre est écrit au-dessus et en dessous. */}
      <span aria-hidden="true" className="relative block h-2.5 rounded-[3px] bg-bg">
        {bar.geometry.kind === "band" ? (
          <span
            className="absolute inset-y-0 rounded-[3px] bg-fg-faint"
            style={{
              left: `${bar.geometry.bandStartPct.toFixed(1)}%`,
              width: `${bar.geometry.bandWidthPct.toFixed(1)}%`,
            }}
          />
        ) : (
          <span
            className="absolute inset-y-0 left-0 rounded-[3px] bg-fg-faint"
            style={{ width: `${bar.geometry.targetWidthPct.toFixed(1)}%` }}
          />
        )}

        {/* Le marqueur déborde le rail de 2 px en haut et en bas : posé à
            l'intérieur, il se confondrait avec l'aplat qu'il traverse. */}
        <span
          className="absolute -top-0.5 -bottom-0.5 w-[3px] -translate-x-1/2 rounded-full bg-fg"
          style={{ left: `${bar.geometry.markerPct.toFixed(1)}%` }}
        />
      </span>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-fg-faint">
        <span>{bar.target}</span>
        {bar.delta === null ? (
          <span className="inline-flex items-center gap-1 text-fg-muted">
            {/* La coche accompagne les mots, elle ne les remplace pas : la
                couleur ne porte jamais l'information seule. */}
            <Check aria-hidden="true" strokeWidth={2.5} className="size-3 text-positive" />
            dans la bande
          </span>
        ) : (
          <span className="num text-fg-muted">{bar.delta}</span>
        )}
      </p>
    </li>
  );
}
