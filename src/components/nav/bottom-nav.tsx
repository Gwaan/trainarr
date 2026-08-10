"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { isActivePath, NAV_LINKS } from "./nav-links";

/**
 * Navigation mobile : l'appli se consulte au bord de la piste.
 * Cibles tactiles ≥ 44 px et safe-area iOS respectée.
 */
export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navigation principale"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      {/* `grid-cols-*` calé sur le nombre d'onglets : cinq colonnes égales
          plutôt qu'un défilement horizontal, que personne ne devine. */}
      <ul className="grid grid-cols-5">
        {NAV_LINKS.map(({ href, label, icon: Icon }) => {
          const active = isActivePath(pathname, href);

          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-14 min-h-11 flex-col items-center justify-center gap-1 px-0.5",
                  "transition-colors duration-150 ease-out",
                  "before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-accent before:transition-opacity before:duration-150 before:ease-out",
                  active
                    ? "bg-accent-soft text-accent before:opacity-100"
                    : "text-fg-faint before:opacity-0 active:bg-surface-2",
                )}
              >
                <Icon
                  aria-hidden="true"
                  strokeWidth={active ? 2.2 : 1.75}
                  className="size-[19px]"
                />
                <span
                  className={cn(
                    // `truncate` en garde-fou : « Progression » tient de justesse
                    // sur un écran de 320 px, il ne doit jamais déborder.
                    "w-full truncate text-center text-[0.66rem] leading-none font-medium tracking-[0.01em]",
                    active && "text-fg",
                  )}
                >
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
