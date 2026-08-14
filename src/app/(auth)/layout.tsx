import type { ReactNode } from "react";

import { TrackMark } from "@/components/nav/logo";

/**
 * Coquille des écrans d'identité (connexion, création du premier compte).
 *
 * Hors du groupe `(app)` : ni sidebar ni bottom-nav — il n'y a rien à naviguer
 * tant qu'on n'est pas entré, et une navigation visible sur un écran de
 * connexion invite surtout à la contourner.
 *
 * Une colonne centrée, étroite, qui tient sur un téléphone sans défilement. Les
 * marges reprennent les `env(safe-area-inset-*)` du reste de l'appli : en PWA
 * `standalone`, la page court jusqu'aux bords physiques.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-[max(1rem,env(safe-area-inset-left))] py-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-[26rem]">
        <div className="mb-7 flex items-center gap-2.5">
          <TrackMark />
          <span className="text-[1.15rem] leading-none font-extrabold tracking-[-0.035em] text-fg">
            train<span className="text-accent">arr</span>
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}
