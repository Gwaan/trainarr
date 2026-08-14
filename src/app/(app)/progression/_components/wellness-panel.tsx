import { Sparkline } from "@/components/sparkline";

import { MetricInfo } from "../../_components/metric-info";
import type { WellnessSeriesView } from "../_lib/wellness-series";

/**
 * Les quatre tendances de bien-être — FC de repos, HRV, sommeil, poids.
 *
 * ## Ce que ces courbes sont, et ne sont pas
 *
 * Ce sont des mesures de **montre** (et de balance pour le poids) : Trainarr ne
 * les calcule pas, ne les corrige pas, et n'en dérive rien. Le panneau les
 * montre parce qu'elles expliquent souvent ce que la charge n'explique pas, et
 * il s'arrête là — aucune conclusion, aucun seuil, aucune couleur d'alerte. Une
 * HRV basse n'est pas une erreur système.
 *
 * **Une courbe est une suite de mesures, pas un axe de temps** : les nuits sans
 * mesure ne sont ni comblées ni creusées (cf. `_lib/wellness-series`). D'où le
 * compte de mesures affiché sous chaque courbe — c'est lui qui empêche de lire
 * six points comme un mois complet.
 *
 * Aucune bibliothèque de graphe : le `Sparkline` maison, déjà utilisé ailleurs.
 */

export type WellnessPanelProps = {
  series: readonly WellnessSeriesView[];
};

/** Une mesure : son libellé, sa dernière valeur, sa courbe, son amplitude. */
function SeriesCell({ entry }: { entry: WellnessSeriesView }) {
  const measures = entry.values.length;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="eyebrow flex min-w-0 items-center gap-1.5">
          {entry.label}
          {entry.sheet === null ? null : <MetricInfo id={entry.sheet} />}
        </h3>
        {entry.latest === null ? null : (
          <span className="num shrink-0 text-[1.05rem] leading-none font-semibold text-fg">
            {entry.latest}
          </span>
        )}
      </div>

      {measures >= 2 ? (
        <>
          <Sparkline
            data={entry.values}
            label={`${entry.label} — ${measures} mesures sur la période`}
            className="mt-3 h-14 sm:h-16"
          />
          <p className="num mt-2.5 text-[0.72rem] leading-snug text-fg-faint">
            {measures} mesures{entry.range === null ? "" : ` · ${entry.range}`}
          </p>
        </>
      ) : (
        <p className="mt-3 text-[0.78rem] leading-snug text-fg-faint">
          {/* Une seule mesure ne fait pas une tendance : on le dit, plutôt que
              de tracer un point isolé qui ressemblerait à une droite plate. */}
          {measures === 1
            ? "Une seule mesure sur la période : pas encore de tendance."
            : entry.absent}
        </p>
      )}
    </div>
  );
}

export function WellnessPanel({ series }: WellnessPanelProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 sm:gap-6">
      {series.map((entry) => (
        <SeriesCell key={entry.key} entry={entry} />
      ))}
    </div>
  );
}
