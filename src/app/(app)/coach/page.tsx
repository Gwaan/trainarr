import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { listCoachMessages } from "@/data/coach-chat";
import { getAiAvailability } from "@/lib/ai/availability";

import { CoachConversation } from "./_components/coach-conversation";
import { CoachSkeleton } from "./_components/coach-skeleton";

export const metadata: Metadata = {
  title: "Coach",
};

/**
 * Contenu de la page.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où ni la base ni l'API IA
 * n'existent. Cf. `.claude/rules/nextjs.md`.
 *
 * Les deux lectures sont indépendantes — le fil vient de la base, la
 * disponibilité du coach d'un ping réseau mémorisé — donc elles partent
 * ensemble.
 *
 * Le fil est réduit à ce que l'écran affiche avant de franchir la frontière
 * client : ni `createdAt` (aucun horodatage n'est rendu), ni rien d'autre que le
 * texte, son rôle et une clé de liste.
 */
async function CoachContent() {
  await connection();
  const [messages, availability] = await Promise.all([
    listCoachMessages(),
    getAiAvailability(),
  ]);

  return (
    <>
      <PageHeader
        title="Coach"
        subtitle="Un regard sur tes données d'entraînement, disponible à toute heure."
      />
      <CoachConversation
        messages={messages.map(({ id, role, content }) => ({ id, role, content }))}
        unavailableReason={availability.available ? null : availability.reason}
      />
    </>
  );
}

export default function CoachPage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<CoachSkeleton />}>
        <CoachContent />
      </Suspense>
    </div>
  );
}
