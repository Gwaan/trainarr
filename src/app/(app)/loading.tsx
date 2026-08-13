import { DashboardSkeleton } from "./_components/dashboard-skeleton";

/**
 * Fallback de navigation du groupe `(app)`. Même géométrie que le tableau de
 * bord, qui est la route par défaut du groupe.
 *
 * Il ne couvre en pratique que celle-ci : les sous-routes qui chargent des
 * données portent désormais leur propre `loading.tsx`, faute de quoi elles
 * héritaient de ce squelette-ci — le tableau de bord s'affichait alors une
 * fraction de seconde à la place de la page demandée. Reste `/coach`, qui n'en
 * a délibérément pas : sa coquille est entièrement prérendue, il n'y a rien à
 * attendre et donc aucun squelette à dessiner. Elle retombe formellement sur ce
 * fallback, sans jamais l'afficher.
 */
export default function AppLoading() {
  return <DashboardSkeleton />;
}
