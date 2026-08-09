import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { db } from './db/client';
import { activities, type Activity } from './db/schema';

/**
 * DTOs des activités exposés à l'UI.
 *
 * Déclarés explicitement (pas de `typeof row`) : `stravaId`, `athleteId` et
 * `createdAt` sont des champs internes et ne franchissent pas la frontière.
 */
export type ActivitySummaryDto = {
  id: number;
  name: string;
  sportType: string;
  startedAt: Date;
  distanceM: number;
  movingTimeS: number;
  elevationGainM: number | null;
  avgHrBpm: number | null;
  avgPaceSecPerKm: number | null;
};

export type ActivityDetailDto = ActivitySummaryDto & {
  elapsedTimeS: number;
  maxHrBpm: number | null;
  avgCadenceSpm: number | null;
};

export function toActivitySummaryDto(row: Activity): ActivitySummaryDto {
  return {
    id: row.id,
    name: row.name,
    sportType: row.sportType,
    startedAt: row.startedAt,
    distanceM: row.distanceM,
    movingTimeS: row.movingTimeS,
    elevationGainM: row.elevationGainM,
    avgHrBpm: row.avgHrBpm,
    avgPaceSecPerKm: row.avgPaceSecPerKm,
  };
}

export function toActivityDetailDto(row: Activity): ActivityDetailDto {
  return {
    ...toActivitySummaryDto(row),
    elapsedTimeS: row.elapsedTimeS,
    maxHrBpm: row.maxHrBpm,
    avgCadenceSpm: row.avgCadenceSpm,
  };
}

/** Les N activités les plus récentes, de la plus récente à la plus ancienne. */
export async function listRecentActivities(limit = 20): Promise<ActivitySummaryDto[]> {
  const rows = await db
    .select()
    .from(activities)
    .orderBy(desc(activities.startedAt))
    .limit(limit);
  return rows.map(toActivitySummaryDto);
}

/** Une activité par son id interne. `null` si elle n'existe pas. */
export async function getActivityById(id: number): Promise<ActivityDetailDto | null> {
  const rows = await db.select().from(activities).where(eq(activities.id, id)).limit(1);
  const row = rows[0];
  return row ? toActivityDetailDto(row) : null;
}
