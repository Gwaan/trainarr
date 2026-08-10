import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { getAthleteProfile } from "@/data/athlete";

import { ProfileForm } from "./_components/profile-form";
import { ProfileSkeleton } from "./_components/profile-skeleton";
import { toProfileFormValues } from "./_lib/form-values";

export const metadata: Metadata = {
  title: "Profil",
};

/**
 * Deux moments, une seule page : la création du profil — le tout premier écran
 * d'une installation neuve — et son édition. Sans profil, rien n'est calculable
 * et aucun fichier FIT n'est importable : l'accueil l'explique, sans reproche.
 */
const HEADINGS = {
  onboarding: {
    title: "Bienvenue sur Trainarr",
    subtitle:
      "Une minute suffit : ces quelques informations permettent de calculer ta charge d'entraînement et d'importer tes séances.",
  },
  edit: {
    title: "Ton profil",
    subtitle:
      "Les données sur lesquelles reposent tes calculs physiologiques. Modifiables à tout moment.",
  },
} as const;

/**
 * Contenu de la page.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md`.
 */
async function ProfileContent() {
  await connection();
  const profile = await getAthleteProfile();

  const mode = profile === null ? "onboarding" : "edit";
  const { title, subtitle } = HEADINGS[mode];

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      {/* Le formulaire ne reçoit que des chaînes prêtes à afficher : la
          conversion des mesures reste côté serveur, testée à part. */}
      <ProfileForm mode={mode} values={toProfileFormValues(profile)} />
    </>
  );
}

export default function ProfilePage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<ProfileSkeleton />}>
        <ProfileContent />
      </Suspense>
    </div>
  );
}
