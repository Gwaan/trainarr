import { Suspense } from "react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { getDashboardSummary } from "@/data/dashboard";

import { DashboardSkeleton } from "./_components/dashboard-skeleton";
import { KeyMetrics } from "./_components/key-metrics";
import { RecentActivitiesPanel } from "./_components/recent-activities-panel";
import { TodaySessionPanel } from "./_components/today-session-panel";
import { TrainingLoadPanel } from "./_components/training-load-panel";
import { capitalize, formatFullDate } from "./_lib/format";

/**
 * Contenu du tableau de bord.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md` — il bascule la route en Partial Prerender :
 * coquille statique immédiate, données streamées à la requête.
 */
async function DashboardContent() {
  await connection();
  const summary = await getDashboardSummary();

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <PageHeader
        eyebrow={capitalize(formatFullDate(new Date()))}
        title={summary.athleteName ? `Bonjour, ${summary.athleteName}` : "Bonjour"}
      />

      <KeyMetrics fitness={summary.fitness} vo2max={summary.vo2max} />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <TodaySessionPanel session={summary.todaySession} />
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
