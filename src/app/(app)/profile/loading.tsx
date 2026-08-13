import { ProfileSkeleton } from "./_components/profile-skeleton";

/**
 * Fallback de navigation vers le profil. Il reprend au caractère près le
 * wrapper et le squelette du `<Suspense>` de la page : les deux se succèdent
 * pendant un même chargement, et toute différence de géométrie se verrait comme
 * un saut.
 */
export default function ProfileLoading() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <ProfileSkeleton />
    </div>
  );
}
