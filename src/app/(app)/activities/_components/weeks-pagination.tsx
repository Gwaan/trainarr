import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { activitiesHref } from "../_lib/pagination";

/**
 * Navigation entre les pages de semaines.
 *
 * Des liens, jamais un état client : c'est le serveur qui relit les semaines,
 * l'URL qui porte la page, et un retour arrière retombe sur ce qu'on regardait.
 * Même grammaire — et mêmes classes — que la navigation de mois du plan
 * (`plan/_components/plan-calendar-toolbar.tsx`) : le système n'a qu'une façon
 * de dessiner une paire de chevrons.
 *
 * Les deux chevrons font 44 px de côté : ce sont des cibles tactiles. Une
 * extrémité de l'historique ne rend pas un lien désactivé mais **rien** — un
 * lien qui ne mène nulle part n'est pas un lien.
 */

export type WeeksPaginationProps = {
  /** Rang de la page affichée, 1 = les semaines les plus récentes. */
  page: number;
  /** `true` s'il reste des semaines plus anciennes au-delà de cette page. */
  hasOlder: boolean;
  /** Repère de position : la plage de dates affichée. */
  span: string;
};

const ARROW =
  "flex size-11 items-center justify-center rounded-button text-fg-faint transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-fg";

/** Emplacement d'un chevron absent : la ligne garde sa géométrie aux extrémités. */
const ARROW_PLACEHOLDER = "size-11";

export function WeeksPagination({ page, hasOlder, span }: WeeksPaginationProps) {
  const hasNewer = page > 1;

  return (
    <nav
      aria-label="Pages de l'historique"
      className="flex items-center justify-between gap-3"
    >
      {hasNewer ? (
        <Link
          href={activitiesHref(page - 1)}
          scroll={false}
          aria-label="Semaines plus récentes"
          className={ARROW}
        >
          <ChevronLeft aria-hidden="true" strokeWidth={1.8} className="size-4" />
        </Link>
      ) : (
        <span aria-hidden="true" className={ARROW_PLACEHOLDER} />
      )}

      <p
        aria-live="polite"
        className="num min-w-0 truncate text-center text-[0.78rem] text-fg-muted"
      >
        {span}
      </p>

      {hasOlder ? (
        <Link
          href={activitiesHref(page + 1)}
          scroll={false}
          aria-label="Semaines plus anciennes"
          className={ARROW}
        >
          <ChevronRight aria-hidden="true" strokeWidth={1.8} className="size-4" />
        </Link>
      ) : (
        <span aria-hidden="true" className={ARROW_PLACEHOLDER} />
      )}
    </nav>
  );
}
