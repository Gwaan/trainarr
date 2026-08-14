import type { AthleteProfile } from "./athlete";
import { AthleteAvatarTrigger } from "./athlete-trigger";
import { Logo } from "./logo";

/**
 * Barre supérieure mobile : la sidebar est masquée, la marque reste visible.
 *
 * En PWA installée, la barre d'état iOS est translucide et se superpose à la page :
 * le header doit donc s'étendre dessous pour que son fond flouté la couvre, sinon
 * l'heure et les icônes système se poseraient sur le contenu qui défile. D'où le
 * padding de safe-area, et une hauteur minimale calculée plutôt que `h-14` : la
 * boîte étant en `border-box`, un simple `min-h-14` ferait manger les 56 px de la
 * barre par l'encoche au lieu de s'y ajouter.
 *
 * Même raison sur les côtés, en paysage : l'encoche masque une bande latérale
 * dans laquelle iOS ne délivre pas non plus les événements tactiles — l'avatar
 * y serait donc invisible *et* intapable. `max()` plutôt qu'une addition pour
 * que l'écart de 16 px reste le plancher, et que rien ne bouge sur un écran
 * sans encoche, où `env()` vaut 0.
 *
 * `view-transition-name` : nommé pour être *exclu* de l'animation d'onglet, pas
 * pour y participer — voir le bloc « Coquille de navigation » de `globals.css`.
 */
export function MobileHeader({ athlete }: { athlete: AthleteProfile }) {
  return (
    <header className="sticky top-0 z-30 flex min-h-[calc(3.5rem+env(safe-area-inset-top))] items-center justify-between border-b border-border bg-bg/85 pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur-md [view-transition-name:app-header] lg:hidden">
      <Logo />
      <AthleteAvatarTrigger athlete={athlete} />
    </header>
  );
}
