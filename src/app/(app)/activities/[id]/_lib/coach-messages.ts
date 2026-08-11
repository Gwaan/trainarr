import type { AiUnavailableReason } from "@/lib/ai/errors";

/**
 * Les phrases du panneau « Coach », hors du fichier `"use server"` — un module
 * d'actions ne peut exporter que des fonctions asynchrones, or l'affichage et
 * l'action doivent dire exactement la même chose d'une même panne.
 */

/** Coach injoignable : le panneau l'explique au lieu de proposer un bouton mort. */
export const COACH_UNAVAILABLE = {
  unconfigured: "Coach IA non configuré (AI_BASE_URL).",
  unreachable:
    "L'API du coach ne répond pas — le bouton reviendra quand elle répondra.",
} as const satisfies Record<AiUnavailableReason, string>;

/** L'API a répondu, mais sa sortie est inexploitable : relancer a du sens. */
export const COACH_GENERATION_FAILED =
  "Le coach n'a pas réussi à analyser cette séance, réessaie.";

/** Identifiant invalide ou séance qui n'est pas celle de l'athlète — même réponse. */
export const COACH_ACTIVITY_NOT_FOUND = "Activité introuvable — recharge la page.";

/** Repli : une panne inattendue ne dévoile jamais sa trace au client. */
export const COACH_UNEXPECTED_FAILURE =
  "Le feedback n'a pas pu être généré pour l'instant. Réessaie.";
