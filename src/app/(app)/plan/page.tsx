import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { getActivePlanWithSessions, getDraftPlanWithSessions } from "@/data/plans";
import { getAiAvailability } from "@/lib/ai/availability";
import { toCivilDate } from "@/lib/dates/civil";

import { AiSuspendedPanel } from "./_components/ai-suspended-panel";
import { PlanCreatePanel } from "./_components/plan-create-panel";
import { PlanProposal } from "./_components/plan-proposal";
import { PlanSkeleton } from "./_components/plan-skeleton";
import { PlanView } from "./_components/plan-view";
import {
  earliestPlanStart,
  earliestRaceDate,
  latestPlanStart,
  latestRaceDate,
} from "./_lib/plan-window";

export const metadata: Metadata = {
  title: "Plan",
};

const SUBTITLES = {
  create:
    "Décris ton objectif : le coach écrit le plan autour de ta charge d'entraînement actuelle.",
  review: "Le coach te propose un plan. Lis-le en entier, puis adopte-le ou refuse-le.",
  view: "Ton programme semaine par semaine, ajusté à ta charge réelle.",
} as const;

/**
 * Contenu de la page.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où ni la base ni l'API IA
 * n'existent. Cf. `.claude/rules/nextjs.md`.
 *
 * Les trois lectures sont indépendantes : les plans viennent de la base, la
 * disponibilité du coach d'un ping réseau mémorisé — elles partent ensemble.
 */
async function PlanContent() {
  await connection();
  const [active, draft, availability] = await Promise.all([
    getActivePlanWithSessions(),
    getDraftPlanWithSessions(),
    getAiAvailability(),
  ]);

  const today = toCivilDate(new Date());

  /*
   * Une proposition en attente prend toute la place : c'est la décision du
   * moment, et rien d'autre ne doit s'y superposer. Le formulaire de création
   * disparaît donc tant qu'elle est là — en générer un second n'écraserait que
   * celle-ci — et le plan en cours, s'il existe, passe dessous : il reste
   * consultable, c'est à lui que la proposition se compare.
   */
  if (draft !== null) {
    return (
      <>
        <PageHeader title="Plan" subtitle={SUBTITLES.review} />
        <PlanProposal
          plan={draft.plan}
          sessions={draft.sessions}
          today={today}
          hasActivePlan={active !== null}
        />
        {active === null ? null : (
          <div className="flex flex-col gap-3 sm:gap-4">
            <h2 className="eyebrow px-0.5">Ton plan en cours</h2>
            <div className="flex flex-col gap-5 sm:gap-6">
              <PlanView
                plan={active.plan}
                sessions={active.sessions}
                today={today}
                unavailableReason={availability.available ? null : availability.reason}
              />
            </div>
          </div>
        )}
      </>
    );
  }

  if (active === null) {
    // Les bornes de la course couvrent tous les démarrages proposés : trop
    // larges d'au plus quelques semaines, jamais trop étroites — un champ qui
    // interdirait une date pourtant valide serait une impasse muette, là où
    // l'action, elle, tranche sur la date de démarrage réellement choisie.
    const firstStart = earliestPlanStart(today);
    const lastStart = latestPlanStart(today);

    return (
      <>
        <PageHeader title="Plan" subtitle={SUBTITLES.create} />
        {availability.available ? (
          <PlanCreatePanel
            minRaceDate={earliestRaceDate(firstStart)}
            maxRaceDate={latestRaceDate(lastStart)}
            defaultStartDate={firstStart}
            maxStartDate={lastStart}
          />
        ) : (
          <AiSuspendedPanel reason={availability.reason} />
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader title="Plan" subtitle={SUBTITLES.view} />
      {/* Le plan reste consultable même coach éteint : seule l'IA est suspendue. */}
      <PlanView
        plan={active.plan}
        sessions={active.sessions}
        today={today}
        unavailableReason={availability.available ? null : availability.reason}
      />
    </>
  );
}

export default function PlanPage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<PlanSkeleton />}>
        <PlanContent />
      </Suspense>
    </div>
  );
}
