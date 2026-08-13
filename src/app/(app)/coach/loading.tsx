import { CoachSkeleton } from "./_components/coach-skeleton";

/**
 * Fallback de navigation vers le coach. Il reprend au caractère près le wrapper
 * et le squelette du `<Suspense>` de la page : les deux se succèdent pendant un
 * même chargement, et toute différence de géométrie se verrait comme un saut.
 */
export default function CoachLoading() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <CoachSkeleton />
    </div>
  );
}
