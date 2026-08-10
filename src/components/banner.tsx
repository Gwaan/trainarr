import type { ReactNode } from "react";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Bandeau de retour d'action (retour OAuth, résultat de synchronisation…).
 *
 * Les tons sont sémantiques, jamais l'accent : celui-ci reste réservé aux
 * actions. Pas de fermeture — un bandeau porté par l'URL disparaît à la
 * navigation suivante.
 */
export type BannerTone = "positive" | "neutral" | "negative";

const TONES: Record<
  BannerTone,
  { icon: LucideIcon; role: "status" | "alert"; container: string; iconColor: string }
> = {
  positive: {
    icon: CircleCheck,
    role: "status",
    container: "border-positive/30 bg-positive/10",
    iconColor: "text-positive",
  },
  neutral: {
    icon: Info,
    role: "status",
    container: "border-border bg-surface-2",
    iconColor: "text-fg-faint",
  },
  negative: {
    icon: TriangleAlert,
    role: "alert",
    container: "border-negative/35 bg-negative/10",
    iconColor: "text-negative",
  },
};

export type BannerProps = {
  tone: BannerTone;
  title: string;
  /** Détail sous le titre — texte ou contenu court (liste de variables…). */
  children?: ReactNode;
  className?: string;
};

export function Banner({ tone, title, children, className }: BannerProps) {
  const { icon: Icon, role, container, iconColor } = TONES[tone];

  return (
    <div
      role={role}
      className={cn(
        "flex items-start gap-3 rounded-card border px-4 py-3",
        container,
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.8}
        className={cn("mt-0.5 size-[1.05rem]", iconColor)}
      />
      <div className="min-w-0">
        <p className="text-[0.9rem] font-semibold text-fg">{title}</p>
        {children ? (
          <div className="mt-1 text-[0.82rem] leading-relaxed text-fg-muted">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
