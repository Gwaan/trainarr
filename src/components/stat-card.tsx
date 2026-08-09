import { ArrowDown, ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";

export type StatTone = "default" | "accent" | "positive" | "warning" | "negative";

export type StatDelta = {
  /** Variation déjà formatée, ex. « +0.4 ». */
  value: string;
  direction: "up" | "down";
  /** Le sens (bon / mauvais) dépend de la métrique : jamais déduit de la direction. */
  tone: Extract<StatTone, "positive" | "warning" | "negative">;
};

export type StatCardProps = {
  label: string;
  /** Valeur déjà formatée — rendue en mono tabulaire. */
  value: string;
  delta?: StatDelta;
  tone?: StatTone;
  /** Courte lecture de la valeur, ex. « fatigue — allège jeudi ». */
  note?: string;
  className?: string;
};

const TONE_TEXT: Record<StatTone, string> = {
  default: "text-fg",
  accent: "text-accent",
  positive: "text-positive",
  warning: "text-warning",
  negative: "text-negative",
};

const DELTA_LABEL: Record<StatDelta["direction"], string> = {
  up: "en hausse de",
  down: "en baisse de",
};

export function StatCard({
  label,
  value,
  delta,
  tone = "default",
  note,
  className,
}: StatCardProps) {
  const DeltaIcon = delta?.direction === "down" ? ArrowDown : ArrowUp;

  return (
    <article
      className={cn(
        "rounded-card border border-border bg-surface p-4 transition-colors duration-150 ease-out hover:border-fg-faint/25 sm:p-5",
        className,
      )}
    >
      <h3 className="eyebrow">{label}</h3>

      <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn(
            "num text-[1.9rem] leading-none font-semibold sm:text-[2.3rem]",
            TONE_TEXT[tone],
          )}
        >
          {value}
        </span>
        {delta ? (
          <span
            className={cn(
              "num inline-flex items-center gap-0.5 text-[0.78rem] font-medium",
              TONE_TEXT[delta.tone],
            )}
          >
            <DeltaIcon aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
            <span className="sr-only">{DELTA_LABEL[delta.direction]} </span>
            {delta.value}
          </span>
        ) : null}
      </p>

      {note ? (
        <p className="mt-2.5 text-[0.78rem] leading-snug text-fg-muted">{note}</p>
      ) : null}
    </article>
  );
}
