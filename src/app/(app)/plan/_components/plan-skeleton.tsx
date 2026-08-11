import { Skeleton } from "@/components/ui/skeleton";

/**
 * Squelette de la page « Plan ».
 *
 * Deux issues possibles derrière le `Suspense` — le formulaire de création ou le
 * plan lui-même — et la même géométrie de départ : en-tête, panneau, puis une
 * pile de blocs. Toute modification de la mise en page doit être répercutée ici.
 */
export function PlanSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement du plan"
      className="flex flex-col gap-5 sm:gap-6"
    >
      {/* En-tête : titre + sous-titre */}
      <div>
        <Skeleton className="h-8 w-40 max-w-full sm:h-9" />
        <Skeleton className="mt-2.5 h-3.5 w-96 max-w-full" />
      </div>

      {/* Panneau d'en-tête : objectif et contraintes */}
      <div className="rounded-card border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="p-4 sm:p-5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="mt-3 h-6 w-72 max-w-full" />
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((setting) => (
              <Skeleton key={setting} className="h-[3.4rem]" />
            ))}
          </div>
        </div>
      </div>

      {/* Trois semaines : le reste arrive en même temps, inutile de les figurer */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        {[0, 1, 2].map((week) => (
          <div key={week} className="rounded-card border border-border bg-surface">
            {/* En-tête sur deux lignes : intitulé de semaine, puis résumé */}
            <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Skeleton className="h-3 w-44 max-w-full" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="size-4 shrink-0" />
            </div>
            {[0, 1].map((session) => (
              <div
                key={session}
                className="flex gap-3 border-t border-border px-4 py-3 sm:px-5"
              >
                <Skeleton className="h-3.5 w-[3.9rem] shrink-0" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="mt-2 h-4 w-48 max-w-full" />
                  <Skeleton className="mt-2 h-3 w-32" />
                </div>
                {/* Chevron de dépliage du déroulé */}
                <Skeleton className="size-4 shrink-0" />
              </div>
            ))}
          </div>
        ))}
      </div>

      <span className="sr-only">Chargement du plan…</span>
    </div>
  );
}
