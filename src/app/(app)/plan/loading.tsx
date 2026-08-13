import { PlanSkeleton } from "./_components/plan-skeleton";

/**
 * Fallback de navigation vers le plan. Il reprend au caractère près le wrapper
 * et le squelette du `<Suspense>` de la page : les deux se succèdent pendant un
 * même chargement, et toute différence de géométrie se verrait comme un saut.
 */
export default function PlanLoading() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <PlanSkeleton />
    </div>
  );
}
