import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Squelette de la page « Plan ».
 *
 * Trois issues possibles derrière le `Suspense` — le formulaire de création, une
 * proposition du coach, ou le plan en cours — et une seule géométrie de départ
 * possible : le fallback ne sait pas laquelle arrive, et `loading.tsx` encore
 * moins (il n'a même pas accès aux `searchParams`). C'est donc la **vue par
 * défaut du cas le plus fréquent** qui est figurée, dans son ordre exact :
 * l'en-tête, la barre de commande, le panneau « Objectif », le calendrier du
 * mois, puis le panneau « Ajuster le plan ».
 *
 * Ce fichier est rendu à l'identique par le `<Suspense>` de `page.tsx` et par
 * `loading.tsx` : les deux se succèdent pendant un même chargement, et toute
 * différence de géométrie se verrait comme un saut. Toute modification de la
 * mise en page de la vue calendrier doit être répercutée ici — **y compris**
 * l'ajout ou le retrait d'un bloc autour de la grille : un panneau oublié ne
 * décale pas un pixel, il pousse la grille de plusieurs centaines.
 */

/** Cinq semaines : ce qu'une grille mensuelle porte le plus souvent. */
const WEEKS = [0, 1, 2, 3, 4];

/** Sept jours, du lundi au dimanche — la ligne de l'agenda, la colonne de la grille. */
const DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Trois contraintes : séances par semaine, sortie longue, temps hebdomadaire. */
const SETTINGS = [0, 1, 2];

/**
 * La coquille d'un `Panel` — mêmes classes, au caractère près : c'est la seule
 * chose qui garantit que la carte pleine occupera exactement cette place.
 */
function PanelSkeleton({
  titleClassName,
  children,
}: {
  titleClassName: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className={cn("h-3", titleClassName)} />
      </div>
      <div className="flex flex-1 flex-col p-4 sm:p-5">{children}</div>
    </div>
  );
}

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

      {/* Barre de commande : bascule de vue à gauche, navigation de mois à droite */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-9 w-[9.5rem]" />
        <Skeleton className="h-11 w-[13rem]" />
      </div>

      {/* Objectif : échéance et fenêtre, intention, contraintes, renforcement.
          Les blocs facultatifs de la carte (note de test, résumé du coach) ne
          sont pas figurés — on ne sait pas s'ils existeront. */}
      <PanelSkeleton titleClassName="w-16">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-7 w-40 max-w-full" />
          <Skeleton className="h-3 w-36 max-w-full" />
        </div>
        <Skeleton className="mt-3 h-5 w-72 max-w-full" />
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SETTINGS.map((setting) => (
            <Skeleton key={setting} className="h-[3.3rem]" />
          ))}
        </div>
        <Skeleton className="mt-4 h-[4.8rem]" />
      </PanelSkeleton>

      <div className="flex flex-col gap-3 sm:gap-4">
        <div className="overflow-hidden rounded-card border border-border bg-surface">
          {/* En-tête de colonnes — la grille seule en a une */}
          <div className="hidden border-b border-border lg:grid lg:grid-cols-7">
            {DAYS.map((day) => (
              <div key={day} className="flex justify-center px-2 py-2">
                <Skeleton className="h-3 w-7" />
              </div>
            ))}
          </div>

          {WEEKS.map((week) => (
            <div key={week} className="border-b border-border">
              <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 lg:px-4">
                <Skeleton className="h-3 w-36 max-w-full" />
                <Skeleton className="h-3 w-14 shrink-0" />
              </div>

              <div className="lg:grid lg:grid-cols-7">
                {DAYS.map((day) => (
                  <div
                    key={day}
                    className="flex min-h-11 items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0 lg:min-h-28 lg:flex-col lg:gap-1 lg:border-t-0 lg:border-r lg:px-1.5 lg:py-1.5 lg:last:border-r-0"
                  >
                    <Skeleton className="h-3.5 w-[3.4rem] shrink-0" />
                    {/* Un jour sur deux porte une séance : une grille pleine
                        annoncerait un plan plus dense qu'il ne l'est. */}
                    {day % 2 === 0 ? (
                      <Skeleton className="h-[3.1rem] min-w-0 flex-1 self-stretch" />
                    ) : (
                      <span className="min-w-0 flex-1" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Grille de lecture des pastilles */}
          <div className="flex flex-wrap gap-x-4 gap-y-2 px-3 py-2.5 lg:px-4">
            {[0, 1, 2].map((item) => (
              <Skeleton key={item} className="h-3 w-24" />
            ))}
          </div>
        </div>
      </div>

      {/* Ajuster le plan : intitulé du champ, zone de saisie, bouton et sa note */}
      <PanelSkeleton titleClassName="w-28">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3.5 w-44 max-w-full" />
          <Skeleton className="h-24" />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Skeleton className="h-11 w-full sm:w-52" />
            <Skeleton className="h-8 w-full sm:h-3 sm:w-64" />
          </div>
        </div>
      </PanelSkeleton>

      <span className="sr-only">Chargement du plan…</span>
    </div>
  );
}
