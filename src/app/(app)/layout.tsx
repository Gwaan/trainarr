import type { ReactNode } from "react";

import type { AthleteProfile } from "@/components/nav/athlete";
import { BottomNav } from "@/components/nav/bottom-nav";
import { MobileHeader } from "@/components/nav/mobile-header";
import { Sidebar } from "@/components/nav/sidebar";
import { ContentTransition } from "./_components/content-transition";

/**
 * Identité affichée dans la navigation. Application mono-utilisateur : c'est une
 * constante d'interface, pas une donnée d'entraînement — celles-ci viennent
 * toutes du DAL. La coquille de navigation reste ainsi entièrement statique.
 */
const ATHLETE: AthleteProfile = { name: "Gwen", initials: "G" };

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <Sidebar athlete={ATHLETE} />
      <MobileHeader athlete={ATHLETE} />

      <div className="lg:pl-[212px]">
        {/*
          `max()` sur les marges latérales : en paysage sur un écran à encoche,
          `viewport-fit=cover` étend la page sous l'encoche et les coins
          arrondis, où le contenu serait rogné. Le padding existant reste le
          plancher, donc rien ne change là où `env()` vaut 0.
        */}
        <main className="mx-auto w-full max-w-5xl pt-6 pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(5rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] lg:pt-10 lg:pr-[max(2.5rem,env(safe-area-inset-right))] lg:pb-16 lg:pl-[max(2.5rem,env(safe-area-inset-left))]">
          {/*
            Changer d'onglet, c'est remplacer ce bloc-ci pendant que la coquille
            de navigation reste en place — d'où un fondu enchaîné du contenu, et
            non une entrée ou une sortie de page.

            Ce qui borne l'animation à la navigation, c'est la clé de route que
            pose `ContentTransition` : elle fait de l'ancien et du nouveau
            contenu une paire sortie/entrée. Sans elle, l'enveloppe s'animerait
            à chaque mutation de la boîte — panneau coach qui se résout,
            `revalidatePath()` d'une Server Action, `router.refresh()` après un
            import FIT.

            Le passage `loading.tsx` → contenu réel n'est volontairement pas
            animé : le squelette a déjà la géométrie de la page, un second fondu
            après celui de la navigation ne dirait rien de plus.
          */}
          <ContentTransition>{children}</ContentTransition>
        </main>
      </div>

      <BottomNav />
    </div>
  );
}
