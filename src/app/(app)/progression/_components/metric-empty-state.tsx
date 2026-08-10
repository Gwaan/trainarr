import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { EmptyState } from "@/components/empty-state";

import type { MetricUnavailableCopy } from "../../_lib/metric-unavailable";

export type MetricEmptyStateProps = MetricUnavailableCopy & { icon: LucideIcon };

/**
 * État vide d'un panneau de graphe, alimenté par la cause réelle calculée par le
 * DAL — jamais un message générique qui récite toutes les conditions possibles.
 *
 * Le pendant de `MetricPlaceholder`, qui remplit une carte d'indicateur : ici on
 * occupe un panneau, dont la surface et la bordure existent déjà.
 */
export function MetricEmptyState({
  icon,
  title,
  description,
  action,
}: MetricEmptyStateProps) {
  return (
    <EmptyState
      className="my-auto"
      icon={icon}
      title={title}
      description={description}
      action={
        action ? (
          <Link
            href={action.href}
            className="inline-flex items-center gap-0.5 rounded-button text-[0.82rem] font-medium text-fg-muted transition-colors duration-150 ease-out hover:text-accent"
          >
            {action.label}
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : undefined
      }
    />
  );
}
