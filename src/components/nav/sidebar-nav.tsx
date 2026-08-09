"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { isActivePath, NAV_LINKS } from "./nav-links";

/** Navigation desktop. Seul morceau client du shell : il lui faut le pathname. */
export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Navigation principale" className="flex flex-col py-1">
      {NAV_LINKS.map(({ href, label, icon: Icon }) => {
        const active = isActivePath(pathname, href);

        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-3 px-5 py-2.5 text-sm font-medium",
              "transition-colors duration-150 ease-out",
              "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent before:transition-opacity before:duration-150 before:ease-out",
              active
                ? "bg-accent-soft text-fg before:opacity-100"
                : "text-fg-faint before:opacity-0 hover:bg-surface-2 hover:text-fg-muted",
            )}
          >
            <Icon
              aria-hidden="true"
              strokeWidth={active ? 2.2 : 1.75}
              className={cn(
                "size-[18px] shrink-0 transition-colors duration-150 ease-out",
                active ? "text-accent" : "text-fg-faint",
              )}
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
