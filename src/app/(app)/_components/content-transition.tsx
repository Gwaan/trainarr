"use client";

import { usePathname } from "next/navigation";
import { ViewTransition, type ReactNode } from "react";

/**
 * Fondu enchaîné du bloc de contenu au changement d'onglet.
 *
 * La clé est le chemin, et c'est elle qui borne l'animation : un changement de
 * clé fait de l'ancien et du nouveau contenu une paire sortie/entrée, là où une
 * enveloppe sans clé s'animerait sur *toute* mutation de la boîte (résolution
 * d'un `<Suspense>`, `revalidatePath()` d'une Server Action, `router.refresh()`).
 *
 * Les `searchParams` sont volontairement hors de la clé : le filtre de période
 * de « Progression » rejouerait sinon un fondu de page entière à chaque clic.
 *
 * `children` est la seule prop : les pages restent des Server Components et ne
 * franchissent pas la frontière client.
 */
export function ContentTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <ViewTransition
      key={pathname}
      name="app-content"
      share="content-swap"
      enter="content-swap"
      default="none"
    >
      {children}
    </ViewTransition>
  );
}
