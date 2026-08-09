import { AthleteAvatar, type AthleteProfile } from "./athlete";
import { Logo } from "./logo";

/** Barre supérieure mobile : la sidebar est masquée, la marque reste visible. */
export function MobileHeader({ athlete }: { athlete: AthleteProfile }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-bg/85 px-4 backdrop-blur-md lg:hidden">
      <Logo />
      <AthleteAvatar initials={athlete.initials} className="size-7" />
    </header>
  );
}
