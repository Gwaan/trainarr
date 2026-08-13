"use client";

import type { ComponentProps } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Boîte de dialogue modale « Night Track », bâtie sur Radix — la base shadcn/ui
 * du projet.
 *
 * Ce qu'on ne réécrit pas à la main : focus piégé, `aria-modal`, titre lié à la
 * boîte, `Esc`, retour du focus au déclencheur à la fermeture, défilement de la
 * page bloqué. Une modale contrôlée (`open` + `onOpenChange`) peut refuser de se
 * fermer — c'est ainsi que la création de plan confirme avant d'abandonner une
 * saisie, et se verrouille pendant la génération.
 *
 * Mobile d'abord : plein écran sous `sm` (c'est l'écran principal), dialogue
 * centré au-dessus. Pas d'ombre portée — le contraste vient des fonds
 * superposés. L'apparition se joue en 150 ms `ease-out` via `@starting-style` ;
 * `prefers-reduced-motion` la neutralise (règle globale de `globals.css`).
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;

function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-50 bg-bg/80 opacity-100",
          "transition-opacity duration-150 ease-out starting:opacity-0",
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-0 z-50 flex flex-col overflow-hidden bg-surface",
          /*
           * En plein écran, la boîte s'étend sous la barre d'état depuis que
           * `viewport-fit=cover` est actif — et l'en-tête s'y retrouvait. iOS
           * ne délivre aucun événement tactile dans cette bande : le bouton
           * « Fermer », qui est la **seule** sortie d'un plein écran (pas
           * d'extérieur à cliquer, pas d'`Esc` sur un téléphone), y était donc
           * intapable. La modale ne se quittait plus.
           *
           * Du padding, jamais de la marge : `bg-surface` doit continuer à
           * couvrir l'écran bord à bord, barre d'état comprise. Le bas est déjà
           * traité par la barre d'actions, qui doit dégager l'indicateur
           * d'accueil sans quoi « Suivant » tomberait dessous.
           */
          "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]",
          "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2",
          /*
           * La boîte centrée, elle, est détachée des bords du viewport — et
           * `env()` se mesure toujours contre le viewport, jamais contre
           * l'élément. Ces trois marges n'y seraient plus qu'un décalage
           * arbitraire : on les remet à zéro.
           */
          "sm:pt-0 sm:pr-0 sm:pl-0",
          "sm:max-h-[min(46rem,calc(100dvh-3rem))] sm:w-[min(38rem,calc(100vw-2.5rem))]",
          "sm:rounded-card sm:border sm:border-border",
          "opacity-100 transition-[opacity,scale] duration-150 ease-out sm:scale-100",
          "starting:opacity-0 sm:starting:scale-[0.98]",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Titre de la boîte — Radix le lie à `aria-labelledby`, il est donc obligatoire. */
function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-base font-semibold text-fg", className)}
      {...props}
    />
  );
}

/** Sous-titre lié à `aria-describedby` : ce que la boîte va demander. */
function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("mt-0.5 text-[0.8rem] leading-snug text-fg-faint", className)}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger };
