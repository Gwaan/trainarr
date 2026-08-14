import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { AiSuspendedPanel, type SuspendedAiFeature } from "@/components/ai-suspended-panel";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { getAthleteProfile, getCurrentAthleteId } from "@/data/athlete";
import { getCalendarRange } from "@/data/calendar";
import { getActivePlanWithSessions, getDraftPlanWithSessions } from "@/data/plans";
import { getWeatherForecast } from "@/data/weather-forecast";
import { getAiAvailability } from "@/lib/ai/availability";
import { toCivilDate } from "@/lib/dates/civil";

import { requireSession } from "../_lib/require-session";

import { PlanAdjustForm } from "./_components/plan-adjust-form";
import { PlanCalendar } from "./_components/plan-calendar";
import { PlanCalendarToolbar } from "./_components/plan-calendar-toolbar";
import { PlanOverview } from "./_components/plan-overview";
import { PlanCreatePanel } from "./_components/plan-create-panel";
import { PlanProposal } from "./_components/plan-proposal";
import { PlanSkeleton } from "./_components/plan-skeleton";
import { PlanView, SUSPENDED_NOTE } from "./_components/plan-view";
import { toCalendarActivityView } from "./_lib/calendar-model";
import {
  civilMonth,
  monthGridRange,
  MONTH_PARAM,
  parseMonthParam,
  parsePlanViewParam,
  PLAN_VIEW_PARAM,
} from "./_lib/calendar-params";
import {
  earliestPlanStart,
  earliestRaceDate,
  latestPlanStart,
  latestRaceDate,
} from "./_lib/plan-window";

export const metadata: Metadata = {
  title: "Plan",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const SUBTITLES = {
  create:
    "Décris ton objectif : le coach écrit le plan autour de ta charge d'entraînement actuelle.",
  review: "Le coach te propose un plan. Lis-le en entier, puis adopte-le ou refuse-le.",
  calendar: "Glisse une séance d'un jour à l'autre pour la replanifier.",
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
async function PlanContent({ searchParams }: PageProps) {
  await connection();
  await requireSession();

  const today = toCivilDate(new Date());
  const currentMonth = civilMonth(today);

  // Lus avant le `Promise.all` : c'est le mois demandé qui décide de la plage à
  // lire, et la vue n'est qu'un aiguillage d'affichage.
  const params = await searchParams;
  const view = parsePlanViewParam(params[PLAN_VIEW_PARAM]);
  const month = parseMonthParam(params[MONTH_PARAM], currentMonth);
  const range = monthGridRange(month);

  // Les plans se lisent sous un athlète **donné** : la page est une requête,
  // elle le lit donc de la session et le passe. Pas d'athlète (onboarding non
  // fait) : ni plan actif, ni proposition — comme avant.
  const athleteId = await getCurrentAthleteId();

  const [active, draft, availability, profile, calendar, forecast] = await Promise.all([
    athleteId === null ? null : getActivePlanWithSessions(athleteId),
    athleteId === null ? null : getDraftPlanWithSessions(athleteId),
    getAiAvailability(),
    getAthleteProfile(),
    getCalendarRange(range.from, range.to),
    // Le relevé du matin, tel quel : seize jours au plus, aucune coordonnée.
    // Lecture indépendante des séances — une prévision ne dépend d'aucun plan.
    getWeatherForecast(),
  ]);

  const maxHrBpm = profile?.maxHrBpm ?? null;

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
          maxHrBpm={maxHrBpm}
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
                maxHrBpm={maxHrBpm}
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

  /*
   * Plan actif : deux lectures du même programme, et c'est le **calendrier** qui
   * ouvre. C'est la vue qui répond à la question qu'on se pose en arrivant —
   * « qu'est-ce que je cours, et quand ? » — et la seule où une séance se
   * déplace. La liste, qui déroule le détail semaine par semaine et porte les
   * actions sur le plan (ajuster, archiver, resynchroniser), reste à une tape.
   */
  return (
    <>
      <PageHeader
        title="Plan"
        subtitle={view === "calendrier" ? SUBTITLES.calendar : SUBTITLES.list}
      />

      <PlanCalendarToolbar view={view} month={month} currentMonth={currentMonth} />

      {view === "calendrier" ? (
        <>
          {/*
            Le calendrier étant la vue par défaut, ces deux blocs ne peuvent pas
            vivre dans la seule vue liste : l'objectif est ce qui donne son sens
            à la grille, et le champ d'ajustement est le seul endroit d'où le
            plan se modifie — c'est là que le coach renvoie l'athlète, dans son
            prompt système. Le reste des actions (resynchro, archivage) reste
            en liste : on les cherche, on ne tombe pas dessus.
          */}
          <Panel title="Objectif">
            <PlanOverview plan={active.plan} />
          </Panel>
          <PlanCalendar
            month={month}
            range={range}
            today={today}
            plan={calendar.plan}
            sessions={calendar.sessions}
            // Projeté ici, pas au passage de la frontière client : le DTO du DAL
            // porte le type de sport et l'allure moyenne, dont le calendrier ne
            // fait rien — et rien de superflu ne franchit la frontière.
            activities={calendar.activities.map(toCalendarActivityView)}
            forecast={forecast}
          />
          <Panel title="Ajuster le plan">
            {availability.available ? (
              <PlanAdjustForm />
            ) : (
              // La même note que la vue liste : sans elle, l'athlète ne peut pas
              // distinguer « suspendu » de « n'existe pas ».
              <p className="text-[0.82rem] leading-relaxed text-fg-faint">
                {SUSPENDED_NOTE[availability.reason]}
              </p>
            )}
          </Panel>
        </>
      ) : (
        // Le plan reste consultable même coach éteint : seule l'IA est suspendue.
        <PlanView
          plan={active.plan}
          sessions={active.sessions}
          today={today}
          maxHrBpm={maxHrBpm}
          unavailableReason={availability.available ? null : availability.reason}
        />
      )}
    </>
  );
}

/**
 * Le `searchParams` n'est pas attendu ici mais dans l'enfant suspendu, et
 * `connection()` y bascule la route en Partial Prerender : coquille statique
 * immédiate, données streamées à la requête. Sans lui, `cacheComponents: true`
 * prérendrait la page pendant `next build` (image Docker), où ni la base ni
 * l'API IA n'existent. Cf. `.claude/rules/nextjs.md`.
 */
export default function PlanPage({ searchParams }: PageProps) {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<PlanSkeleton />}>
        <PlanContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
