import { Skeleton } from "@/components/ui/skeleton";

/**
 * Squelette de la page « Coach ».
 *
 * Même géométrie que la page réelle : en-tête, panneau « Conversation »
 * contenant deux tours de parole — question en bulle à droite, réponse pleine
 * largeur à gauche —, puis la saisie séparée par un filet. Toute modification de
 * la mise en page doit être répercutée ici.
 *
 * Deux tours plutôt qu'un fil complet : la hauteur exacte du fil est inconnue
 * avant lecture, et un squelette plus haut que la conversation réelle ferait
 * remonter la page à l'arrivée des données.
 */
export function CoachSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement de la conversation"
      className="flex flex-col gap-5 sm:gap-6"
    >
      {/* En-tête : titre + sous-titre */}
      <div>
        <Skeleton className="h-8 w-40 max-w-full sm:h-9" />
        <Skeleton className="mt-2.5 h-3.5 w-96 max-w-full" />
      </div>

      <div className="rounded-card border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <Skeleton className="h-3 w-24" />
        </div>

        <div className="flex flex-col gap-5 p-4 sm:p-5">
          {/* Une question, puis sa réponse — deux fois. */}
          <div className="flex justify-end">
            <Skeleton className="h-[3.4rem] w-3/5" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>

          <div className="flex justify-end">
            <Skeleton className="h-9 w-2/5" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        </div>

        {/* Saisie : champ d'une ligne, puis la ligne d'envoi. */}
        <div className="border-t border-border p-4 sm:p-5">
          <Skeleton className="h-12 w-full" />
          <div className="mt-3 flex justify-end">
            <Skeleton className="h-11 w-32" />
          </div>
        </div>
      </div>

      <span className="sr-only">Chargement de la conversation…</span>
    </div>
  );
}
