import type { WeekOfActivities } from "@/data/activities";
import { Panel } from "@/components/panel";

import {
  formatDistance,
  formatDuration,
  formatHeartRate,
  formatPace,
  formatRelativeDay,
} from "../../_lib/format";

/** Cellule absente : tiret discret, la ligne garde son alignement en colonnes. */
const MISSING = "—";

/**
 * Une semaine d'entraînement : en-tête (numéro ISO + volume et durée cumulés)
 * puis les sorties, de la plus récente à la plus ancienne.
 *
 * Mêmes colonnes que le panneau « Dernières activités » du tableau de bord ;
 * sous 640 px la FC moyenne se replie, distance et allure restent alignées.
 */
export function ActivityWeek({ week }: { week: WeekOfActivities }) {
  return (
    <Panel
      title={week.weekLabel}
      padded={false}
      meta={
        <>
          <span className="num text-fg-muted">
            {formatDistance(week.totalDistanceM)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="num text-fg-muted">
            {formatDuration(week.totalMovingTimeS)}
          </span>
        </>
      }
    >
      <ul>
        {week.activities.map((activity) => (
          <li
            key={activity.id}
            className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:px-5"
          >
            <span className="min-w-0">
              <span className="block truncate text-[0.9rem] font-medium text-fg">
                {activity.name}
              </span>
              <span className="eyebrow mt-1.5 block">
                {formatRelativeDay(activity.startedAt)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-3 sm:gap-6">
              <span className="num w-[4.6rem] text-right text-[0.82rem] text-fg">
                {formatDistance(activity.distanceM)}
              </span>
              <span className="num w-[4.6rem] text-right text-[0.82rem] text-fg-muted">
                {activity.avgPaceSecPerKm === null
                  ? MISSING
                  : formatPace(activity.avgPaceSecPerKm)}
              </span>
              <span className="num hidden w-[4.6rem] text-right text-[0.82rem] text-fg-muted sm:block">
                {activity.avgHrBpm === null ? MISSING : formatHeartRate(activity.avgHrBpm)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
