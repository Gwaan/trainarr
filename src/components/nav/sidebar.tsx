import { AthleteAvatar, type AthleteProfile } from "./athlete";
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

      <div className="mt-auto border-t border-border p-3">
        <div className="flex items-center gap-3 px-2 py-1.5">
          <AthleteAvatar initials={athlete.initials} />
          <span className="min-w-0">
            <span className="block truncate text-[0.82rem] leading-tight font-medium text-fg">
              {athlete.name}
            </span>
            {athlete.subtitle ? (
              <span className="eyebrow mt-1 block truncate">
                {athlete.subtitle}
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </aside>
  );
}
