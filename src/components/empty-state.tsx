import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
};

/** État vide dessiné — jamais de zone vide brute, jamais de « coming soon ». */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center px-6 py-12 text-center sm:py-16",
        className,
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-full border border-border bg-surface-2">
        <Icon aria-hidden="true" strokeWidth={1.6} className="size-6 text-fg-faint" />
      </span>
      <h3 className="mt-5 text-base font-semibold text-fg">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-balance text-fg-muted">
        {description}
      </p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
