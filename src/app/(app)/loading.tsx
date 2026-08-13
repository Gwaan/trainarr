import { DashboardSkeleton } from "./_components/dashboard-skeleton";

/**
 * Fallback de navigation du groupe `(app)`. Même géométrie que le tableau de
 * bord, qui est la route par défaut du groupe.
 *
 * Il ne couvre plus que celle-ci : toutes les sous-routes du groupe portent
 * désormais leur propre `loading.tsx`, faute de quoi elles héritaient de ce
 * squelette-ci — le tableau de bord s'affichait alors une fraction de seconde à
 * la place de la page demandée. Y ajouter une route sans son squelette propre,
 * c'est réintroduire ce défaut.
 */
export default function AppLoading() {
  return <DashboardSkeleton />;
}
