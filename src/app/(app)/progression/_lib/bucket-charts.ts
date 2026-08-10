/**
 * Ce que les deux histogrammes de la page tracent : la charge et le volume,
 * seau par seau. Fonctions pures — le modèle est construit côté serveur, seule
 * sa forme sérialisable traverse la frontière client.
 */

import type { BucketKind, BucketTrimpDto, BucketVolumeDto } from "@/data/progression";

import { formatDuration, formatNumber } from "../../_lib/format";
import { buildBucketBarsModel, type BucketBarsModel } from "./bucket-model";

/**
 * Le seau nomme la période dans les titres de panneaux et les messages. `none`
 * porte le genre du nom, que le français impose d'accorder : « aucune semaine »
 * mais « aucun mois ».
 */
export const BUCKET_NOUN: Record<BucketKind, { singular: string; none: string }> = {
  week: { singular: "semaine", none: "aucune semaine" },
  month: { singular: "mois", none: "aucun mois" },
};

/** « 4 séances », « 1 séance » — jamais « 1 séances ». */
function sessionCount(count: number): string {
  return `${count} séance${count > 1 ? "s" : ""}`;
}

export function buildTrimpBarsModel(
  buckets: readonly BucketTrimpDto[],
): BucketBarsModel | null {
  return buildBucketBarsModel({
    bars: buckets.map((bucket) => ({
      label: bucket.label,
      value: bucket.trimp,
      detail: null,
      partial: bucket.partial,
    })),
    formatValue: (value) => formatNumber(value, 0),
    formatTick: (value) => formatNumber(value, 0),
    // Le TRIMP est sans dimension : son nom tient lieu d'unité à l'oral.
    valueUnit: "TRIMP",
    seriesLabel: "Charge d'entraînement (TRIMP)",
  });
}

export function buildVolumeBarsModel(
  buckets: readonly BucketVolumeDto[],
): BucketBarsModel | null {
  return buildBucketBarsModel({
    bars: buckets.map((bucket) => ({
      label: bucket.label,
      value: bucket.distanceKm,
      detail: sessionCount(bucket.count),
      partial: bucket.partial,
    })),
    formatValue: (value) => `${formatNumber(value, 1)} km`,
    formatTick: (value) => formatNumber(value, 0),
    seriesLabel: "Volume parcouru",
  });
}

/**
 * Cumul de la période, sous le graphe : les barres montrent la répartition, ce
 * total dit ce qu'elles pèsent ensemble — et c'est le seul endroit où le temps
 * de déplacement est exposé, la hauteur des barres portant les kilomètres.
 */
export function summarizeVolume(buckets: readonly BucketVolumeDto[]): string | null {
  let distanceKm = 0;
  let movingTimeS = 0;
  let count = 0;

  for (const bucket of buckets) {
    distanceKm += bucket.distanceKm;
    movingTimeS += bucket.movingTimeS;
    count += bucket.count;
  }

  if (count === 0) return null;
  return `${formatNumber(distanceKm, 1)} km · ${formatDuration(movingTimeS)} · ${sessionCount(count)}`;
}
