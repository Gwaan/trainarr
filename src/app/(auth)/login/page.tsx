import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { Banner } from "@/components/banner";
import { Skeleton } from "@/components/ui/skeleton";
import { authUnavailableMessage } from "@/lib/auth";

import { isBootstrapOpen } from "../_lib/bootstrap";
import { AuthCard } from "../_components/auth-form";
import { LoginForm } from "./_components/login-form";

export const metadata: Metadata = {
  title: "Connexion",
};

/**
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * cette page pendant `next build`, où ni la base ni les variables
 * d'environnement n'existent — et la simple lecture de `BETTER_AUTH_SECRET`
 * ferait échouer le build. Cf. `.claude/rules/nextjs.md`.
 */
async function LoginContent() {
  await connection();

  const unavailable = authUnavailableMessage();
  if (unavailable !== null) {
    return (
      <AuthCard>
        <Banner tone="negative" title="Connexion indisponible">
          {unavailable}
        </Banner>
      </AuthCard>
    );
  }

  return <LoginForm bootstrapOpen={await isBootstrapOpen()} />;
}

export default function LoginPage() {
  return (
    <Suspense fallback={<Skeleton className="h-80 w-full rounded-card" />}>
      <LoginContent />
    </Suspense>
  );
}
