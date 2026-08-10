import Link from "next/link";

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
 * Chaque ligne entière mène au détail de la séance.
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
          <li key={activity.id} className="border-b border-border last:border-b-0">
            {/* Toute la ligne mène au détail de la séance. */}
            <Link
              href={`/activities/${activity.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-2 sm:px-5"
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
                  {activity.avgHrBpm === null
                    ? MISSING
                    : formatHeartRate(activity.avgHrBpm)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
