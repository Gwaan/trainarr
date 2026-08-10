import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { Activity, Zap } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StravaConnectButton } from "@/components/strava-connect-button";
import { listActivitiesByWeek } from "@/data/activities";
import { isStravaConnected } from "@/data/strava-tokens";

import { ActivitiesSkeleton } from "./_components/activities-skeleton";
import { ActivityWeek } from "./_components/activity-week";
import { StravaStatusBanner } from "./_components/strava-status-banner";

export const metadata: Metadata = {
  title: "Activités",
};

const PAGE_SUBTITLE =
  "L'historique de tes sorties, semaine par semaine : distances, allures et fréquences cardiaques.";

/** Pas de pagination pour l'instant : la page s'arrête à huit semaines. */
const WEEKS_LIMIT = 8;

/** Badge discret — l'accent reste réservé aux actions. */
function StravaConnectedBadge() {
  return (
    <span className="inline-flex items-center gap-2 rounded-button border border-border bg-surface-2 px-3 py-2 text-[0.78rem] text-fg-muted">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-positive" />
      Strava connecté
    </span>
  );
}

/**
 * Contenu de la page.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md`.
 */
async function ActivitiesContent() {
  await connection();
  const [connected, weeks] = await Promise.all([
    isStravaConnected(),
    listActivitiesByWeek(WEEKS_LIMIT),
  ]);

  const isEmpty = weeks.length === 0;
  // Un seul CTA accent par écran : quand l'état d'accueil le porte, l'en-tête
  // n'affiche aucune action.
  const headerAction = connected ? (
    <StravaConnectedBadge />
  ) : isEmpty ? undefined : (
    <StravaConnectButton />
  );

  return (
    <>
      <PageHeader title="Activités" subtitle={PAGE_SUBTITLE} action={headerAction} />

      {isEmpty ? (
        <div className="rounded-card border border-border bg-surface">
          {connected ? (
            <EmptyState
              icon={Activity}
              title="Aucune activité pour l'instant"
              description="Ton compte Strava est connecté : tes prochaines sorties seront importées automatiquement et s'afficheront ici."
            />
          ) : (
            <EmptyState
              icon={Zap}
              title="Connecte ton compte Strava"
              description="Tes sorties seront importées automatiquement — distances, allures, fréquences cardiaques — pour alimenter tes analyses et ton coach."
              action={<StravaConnectButton />}
            />
          )}
        </div>
      ) : (
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
      )}
    </>
  );
}

export default function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* Bandeau et contenu sont suspendus séparément : le retour OAuth ne doit
          pas attendre la lecture des activités. */}
      <Suspense fallback={null}>
        <StravaStatusBanner searchParams={searchParams} />
      </Suspense>

      <Suspense fallback={<ActivitiesSkeleton />}>
        <ActivitiesContent />
      </Suspense>
    </div>
  );
}
