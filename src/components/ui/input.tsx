import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Champ de saisie shadcn/ui re-thémé « Night Track ».
 *
 * Fond `surface-2` sur les cartes `surface` : le champ se lit comme un creux,
 * sans ombre. Hauteur 44 px — même cible tactile que les boutons. Le focus
 * visible vient de la règle globale (`:focus-visible`), jamais d'un ring local.
 */
function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        // 16 px minimum, pas une coquetterie : en dessous, iOS zoome la page à la
        // prise de focus, et en PWA `standalone` rien ne permet de revenir en
        // arrière — la page reste plus large que l'écran et glisse sous le doigt.
        "h-11 w-full rounded-button border border-border bg-surface-2 px-3 text-base text-fg",
        "transition-colors duration-150 ease-out",
        "placeholder:text-fg-faint hover:border-fg-faint/35",
        "aria-invalid:border-negative/60",
        "disabled:pointer-events-none disabled:opacity-55",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
