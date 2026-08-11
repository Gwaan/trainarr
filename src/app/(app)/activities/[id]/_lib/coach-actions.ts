"use server";

/**
 * Server Action du panneau « Coach » de la page de détail.
 *
 * Mince par construction : valider l'entrée → déléguer au service IA → revalider
 * la page. Aucune logique métier ici — l'assemblage du contexte, l'appel au
 * modèle et l'enregistrement vivent dans `src/lib/ai/feedback-service.ts`, et
 * l'appartenance de la séance à l'athlète est revérifiée par le DAL quel que
 * soit l'appelant (anti-IDOR).
 *
 * Rappel de sécurité : cette action est un endpoint public, appelable par POST
 * direct sans passer par le bouton. L'identifiant qui arrive ici vient du client
 * et n'est donc jamais une preuve d'appartenance.
 */

import { revalidatePath } from "next/cache";

import { ActivityNotFoundError } from "@/data/activity-feedback";
import { AiInvalidOutputError, AiResponseError, AiUnavailableError } from "@/lib/ai/errors";
import { generateActivityFeedback } from "@/lib/ai/feedback-service";

import { parseActivityId } from "./activity-id";
import {
  COACH_ACTIVITY_NOT_FOUND,
  COACH_GENERATION_FAILED,
  COACH_UNAVAILABLE,
  COACH_UNEXPECTED_FAILURE,
} from "./coach-messages";

/** État minimal : le contenu généré est relu par la page, pas renvoyé ici. */
export type CoachFeedbackState = {
  status: "idle" | "success" | "error";
  message?: string;
};

/**
 * Demande (ou redemande) au coach son analyse d'une séance.
 *
 * Compatible `useActionState` : `(état précédent, formData) => nouvel état`.
 * L'appel au modèle peut durer plusieurs minutes sur un modèle local — c'est
 * l'UI qui prévient, l'action se contente d'attendre.
 */
export async function requestFeedbackAction(
  _previous: CoachFeedbackState,
  formData: FormData,
): Promise<CoachFeedbackState> {
  // TODO(auth) : pas encore de session dans Trainarr (mono-utilisateur, accès
  // réseau restreint). Dès qu'elle existera, vérifier ici l'identité de
  // l'appelant — un contrôle au niveau de la page ne protège pas cette action.

  const raw = formData.get("activityId");
  // Même validation Zod que le segment d'URL : entier positif, forme unique.
  const activityId = typeof raw === "string" ? parseActivityId(raw) : null;
  if (activityId === null) {
    return { status: "error", message: COACH_ACTIVITY_NOT_FOUND };
  }

  try {
    await generateActivityFeedback(activityId);
  } catch (error) {
    return failure(error);
  }

  revalidatePath(`/activities/${activityId}`);
  return { status: "success" };
}

/**
 * Traduit une erreur du service en état de formulaire. Aucune trace d'exécution
 * ne franchit la frontière client : l'inattendu est journalisé côté serveur et
 * rendu générique côté client.
 */
function failure(error: unknown): CoachFeedbackState {
  if (error instanceof AiUnavailableError) {
    return { status: "error", message: COACH_UNAVAILABLE[error.reason] };
  }
  if (error instanceof ActivityNotFoundError) {
    return { status: "error", message: COACH_ACTIVITY_NOT_FOUND };
  }
  if (error instanceof AiResponseError || error instanceof AiInvalidOutputError) {
    return { status: "error", message: COACH_GENERATION_FAILED };
  }

  console.error("[coach] feedback impossible :", error);
  return { status: "error", message: COACH_UNEXPECTED_FAILURE };
}
