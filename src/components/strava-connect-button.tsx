import { Button } from "@/components/ui/button";

/** Départ du parcours OAuth : route handler serveur, donc navigation complète. */
export const STRAVA_CONNECT_HREF = "/api/strava/connect";

/**
 * Lien de connexion Strava.
 *
 * `<a>` et non `next/link` : la cible est un route handler qui redirige vers
 * strava.com, pas une route de l'application.
 */
export function StravaConnectButton({
  variant = "accent",
}: {
  variant?: "accent" | "secondary";
}) {
  return (
    <Button variant={variant} asChild>
      <a href={STRAVA_CONNECT_HREF}>Connecter Strava</a>
    </Button>
  );
}
