import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import { formatMonthLabel } from "../_lib/calendar-model";
import {
  activitiesHref,
  shiftMonth,
  VIEW_OPTIONS,
  type CalendarViewParam,
} from "../_lib/calendar-params";

/**
 * La barre de commande de l'onglet : quelle vue, et quel mois.
 *
 * Des liens, jamais un état client — c'est le serveur qui relit la plage, l'URL
 * qui la porte, et un retour arrière retombe sur l'écran qu'on regardait. Même
 * grammaire que le filtre de période de « Progression », dont ce composant
 * reprend les classes : le système n'a qu'une façon de dessiner un segmenté.
 */

export type CalendarToolbarProps = {
  view: CalendarViewParam;
  /** Mois affiché, `YYYY-MM`. */
  month: string;
  /** Mois du jour — celui que l'URL n'a pas besoin de nommer. */
  currentMonth: string;
};

export function CalendarToolbar({ view, month, currentMonth }: CalendarToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav
        aria-label="Vue du calendrier"
        className="flex w-fit items-center gap-1 rounded-button border border-border p-0.5"
      >
        {VIEW_OPTIONS.map((option) => (
          <Link
            key={option.param}
            // La page n'est pas transmise : un rang de page appartient à la
            // liste qu'on quitte, pas à celle qu'on rouvre.
            href={activitiesHref({ view: option.param, month }, currentMonth)}
            scroll={false}
            aria-current={view === option.param ? "page" : undefined}
            className={cn(
              "rounded-[6px] px-2.5 py-1.5 text-[0.68rem] font-medium transition-colors duration-150 ease-out",
              view === option.param
                ? "bg-accent-soft text-accent"
                : "text-fg-faint hover:text-fg-muted",
            )}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {view === "calendrier" ? (
        <MonthNav month={month} currentMonth={currentMonth} />
      ) : null}
    </div>
  );
}

/**
 * Mois précédent, mois suivant, retour au mois courant.
 *
 * Les deux chevrons font 44 px de côté : ce sont des cibles tactiles, posées en
 * haut d'un écran qu'on consulte au bord de la piste. « Aujourd'hui » disparaît
 * quand on y est déjà — un lien qui ne mène nulle part n'est pas un lien.
 */
function MonthNav({ month, currentMonth }: { month: string; currentMonth: string }) {
  const arrow =
    "flex size-11 items-center justify-center rounded-button text-fg-faint transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg";

  return (
    <nav aria-label="Mois affiché" className="flex items-center gap-1">
      {currentMonth === month ? null : (
        <Link
          href={activitiesHref({ view: "calendrier", month: currentMonth }, currentMonth)}
          scroll={false}
          className="mr-1 inline-flex h-9 items-center gap-1.5 rounded-button px-2.5 text-[0.72rem] font-medium text-fg-faint transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg"
        >
          <CalendarDays aria-hidden="true" strokeWidth={1.8} className="size-3.5" />
          Aujourd&apos;hui
        </Link>
      )}

      <Link
        href={activitiesHref({ view: "calendrier", month: shiftMonth(month, -1) }, currentMonth)}
        scroll={false}
        aria-label="Mois précédent"
        className={arrow}
      >
        <ChevronLeft aria-hidden="true" strokeWidth={1.8} className="size-4" />
      </Link>

      <span
        aria-live="polite"
        className="num min-w-[7.5rem] text-center text-[0.82rem] font-medium text-fg"
      >
        {formatMonthLabel(month)}
      </span>

      <Link
        href={activitiesHref({ view: "calendrier", month: shiftMonth(month, 1) }, currentMonth)}
        scroll={false}
        aria-label="Mois suivant"
        className={arrow}
      >
        <ChevronRight aria-hidden="true" strokeWidth={1.8} className="size-4" />
      </Link>
    </nav>
  );
}
