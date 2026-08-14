import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";

import { listActivityWeekPage } from "@/data/activities";
import { getAthleteProfile } from "@/data/athlete";
import { getCalendarRange } from "@/data/calendar";
import { getWeatherForecast } from "@/data/weather-forecast";
import { toCivilDate } from "@/lib/dates/civil";

import { requireSession } from "../_lib/require-session";

import { ActivitiesHeader } from "./_components/activities-header";
import { ActivitiesSkeleton } from "./_components/activities-skeleton";
import { ActivityWeek } from "./_components/activity-week";
import { CalendarToolbar } from "./_components/calendar-toolbar";
import { TrainingCalendar } from "./_components/training-calendar";
import { WeeksPagination } from "./_components/weeks-pagination";
import { toCalendarActivityView } from "./_lib/calendar-model";
import {
  activitiesHref,
  civilMonth,
  monthGridRange,
  MONTH_PARAM,
  parseMonthParam,
  parseViewParam,
  VIEW_PARAM,
} from "./_lib/calendar-params";
import {
  formatWeekSpan,
  PAGE_PARAM,
  pageOffset,
  parsePageParam,
  WEEKS_PER_PAGE,
} from "./_lib/pagination";

export const metadata: Metadata = {
  title: "Calendrier",
};

/**
 * Un calendrier ne parle ni du passé ni du futur : il parle du **temps**. C'est
 * pourquoi il est le sujet de cet onglet, et non un mode de lecture du plan —
 * il montre côte à côte ce qui est prévu et ce qui a été couru, ce qu'aucun des
 * deux autres onglets ne fait.
 */
const SUBTITLES = {
  calendar:
    "Ce qui est prévu, ce qui a été couru. Ouvre une séance pour son détail, glisse-la pour la replanifier.",
  list: "L'historique de tes sorties, semaine par semaine : distances, allures et fréquences cardiaques.",
} as const;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Contenu de la page.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md`.
 *
 * `requireSession()` juste après : c'est ici que la vérification fait autorité
 * (le proxy, lui, n'a regardé que la présence du cookie). Dans le composant
 * suspendu, donc sans coûter le `◐` de la route.
 */
async function ActivitiesContent({ searchParams }: PageProps) {
  await connection();
  await requireSession();

  const today = toCivilDate(new Date());
  const currentMonth = civilMonth(today);

  // Lus avant toute lecture de données : c'est la vue demandée qui décide de ce
  // qu'il y a à lire, et le mois qui décide de la plage.
  const params = await searchParams;
  const view = parseViewParam(params[VIEW_PARAM]);
  const month = parseMonthParam(params[MONTH_PARAM], currentMonth);

  if (view === "liste") {
    return (
      <ActivityList
        page={parsePageParam(params[PAGE_PARAM])}
        month={month}
        currentMonth={currentMonth}
      />
    );
  }

  const range = monthGridRange(month);
  const [calendar, forecast, profile] = await Promise.all([
    getCalendarRange(range.from, range.to),
    // Le relevé du matin, tel quel : seize jours au plus, aucune coordonnée.
    // Lecture indépendante de la plage — un relevé les couvre tous d'un coup.
    getWeatherForecast(),
    // Le profil n'est lu que pour sa **FC max** : c'est elle qui traduit en
    // battements les zones cardiaques du détail d'une séance, ouvert depuis sa
    // pastille. Même lecture, et même rôle, que sur la page Plan.
    getAthleteProfile(),
  ]);

  return (
    <>
      <ActivitiesHeader title="Calendrier" subtitle={SUBTITLES.calendar} isEmpty={false} />
      <CalendarToolbar view={view} month={month} currentMonth={currentMonth} />
      <TrainingCalendar
        month={month}
        range={range}
        today={today}
        maxHrBpm={profile?.maxHrBpm ?? null}
        plan={calendar.plan}
        sessions={calendar.sessions}
        // Projetées ici, pas au passage de la frontière client : le DTO du DAL
        // porte le type de sport et l'allure moyenne, dont le calendrier ne fait
        // rien — et rien de superflu ne franchit la frontière.
        activities={calendar.activities.map(toCalendarActivityView)}
        weather={calendar.weather}
        forecast={forecast}
      />
    </>
  );
}

/**
 * L'historique complet, semaine par semaine et page par page.
 *
 * C'est la seconde lecture du même temps : là où la grille répond à « quand ? »,
 * la liste répond à « qu'est-ce que j'ai couru ? », et elle seule remonte
 * jusqu'aux premières sorties importées.
 */
async function ActivityList({
  page,
  month,
  currentMonth,
}: {
  page: number;
  month: string;
  currentMonth: string;
}) {
  const { weeks, hasOlder } = await listActivityWeekPage({
    limit: WEEKS_PER_PAGE,
    offset: pageOffset(page),
  });

  const newest = weeks[0];
  const oldest = weeks[weeks.length - 1];

  return (
    <>
      {/* L'en-tête porte l'import FIT — et, tant qu'aucune sortie n'est
          enregistrée, l'état d'accueil qui l'invite. Une page vide **au-delà**
          de l'historique n'est pas un historique vide : l'invitation ne s'y
          affiche pas, le lien de retour s'en charge. */}
      <ActivitiesHeader
        title="Calendrier"
        subtitle={SUBTITLES.list}
        isEmpty={weeks.length === 0 && page === 1}
      />

      <CalendarToolbar view="liste" month={month} currentMonth={currentMonth} />

      {newest !== undefined && oldest !== undefined ? (
        <div className="flex flex-col gap-4">
          {weeks.map((week) => (
            <ActivityWeek key={week.startsOn} week={week} />
          ))}

          {/* Rendue dès qu'une extrémité est franchissable : sur un historique
              qui tient en une page, la navigation n'a rien à proposer. */}
          {hasOlder || page > 1 ? (
            <WeeksPagination
              page={page}
              hasOlder={hasOlder}
              span={formatWeekSpan(oldest.startsOn, newest.startsOn)}
              month={month}
              currentMonth={currentMonth}
            />
          ) : null}
        </div>
      ) : null}

      {weeks.length === 0 && page > 1 ? (
        <p className="text-[0.78rem] text-fg-faint">
          Ton historique s&apos;arrête avant cette page.{" "}
          <Link
            href={activitiesHref({ view: "liste", month }, currentMonth)}
            className="text-accent underline-offset-4 hover:underline"
          >
            Revenir aux dernières semaines
          </Link>
        </p>
      ) : null}
    </>
  );
}

/**
 * Le `searchParams` n'est pas attendu ici mais dans l'enfant suspendu, et
 * `connection()` y bascule la route en Partial Prerender : coquille statique
 * immédiate, données streamées à la requête.
 */
export default function ActivitiesPage({ searchParams }: PageProps) {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<ActivitiesSkeleton />}>
        <ActivitiesContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
