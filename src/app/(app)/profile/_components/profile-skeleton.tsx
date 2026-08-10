import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Une ligne de champ : libellé, aide, saisie. */
function FieldSkeleton({ inputClassName }: { inputClassName: string }) {
  return (
    <div>
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="mt-2 h-3 w-72 max-w-full" />
      <Skeleton className={cn("mt-3 h-11", inputClassName)} />
    </div>
  );
}

function PanelSkeleton({
  titleWidth,
  children,
}: {
  titleWidth: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className={cn("h-3", titleWidth)} />
      </div>
      <div className="flex flex-col gap-5 p-4 sm:p-5">{children}</div>
    </div>
  );
}

/**
 * Squelette de la page « Profil ».
 *
 * Même géométrie que le formulaire réel (en-tête, deux panneaux, bouton) pour
 * qu'aucun bloc ne saute à l'arrivée des données. Toute modification de la mise
 * en page doit être répercutée ici.
 */
export function ProfileSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement du profil"
      className="flex flex-col gap-5 sm:gap-6"
    >
      {/* En-tête : titre + sous-titre */}
      <div>
        <Skeleton className="h-8 w-64 max-w-full sm:h-9" />
        <Skeleton className="mt-2.5 h-3.5 w-96 max-w-full" />
      </div>

      <div className="flex flex-col gap-4 sm:gap-5">
        <PanelSkeleton titleWidth="w-16">
          <FieldSkeleton inputClassName="w-full sm:max-w-xs" />
          {/* Sexe : trois choix côte à côte à partir de `sm` */}
          <div>
            <Skeleton className="h-3.5 w-12" />
            <Skeleton className="mt-2 h-3 w-full max-w-lg" />
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {[0, 1, 2].map((choice) => (
                <Skeleton key={choice} className="h-[2.85rem]" />
              ))}
            </div>
          </div>
          <FieldSkeleton inputClassName="w-full sm:w-48" />
        </PanelSkeleton>

        <PanelSkeleton titleWidth="w-40">
          {/* Fréquences cardiaques : deux champs courts sur une ligne */}
          <div>
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="mt-2 h-3 w-full max-w-md" />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-3">
              {[0, 1].map((field) => (
                <div key={field}>
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="mt-2.5 h-11 w-32" />
                </div>
              ))}
            </div>
          </div>
          <FieldSkeleton inputClassName="w-32" />
        </PanelSkeleton>

        <Skeleton className="h-12 w-full sm:w-44" />
      </div>

      <span className="sr-only">Chargement du profil…</span>
    </div>
  );
}
