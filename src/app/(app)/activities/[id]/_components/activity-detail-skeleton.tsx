import { Skeleton } from "@/components/ui/skeleton";

/** Cadre de panneau, repris à l'identique du composant `Panel`. */
function PanelFrame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-card border border-border bg-surface ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-16" />
      </div>
      {children}
    </div>
  );
}

/**
 * Squelette du détail d'une activité.
 *
 * Même géométrie que la page réelle (en-tête, chiffres + carte, graphes
 * empilés, kilomètres et zones, distributions, dérive et meilleurs segments)
 * pour qu'aucun bloc ne saute à l'arrivée des données.
 * Toute modification de la mise en page doit être répercutée ici.
 */
export function ActivityDetailSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement de la séance"
      className="flex flex-col gap-5 sm:gap-6"
    >
      <div className="min-w-0">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="mt-2.5 h-8 w-72 max-w-full sm:h-9" />
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3.5 w-56 max-w-full" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <PanelFrame className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 p-4 sm:grid-cols-3 sm:p-5 lg:grid-cols-2">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((tile) => (
              <div key={tile}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-4 w-20" />
              </div>
            ))}
          </div>
        </PanelFrame>
        <PanelFrame className="lg:col-span-3">
          <Skeleton className="h-64 w-full rounded-none sm:h-72 lg:h-[calc(100%-3rem)] lg:min-h-[20rem]" />
        </PanelFrame>
      </div>

      {/* Panneau « Coach » — même géométrie que `CoachPanelSkeleton`. */}
      <PanelFrame>
        <div className="flex flex-col gap-2.5 p-4 sm:p-5">
          <Skeleton className="h-3.5 w-52 max-w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-9/12" />
        </div>
      </PanelFrame>

      <PanelFrame>
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          {[
            "h-36 sm:h-44",
            "h-36 sm:h-44",
            "h-24 sm:h-28",
            "h-24 sm:h-28",
            "h-24 sm:h-28",
          ].map((height, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-40" />
              <div className="flex gap-2">
                <Skeleton className="h-3 w-9 shrink-0 sm:w-12" />
                <Skeleton className={`min-w-0 flex-1 ${height}`} />
              </div>
            </div>
          ))}
        </div>
      </PanelFrame>

      <div className="grid gap-4 lg:grid-cols-5">
        <PanelFrame className="lg:col-span-3">
          <div className="flex flex-col gap-3 p-4 sm:p-5">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-4 w-full" />
            ))}
          </div>
        </PanelFrame>
        <PanelFrame className="self-start lg:col-span-2">
          <div className="flex flex-col gap-0.5 p-4 sm:p-5">
            {[0, 1, 2, 3, 4].map((zone) => (
              <Skeleton key={zone} className="h-4 w-full" />
            ))}
          </div>
        </PanelFrame>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((histogram) => (
          <PanelFrame key={histogram}>
            <div className="flex flex-col gap-3 p-4 sm:p-5">
              <Skeleton className="h-3 w-48 max-w-full" />
              <div className="flex gap-2">
                <Skeleton className="h-3 w-9 shrink-0 sm:w-12" />
                <Skeleton className="h-32 min-w-0 flex-1 sm:h-36" />
              </div>
            </div>
          </PanelFrame>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <PanelFrame className="self-start lg:col-span-2">
          <div className="flex flex-col gap-3 p-4 sm:p-5">
            <Skeleton className="h-7 w-28" />
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-4 w-full" />
            ))}
          </div>
        </PanelFrame>
        <PanelFrame className="self-start lg:col-span-3">
          <div className="flex flex-col gap-3 p-4 sm:p-5">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-4 w-full" />
            ))}
          </div>
        </PanelFrame>
      </div>

      <span className="sr-only">Chargement de la séance…</span>
    </div>
  );
}
