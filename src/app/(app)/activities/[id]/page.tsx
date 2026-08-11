import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { getActivityFeedback } from "@/data/activity-feedback";
import { getAiAvailability } from "@/lib/ai/availability";

import { ActivityCharts } from "./_components/activity-charts";
import { ActivityDetailSkeleton } from "./_components/activity-detail-skeleton";
import { ActivityMapPanel } from "./_components/activity-map-panel";
import { ActivitySplits } from "./_components/activity-splits";
import { ActivityHeader, ActivityStatsPanel } from "./_components/activity-summary";
import { BestSegmentsPanel } from "./_components/best-segments-panel";
import { CoachPanel, CoachPanelSkeleton } from "./_components/coach-panel";
import { DecouplingPanel } from "./_components/decoupling-panel";
import { DistributionPanel } from "./_components/distribution-panel";
import { HrZonesPanel } from "./_components/hr-zones-panel";
import { NoDetailedData } from "./_components/no-detailed-data";
import { parseActivityId } from "./_lib/activity-id";
import { hrDistributionModel, paceDistributionModel } from "./_lib/distribution-model";
import { loadActivity } from "./_lib/load-activity";

type PageProps = { params: Promise<{ id: string }> };

/**
 * Navigation instantanée désactivée sur cette route.
 *
 * C'est la première route à segment dynamique de l'appli : son shell statique
 * serait rendu sans URL connue, or la navigation du groupe `(app)` (sidebar et
 * bottom-nav) lit `usePathname()` pour marquer l'onglet actif. Next refuse donc
 * de valider la navigation instantanée (`CLIENT_HOOK_DYNAMIC`). Les deux issues
 * sont de suspendre la navigation partagée — elle clignoterait sur *toutes* les
 * pages — ou de lever l'exigence d'instantanéité ici : c'est le choix fait.
 *
 * `instant = false` ne change **pas** le mode de rendu : la route reste en
 * Partial Prerender (`◐` au build) grâce aux `connection()` ci-dessous, shell
 * statique et séance streamée à la requête. Le `loading.tsx` couvre l'attente.
 */
export const instant = false;

/**
 * Le titre de l'onglet est le nom de la séance.
 *
 * `connection()` ici aussi : sans lui, `cacheComponents: true` ferait exécuter
 * les métadonnées — donc une requête base — pendant `next build`, où la base
 * n'existe pas (cf. `.claude/rules/nextjs.md`).
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  await connection();

  const id = parseActivityId((await params).id);
  const activity = id === null ? null : await loadActivity(id);
  return { title: activity?.detail.name ?? "Activité" };
}

/**
 * Le panneau du coach, suspendu à part : lire le feedback interroge la base, et
 * savoir si le coach répond passe par un ping réseau (jusqu'à 2 s). Ni l'un ni
 * l'autre ne doit retarder l'affichage de la séance elle-même.
 */
async function CoachFeedback({ activityId }: { activityId: number }) {
  const [feedback, availability] = await Promise.all([
    getActivityFeedback(activityId),
    getAiAvailability(),
  ]);

  return (
    <CoachPanel activityId={activityId} feedback={feedback} availability={availability} />
  );
}

async function ActivityDetail({ params }: PageProps) {
  await connection();

  const id = parseActivityId((await params).id);
  if (id === null) notFound();

  const full = await loadActivity(id);
  if (full === null) notFound();

  const { detail, charts, splits, hrZones, decoupling, bestSegments } = full;
  const summary = { ...detail, trimp: full.trimp, effectiveVo2max: full.effectiveVo2max };

  const path = charts?.latlng ?? null;
  const hasMap = path !== null && path.length >= 2;
  const hasBreakdown = splits.length > 0 || hrZones !== null;

  // Les modèles d'histogramme se calculent ici, côté serveur : le composant de
  // rendu n'est client que pour son état de survol.
  const paceBars =
    full.paceDistribution === null ? null : paceDistributionModel(full.paceDistribution);
  const hrBars =
    full.hrDistribution === null
      ? null
      : hrDistributionModel(full.hrDistribution, full.profileMaxHrBpm);
  const both = paceBars !== null && hrBars !== null;

  const hasEfforts = decoupling !== null || bestSegments.length > 0;

  return (
    <>
      <ActivityHeader activity={summary} />

      {/* Bureau : chiffres et carte se partagent une rangée ; mobile : une colonne. */}
      <div className="grid gap-4 lg:grid-cols-5">
        <ActivityStatsPanel
          activity={summary}
          className={hasMap ? "lg:col-span-2" : "lg:col-span-5"}
          gridClassName={
            hasMap ? "sm:grid-cols-3 lg:grid-cols-2" : "sm:grid-cols-3 lg:grid-cols-5"
          }
        />
        {hasMap ? <ActivityMapPanel path={path} className="lg:col-span-3" /> : null}
      </div>

      <Suspense fallback={<CoachPanelSkeleton />}>
        <CoachFeedback activityId={id} />
      </Suspense>

      {charts === null ? <NoDetailedData /> : <ActivityCharts points={charts.points} />}

      {hasBreakdown ? (
        <div className="grid gap-4 lg:grid-cols-5">
          {splits.length > 0 ? (
            <ActivitySplits splits={splits} className="lg:col-span-3" />
          ) : null}
          {hrZones === null ? null : (
            <HrZonesPanel
              zones={hrZones}
              className={splits.length > 0 ? "self-start lg:col-span-2" : "lg:col-span-5"}
            />
          )}
        </div>
      ) : null}

      {/* Deux histogrammes de même nature : côte à côte, ils se comparent. */}
      {paceBars === null && hrBars === null ? null : (
        <div className={both ? "grid gap-4 md:grid-cols-2" : "grid gap-4"}>
          {paceBars === null ? null : (
            <DistributionPanel
              title="Distribution de l'allure"
              model={paceBars}
              hint="Temps passé dans chaque tranche d'allure."
            />
          )}
          {hrBars === null ? null : (
            <DistributionPanel
              title="Distribution cardiaque"
              model={hrBars}
              // La couleur ne se devine pas : quand les tranches sont zonées,
              // la légende le dit — sinon elle ne promet rien.
              hint={
                full.profileMaxHrBpm === null
                  ? "Temps passé dans chaque tranche de fréquence cardiaque."
                  : "Temps passé dans chaque tranche de fréquence cardiaque, colorée par zone."
              }
            />
          )}
        </div>
      )}

      {hasEfforts ? (
        <div className="grid gap-4 lg:grid-cols-5">
          {decoupling === null ? null : (
            <DecouplingPanel
              decoupling={decoupling}
              className={
                bestSegments.length > 0 ? "self-start lg:col-span-2" : "lg:col-span-5"
              }
            />
          )}
          {bestSegments.length > 0 ? (
            <BestSegmentsPanel
              segments={bestSegments}
              className={
                decoupling === null ? "lg:col-span-5" : "self-start lg:col-span-3"
              }
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Le `params` n'est pas attendu ici mais dans l'enfant suspendu : sous
 * `cacheComponents`, c'est ce qui laisse Next servir un shell statique et
 * streamer la séance à la requête.
 */
export default function ActivityDetailPage({ params }: PageProps) {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<ActivityDetailSkeleton />}>
        <ActivityDetail params={params} />
      </Suspense>
    </div>
  );
}
