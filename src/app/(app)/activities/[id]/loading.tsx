import { ActivityDetailSkeleton } from "./_components/activity-detail-skeleton";

/**
 * Fallback de navigation vers le détail d'une séance — sans lui, le groupe
 * `(app)` afficherait le squelette du tableau de bord, d'une tout autre
 * géométrie.
 */
export default function ActivityDetailLoading() {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <ActivityDetailSkeleton />
    </div>
  );
}
