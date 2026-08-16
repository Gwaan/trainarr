import { Skeleton } from "@/components/ui/skeleton";

/**
 * Squelette du tableau de bord.
 *
 * Reproduit la géométrie réelle (mêmes grilles, mêmes hauteurs de cartes et de
 * panneaux) : à l'arrivée des données, rien ne doit sauter. Toute modification
 * de la mise en page du dashboard doit être répercutée ici.
 */
export function DashboardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement du tableau de bord"
      className="flex flex-col gap-5 sm:gap-6"
    >
      {/* En-tête : date + salutation */}
      <div>
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-2 h-8 w-56 max-w-full sm:h-9" />
      </div>

      {/* Indicateurs clés */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-card border border-border bg-surface p-4 sm:p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-[1.9rem] w-20 sm:h-[2.3rem]" />
        </div>
        <div className="rounded-card border border-border bg-surface p-4 sm:p-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-[1.9rem] w-16 sm:h-[2.3rem]" />
        </div>
        {/* Forme TSB : une jauge, pas un chiffre. Même géométrie que `Gauge` —
            libellé, arc **carré** (son viewBox l'est) centré sous les 10 rem du
            composant, puis la note centrée. Une tuile plate ici ferait grandir
            la rangée de ~140 px à l'arrivée des données. */}
        <div className="col-span-2 rounded-card border border-border bg-surface p-4 sm:p-5 md:col-span-1">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mx-auto mt-3 aspect-square w-full max-w-[10rem]" />
          <Skeleton className="mx-auto mt-2.5 h-3 w-40 max-w-full" />
        </div>

        {/* Tuile bien-être : pleine largeur, trois mesures côte à côte. Même
            géométrie que `WellnessTile` — titre, puis libellé + valeur par
            colonne. */}
        <div className="col-span-2 rounded-card border border-border bg-surface p-4 sm:p-5 md:col-span-3">
          <Skeleton className="h-3 w-24" />
          <div className="mt-3 grid grid-cols-3 gap-3 sm:gap-4">
            {[0, 1, 2].map((measure) => (
              <div key={measure}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-[1.45rem] w-14 sm:h-[1.6rem]" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        {/* Séance du jour */}
        <div className="flex flex-col rounded-card border border-border bg-surface lg:col-span-2">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="flex flex-1 flex-col p-4 sm:p-5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-2.5 h-[1.7rem] w-44 max-w-full" />

            <div className="mt-4 border-t border-border">
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  className="flex items-center justify-between gap-3 border-b border-border py-2.5"
                >
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              {[0, 1].map((box) => (
                <div key={box} className="rounded-button bg-surface-2 px-3 py-2">
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="mt-1.5 h-5 w-16" />
                </div>
              ))}
            </div>

            <div className="flex-1" />
            <Skeleton className="mt-5 h-12 w-full" />
          </div>
        </div>

        {/* Charge d'entraînement */}
        <div className="flex flex-col rounded-card border border-border bg-surface lg:col-span-3">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <Skeleton className="h-3 w-36" />
          </div>
          <div className="flex flex-1 flex-col p-4 sm:p-5">
            <Skeleton className="max-h-72 min-h-32 flex-1 sm:min-h-40" />
            <div className="mt-3 flex justify-between">
              {[0, 1, 2, 3, 4, 5].map((week) => (
                <Skeleton key={week} className="h-3 w-7" />
              ))}
            </div>
            <Skeleton className="mt-4 h-3.5 w-full max-w-sm md:mt-auto" />
          </div>
        </div>
      </div>

      {/* Dernières activités */}
      <div className="rounded-card border border-border bg-surface">
        <div className="border-b border-border px-4 py-3 sm:px-5">
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

      <span className="sr-only">Chargement du tableau de bord…</span>
    </div>
  );
}
