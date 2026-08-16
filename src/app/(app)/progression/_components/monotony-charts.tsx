"use client";

import { useMemo } from "react";

import { SyncedMultiPanels } from "@/components/chart/synced-multi-panels";
import { civilDateToMs } from "@/lib/dates/civil";
import type { MonotonyPoint } from "@/lib/metrics";
import { cn } from "@/lib/utils";

import { MetricInfo } from "../../_components/metric-info";
import { formatMonotony } from "../../_lib/format";
import { MONOTONY_THRESHOLD, readMonotony } from "../../_lib/metric-tone";
import {
  buildMonotonyChartsModel,
  monotonyReading,
  type MonotonyReading,
} from "../_lib/monotony-series";
import { formatFullDay } from "../_lib/date-axis";

/**
 * Les deux tons que `readMonotony` peut rendre. Une monotonie haute est un
 * signal à regarder, jamais une erreur : `warning` est le ton le plus fort
 * qu'elle atteigne, et le chiffre reste en texte — pas en couleur de série.
 */
const TONE_TEXT: Record<ReturnType<typeof readMonotony>["tone"], string> = {
  default: "text-fg",
  accent: "text-accent",
  positive: "text-positive",
  warning: "text-warning",
  negative: "text-negative",
};

export type MonotonyChartsProps = {
  /** Série dense, un point par jour de la période. */
  points: readonly MonotonyPoint[];
};

/**
 * Monotonie et contrainte de Foster sur un même panneau à deux axes : la charge
 * dit combien on charge, la monotonie dit si on alterne.
 */
export function MonotonyCharts({ points }: MonotonyChartsProps) {
  // Mémoïsation manuelle assumée, comme sur le panneau de charge : sans elle,
  // les chemins des deux séries seraient reconstruits à chaque mouvement du
  // pointeur.
  const model = useMemo(() => buildMonotonyChartsModel(points), [points]);
  const reading = useMemo(() => monotonyReading(points), [points]);

  if (model === null) {
    return (
      // La porte de la page est de huit jours (`MIN_MONOTONY_DAYS`) : arriver
      // ici ne veut donc pas dire « période trop courte », mais « aucun jour de
      // la période n'a de monotonie mesurable ». Sept jours de charge
      // rigoureusement identique — le plus souvent sept jours à zéro — n'ont pas
      // d'écart-type, donc pas de quotient : ni séance, ni FC enregistrée, et
      // rien à tracer.
      <p className="text-[0.82rem] leading-relaxed text-fg-muted">
        Aucune semaine de la période n&apos;a de monotonie mesurable : elle
        compare les charges de sept jours entre elles, et il n&apos;y a rien à
        comparer tant qu&apos;elles restent toutes identiques — sept jours sans
        séance, ou sans fréquence cardiaque enregistrée, n&apos;en donnent
        aucune.
      </p>
    );
  }

  return (
    <>
      <SyncedMultiPanels
        model={model}
        ariaLabel="Graphe synchronisé de la monotonie et de la contrainte"
        header={(hover) => <CursorReadout points={points} hover={hover} />}
        info={() => <MetricInfo id="monotony" />}
      />

      {reading === null ? null : <MonotonyNote reading={reading} />}
    </>
  );
}

/**
 * La lecture du dernier point mesuré, en toutes lettres.
 *
 * **La semaine décrite est nommée dès qu'elle n'est pas la dernière.** Sauter
 * les trous de fin est la bonne chose à faire — il n'y a rien à dire d'une
 * fenêtre sans monotonie —, mais ça déplace la valeur dans le temps : une
 * semaine de séances sans ceinture cardio ne produit aucun TRIMP, donc aucune
 * monotonie, et la dernière mesurée peut dater de dix jours. L'annoncer « sur
 * les sept derniers jours » lui attribuerait une période qu'elle ne décrit pas,
 * ton d'alerte compris.
 *
 * Le seuil de Foster n'est pas tracé sur le graphe : c'est un repère de
 * population, et une ligne rouge en travers de la courbe lui donnerait l'autorité
 * d'un seuil personnel qu'il n'a pas. Il se lit ici, avec sa réserve.
 */
function MonotonyNote({ reading }: { reading: MonotonyReading }) {
  const tone = readMonotony(reading.monotony);

  return (
    <p className="mt-4 text-[0.82rem] leading-relaxed text-fg-muted">
      <span className={cn("num", TONE_TEXT[tone.tone])}>
        {formatMonotony(reading.monotony)}
      </span>{" "}
      {reading.atPeriodEnd ? (
        "sur les sept derniers jours de la période."
      ) : (
        <>
          sur les sept jours s&apos;achevant le{" "}
          <span className="num">{formatFullDay(civilDateToMs(reading.date))}</span>,
          dernière semaine mesurable de la période : depuis, les charges
          quotidiennes sont toutes identiques — sans séance ou sans fréquence
          cardiaque, il n&apos;y a pas de quotient à calculer.
        </>
      )}{" "}
      {tone.note} Le repère usuel (Foster, 1998) place la limite autour de{" "}
      {MONOTONY_THRESHOLD} — c&apos;est une moyenne de population, pas un seuil
      calé sur toi, et la contrainte n&apos;en a aucun.
    </p>
  );
}

/** Repère du curseur : la date lue, ou le dernier jour de la période au repos. */
function CursorReadout({
  points,
  hover,
}: {
  points: readonly MonotonyPoint[];
  hover: number | null;
}) {
  const point = hover === null ? points[points.length - 1] : points[hover];

  return (
    <p className="flex items-baseline justify-between gap-3">
      <span className="eyebrow">{hover === null ? "Dernier jour" : "Curseur"}</span>
      <span className="num text-[0.82rem] text-fg">
        {formatFullDay(civilDateToMs(point.date))}
      </span>
    </p>
  );
}
