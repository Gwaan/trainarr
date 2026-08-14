import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { Banner } from "@/components/banner";
import { Skeleton } from "@/components/ui/skeleton";
import { authUnavailableMessage } from "@/lib/auth";

import { isBootstrapOpen } from "../_lib/bootstrap";
import { AuthCard } from "../_components/auth-form";
import { FirstAccountForm } from "./_components/first-account-form";

export const metadata: Metadata = {
  title: "Premier compte",
};

/**
 * Cet écran n'existe que sur une installation neuve : dès qu'un compte existe,
 * il renvoie vers la connexion. Ce n'est pas lui qui *garantit* l'unicité du
 * premier compte — c'est la base (cf. `src/lib/auth/`) ; il évite simplement de
 * présenter un formulaire dont l'envoi serait refusé.
 *
 * `connection()` : même raison que sur l'écran de connexion — sans lui, la page
 * serait prérendue au build, où la base n'existe pas.
 */
async function FirstAccountContent() {
  await connection();

  const unavailable = authUnavailableMessage();
  if (unavailable !== null) {
    return (
      <AuthCard>
        <Banner tone="negative" title="Création de compte indisponible">
          {unavailable}
        </Banner>
      </AuthCard>
    );
  }

  if (!(await isBootstrapOpen())) redirect("/login");

  return <FirstAccountForm />;
}

export default function FirstAccountPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-card" />}>
      <FirstAccountContent />
    </Suspense>
  );
}
