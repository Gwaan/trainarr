"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

import { AthleteAvatar, type AthleteProfile } from "./athlete";
import { isActivePath } from "./nav-links";

/**
 * Le bloc athlète mène au profil — c'est là qu'on le crée puis qu'on le
 * modifie. Client comme le reste de la nav : il lui faut le pathname pour
 * porter le même état actif que les autres items.
 */

const PROFILE_HREF = "/profile";

/** Sous-titre par défaut : sans lui, rien ne dit que le bloc est cliquable. */
const PROFILE_CAPTION = "Voir mon profil";

/** Bloc en pied de sidebar : avatar, nom, légende. */
export function AthleteLink({ athlete }: { athlete: AthleteProfile }) {
  const active = isActivePath(usePathname(), PROFILE_HREF);

  return (
    <Link
      href={PROFILE_HREF}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 px-5 py-3",
        "transition-colors duration-150 ease-out",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent before:transition-opacity before:duration-150 before:ease-out",
        active
          ? "bg-accent-soft before:opacity-100"
          : "before:opacity-0 hover:bg-surface-2",
      )}
    >
      <AthleteAvatar
        initials={athlete.initials}
        className={cn(active && "border-accent/50 bg-accent-soft text-accent")}
      />
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate text-[0.82rem] leading-tight font-medium",
            active ? "text-fg" : "text-fg-muted",
          )}
        >
          {athlete.name}
        </span>
        <span className="eyebrow mt-1 block truncate">
          {athlete.subtitle ?? PROFILE_CAPTION}
        </span>
      </span>
    </Link>
  );
}

/** Équivalent mobile : l'avatar de la barre supérieure, seul point d'entrée. */
export function AthleteAvatarLink({ athlete }: { athlete: AthleteProfile }) {
  const active = isActivePath(usePathname(), PROFILE_HREF);

  return (
    <Link
      href={PROFILE_HREF}
      aria-current={active ? "page" : undefined}
      aria-label="Mon profil"
      // Avatar de 28 px, cible tactile de 44 px : le débord compense le padding
      // de l'en-tête pour que l'avatar reste aligné sur les autres écrans.
      className="-mr-2.5 flex size-11 items-center justify-center rounded-full"
    >
      <AthleteAvatar
        initials={athlete.initials}
        className={cn(
          "size-7",
          active && "border-accent/50 bg-accent-soft text-accent",
        )}
      />
    </Link>
  );
}
