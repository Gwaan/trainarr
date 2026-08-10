import Link from "next/link";
import { Activity, ChevronRight } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/panel";
import { StravaConnectButton } from "@/components/strava-connect-button";
import type { ActivitySummaryDto } from "@/data/activities";

import {
  formatDistance,
  formatHeartRate,
  formatPace,
  formatRelativeDay,
} from "../_lib/format";

const PANEL_TITLE = "Dernières activités";

/** Cellule absente : tiret discret, la ligne garde son alignement en colonnes. */
const MISSING = "—";

export function RecentActivitiesPanel({
  activities,
}: {
  activities: ActivitySummaryDto[];
}) {
  if (activities.length === 0) {
    return (
      <Panel title={PANEL_TITLE} padded={false}>
        <EmptyState
          icon={Activity}
          title="Aucune activité synchronisée"
          description="Connecte ton compte Strava pour importer automatiquement tes sorties : distances, allures et fréquences cardiaques arriveront ici."
          action={<StravaConnectButton variant="secondary" />}
        />
      </Panel>
    );
  }

  return (
    <Panel
      title={PANEL_TITLE}
      padded={false}
      meta={
        <Link
          href="/activities"
          className="inline-flex items-center gap-0.5 rounded-button text-fg-muted transition-colors duration-150 ease-out hover:text-accent"
        >
          Tout voir
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </Link>
      }
    >
      <ul>
        {activities.map((activity) => (
          <li key={activity.id} className="border-b border-border last:border-b-0">
            <Link
              href="/activities"
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
                  {activity.avgHrBpm === null ? MISSING : formatHeartRate(activity.avgHrBpm)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
