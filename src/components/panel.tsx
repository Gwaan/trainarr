import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type PanelProps = {
  title: string;
  /** Contenu discret aligné à droite du titre (période, lien « tout voir »…). */
  meta?: ReactNode;
  children: ReactNode;
  /** `false` quand le contenu gère lui-même ses marges (listes pleine largeur). */
  padded?: boolean;
  className?: string;
};

/** Card « Night Track » : surface + bordure, jamais d'ombre portée. */
export function Panel({
  title,
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
        <h2 className="eyebrow">{title}</h2>
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
