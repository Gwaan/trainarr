import "server-only";

import { cache } from "react";

import { getActivityFull, type ActivityFullDto } from "@/data/activities";

/**
 * `generateMetadata` (le titre est le nom de la séance) et le corps de la page
 * lisent la même activité. `cache()` de React les dédoublonne à l'échelle de la
 * requête : une seule lecture, pas deux.
 */
export const loadActivity = cache(
  (id: number): Promise<ActivityFullDto | null> => getActivityFull(id),
);
