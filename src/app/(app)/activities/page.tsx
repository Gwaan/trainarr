import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { listActivitiesByWeek } from "@/data/activities";

import { ActivitiesHeader } from "./_components/activities-header";
import { ActivitiesSkeleton } from "./_components/activities-skeleton";
import { ActivityWeek } from "./_components/activity-week";

export const metadata: Metadata = {
  title: "Activités",
};

const PAGE_SUBTITLE =
  "L'historique de tes sorties, semaine par semaine : distances, allures et fréquences cardiaques.";

/** Pas de pagination pour l'instant : la page s'arrête à huit semaines. */
const WEEKS_LIMIT = 8;

/**
 * Contenu de la page.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md`.
 */
async function ActivitiesContent() {
  await connection();
  const weeks = await listActivitiesByWeek(WEEKS_LIMIT);

  return (
    <>
      {/* L'en-tête porte l'import FIT — et, tant qu'aucune sortie n'est
          enregistrée, l'état d'accueil qui l'invite. */}
      <ActivitiesHeader
        title="Activités"
        subtitle={PAGE_SUBTITLE}
        isEmpty={weeks.length === 0}
      />

      {weeks.length > 0 ? (
        <div className="flex flex-col gap-4">
          {weeks.map((week) => (
            <ActivityWeek key={week.weekLabel} week={week} />
          ))}
          {weeks.length === WEEKS_LIMIT ? (
            <p className="text-[0.78rem] text-fg-faint">
              Seules les {WEEKS_LIMIT} dernières semaines d&apos;entraînement sont
              affichées.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export default function ActivitiesPage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<ActivitiesSkeleton />}>
        <ActivitiesContent />
      </Suspense>
    </div>
  );
}
