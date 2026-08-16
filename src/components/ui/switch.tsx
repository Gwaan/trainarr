"use client";

import type { ComponentProps } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Interrupteur « Pulse », bâti sur Radix — la base shadcn/ui du projet.
 *
 * Ce qu'on ne réécrit pas à la main : `role="switch"`, `aria-checked`, la
 * bascule à la barre d'espace, l'association au `<label htmlFor>` (Radix rend
 * un vrai `<button>` porteur de l'`id`) et un `<input>` masqué pour les
 * formulaires. Une `<div>` stylée n'aurait rien de tout cela.
 *
 * **Pourquoi un interrupteur et pas une case à cocher** : ces réglages
 * s'appliquent au clic, sans bouton « Enregistrer ». Une case à cocher promet
 * une soumission à venir ; un interrupteur dit que l'effet est immédiat.
 *
 * Couleurs : `accent` à l'état actif — c'est bien de la **sélection**, le rôle
 * que le système lui réserve — avec un curseur `bg` dessus (7,2:1). Jamais du
 * blanc sur `accent`, cf. `.claude/rules/design.md`.
 *
 * La cible tactile fait 44 px de haut malgré une piste de 24 px : le padding
 * vertical du conteneur est transparent, la piste seule est visible.
 */
function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "group inline-flex h-11 w-11 shrink-0 items-center justify-center",
        "rounded-button outline-offset-2 outline-accent focus-visible:outline-2",
        "disabled:pointer-events-none disabled:opacity-55",
        className,
      )}
      {...props}
    >
      {/* La piste : élément décoratif porté par le bouton, dont la surface
          cliquable reste à 44 px. */}
      <span
        aria-hidden="true"
        className={cn(
          "relative flex h-6 w-11 items-center rounded-full border transition-colors duration-150 ease-out",
          "border-border bg-surface-2",
          "group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent",
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            "block size-4.5 rounded-full transition-[translate,background-color] duration-150 ease-out",
            "translate-x-[3px] bg-fg-faint",
            "data-[state=checked]:translate-x-[23px] data-[state=checked]:bg-bg",
          )}
        />
      </span>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
