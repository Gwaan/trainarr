import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type MetricPlaceholderProps = {
  icon: LucideIcon;
  /** Même libellé que la carte qu'elle remplace. */
  label: string;
  title: string;
  /** Ce qui manque, et comment l'obtenir. */
  description: string;
  /**
   * Où lever l'obstacle, quand il y a un endroit où le faire. Lien discret et
   * non un bouton accent : le tableau de bord n'en porte qu'un.
   */
  action?: { href: string; label: string };
  className?: string;
};

/**
 * Carte d'indicateur sans donnée : occupe la place d'une `StatCard` et explique
 * ce qui manque. La bordure pointillée signale « à venir » sans nouvelle couleur.
 */
export function MetricPlaceholder({
  icon: Icon,
  label,
  title,
  description,
  action,
  className,
}: MetricPlaceholderProps) {
  return (
    <article
      className={cn(
        "flex flex-col rounded-card border border-dashed border-border bg-surface p-4 sm:p-5",
        className,
      )}
    >
      <h3 className="eyebrow">{label}</h3>
      <p className="mt-3 flex items-center gap-2 text-[0.95rem] leading-tight font-semibold text-fg-muted">
        <Icon aria-hidden="true" strokeWidth={1.8} className="size-4 shrink-0 text-fg-faint" />
        {title}
      </p>
      <p className="mt-2 text-[0.78rem] leading-snug text-fg-faint">{description}</p>
      {action ? (
        <Link
          href={action.href}
          className="mt-3 inline-flex items-center gap-0.5 self-start rounded-button text-[0.78rem] font-medium text-fg-muted transition-colors duration-150 ease-out hover:text-accent"
        >
          {action.label}
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </Link>
      ) : null}
    </article>
  );
}
