"use server";

/**
 * Server Actions de la proposition de FC seuil : l'accepter, ou l'écarter.
 *
 * Minces par construction : session → validation Zod → DAL → revalidation.
 * Toute la logique (quelle valeur est proposable, ce qu'un refus mémorise) vit
 * dans `src/data/lthr-suggestion.ts` et `src/lib/metrics/lthr.ts`.
 *
 * **Deux surfaces, ces deux actions-là.** Le tableau de bord et l'onglet
 * « Profil » des réglages montrent la même proposition et la tranchent avec les
 * mêmes actions — d'où leur place ici, dans le `_lib` du groupe `(app)`, plutôt
 * que colocalisées à l'une des deux routes.
 *
 * Rappel de sécurité : une Server Action exportée est un endpoint public,
 * appelable par POST direct. La valeur qui arrive ici ne sert **jamais** de
 * valeur écrite — le DAL relit la proposition courante et refuse si elle ne
 * correspond pas. Choisir sa propre FC seuil par un appel direct est donc sans
 * effet.
 *
 * `revalidatePath('/', 'layout')` après une acceptation, et il en fait plus ici
 * que pour la FC max : adopter une FC seuil change l'**ancrage** des zones
 * cardiaques, donc leurs bornes, donc la coloration des histogrammes, les cibles
 * FC affichées sur le plan et la répartition de chaque séance passée. Tout
 * l'écran change, partout.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AthleteNotFoundError } from "@/data/athlete";
import {
  StaleLthrSuggestionError,
  acceptLthrSuggestion,
  dismissLthrSuggestion,
} from "@/data/lthr-suggestion";
import { getSession } from "@/data/session";
import { SESSION_REQUIRED_MESSAGE } from "@/lib/auth/messages";
import { LTHR_BOUNDS } from "@/lib/metrics/lthr";

import type { LthrSuggestionState } from "./lthr-suggestion";

/**
 * Ce que le navigateur envoie : le geste, et la valeur qu'il croyait proposée.
 *
 * Les bornes sont celles de la plausibilité d'une FC seuil — une valeur hors
 * bornes est refusée avant même d'interroger la base, et le DAL la refuserait de
 * toute façon.
 */
const decisionSchema = z.object({
  intent: z.enum(["accept", "dismiss"]),
  bpm: z.number().int().min(LTHR_BOUNDS.min).max(LTHR_BOUNDS.max),
});

/** Ce que la carte envoie — la forme est revalidée ici, rien n'est cru sur parole. */
export type LthrDecision = z.input<typeof decisionSchema>;

const STALE_MESSAGE =
  "Cette proposition n’est plus d’actualité — recharge la page pour voir la suivante.";

/**
 * Tranche la proposition de FC seuil courante.
 *
 * Une seule action pour les deux gestes : ils partagent leur état, leur
 * validation et leur traitement d'erreur, et ne diffèrent que d'un appel au DAL.
 */
export async function resolveLthrSuggestionAction(
  _previous: LthrSuggestionState,
  decision: LthrDecision,
): Promise<LthrSuggestionState> {
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
      await acceptLthrSuggestion(bpm);
    } else {
      await dismissLthrSuggestion(bpm);
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
function failure(error: unknown): LthrSuggestionState {
  if (error instanceof StaleLthrSuggestionError) {
    return { status: "error", message: STALE_MESSAGE };
  }
  if (error instanceof AthleteNotFoundError) {
    return {
      status: "error",
      message: "Aucun profil enregistré : crée-le d’abord, puis reviens ici.",
    };
  }

  console.error("[profile] proposition de FC seuil non tranchée :", error);
  return { status: "error", message: "Impossible pour l’instant. Réessaie." };
}
