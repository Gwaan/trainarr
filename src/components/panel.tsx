import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type PanelProps = {
  title: string;
  /**
   * Déclencheur d'explication posé à droite du titre (un ⓘ). Un `ReactNode` :
   * cette primitive partagée n'a pas à connaître le catalogue des fiches.
   */
  info?: ReactNode;
  /** Contenu discret aligné à droite du titre (période, lien « tout voir »…). */
  meta?: ReactNode;
  children: ReactNode;
  /** `false` quand le contenu gère lui-même ses marges (listes pleine largeur). */
  padded?: boolean;
  className?: string;
};

/** Card « Pulse » : surface + bordure, jamais d'ombre portée. */
export function Panel({
  title,
  info,
  meta,
  children,
  padded = true,
  className,
}: PanelProps) {
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-card border border-border bg-surface",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        {/* Flex plutôt que texte nu : le ⓘ se pose au bout du titre sans le
            faire déborder, et le titre garde son droit de passer à la ligne. */}
        <h2 className="eyebrow flex min-w-0 items-center gap-1.5">
          {title}
          {info}
        </h2>
        {meta ? (
          <div className="flex shrink-0 items-center gap-2 text-[0.7rem] text-fg-faint">
            {meta}
          </div>
        ) : null}
      </header>
      {/* Colonne flex : les enfants peuvent occuper la hauteur restante (graphes). */}
      <div className={cn("flex flex-1 flex-col", padded && "p-4 sm:p-5")}>
        {children}
      </div>
    </section>
  );
}
