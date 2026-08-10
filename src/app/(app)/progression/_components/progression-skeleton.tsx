import { Skeleton } from "@/components/ui/skeleton";

/** Cadre de panneau, repris à l'identique du composant `Panel`. */
function PanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      {children}
    </div>
  );
}

/** Un histogramme par seau : gouttière de graduations + cadre de barres. */
function BarsFrame() {
  return (
    <div className="flex gap-2 p-4 sm:p-5">
      <Skeleton className="h-40 w-9 shrink-0 sm:h-48 sm:w-12" />
      <Skeleton className="h-40 min-w-0 flex-1 sm:h-48" />
    </div>
  );
}

/**
 * Squelette de la page « Progression ».
 *
 * Même géométrie que la page réelle (en-tête, filtre, indicateurs, panneaux de
 * courbes puis d'histogrammes) : à l'arrivée des données, rien ne doit sauter.
 * Toute modification de la mise en page doit être répercutée ici.
 */
export function ProgressionSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement de la progression"
      className="flex flex-col gap-5 sm:gap-6"
    >
      <div className="min-w-0">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2.5 h-8 w-56 max-w-full sm:h-9" />
        <Skeleton className="mt-2 h-3.5 w-72 max-w-full" />
      </div>

      <Skeleton className="h-8 w-56" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {[0, 1, 2].map((card) => (
          <div
            key={card}
            className="rounded-card border border-border bg-surface p-4 last:col-span-2 sm:p-5 md:last:col-span-1"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-[1.9rem] w-20 sm:h-[2.3rem]" />
            <Skeleton className="mt-2.5 h-3 w-32 max-w-full" />
          </div>
        ))}
      </div>

      <PanelFrame>
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <Skeleton className="h-4 w-full" />
          {["h-36 sm:h-44", "h-24 sm:h-28", "h-24 sm:h-28"].map((height, index) => (
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

      <PanelFrame>
        <div className="flex gap-2 p-4 sm:p-5">
          <Skeleton className="h-40 w-9 shrink-0 sm:h-52 sm:w-12" />
          <Skeleton className="h-40 min-w-0 flex-1 sm:h-52" />
        </div>
      </PanelFrame>

      <PanelFrame>
        <BarsFrame />
      </PanelFrame>

      <PanelFrame>
        <BarsFrame />
      </PanelFrame>

      <span className="sr-only">Chargement de la progression…</span>
    </div>
  );
}
