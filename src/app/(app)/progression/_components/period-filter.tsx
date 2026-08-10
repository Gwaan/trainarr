import Link from "next/link";

import { cn } from "@/lib/utils";

import { RANGE_OPTIONS, rangeHref, type RangeParam } from "../_lib/range";

/**
 * Filtre de période — **une seule ligne au-dessus de tous les graphes**, jamais
 * un filtre par graphe : la page raconte une période, et deux blocs qui ne
 * couvriraient pas la même seraient impossibles à comparer.
 *
 * Des liens plutôt qu'un état client : c'est le serveur qui refiltre, l'URL
 * porte la période, et un retour arrière retombe sur ce qu'on regardait. Le
 * rendu reprend les classes de `SegmentedToggle`, dont c'est le pendant client.
 */
export function PeriodFilter({ active }: { active: RangeParam }) {
  return (
    <nav
      aria-label="Période affichée"
      className="flex w-fit items-center gap-1 rounded-button border border-border p-0.5"
    >
      {RANGE_OPTIONS.map((option) => (
        <Link
          key={option.param}
          href={rangeHref(option.param)}
          scroll={false}
          aria-current={active === option.param ? "page" : undefined}
          className={cn(
            "rounded-[6px] px-2 py-1 text-[0.68rem] font-medium transition-colors duration-150 ease-out",
            active === option.param
              ? "bg-accent-soft text-accent"
              : "text-fg-faint hover:text-fg-muted",
          )}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
