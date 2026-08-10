/**
 * Retour du parcours OAuth Strava, porté par `?strava=…`.
 *
 * Le paramètre vient de l'URL : il n'est jamais réaffiché tel quel. Seules les
 * valeurs de la liste blanche produisent un bandeau, tout le reste (valeur
 * inconnue, paramètre répété, absence) ne produit rien.
 */

import type { BannerTone } from "@/components/banner";

export type StravaBanner = {
  tone: BannerTone;
  title: string;
  description: string;
  /** Variables d'environnement à renseigner, affichées en mono. */
  envVars?: readonly string[];
  /** Lien de sortie, quand le bandeau propose une action corrective. */
  action?: { href: string; label: string };
};

/**
 * Relance du flux OAuth, proposée par les bandeaux qui appellent une correction.
 *
 * Le chemin est écrit ici plutôt qu'importé de `StravaConnectButton` : ce module
 * doit rester sans dépendance de rendu (il est testé unitairement).
 */
const RETRY_CONNECT = {
  href: "/api/strava/connect",
  label: "Relancer la connexion Strava",
} as const;

const BANNERS: Record<string, StravaBanner> = {
  connected: {
    tone: "positive",
    title: "Strava connecté",
    description:
      "Synchronisation en cours… tes sorties apparaîtront ici au fil de leur import.",
  },
  denied: {
    tone: "neutral",
    title: "Connexion Strava annulée",
    description:
      "L'autorisation a été refusée : aucune donnée n'a été importée. Tu peux relancer la connexion quand tu veux.",
  },
  error: {
    tone: "negative",
    title: "La connexion Strava a échoué",
    description:
      "L'échange avec Strava n'a pas abouti. Relance la connexion ; si l'erreur persiste, vérifie l'application Strava déclarée.",
  },
  scope: {
    tone: "negative",
    title: "Permission Strava insuffisante",
    description:
      "Trainarr a besoin d'accéder à toutes tes activités, y compris privées. Relance la connexion et laisse « Voir tes activités privées » (activités privées) cochée sur l'écran d'autorisation Strava. Rien n'a été enregistré.",
    action: RETRY_CONNECT,
  },
  foreign: {
    tone: "negative",
    title: "Un autre compte Strava est déjà connecté",
    description:
      "Cette instance est liée à un autre compte Strava : l'autorisation a été refusée et rien n'a été enregistré. Si c'est bien ton compte, déconnecte l'autre d'abord.",
    action: RETRY_CONNECT,
  },
  unconfigured: {
    tone: "negative",
    title: "Strava n'est pas configuré",
    description:
      "Renseigne les variables du flux OAuth dans .env.local, puis redémarre l'application :",
    envVars: ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "APP_BASE_URL"],
  },
};

/**
 * Bandeau correspondant à `?strava=…`, ou `null` si le paramètre est absent,
 * répété ou inconnu.
 */
export function resolveStravaBanner(
  value: string | string[] | undefined,
): StravaBanner | null {
  // `hasOwn` et non un simple accès : `?strava=constructor` remonterait sinon
  // une propriété héritée de `Object.prototype`.
  if (typeof value !== "string" || !Object.hasOwn(BANNERS, value)) return null;
  return BANNERS[value] ?? null;
}
