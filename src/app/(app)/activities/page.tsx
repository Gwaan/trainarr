import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";

import { listActivityWeekPage } from "@/data/activities";

import { ActivitiesHeader } from "./_components/activities-header";
import { ActivitiesSkeleton } from "./_components/activities-skeleton";
import { ActivityWeek } from "./_components/activity-week";
import { WeeksPagination } from "./_components/weeks-pagination";
import {
  activitiesHref,
  formatWeekSpan,
  PAGE_PARAM,
  pageOffset,
  parsePageParam,
  WEEKS_PER_PAGE,
} from "./_lib/pagination";

export const metadata: Metadata = {
  title: "Activités",
};

const PAGE_SUBTITLE =
  "L'historique de tes sorties, semaine par semaine : distances, allures et fréquences cardiaques.";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Contenu de la page.
 *
 * `connection()` est indispensable : `cacheComponents: true` prérendrait sinon
 * la page pendant `next build` (image Docker), où la base n'existe pas.
 * Cf. `.claude/rules/nextjs.md`.
 */
async function ActivitiesContent({ searchParams }: PageProps) {
  await connection();

  const page = parsePageParam((await searchParams)[PAGE_PARAM]);
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
        title="Activités"
        subtitle={PAGE_SUBTITLE}
        isEmpty={weeks.length === 0 && page === 1}
      />

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
            />
          ) : null}
        </div>
      ) : null}

      {weeks.length === 0 && page > 1 ? (
        <p className="text-[0.78rem] text-fg-faint">
          Ton historique s&apos;arrête avant cette page.{" "}
          <Link
            href={activitiesHref(1)}
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
 * immédiate, semaines streamées à la requête.
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
