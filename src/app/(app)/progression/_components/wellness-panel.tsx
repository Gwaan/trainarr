"use client";

import { useMemo } from "react";

import { SyncedPanels } from "@/components/chart/synced-panels";

import { MetricInfo } from "../../_components/metric-info";
import { formatFullDay } from "../_lib/date-axis";
import {
  buildWellnessTrends,
  wellnessSheetOf,
  type WellnessDayLike,
  type WellnessTrends,
} from "../_lib/wellness-series";

/**
 * Les quatre tendances de bien-être — FC de repos, HRV, sommeil, poids — en
 * petits multiples synchronisés sur une abscisse de dates.
 *
 * ## Ce que ces courbes sont, et ne sont pas
 *
 * Ce sont des mesures de **montre** (et de balance pour le poids) : Trainarr ne
 * les calcule pas, ne les corrige pas, et n'en dérive rien. Le panneau les
 * montre parce qu'elles expliquent souvent ce que la charge n'explique pas, et
 * il s'arrête là — aucune conclusion, aucun seuil, aucune couleur d'alerte. Une
 * HRV basse n'est pas une erreur système.
 *
 * ## Un seul curseur pour les quatre
 *
 * Même rendu que la charge d'entraînement, et pour une raison propre à ces
 * mesures : elles décrivent **la même nuit**, et c'est leur lecture croisée qui
 * dit quelque chose (« HRV basse *et* FC de repos haute »). Le curseur les
 * traverse donc toutes, à la souris comme au doigt (glissement — `SyncedPanels`
 * laisse le défilement vertical de la page passer).
 *
 * Une nuit sans mesure n'est jamais comblée : la courbe s'y coupe et le curseur
 * y affiche « — ».
 *
 * Le modèle se construit **ici**, côté client : il porte des fonctions de
 * formatage, qui ne franchissent pas la frontière serveur.
 */

export type WellnessPanelProps = {
  /** Les journées de la fenêtre, de la plus ancienne à la plus récente. */
  days: readonly WellnessDayLike[];
};

export function WellnessPanel({ days }: WellnessPanelProps) {
  // Mémoïsation manuelle assumée, comme sur les autres graphes de la page : le
  // React Compiler n'est pas activé, et les chemins seraient reconstruits à
  // chaque mouvement du pointeur.
  const trends = useMemo(() => buildWellnessTrends(days), [days]);

  return (
    <div className="flex flex-col gap-4">
      {trends.charts === null ? null : (
        <SyncedPanels
          model={trends.charts}
          ariaLabel="Graphes synchronisés des mesures de bien-être"
          header={(hover) => <CursorReadout trends={trends} hover={hover} />}
          info={(key) => {
            const sheet = wellnessSheetOf(key);
            return sheet === null ? null : <MetricInfo id={sheet} />;
          }}
        />
      )}

      {trends.absences.map((absence) => (
        <p key={absence.key} className="text-[0.78rem] leading-snug text-fg-faint">
          {absence.message}
        </p>
      ))}
    </div>
  );
}

/** Repère du curseur : la date lue, ou le dernier jour de la période au repos. */
function CursorReadout({
  trends,
  hover,
}: {
  trends: WellnessTrends;
  hover: number | null;
}) {
  const xs = trends.charts?.xs ?? [];
  const day = hover === null ? xs[xs.length - 1] : xs[hover];
  if (day === undefined) return null;

  return (
    <p className="flex items-baseline justify-between gap-3">
      <span className="eyebrow">{hover === null ? "Dernier jour" : "Curseur"}</span>
      <span className="num text-[0.82rem] text-fg">{formatFullDay(day)}</span>
    </p>
  );
}
