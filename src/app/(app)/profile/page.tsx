import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";

import { AccountPanel } from "./_components/account-panel";
import { ProfileForm } from "./_components/profile-form";
import { ProfileSkeleton } from "./_components/profile-skeleton";
import { SettingsTabs } from "./_components/settings-tabs";
import { loadSettingsData } from "./_lib/settings-data";

export const metadata: Metadata = {
  title: "Réglages",
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
    title: "Tes réglages",
    subtitle:
      "Ton profil physiologique, ton compte et l'import automatique de tes séances.",
  },
} as const;

/**
 * Contenu de la page.
 *
 * Elle reste atteignable et rend **les mêmes sections que la modale** : c'est le
 * même `SettingsTabs`, monté ici dans la colonne de la page plutôt que dans le
 * corps défilant de la boîte de dialogue. Aucun formulaire n'existe en deux
 * exemplaires, et rien ne peut donc diverger entre les deux entrées.
 *
 * L'onboarding, lui, garde son écran plein : un premier profil se crée sur une
 * page, pas dans une modale — il n'y a pas encore d'application autour d'elle.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md`.
 */
async function ProfileContent() {
  await connection();
  const { mode, ...sections } = await loadSettingsData();
  const { title, subtitle } = HEADINGS[mode];

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />

      {mode === "onboarding" ? (
        <>
          {/* Le formulaire ne reçoit que des chaînes prêtes à afficher : la
              conversion des mesures reste côté serveur, testée à part. À la
              création, les champs intervals.icu voyagent avec le profil dans la
              même soumission — l'athlète n'existe pas encore, il n'y a rien à
              modifier séparément, donc pas d'onglet « Import ». */}
          <ProfileForm mode="onboarding" values={sections.profile} />
          {/* À part : l'identité de connexion n'a rien à voir avec les données
              physiologiques, et son CTA ne doit pas concurrencer
              l'enregistrement. Le composant ne reçoit que le nom — jamais
              l'e-mail, l'identifiant interne ni quoi que ce soit de la
              session. */}
          <AccountPanel account={sections.account} />
        </>
      ) : (
        <SettingsTabs data={sections} />
      )}
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
