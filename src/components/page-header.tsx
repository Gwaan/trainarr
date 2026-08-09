import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type PageHeaderProps = {
  /** Micro-label au-dessus du titre (date, section…). */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
};

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn("flex flex-wrap items-end justify-between gap-4", className)}
    >
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow num">{eyebrow}</p> : null}
        <h1
          className={cn(
            "text-[1.6rem] leading-tight font-extrabold tracking-[-0.035em] text-fg sm:text-[1.9rem]",
            eyebrow && "mt-2",
          )}
        >
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
