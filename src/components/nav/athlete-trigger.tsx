"use client";

import { cn } from "@/lib/utils";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

import { AthleteAvatar, type AthleteProfile } from "./athlete";

/**
 * Le bloc athlète ouvre les réglages — profil, compte, import — dans une modale,
 * plutôt que de mener à une page.
 *
 * Ce sont des `<button>`, pas des liens : ils ne changent pas d'URL. Ils
 * n'empruntent donc pas non plus l'état actif des items de navigation
 * (`aria-current="page"`), mais celui d'un déclencheur de boîte de dialogue —
 * `aria-haspopup` et `aria-expanded` — et le même traitement visuel tant qu'elle
 * est ouverte.
 *
 * Le déclencheur se transmet à l'ouverture : c'est à lui que le focus revient à
 * la fermeture.
 */

/** Sous-titre : sans lui, rien ne dit que le bloc est actionnable. */
const SETTINGS_CAPTION = "Réglages";

/** Bloc en pied de sidebar : avatar, nom, légende. */
export function AthleteTrigger({ athlete }: { athlete: AthleteProfile }) {
  const { isOpen, open } = useSettingsDialog();

  return (
    <button
      type="button"
      onClick={(event) => open(event.currentTarget)}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      className={cn(
        "relative flex w-full items-center gap-3 px-5 py-3 text-left",
        "transition-colors duration-150 ease-out",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent before:transition-opacity before:duration-150 before:ease-out",
        isOpen
          ? "bg-accent-soft before:opacity-100"
          : "before:opacity-0 hover:bg-surface-2",
      )}
    >
      <AthleteAvatar
        initials={athlete.initials}
        className={cn(isOpen && "border-accent/50 bg-accent-soft text-accent")}
      />
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate text-[0.82rem] leading-tight font-medium",
            isOpen ? "text-fg" : "text-fg-muted",
          )}
        >
          {athlete.name}
        </span>
        <span className="eyebrow mt-1 block truncate">
          {athlete.subtitle ?? SETTINGS_CAPTION}
        </span>
      </span>
    </button>
  );
}

/** Équivalent mobile : l'avatar de la barre supérieure, seul point d'entrée. */
export function AthleteAvatarTrigger({ athlete }: { athlete: AthleteProfile }) {
  const { isOpen, open } = useSettingsDialog();

  return (
    <button
      type="button"
      onClick={(event) => open(event.currentTarget)}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-label="Réglages"
      // Avatar de 28 px, cible tactile de 44 px : le débord compense le padding
      // de l'en-tête pour que l'avatar reste aligné sur les autres écrans.
      className="-mr-2.5 flex size-11 items-center justify-center rounded-full"
    >
      <AthleteAvatar
        initials={athlete.initials}
        className={cn(
          "size-7",
          isOpen && "border-accent/50 bg-accent-soft text-accent",
        )}
      />
    </button>
  );
}
