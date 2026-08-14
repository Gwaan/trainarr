import { Suspense } from "react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { getDashboardSummary } from "@/data/dashboard";

import { requireSession } from "./_lib/require-session";

import { DashboardSkeleton } from "./_components/dashboard-skeleton";
import { KeyMetrics } from "./_components/key-metrics";
import { LthrSuggestionCard } from "./_components/lthr-suggestion-card";
import { MaxHrSuggestionCard } from "./_components/max-hr-suggestion-card";
import { OnboardingCard } from "./_components/onboarding-card";
import { PlanRevisionCard } from "./_components/plan-revision-card";
import { RecentActivitiesPanel } from "./_components/recent-activities-panel";
import { RestingHrSuggestionCard } from "./_components/resting-hr-suggestion-card";
import { TodaySessionPanel } from "./_components/today-session-panel";
import { TrainingLoadPanel } from "./_components/training-load-panel";
import { capitalize, formatFullDate } from "./_lib/format";
import { toLthrSuggestionView } from "./_lib/lthr-suggestion";
import { toMaxHrSuggestionView } from "./_lib/max-hr-suggestion";
import { toRestingHrSuggestionView } from "./_lib/resting-hr-suggestion";
import { toWellnessTileView } from "./_lib/wellness-view";

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
  const restingHrSuggestion = toRestingHrSuggestionView(summary.restingHrSuggestion);
  const lthrSuggestion = toLthrSuggestionView(summary.lthrSuggestion);

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
        // temps ; la carte de réévaluation, elle, n'a aucun bouton).
        <MaxHrSuggestionCard suggestion={maxHrSuggestion} emphasis="accent" />
      )}

      {/* Les trois propositions cardiaques peuvent coexister, et elles
          s'empilent alors dans cet ordre : FC max, FC de repos, FC seuil.

          **Un seul CTA accent par écran**, et l'arbitrage se lit de haut en bas
          — la première carte présente le prend, les suivantes passent en
          `secondary`. L'ordre n'est pas celui de la « gravité » mais celui de la
          **dépendance** : la FC seuil se mesure et se juge sur des zones qui
          dépendent encore de la FC max, et une FC max fausse fausse aussi le
          contrôle d'effort maximal des tests. On corrige donc les références
          brutes avant de changer d'ancrage — accepter le seuil d'abord, puis la
          FC max, reviendrait à ancrer sur une valeur qu'on est en train de
          corriger. */}
      {restingHrSuggestion === null ? null : (
        <RestingHrSuggestionCard
          suggestion={restingHrSuggestion}
          emphasis={maxHrSuggestion === null ? "accent" : "secondary"}
        />
      )}

      {lthrSuggestion === null ? null : (
        <LthrSuggestionCard
          suggestion={lthrSuggestion}
          emphasis={
            maxHrSuggestion === null && restingHrSuggestion === null
              ? "accent"
              : "secondary"
          }
        />
      )}

      {/* La réévaluation de plan que le coach propose, à la même place et pour
          la même raison : c'est un état qui appelle une décision, et le tableau
          de bord est le seul écran qu'on ouvre sans rien chercher. Elle ne
          tranche pas ici — accepter trois semaines de séances réécrites sans les
          avoir vues serait un mauvais réflexe : elle renvoie à la page du plan. */}
      {summary.planRevision === null ? null : (
        <PlanRevisionCard revision={summary.planRevision} />
      )}

      <KeyMetrics
        fitness={summary.fitness}
        fitnessUnavailable={summary.fitnessUnavailable}
        vo2max={summary.vo2max}
        vo2maxUnavailable={summary.vo2maxUnavailable}
        // Sans profil, aucun relevé n'a pu être rapatrié : la tuile n'aurait
        // qu'un état vide à montrer, et l'invitation à créer son profil est
        // déjà en tête de page.
        wellness={hasProfile ? toWellnessTileView(summary.wellness) : null}
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
