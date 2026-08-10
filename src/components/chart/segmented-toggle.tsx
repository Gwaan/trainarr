"use client";

import { cn } from "@/lib/utils";

export type SegmentedOption<V extends string> = {
  value: V;
  label: string;
};

export type SegmentedToggleProps<V extends string> = {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (next: V) => void;
  /** Ce que le groupe commande, pour les lecteurs d'écran (ex. « Axe horizontal »). */
  ariaLabel: string;
};

/**
 * Choix exclusif entre deux ou trois options, posé dans le `meta` d'un panneau :
 * assez discret pour ne pas concurrencer le CTA accent de l'écran, l'option
 * active portant seule le fond `accent-soft`.
 */
export function SegmentedToggle<V extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedToggleProps<V>) {
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      className="flex items-center gap-1 rounded-button border border-border p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[6px] px-2 py-1 text-[0.68rem] font-medium transition-colors duration-150 ease-out",
            value === option.value
              ? "bg-accent-soft text-accent"
              : "text-fg-faint hover:text-fg-muted",
          )}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
