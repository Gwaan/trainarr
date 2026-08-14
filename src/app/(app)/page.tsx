import { Suspense } from "react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { getDashboardSummary } from "@/data/dashboard";

import { requireSession } from "./_lib/require-session";

import { DashboardSkeleton } from "./_components/dashboard-skeleton";
import { KeyMetrics } from "./_components/key-metrics";
import { MaxHrSuggestionCard } from "./_components/max-hr-suggestion-card";
import { OnboardingCard } from "./_components/onboarding-card";
import { RecentActivitiesPanel } from "./_components/recent-activities-panel";
import { TodaySessionPanel } from "./_components/today-session-panel";
import { TrainingLoadPanel } from "./_components/training-load-panel";
import { capitalize, formatFullDate } from "./_lib/format";
import { toMaxHrSuggestionView } from "./_lib/max-hr-suggestion";

/**
 * Contenu du tableau de bord.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md` — il bascule la route en Partial Prerender :
 * coquille statique immédiate, données streamées à la requête.
 *
 * `requireSession()` juste après : c'est ici que la vérification fait autorité
 * (le proxy, lui, n'a regardé que la présence du cookie). Dans le composant
 * suspendu, donc sans coûter le `◐` de la route.
 */
async function DashboardContent() {
  await connection();
  await requireSession();

  const summary = await getDashboardSummary();

  // Aucun nom d'athlète = aucun profil en base : l'installation est neuve.
  const hasProfile = summary.athleteName !== null;
  const maxHrSuggestion = toMaxHrSuggestionView(summary.maxHrSuggestion);

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <PageHeader
        eyebrow={capitalize(formatFullDate(new Date()))}
        title={summary.athleteName ? `Bonjour, ${summary.athleteName}` : "Bonjour"}
      />

      {hasProfile ? null : <OnboardingCard />}

      {/* Juste sous l'en-tête, à la place qu'occupe l'invitation à créer son
          profil — les deux s'excluent (sans profil, aucune séance n'est
          rattachée) et c'est le seul endroit du tableau de bord réservé à un
          état qui appelle une décision. Aucun risque de la voir clignoter
          pendant le chargement : tout ce bloc est suspendu derrière
          `connection()`, et le squelette ne réserve rien pour elle. */}
      {maxHrSuggestion === null ? null : (
        // Le tableau de bord ne porte aucun autre CTA accent : celui-ci peut le
        // prendre (l'`OnboardingCard`, qui en a un, ne s'affiche jamais en même
        // temps).
        <MaxHrSuggestionCard suggestion={maxHrSuggestion} emphasis="accent" />
      )}

      <KeyMetrics
        fitness={summary.fitness}
        fitnessUnavailable={summary.fitnessUnavailable}
        vo2max={summary.vo2max}
        vo2maxUnavailable={summary.vo2maxUnavailable}
        hasProfile={hasProfile}
      />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <TodaySessionPanel
          session={summary.todaySession}
          forecast={summary.forecast}
          today={summary.today}
        />
        <TrainingLoadPanel weeks={summary.loadWeeks} />
      </div>

      <RecentActivitiesPanel activities={summary.recentActivities} />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}
