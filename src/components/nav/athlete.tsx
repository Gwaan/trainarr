import { cn } from "@/lib/utils";

export type AthleteProfile = {
  name: string;
  /** Contexte court affiché sous le nom (objectif, semaine en cours…). */
  subtitle: string;
  initials: string;
};

export function AthleteAvatar({
  initials,
  className,
}: {
  initials: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-[0.72rem] font-semibold text-fg-muted",
        className,
      )}
    >
      {initials}
    </span>
  );
}
