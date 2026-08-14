import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { AiSuspendedPanel, type SuspendedAiFeature } from "@/components/ai-suspended-panel";
import { PageHeader } from "@/components/page-header";
import { getAthleteProfile, getCurrentAthleteId } from "@/data/athlete";
import { getPendingPlanRevisionDetail } from "@/data/plan-revisions";
import { getActivePlanWithSessions, getDraftPlanWithSessions } from "@/data/plans";
import { getAiAvailability } from "@/lib/ai/availability";
import { toCivilDate } from "@/lib/dates/civil";
import { hrZoneAnchor } from "@/lib/metrics/hr-zones";

import { requireSession } from "../_lib/require-session";

import { PlanCreatePanel } from "./_components/plan-create-panel";
import { PlanProposal } from "./_components/plan-proposal";
import { PlanRevisionProposal } from "./_components/plan-revision-proposal";
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
  list: "Ton programme semaine par semaine, ajusté à ta charge réelle.",
} as const;

/** Ce que cette page perd quand le coach ne répond pas. */
const PLAN_CREATION: SuspendedAiFeature = {
  subject: "La création d'un plan",
  inline: "la création de plan",
};

/**
 * Contenu de la page.
 *
 * Le **programme** et rien d'autre : l'objectif, son déroulé semaine par semaine
 * avec le détail des séances, et les trois actions qui le font vivre (ajuster,
 * resynchroniser, archiver). Le calendrier, lui, a son propre onglet — un
 * calendrier ne parle pas du programme, il parle du temps, et il montre autant
 * les sorties courues que les séances prévues.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où ni la base ni l'API IA
 * n'existent. Cf. `.claude/rules/nextjs.md`.
 *
 * Les lectures sont indépendantes : les plans et le profil viennent de la base,
 * la disponibilité du coach d'un ping réseau mémorisé — elles partent ensemble.
 *
 * Le profil n'est lu que pour sa **FC max** : c'est elle qui traduit en
 * battements les zones cardiaques prescrites sur les séances faciles. La
 * conversion se fait à l'affichage, jamais à l'écriture du plan — une FC max
 * corrigée met donc tout le programme à jour au rechargement suivant.
 *
 * `requireSession()` juste après `connection()` : c'est ici que la vérification
 * fait autorité (le proxy, lui, n'a regardé que la présence du cookie). Dans le
 * composant suspendu, donc sans coûter le `◐` de la route.
 */
async function PlanContent() {
  await connection();
  await requireSession();

  const today = toCivilDate(new Date());

  // Les plans se lisent sous un athlète **donné** : la page est une requête,
  // elle le lit donc de la session et le passe. Pas d'athlète (onboarding non
  // fait) : ni plan actif, ni proposition — comme avant.
  const athleteId = await getCurrentAthleteId();

  const [active, draft, revision, availability, profile] = await Promise.all([
    athleteId === null ? null : getActivePlanWithSessions(athleteId),
    athleteId === null ? null : getDraftPlanWithSessions(athleteId),
    // La réévaluation que le coach propose. La lecture exige déjà que son plan
    // soit toujours le plan **actif** : il n'y a rien de plus à vérifier ici.
    athleteId === null ? null : getPendingPlanRevisionDetail(athleteId),
    getAiAvailability(),
    getAthleteProfile(),
  ]);

  // L'ancrage cardiaque du profil : la FC seuil si l'athlète en a adopté une,
  // la FC max sinon. Lu une fois ici et descendu tel quel dans tout l'écran —
  // c'est lui qui résout les zones prescrites en battements.
  const hrAnchor = hrZoneAnchor(profile?.maxHrBpm ?? null, profile?.lthrBpm ?? null);

  /*
   * La réévaluation se pose **au-dessus du plan actif**, dans les deux
   * dispositions possibles : ce qu'elle propose ne se juge que par comparaison
   * avec le plan qu'elle réécrit, et il faut donc l'avoir sous les yeux juste en
   * dessous. Elle n'apparaît jamais sans lui — la lecture la joint au plan actif.
   */
  const revisionBlock =
    revision === null || active === null ? null : (
      <PlanRevisionProposal
        detail={revision}
        plan={active.plan}
        today={today}
        hrAnchor={hrAnchor}
      />
    );

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
          hrAnchor={hrAnchor}
          hasActivePlan={active !== null}
        />
        {active === null ? null : (
          <div className="flex flex-col gap-3 sm:gap-4">
            <h2 className="eyebrow px-0.5">Ton plan en cours</h2>
            <div className="flex flex-col gap-5 sm:gap-6">
              {revisionBlock}
              <PlanView
                plan={active.plan}
                sessions={active.sessions}
                today={today}
                hrAnchor={hrAnchor}
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
          <AiSuspendedPanel
            reason={availability.reason}
            panelTitle="Programme en cours"
            feature={PLAN_CREATION}
          />
        )}
      </>
    );
  }

  // Plan actif : le programme déroulé semaine par semaine, avec le détail de
  // chaque séance. Le plan reste consultable coach éteint — seule l'IA est
  // suspendue.
  return (
    <>
      <PageHeader title="Plan" subtitle={SUBTITLES.list} />
      {revisionBlock}
      <PlanView
        plan={active.plan}
        sessions={active.sessions}
        today={today}
        hrAnchor={hrAnchor}
        unavailableReason={availability.available ? null : availability.reason}
      />
    </>
  );
}

/**
 * `connection()` est appelé dans l'enfant suspendu, où il bascule la route en
 * Partial Prerender : coquille statique immédiate, données streamées à la
 * requête. Sans lui, `cacheComponents: true` prérendrait la page pendant
 * `next build` (image Docker), où ni la base ni l'API IA n'existent.
 * Cf. `.claude/rules/nextjs.md`.
 */
export default function PlanPage() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<PlanSkeleton />}>
        <PlanContent />
      </Suspense>
    </div>
  );
}
