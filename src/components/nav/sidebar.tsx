import type { AthleteProfile } from "./athlete";
import { AthleteLink } from "./athlete-link";
import { Logo } from "./logo";
import { SidebarNav } from "./sidebar-nav";

/** Sidebar desktop fixe. Server Component : seule la liste de liens est cliente. */
export function Sidebar({ athlete }: { athlete: AthleteProfile }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[212px] flex-col border-r border-border bg-surface lg:flex">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Logo />
      </div>

      <SidebarNav />

      {/* Pas de padding latéral : le filet accent de l'item actif doit affleurer
          le bord de la sidebar, comme sur les liens de navigation. */}
      <div className="mt-auto border-t border-border py-2">
        <AthleteLink athlete={athlete} />
      </div>
    </aside>
  );
}
