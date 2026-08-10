import Link from "next/link";
import { ArrowRight, UserRoundPlus } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Invitation à créer le profil, en tête du tableau de bord tant qu'aucun athlète
 * n'existe. C'est le point de départ de l'application : sans profil, ni charge
 * d'entraînement ni import de séance. Elle remplace alors le placeholder
 * « Profil incomplet » des indicateurs — un seul message, pas deux.
 */
export function OnboardingCard() {
  return (
    <section className="rounded-card border border-accent/30 bg-accent-soft p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex items-start gap-3.5">
          <span className="hidden size-10 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-bg/40 sm:flex">
            <UserRoundPlus
              aria-hidden="true"
              strokeWidth={1.7}
              className="size-5 text-accent"
            />
          </span>
          <div className="min-w-0">
            <h2 className="text-[1.05rem] leading-tight font-semibold text-fg">
              Commence par créer ton profil
            </h2>
            <p className="mt-1.5 text-[0.85rem] leading-relaxed text-fg-muted">
              Ton prénom, ton sexe et tes fréquences cardiaques suffisent :
              Trainarr peut alors calculer ta charge d&apos;entraînement et
              importer tes séances.
            </p>
          </div>
        </div>

        <Button asChild size="lg" className="w-full sm:w-auto">
          <Link href="/profile">
            Créer mon profil
            <ArrowRight aria-hidden="true" strokeWidth={2} />
          </Link>
        </Button>
      </div>
    </section>
  );
}
