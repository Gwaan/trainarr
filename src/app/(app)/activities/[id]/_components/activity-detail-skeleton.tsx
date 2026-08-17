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
 *
 * **Deux familles de blocs n'y figurent pas**, pour deux raisons distinctes :
 *
 * 1. **les blocs vraiment conditionnels** — la météo, les objectifs de la
 *    séance, la ligne de recalage de la VO₂max (seulement quand une course est
 *    déclarée) : ils n'existent pas sur toutes les séances, et les réserver
 *    ferait sauter la page dans l'autre sens — plus souvent, et vers le haut ;
 * 2. **le bloc « Course officielle »**, qui n'est pas dans ce cas : la page ne
 *    le conditionne qu'à `isRunning`, il est donc présent sur la quasi-totalité
 *    des séances d'une appli de running. S'il n'est pas réservé, c'est qu'il est
 *    **en fin de page** : ce qui apparaît sous le dernier panneau ne décale
 *    rien de ce qu'on est en train de lire.
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
          <div className="p-4 sm:p-5">
            {/* Neuf tuiles, pas dix : la charge quitte la grille pour la jauge
                de pied de panneau dès que l'athlète a de quoi la calibrer, ce
                qui est le cas courant. */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-2">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((tile) => (
                <div key={tile}>
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="mt-2 h-4 w-20" />
                </div>
              ))}
            </div>

            {/* Jauge « Charge de la séance » — même géométrie que `Gauge` :
                libellé, arc carré centré, note. */}
            <div className="mt-5 border-t border-border pt-4">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mx-auto mt-3 aspect-square w-full max-w-[10rem] rounded-full" />
              <Skeleton className="mx-auto mt-2.5 h-3 w-44 max-w-full" />
            </div>
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
          {/* Trois panneaux depuis que les mesures se superposent : allure + FC,
              altitude en contexte, cadence + foulée. Deux d'entre eux portent un
              axe droit, donc les trois réservent la gouttière de droite —
              `hasRightGutter` est global, c'est ce qui les aligne. */}
          {["h-44 sm:h-60", "h-20 sm:h-24", "h-24 sm:h-32"].map((height, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-40" />
              <div className="flex gap-2">
                <Skeleton className="h-3 w-9 shrink-0 sm:w-12" />
                <Skeleton className={`min-w-0 flex-1 ${height}`} />
                <Skeleton className="h-3 w-9 shrink-0 sm:w-12" />
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
