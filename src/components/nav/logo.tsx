import Link from "next/link";

import { cn } from "@/lib/utils";

/** Marque Trainarr : une piste d'athlétisme vue de dessus. */
export function TrackMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("size-6 shrink-0", className)}
    >
      <rect
        x="1.9"
        y="6.9"
        width="20.2"
        height="10.2"
        rx="5.1"
        className="stroke-accent"
        strokeWidth="1.8"
      />
      <rect
        x="7.4"
        y="10.4"
        width="9.2"
        height="3.2"
        rx="1.6"
        className="stroke-fg-faint"
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Trainarr — accueil"
      className={cn(
        "flex items-center gap-2.5 rounded-button transition-opacity duration-150 ease-out hover:opacity-80",
        className,
      )}
    >
      <TrackMark />
      <span className="text-[1.15rem] leading-none font-extrabold tracking-[-0.035em] text-fg">
        train<span className="text-accent">arr</span>
      </span>
    </Link>
  );
}
