import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Squelette de la page « Plan ».
 *
 * Trois issues possibles derrière le `Suspense` — le formulaire de création, une
 * proposition du coach, ou le plan en cours — et une seule géométrie de départ
 * possible : le fallback ne sait pas laquelle arrive, et `loading.tsx` encore
 * moins. C'est donc le **cas le plus fréquent** qui est figuré, dans son ordre
 * exact : l'en-tête, le panneau « Objectif » et sa resynchronisation, les
 * semaines du programme, puis le panneau « Ajuster le plan ».
 *
 * **Le bandeau de réévaluation n'est pas figuré**, et c'est la même décision que
 * pour la proposition de plan : il n'existe que tant qu'une réévaluation attend
 * une décision, c'est-à-dire rarement. Lui réserver de la place ferait sauter
 * l'écran à chaque chargement ordinaire — bien plus souvent qu'il ne l'évite.
 * Comme la proposition, il arrive **au-dessus** de ce squelette : ce qui suit ne
 * se décale pas, il se pousse d'un bloc.
 *
 * Ce fichier est rendu à l'identique par le `<Suspense>` de `page.tsx` et par
 * `loading.tsx` : les deux se succèdent pendant un même chargement, et toute
 * différence de géométrie se verrait comme un saut. Toute modification de la
 * mise en page du plan actif doit être répercutée ici — **y compris** l'ajout ou
 * le retrait d'un bloc : un panneau oublié ne décale pas un pixel, il pousse
 * tout ce qui suit de plusieurs centaines.
 */

/** Cinq semaines : de quoi remplir un écran sans promettre la longueur du plan. */
const WEEKS = [0, 1, 2, 3, 4];

/** Trois contraintes : séances par semaine, sortie longue, temps hebdomadaire. */
const SETTINGS = [0, 1, 2];

/**
 * La coquille d'un `Panel` — mêmes classes, au caractère près : c'est la seule
 * chose qui garantit que la carte pleine occupera exactement cette place.
 */
function PanelSkeleton({
  titleClassName,
  meta,
  children,
}: {
  titleClassName: string;
  /** Le pendant du `meta` d'un `Panel` : le repère aligné à droite du titre. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className={cn("h-3", titleClassName)} />
        {meta}
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

      {/* Objectif : échéance et fenêtre, intention, contraintes, renforcement,
          puis la resynchronisation en pied. Les blocs facultatifs de la carte
          (note de test, résumé du coach) ne sont pas figurés — on ne sait pas
          s'ils existeront. */}
      <PanelSkeleton
        titleClassName="w-16"
        meta={<Skeleton className="h-3 w-24 shrink-0" />}
      >
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
        <div className="mt-4 border-t border-border pt-3">
          <Skeleton className="h-9 w-full sm:w-56" />
        </div>
      </PanelSkeleton>

      {/* Programme : l'intitulé de section, puis les semaines repliées. Aucune
          n'est figurée dépliée : c'est le plan qui décide laquelle s'ouvre (la
          semaine en cours et la suivante), et le deviner ferait sauter l'écran
          plus sûrement qu'un repli uniforme. */}
      <section className="flex flex-col gap-3">
        <Skeleton className="ml-0.5 h-3 w-24" />
        {WEEKS.map((week) => (
          <div
            key={week}
            className="overflow-hidden rounded-card border border-border bg-surface"
          >
            <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-3.5 w-40 max-w-full" />
              </div>
              <Skeleton className="mt-0.5 size-4 shrink-0" />
            </div>
          </div>
        ))}
      </section>

      {/* Ajuster le plan : intitulé du champ, zone de saisie, bouton et sa note,
          puis l'archivage sous son filet. */}
      <PanelSkeleton titleClassName="w-28">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3.5 w-44 max-w-full" />
          <Skeleton className="h-24" />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Skeleton className="h-11 w-full sm:w-52" />
            <Skeleton className="h-8 w-full sm:h-3 sm:w-64" />
          </div>
        </div>
        <div className="mt-5 border-t border-border pt-4">
          <Skeleton className="h-9 w-full sm:w-44" />
        </div>
      </PanelSkeleton>

      <span className="sr-only">Chargement du plan…</span>
    </div>
  );
}
