"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Button } from "@/components/ui/button";

/**
 * Ce que la modale montre tant qu'aucun profil n'existe.
 *
 * La création d'un profil reste un écran plein — c'est le tout premier de
 * l'installation, il n'y a pas encore d'application autour à laquelle revenir.
 * La modale n'en propose donc pas une seconde version : elle y renvoie.
 *
 * Elle se ferme au clic, sinon la navigation vers `/profile` se ferait derrière
 * un voile que rien n'aurait levé — la coquille applicative, elle, ne se
 * démonte pas d'une page à l'autre.
 */
export function SettingsOnboardingNotice() {
  const { close } = useSettingsDialog();

  return (
    <div>
      <p className="text-[0.9rem] leading-relaxed text-fg-muted">
        Ton profil n&apos;est pas encore créé. Tant qu&apos;il manque, aucune
        charge d&apos;entraînement n&apos;est calculable et aucune séance
        n&apos;est importable — et il n&apos;y a rien à régler ici.
      </p>
      <Button asChild className="mt-4 w-full sm:w-auto">
        <Link href="/profile" onClick={close}>
          Créer mon profil
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}
