import type { ReactNode } from "react";

import { Panel } from "@/components/panel";
import type { Decoupling, HalfStats } from "@/lib/metrics";
import { cn } from "@/lib/utils";

import { MetricInfo } from "../../../_components/metric-info";
import { formatHeartRate, formatNumber, formatPace } from "../../../_lib/format";
import { decouplingVerdict, pacePerKmOf } from "../_lib/decoupling-model";
import { MISSING, formatSignedPercent } from "../_lib/format-detail";

/** Ton d'état — sémantique, jamais une couleur de série (cf. design.md). */
const TONE_TEXT = {
  positive: "text-positive",
  warning: "text-warning",
  negative: "text-negative",
} as const;

const TONE_DOT = {
  positive: "bg-positive",
  warning: "bg-warning",
  negative: "bg-negative",
} as const;

/**
 * Dérive cardiaque (Pa:Hr) de la séance.
 *
 * La valeur en tête est signée — un découplage négatif est une bonne nouvelle,
 * et « 4,2 % » sans signe ne dirait pas dans quel sens le cœur a dérivé. Le ton
 * qualifie l'état, avec son libellé : la couleur ne porte jamais l'information
 * seule.
 *
 * Le tableau du dessous montre d'où vient le chiffre : les deux moitiés
 * comparées, leur allure, leur FC et leur efficience.
 */
export function DecouplingPanel({
  decoupling,
  className,
}: {
  decoupling: Decoupling;
  className?: string;
}) {
  const verdict = decouplingVerdict(decoupling.decouplingPct);

  return (
    <Panel
      title="Dérive cardiaque"
      info={<MetricInfo id="decoupling" />}
      className={className}
    >
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span
          className={cn(
            "num text-[1.9rem] leading-none font-semibold",
            TONE_TEXT[verdict.tone],
          )}
        >
          {formatSignedPercent(decoupling.decouplingPct)}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[0.78rem] text-fg-muted">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", TONE_DOT[verdict.tone])}
          />
          {verdict.label}
        </span>
      </p>

      <p className="mt-2 text-[0.72rem] leading-snug text-fg-faint">
        Écart d&apos;efficience (vitesse ÷ FC) entre les deux moitiés de la
        séance. Positif = le cœur monte à allure tenue.
      </p>

      <table className="mt-4 w-full text-[0.8rem]">
        <caption className="sr-only">
          Allure moyenne, fréquence cardiaque moyenne et facteur d&apos;efficience
          de chaque moitié de la séance.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="eyebrow py-2 text-left" />
            <th scope="col" className="eyebrow py-2 text-right">
              1ʳᵉ moitié
            </th>
            <th scope="col" className="eyebrow py-2 text-right">
              2ᵉ moitié
            </th>
          </tr>
        </thead>
        <tbody>
          <HalfRow
            label="Allure"
            first={paceOf(decoupling.firstHalf)}
            second={paceOf(decoupling.secondHalf)}
          />
          <HalfRow
            label="FC moy."
            first={formatHeartRate(decoupling.firstHalf.avgHrBpm)}
            second={formatHeartRate(decoupling.secondHalf.avgHrBpm)}
          />
          {/* Trois décimales : l'EF vaut ~0,027 m/s par bpm — au centième, les
              deux moitiés afficheraient le même nombre. */}
          <HalfRow
            label="EF"
            info={<MetricInfo id="ef" />}
            first={formatNumber(decoupling.firstHalf.ef, 3)}
            second={formatNumber(decoupling.secondHalf.ef, 3)}
          />
        </tbody>
      </table>
    </Panel>
  );
}

function paceOf(half: HalfStats): string {
  const pace = pacePerKmOf(half.avgSpeedMps);
  return pace === null ? MISSING : formatPace(pace);
}

function HalfRow({
  label,
  info,
  first,
  second,
}: {
  label: string;
  /** Déclencheur d'explication, sur les seules lignes qui sont un calcul. */
  info?: ReactNode;
  first: string;
  second: string;
}) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <th scope="row" className="py-2 text-left font-medium text-fg-muted">
        <span className="flex items-center gap-1.5">
          {label}
          {info}
        </span>
      </th>
      <td className="num py-2 text-right whitespace-nowrap text-fg">{first}</td>
      <td className="num py-2 text-right whitespace-nowrap text-fg">{second}</td>
    </tr>
  );
}
