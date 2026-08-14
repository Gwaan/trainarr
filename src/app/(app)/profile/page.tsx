import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { getAthleteProfile } from "@/data/athlete";
import { getAccountSummary } from "@/lib/auth/session";

import { AccountPanel } from "./_components/account-panel";
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
  // Deux lectures indépendantes : le profil athlète (nos tables, via le DAL) et
  // le compte connecté (la session, via better-auth).
  const [profile, account] = await Promise.all([
    getAthleteProfile(),
    getAccountSummary(),
  ]);

  const mode = profile === null ? "onboarding" : "edit";
  const { title, subtitle } = HEADINGS[mode];

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      {/* Le formulaire ne reçoit que des chaînes prêtes à afficher : la
          conversion des mesures reste côté serveur, testée à part. */}
      <ProfileForm mode={mode} values={toProfileFormValues(profile)} />
      {/* Après le profil, et à part : l'identité de connexion n'a rien à voir
          avec les données physiologiques, et son CTA ne doit pas concurrencer
          l'enregistrement. Le composant ne reçoit que le nom — jamais l'e-mail,
          l'identifiant interne ni quoi que ce soit de la session. */}
      <AccountPanel account={account} />
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
