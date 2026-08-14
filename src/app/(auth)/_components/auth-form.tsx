import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Les briques communes aux deux écrans d'identité : même trame de champ, même
 * bouton, mêmes tailles. Les deux formulaires ne diffèrent que par leurs champs
 * et leur action.
 */

/** Concatène les `id` de description d'un champ, en écartant ceux qui n'existent pas. */
function describedBy(...ids: (string | false)[]): string | undefined {
  const kept = ids.filter((id) => id !== false);
  return kept.length > 0 ? kept.join(" ") : undefined;
}

export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 sm:p-6">
      {children}
    </div>
  );
}

export function AuthHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-[1.5rem] leading-tight font-extrabold tracking-[-0.035em] text-fg">
        {title}
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{subtitle}</p>
    </div>
  );
}

export type AuthFieldProps = {
  id: string;
  name: string;
  label: string;
  /** Ligne d'aide sous le libellé — omise quand le champ se suffit. */
  hint?: string;
  error?: string;
  type: "text" | "email" | "password";
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
};

/**
 * Un champ : libellé, aide, saisie, erreur.
 *
 * **`text-base` n'est pas décoratif** : en dessous de 16 px, iOS zoome à la
 * prise de focus, et en PWA `standalone` aucun geste ne ramène en arrière —
 * l'écran de connexion resterait agrandi et tronqué. Il l'emporte donc sur la
 * taille par défaut de `Input`.
 */
export function AuthField({
  id,
  name,
  label,
  hint,
  error,
  type,
  autoComplete,
  value,
  onChange,
}: AuthFieldProps) {
  const isEmail = type === "email";

  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="block text-[0.85rem] font-medium text-fg"
      >
        {label}
      </label>
      {hint ? (
        <p
          id={`${id}-hint`}
          className="mt-1 text-[0.76rem] leading-snug text-fg-faint"
        >
          {hint}
        </p>
      ) : null}
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        // Un e-mail saisi au pouce : clavier dédié, pas de majuscule
        // automatique, pas de correction — trois sources d'erreur en moins.
        inputMode={isEmail ? "email" : undefined}
        autoCapitalize={isEmail ? "none" : undefined}
        autoCorrect={isEmail ? "off" : undefined}
        spellCheck={isEmail ? false : undefined}
        aria-required="true"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(
          Boolean(hint) && `${id}-hint`,
          Boolean(error) && `${id}-error`,
        )}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn("text-base", hint ? "mt-2" : "mt-1.5")}
      />
      {error ? (
        <p
          id={`${id}-error`}
          className="mt-1.5 text-[0.76rem] leading-snug text-negative"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Le seul CTA accent de l'écran. */
export function AuthSubmit({
  pending,
  label,
  pendingLabel,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
}) {
  return (
    <Button
      type="submit"
      size="lg"
      disabled={pending}
      aria-busy={pending}
      className="w-full"
    >
      {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
      {pending ? pendingLabel : label}
    </Button>
  );
}
