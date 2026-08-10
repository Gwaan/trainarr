import { Skeleton } from "@/components/ui/skeleton";

/**
 * Squelette de la page « Activités ».
 *
 * Même géométrie que le contenu réel (en-tête, cartes de semaine, lignes
 * d'activité) pour qu'aucun bloc ne saute à l'arrivée des données. Toute
 * modification de la mise en page doit être répercutée ici.
 */
export function ActivitiesSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement des activités"
      className="flex flex-col gap-5 sm:gap-6"
    >
      {/* En-tête : titre + sous-titre, et l'action alignée à droite */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Skeleton className="h-8 w-44 max-w-full sm:h-9" />
          <Skeleton className="mt-2.5 h-3.5 w-80 max-w-full" />
        </div>
        {/* Statut Strava + bouton d'import FIT */}
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-[8.5rem]" />
          <Skeleton className="h-11 w-[8.5rem] sm:w-[13.5rem]" />
        </div>
      </div>

      {/* Deux semaines : le reste arrive en même temps, inutile de les figurer */}
      <div className="flex flex-col gap-4">
        {[0, 1].map((week) => (
          <div key={week} className="rounded-card border border-border bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-32" />
            </div>
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:px-5"
              >
                <div className="min-w-0">
                  <Skeleton className="h-5 w-40 max-w-full" />
                  <Skeleton className="mt-1.5 h-3 w-20" />
                </div>
                <div className="flex shrink-0 items-center gap-3 sm:gap-6">
                  <Skeleton className="h-3.5 w-[4.6rem]" />
                  <Skeleton className="h-3.5 w-[4.6rem]" />
                  <Skeleton className="hidden h-3.5 w-[4.6rem] sm:block" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <span className="sr-only">Chargement des activités…</span>
    </div>
  );
}
