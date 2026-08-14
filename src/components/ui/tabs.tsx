"use client";

import type { ComponentProps } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Onglets « Pulse », bâtis sur Radix — la base shadcn/ui du projet.
 *
 * Ce qu'on ne réécrit pas à la main : `role="tablist"`/`tab`/`tabpanel`,
 * `aria-selected`, la liaison onglet ↔ panneau (`aria-controls`,
 * `aria-labelledby`), le tabindex glissant (une seule tabulation traverse le
 * groupe) et la navigation aux flèches. Des `<button>` stylés n'auraient rien
 * de tout cela.
 *
 * Le rendu reprend le vocabulaire du segmenté déjà en place — filtre de période
 * de « Progression », bascules des graphes : une gouttière fine bordée, l'option
 * active seule sur `accent-soft`. Les onglets pilotent en revanche des
 * formulaires entiers, pas un axe de graphe : hauteur 44 px (cible tactile) et
 * libellés à la taille des étiquettes de champ, plutôt que le 0,68 rem d'un
 * réglage de graphe.
 */

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        // Colonnes de largeur égale : sur un téléphone étroit, trois onglets se
        // partagent la ligne plutôt que de déborder.
        "grid auto-cols-fr grid-flow-col gap-1 rounded-button border border-border p-0.5",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "flex h-11 min-w-0 items-center justify-center rounded-[6px] px-2",
        "text-[0.85rem] font-medium transition-colors duration-150 ease-out",
        "text-fg-faint hover:text-fg-muted",
        "data-[state=active]:bg-accent-soft data-[state=active]:text-accent",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Panneau d'un onglet.
 *
 * **`forceMount` n'est pas une optimisation, c'est une correction.** Radix
 * démonte par défaut le panneau inactif : passer de « Compte » à « Import »
 * puis revenir viderait le mot de passe à moitié tapé, et un `useActionState`
 * démonté perd aussi la bannière qui venait d'annoncer le résultat. Les trois
 * panneaux restent donc montés, et c'est `hidden` — que l'appelant pilote via
 * `active` — qui les retire de l'écran et de l'arbre d'accessibilité.
 *
 * Le `hidden` posé ici écrase délibérément celui de Radix : monté de force, il
 * considère le panneau présent, donc visible.
 */
function TabsContent({
  active,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content> & { active: boolean }) {
  return <TabsPrimitive.Content forceMount hidden={!active} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
