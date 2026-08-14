import type { Metadata } from "next";
import { Suspense } from "react";
import { ChartSpline, Gauge, TrendingUp } from "lucide-react";
import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import {
  getProgression,
  type FitnessUnavailableDto,
  type ProgressionDto,
} from "@/data/progression";
import { civilDateToMs } from "@/lib/dates/civil";

import { BucketBars } from "./_components/bucket-bars";
import { FitnessCharts } from "./_components/fitness-charts";
import { MetricEmptyState } from "./_components/metric-empty-state";
import { PeriodFilter } from "./_components/period-filter";
import { ProgressionSkeleton } from "./_components/progression-skeleton";
import { ProgressionStats } from "./_components/progression-stats";
import { Vo2maxChart } from "./_components/vo2max-chart";
import {
  BUCKET_NOUN,
  buildTrimpBarsModel,
  buildVolumeBarsModel,
  summarizeVolume,
} from "./_lib/bucket-charts";
import { formatFullDay } from "./_lib/date-axis";
import { RANGE_PARAM, parseRangeParam, toProgressionRange } from "./_lib/range";
import { MetricInfo } from "../_components/metric-info";
import {
  describeFitnessUnavailable,
  describeVo2maxUnavailable,
  type MetricUnavailableCopy,
} from "../_lib/metric-unavailable";
import { requireSession } from "../_lib/require-session";

export const metadata: Metadata = {
  title: "Progression",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Une courbe demande deux points ; en dessous, le panneau explique son vide. */
const MIN_LOAD_DAYS = 2;

/**
 * Note « en cours » du seau entamé : sa valeur est vraie mais incomplète, et une
 * barre plus basse que ses voisines se lirait sinon comme un décrochage.
 */
function partialNote(
  buckets: readonly { label: string; partial: boolean }[],
): string | null {
  const current = buckets.find((bucket) => bucket.partial);
  return current === undefined ? null : `${current.label} en cours`;
}

/**
 * Cause de l'absence de charge : celle que le DAL a calculée quand il en tient
 * une, sinon `fallback` — le cas où tout est en place mais où la période
 * elle-même ne porte rien.
 *
 * Ce branchement vaut pour **les deux** panneaux de charge, courbes et
 * histogramme : `buildDailyTrimp` renonce dès qu'un champ de profil manque,
 * sans même regarder les activités. Sans lui, l'un annoncerait « profil
 * incomplet » pendant que l'autre accuserait des séances sans cardio — deux
 * messages contradictoires, dont un faux.
 */
function loadUnavailableCopy(
  cause: FitnessUnavailableDto | null,
  fallback: MetricUnavailableCopy,
): MetricUnavailableCopy {
  return cause === null ? fallback : describeFitnessUnavailable(cause);
}

function LoadPanel({ progression }: { progression: ProgressionDto }) {
  if (progression.load.length >= MIN_LOAD_DAYS) {
    return (
      <Panel
        title="Forme, fatigue et fraîcheur"
        meta={<span className="num">{progression.load.length} jours</span>}
      >
        {/* Pas de ⓘ sur l'en-tête : le panneau trace trois métriques, et
            chacune porte le sien au-dessus de sa propre courbe. */}
        <FitnessCharts load={progression.load} />
      </Panel>
    );
  }

  return (
    <Panel title="Forme, fatigue et fraîcheur" padded={false}>
      <MetricEmptyState
        icon={ChartSpline}
        {...loadUnavailableCopy(progression.fitnessUnavailable, {
          title: "Pas encore de courbe de charge",
          description:
            "Il faut au moins deux jours d'entraînement enregistrés pour tracer une évolution de la charge.",
        })}
      />
    </Panel>
  );
}

function Vo2maxPanel({ progression }: { progression: ProgressionDto }) {
  return (
    <Panel
      title="VO₂max effective (ml/kg/min)"
      info={<MetricInfo id="vo2max" />}
      meta={<span>tendance 30 jours</span>}
      padded={progression.vo2max !== null}
    >
      {progression.vo2max ? (
        <Vo2maxChart points={progression.vo2max.points} trend={progression.vo2max.trend} />
      ) : (
        <MetricEmptyState
          icon={Gauge}
          {...describeVo2maxUnavailable(progression.vo2maxUnavailable)}
        />
      )}
    </Panel>
  );
}

function TrimpPanel({ progression }: { progression: ProgressionDto }) {
  const noun = BUCKET_NOUN[progression.bucketKind];
  const model = buildTrimpBarsModel(progression.trimpBuckets);
  const note = partialNote(progression.trimpBuckets);

  return (
    <Panel
      title={`Charge par ${noun.singular} (TRIMP)`}
      info={<MetricInfo id="trimp" />}
      meta={note === null ? null : <span className="num">{note}</span>}
      padded={false}
    >
      {model ? (
        <BucketBars model={model} className="p-4 sm:p-5" />
      ) : (
        <MetricEmptyState
          icon={TrendingUp}
          {...loadUnavailableCopy(progression.fitnessUnavailable, {
            title: "Pas encore de charge à répartir",
            description: `Le TRIMP repose sur la fréquence cardiaque : aucune séance de la période affichée n'en porte, ${noun.none} n'a donc de charge à montrer.`,
          })}
        />
      )}
    </Panel>
  );
}

function VolumePanel({ progression }: { progression: ProgressionDto }) {
  const noun = BUCKET_NOUN[progression.bucketKind];
  const model = buildVolumeBarsModel(progression.volume);
  const total = summarizeVolume(progression.volume);
  const note = partialNote(progression.volume);

  return (
    <Panel
      title={`Volume par ${noun.singular}`}
      meta={note === null ? null : <span className="num">{note}</span>}
      padded={false}
    >
      {model ? (
        <>
          <BucketBars model={model} className="p-4 pb-0 sm:p-5 sm:pb-0" />
          {/* Les barres disent la répartition ; ce total dit ce qu'elles pèsent
              ensemble — et c'est le seul endroit où le temps est exposé. */}
          {total ? (
            <p className="num px-4 py-4 text-[0.78rem] text-fg-faint sm:px-5 sm:pb-5">
              Total : {total}
            </p>
          ) : null}
        </>
      ) : (
        <MetricEmptyState
          icon={TrendingUp}
          title="Aucune sortie sur la période"
          description="Importe une séance depuis la page « Activités », ou élargis la période affichée."
        />
      )}
    </Panel>
  );
}

/**
 * `requireSession()` juste après `connection()` : c'est ici que la vérification
 * fait autorité (le proxy, lui, n'a regardé que la présence du cookie). Dans le
 * composant suspendu, donc sans coûter le `◐` de la route.
 */
async function ProgressionContent({ searchParams }: PageProps) {
  await connection();
  await requireSession();

  const param = parseRangeParam((await searchParams)[RANGE_PARAM]);
  const progression = await getProgression(toProgressionRange(param));

  return (
    <>
      <PageHeader
        eyebrow="Progression"
        title="Ton évolution"
        subtitle={`VO₂max, charge et volume — du ${formatFullDay(civilDateToMs(progression.from))} au ${formatFullDay(civilDateToMs(progression.to))}.`}
      />

      {/* Un seul filtre pour toute la page : deux blocs qui ne couvriraient pas
          la même période ne seraient comparables ni entre eux ni dans le temps. */}
      <PeriodFilter active={param} />

      <ProgressionStats
        fitness={progression.current.fitness}
        vo2max={progression.current.vo2max}
        fitnessUnavailable={progression.fitnessUnavailable}
        vo2maxUnavailable={progression.vo2maxUnavailable}
        hasProfile={progression.hasProfile}
      />

      <LoadPanel progression={progression} />
      <Vo2maxPanel progression={progression} />
      <TrimpPanel progression={progression} />
      <VolumePanel progression={progression} />
    </>
  );
}

/**
 * Le `searchParams` n'est pas attendu ici mais dans l'enfant suspendu, et
 * `connection()` y bascule la route en Partial Prerender : coquille statique
 * immédiate, données streamées à la requête. Sans lui, `cacheComponents: true`
 * prérendrait la page pendant `next build` (image Docker), où la base n'existe
 * pas. Cf. `.claude/rules/nextjs.md`.
 */
export default function ProgressionPage({ searchParams }: PageProps) {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <Suspense fallback={<ProgressionSkeleton />}>
        <ProgressionContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
