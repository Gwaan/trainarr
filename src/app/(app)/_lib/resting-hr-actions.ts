"use server";

/**
 * Server Actions de la proposition de FC de repos : l'accepter, ou l'écarter.
 *
 * Minces par construction : session → validation Zod → DAL → revalidation. Toute
 * la logique (quelle médiane est proposable, ce qu'un refus mémorise) vit dans
 * `src/data/resting-hr-suggestion.ts` et `src/lib/metrics/resting-hr.ts`.
 *
 * **Deux surfaces, ces deux actions-là** — le tableau de bord et l'onglet
 * « Profil » des réglages — d'où leur place dans le `_lib` du groupe `(app)`,
 * comme celles de la FC max.
 *
 * Rappel de sécurité : une Server Action exportée est un endpoint public,
 * appelable par POST direct. La valeur qui arrive ici ne sert **jamais** de
 * valeur écrite — le DAL relit la proposition courante et refuse si elle ne
 * correspond pas. Se choisir une FC de repos par un appel direct est donc sans
 * effet.
 *
 * `revalidatePath('/', 'layout')` après une acceptation : la FC de repos de
 * profil est le plancher de la réserve cardiaque, donc elle pilote le TRIMP de
 * Karvonen et, par lui, la CTL, l'ATL et le TSB — tous recalculés à la lecture.
 * Tout l'écran change, pas seulement le formulaire.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ATHLETE_PROFILE_LIMITS, AthleteNotFoundError } from "@/data/athlete";
import {
  StaleRestingHrSuggestionError,
  acceptRestingHrSuggestion,
  dismissRestingHrSuggestion,
} from "@/data/resting-hr-suggestion";
import { getSession } from "@/data/session";
import { SESSION_REQUIRED_MESSAGE } from "@/lib/auth/messages";

import type { RestingHrSuggestionState } from "./resting-hr-suggestion";

/**
 * Ce que le navigateur envoie : le geste, et la valeur qu'il croyait proposée.
 *
 * Les bornes sont celles du profil — une valeur hors bornes est refusée avant
 * même d'interroger la base, et le DAL la refuserait de toute façon.
 */
const decisionSchema = z.object({
  intent: z.enum(["accept", "dismiss"]),
  bpm: z
    .number()
    .int()
    .min(ATHLETE_PROFILE_LIMITS.restingHrBpm.min)
    .max(ATHLETE_PROFILE_LIMITS.restingHrBpm.max),
});

/** Ce que la carte envoie — la forme est revalidée ici, rien n'est cru sur parole. */
export type RestingHrDecision = z.input<typeof decisionSchema>;

const STALE_MESSAGE =
  "Cette proposition n’est plus d’actualité — recharge la page pour voir la suivante.";

/**
 * Tranche la proposition de FC de repos courante. Compatible `useActionState`.
 *
 * Une seule action pour les deux gestes : ils partagent leur état, leur
 * validation et leur traitement d'erreur, et ne diffèrent que d'un appel au DAL.
 */
export async function resolveRestingHrSuggestionAction(
  _previous: RestingHrSuggestionState,
  decision: RestingHrDecision,
): Promise<RestingHrSuggestionState> {
  // Dans le corps de l'action, avant toute validation : ni le proxy ni la page
  // ne la protègent, elle s'appelle en POST direct.
  if ((await getSession()) === null) {
    return { status: "error", message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = decisionSchema.safeParse(decision);
  if (!parsed.success) {
    return { status: "error", message: STALE_MESSAGE };
  }

  const { intent, bpm } = parsed.data;

  try {
    if (intent === "accept") {
      await acceptRestingHrSuggestion(bpm);
    } else {
      await dismissRestingHrSuggestion(bpm);
    }
  } catch (error) {
    return failure(error);
  }

  revalidatePath("/", "layout");
  return { status: intent === "accept" ? "accepted" : "dismissed" };
}

/**
 * Traduit une erreur du DAL en état d'action. Aucune trace d'exécution ne
 * franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 */
function failure(error: unknown): RestingHrSuggestionState {
  if (error instanceof StaleRestingHrSuggestionError) {
    return { status: "error", message: STALE_MESSAGE };
  }
  if (error instanceof AthleteNotFoundError) {
    return {
      status: "error",
      message: "Aucun profil enregistré : crée-le d’abord, puis reviens ici.",
    };
  }

  console.error("[profile] proposition de FC de repos non tranchée :", error);
  return { status: "error", message: "Impossible pour l’instant. Réessaie." };
}
