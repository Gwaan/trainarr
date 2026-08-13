import type { AthleteProfile } from "./athlete";
import { AthleteLink } from "./athlete-link";
import { Logo } from "./logo";
import { SidebarNav } from "./sidebar-nav";

/**
 * Sidebar desktop fixe. Server Component : seule la liste de liens est cliente.
 *
 * `view-transition-name` : nommée pour être *exclue* de l'animation d'onglet, pas
 * pour y participer — voir le bloc « Coquille de navigation » de `globals.css`.
 */
export function Sidebar({ athlete }: { athlete: AthleteProfile }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[212px] flex-col border-r border-border bg-surface [view-transition-name:app-sidebar] lg:flex">
      {/* Sur iPad en PWA installée, la barre d'état est translucide et le header
          mobile qui lui réserve sa marge est masqué à partir de `lg` : sans ce
          padding, la marque passerait dessous. Hauteur recalculée plutôt que
          `h-16`, sinon l'encoche mangerait les 64 px au lieu de s'y ajouter. */}
      <div className="flex min-h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-center px-5 pt-[env(safe-area-inset-top)]">
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
