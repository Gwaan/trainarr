import { DashboardSkeleton } from "./_components/dashboard-skeleton";

/**
 * Fallback de navigation du groupe `(app)`. Même géométrie que le tableau de
 * bord, qui est la route par défaut du groupe.
 */
export default function AppLoading() {
  return <DashboardSkeleton />;
}
