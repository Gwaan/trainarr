import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Bouton shadcn/ui re-thémé « Night Track ».
 * Un seul CTA `accent` par écran ; le reste en `secondary` / `ghost`.
 * Hauteur par défaut 44 px : cible tactile mobile.
 */
const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-button text-sm font-semibold whitespace-nowrap select-none",
    "transition-[background-color,border-color,color,opacity] duration-150 ease-out",
    "disabled:pointer-events-none disabled:opacity-55",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      variant: {
        accent: "bg-accent text-bg hover:bg-accent/88 active:translate-y-px",
        secondary:
          "border border-border bg-surface-2 text-fg hover:border-fg-faint/35 hover:bg-surface-2/60",
        ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
      },
      size: {
        sm: "h-9 px-3 text-[0.8rem]",
        default: "h-11 px-4",
        lg: "h-12 px-5",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "accent",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
