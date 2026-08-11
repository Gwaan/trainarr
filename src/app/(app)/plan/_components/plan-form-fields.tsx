"use client";

import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Les briques de saisie du formulaire de création, partagées par ses étapes.
 *
 * Extraites de l'ancien formulaire d'une seule pièce : une étape ne décrit plus
 * que ses champs, la trame (libellé, aide, erreur) est la même partout.
 */

/** Concatène les `id` de description d'un champ, en écartant ceux qui n'existent pas. */
export function describedBy(...ids: (string | false)[]): string | undefined {
  const kept = ids.filter((id) => id !== false);
  return kept.length > 0 ? kept.join(" ") : undefined;
}

export function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="mt-1.5 text-[0.76rem] leading-snug text-negative">
      {message}
    </p>
  );
}

/** Trame commune d'un champ : libellé, ligne d'aide, saisie, erreur. */
export function Field({
  id,
  label,
  hint,
  error,
  optional,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="flex flex-wrap items-baseline gap-x-2 text-[0.85rem] font-medium text-fg"
      >
        {label}
        {optional ? (
          <span className="text-[0.72rem] font-normal text-fg-faint">facultatif</span>
        ) : null}
      </label>
      <p id={`${id}-hint`} className="mt-1 text-[0.76rem] leading-snug text-fg-faint">
        {hint}
      </p>
      <div className="mt-2">{children}</div>
      {error ? <FieldError id={`${id}-error`} message={error} /> : null}
    </div>
  );
}

/**
 * Choix exclusif présenté en cartes : libellé, pastille et phrase d'aide.
 *
 * Deux groupes s'en servent (type d'objectif, niveau) et ils doivent rester
 * visuellement identiques — d'où un composant plutôt qu'un second bloc recopié,
 * qui divergerait à la première retouche.
 */
export function RadioCards<T extends string>({
  name,
  legend,
  choices,
  value,
  onChange,
  error,
  errorId,
  columns,
}: {
  name: string;
  legend: string;
  choices: readonly { value: T; label: string; hint: string }[];
  value: T;
  onChange: (value: T) => void;
  error?: string;
  /** Identifiant du message d'erreur, référencé par le `fieldset`. */
  errorId: string;
  /** Classe de grille appliquée à partir de `sm` — deux ou trois colonnes. */
  columns: string;
}) {
  return (
    <fieldset className="min-w-0" aria-describedby={describedBy(Boolean(error) && errorId)}>
      <legend className="text-[0.85rem] font-medium text-fg">{legend}</legend>

      <div className={cn("mt-2 grid gap-2", columns)}>
        {choices.map((choice) => {
          const checked = value === choice.value;

          return (
            <label
              key={choice.value}
              className={cn(
                "cursor-pointer rounded-button border px-3 py-2.5",
                "transition-colors duration-150 ease-out",
                // Le radio natif est masqué : le focus clavier est reporté
                // sur l'étiquette entière, sans quoi il disparaîtrait.
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                checked
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-surface-2 hover:border-fg-faint/35",
              )}
            >
              <span className="flex items-center gap-2.5">
                <input
                  type="radio"
                  name={name}
                  value={choice.value}
                  checked={checked}
                  onChange={() => onChange(choice.value)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-[1.05rem] shrink-0 items-center justify-center rounded-full border",
                    checked ? "border-accent" : "border-fg-faint",
                  )}
                >
                  {checked ? <span className="size-2 rounded-full bg-accent" /> : null}
                </span>
                <span
                  className={cn("text-[0.85rem]", checked ? "font-medium text-fg" : "text-fg-muted")}
                >
                  {choice.label}
                </span>
              </span>
              <span className="mt-1.5 block text-[0.74rem] leading-snug text-fg-faint">
                {choice.hint}
              </span>
            </label>
          );
        })}
      </div>

      {error ? <FieldError id={errorId} message={error} /> : null}
    </fieldset>
  );
}

/**
 * Liste déroulante native, habillée aux tokens du champ de saisie : sur mobile
 * elle ouvre le sélecteur du système, qu'aucun composant maison n'égale.
 */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className={cn("relative", className)}>
      <select
        {...props}
        className={cn(
          "h-11 w-full appearance-none rounded-button border border-border bg-surface-2 pr-9 pl-3",
          "text-[0.95rem] text-fg transition-colors duration-150 ease-out",
          "hover:border-fg-faint/35 aria-invalid:border-negative/60",
        )}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 my-auto size-4 text-fg-faint"
      />
    </div>
  );
}
