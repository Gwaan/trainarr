import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";

import { Banner } from "@/components/banner";
import { Skeleton } from "@/components/ui/skeleton";
import { authUnavailableMessage } from "@/lib/auth";
import { invitationTokenSchema } from "@/lib/auth/invitation-token";
import { INVITATION_UNUSABLE_MESSAGE, isInvitationUsable } from "@/data/invitations";
import { cn } from "@/lib/utils";

import { AuthCard } from "../../_components/auth-form";
import { InvitedAccountForm } from "./_components/invited-account-form";

/**
 * **Titre fixe, et c'est délibéré** : le jeton est dans l'URL, il n'a rien à
 * faire en plus dans le titre de l'onglet, dans une balise `meta` ou dans un
 * historique de partage. Rien de ce que rend cette page ne le répète, hors le
 * champ caché du formulaire qui doit le renvoyer.
 */
export const metadata: Metadata = {
  title: "Créer ton compte",
};

/** Ce qu'on montre quand le lien n'ouvre rien — sans jamais dire pourquoi. */
function UnusableInvitation() {
  return (
    <AuthCard>
      <Banner tone="negative" title="Lien non valable">
        {INVITATION_UNUSABLE_MESSAGE}
      </Banner>
      <Link
        href="/login"
        className={cn(
          "mt-5 inline-flex h-11 w-full items-center justify-center rounded-button border border-border bg-surface-2 px-4",
          "text-sm font-semibold text-fg transition-colors duration-150 ease-out",
          "hover:border-fg-faint/35 hover:bg-surface-2/60",
        )}
      >
        Aller à la connexion
      </Link>
    </AuthCard>
  );
}

/**
 * `connection()` : même raison que les deux autres écrans d'identité — sans lui,
 * `cacheComponents: true` prérendrait la page pendant `next build`, où ni la
 * base ni `BETTER_AUTH_SECRET` n'existent (cf. `.claude/rules/nextjs.md`).
 *
 * La vérification du lien est faite ici, avant d'afficher quoi que ce soit :
 * faire remplir quatre champs pour apprendre ensuite que le lien est périmé
 * serait une perte de temps gratuite. Elle ne consomme rien et ne fait pas
 * autorité — l'action refait le contrôle au moment d'écrire.
 *
 * **Une panne de lecture répond « lien non valable »**, comme `isBootstrapOpen()`
 * répond « fermée » : le sens prudent ne coûte rien ici, une base injoignable
 * empêche de toute façon de créer le compte.
 */
async function InvitationContent({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
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

  // Un segment dynamique est de l'entrée utilisateur : validé avant tout usage.
  const parsed = invitationTokenSchema.safeParse((await params).token);
  if (!parsed.success) return <UnusableInvitation />;

  let usable = false;
  try {
    usable = await isInvitationUsable(parsed.data);
  } catch (error) {
    // Le jeton n'entre pas dans la trace : seule l'erreur y figure.
    console.error("[invitations] vérification du lien impossible", error);
  }
  if (!usable) return <UnusableInvitation />;

  return <InvitedAccountForm token={parsed.data} />;
}

/**
 * `params` est passé en promesse au composant suspendu plutôt qu'attendu ici :
 * la coquille de l'écran reste prérendue, et seule la vérification du lien est
 * streamée.
 */
export default function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-card" />}>
      <InvitationContent params={params} />
    </Suspense>
  );
}
