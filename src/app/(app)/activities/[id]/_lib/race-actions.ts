"use server";

/**
 * Server Actions du bloc « Course officielle » : déclarer une séance comme
 * course (ou corriger la déclaration), et la retirer.
 *
 * Minces par construction : vérifier la session → valider (Zod) → déléguer au
 * DAL → revalider. Le DAL revérifie les bornes de son côté et reborne toute
 * écriture à l'athlète de la session (défense en profondeur).
 *
 * Ce sont des endpoints publics appelables par POST direct, et ils portent un
 * **identifiant de ressource** — celui de l'activité, celui de la course. Aucun
 * des deux ne prouve quoi que ce soit : c'est le DAL qui les confronte à
 * l'athlète, et son refus ne dit jamais si la ressource existe.
 *
 * **Ce qu'elles renvoient est sérialisé vers le client** : un statut, un
 * message, des erreurs par champ. Jamais une trace d'exécution.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getSession } from "@/data/session";
import {
  InvalidRaceResultError,
  RACE_RESULT_LIMITS,
  RaceActivityNotFoundError,
  deleteRaceResult,
  saveRaceResult,
} from "@/data/race-results";
import { SESSION_REQUIRED_MESSAGE } from "@/lib/auth/messages";

import { parseRaceTimeSeconds } from "../../../_lib/race-time";

import type { RaceFormState, RaceRemovalState } from "./race-state";

/** Un `FormData` ne porte que des chaînes ou des fichiers ; un fichier n'est pas une valeur. */
function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * La distance officielle, saisie en kilomètres.
 *
 * Une chaîne convertie puis vérifiée, et non `z.coerce.number()` : celui-ci
 * transforme un champ vidé en zéro, c'est-à-dire en une course de zéro
 * kilomètre que la borne du DAL refuserait avec un message hors sujet.
 *
 * **La virgule est acceptée** : un clavier français en produit une, et refuser
 * « 10,5 » pour cause de séparateur serait une brimade.
 */
const distanceKm = z
  .string()
  .trim()
  .min(1, "Distance officielle manquante.")
  .transform((value) => Number(value.replace(",", ".")))
  .refine(
    (value) =>
      Number.isFinite(value) &&
      value * 1_000 >= RACE_RESULT_LIMITS.distanceM.min &&
      value * 1_000 <= RACE_RESULT_LIMITS.distanceM.max,
    `Distance attendue entre ${RACE_RESULT_LIMITS.distanceM.min / 1_000} et ${
      RACE_RESULT_LIMITS.distanceM.max / 1_000
    } km.`,
  );

/**
 * Le chrono officiel, au format du masque de saisie (`mm:ss` ou `hh:mm:ss`).
 * `parseRaceTimeSeconds` rend `null` sur tout le reste — minutes ou secondes
 * au-dessus de 59 comprises, qui sont ambiguës plutôt qu'erronées.
 */
const raceTime = z
  .string()
  .trim()
  .min(1, "Chrono officiel manquant.")
  .transform((value) => parseRaceTimeSeconds(value))
  .refine((value) => value !== null, "Chrono attendu au format mm:ss ou h:mm:ss.");

const saveSchema = z.object({
  activityId: z
    .string()
    .trim()
    .transform((value) => Number(value))
    .refine((value) => Number.isInteger(value) && value > 0, "Séance inconnue."),
  racedOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date de la course attendue au format AAAA-MM-JJ."),
  distanceKm,
  time: raceTime,
  name: z
    .string()
    .trim()
    .max(RACE_RESULT_LIMITS.nameMaxChars, "Nom de l’épreuve trop long."),
});

const removeSchema = z.object({
  raceId: z
    .string()
    .trim()
    .transform((value) => Number(value))
    .refine((value) => Number.isInteger(value) && value > 0),
});

const SAVED_MESSAGE =
  "Course enregistrée. Le facteur correctif de ta VO₂max est recalculé sur toutes tes séances — rien n’est à rattraper.";
const REMOVED_MESSAGE =
  "Course retirée. Elle ne calibre plus ta VO₂max ; si c’était elle qui la recalait, les valeurs reviennent à l’estimation non recalée.";
const GENERIC_FAILURE = "La course n’a pas été enregistrée.";

/** Déclare (ou corrige) la course d'une séance. Compatible `useActionState`. */
export async function saveRaceResultAction(
  _previous: RaceFormState,
  formData: FormData,
): Promise<RaceFormState> {
  // Dans le corps de l'action, avant toute validation : ni le proxy ni la page
  // ne la protègent, elle s'appelle en POST direct. Le refus est le même pour
  // une entrée valide et pour une entrée absurde.
  if ((await getSession()) === null) {
    return { status: "error", message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = saveSchema.safeParse({
    activityId: textField(formData, "activityId"),
    racedOn: textField(formData, "racedOn"),
    distanceKm: textField(formData, "distanceKm"),
    time: textField(formData, "time"),
    name: textField(formData, "name"),
  });

  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    return {
      status: "error",
      message: "Vérifie la saisie : une des valeurs ne décrit pas une course.",
      fieldErrors: {
        racedOn: fieldErrors.racedOn?.[0],
        distanceKm: fieldErrors.distanceKm?.[0],
        time: fieldErrors.time?.[0],
        name: fieldErrors.name?.[0],
      },
    };
  }

  try {
    await saveRaceResult({
      racedOn: parsed.data.racedOn,
      name: parsed.data.name,
      // Le kilomètre saisi devient des mètres ici : la base et les calculs ne
      // connaissent que les mètres (cf. la convention d'unités du dépôt).
      distanceM: parsed.data.distanceKm * 1_000,
      timeS: parsed.data.time,
      activityId: parsed.data.activityId,
    });
  } catch (error) {
    return failure(error);
  }

  revalidatePath("/", "layout");
  return { status: "success", message: SAVED_MESSAGE };
}

/** Retire la course déclarée. Compatible `useActionState`. */
export async function removeRaceResultAction(
  _previous: RaceRemovalState,
  formData: FormData,
): Promise<RaceRemovalState> {
  if ((await getSession()) === null) {
    return { status: "error", message: SESSION_REQUIRED_MESSAGE };
  }

  const parsed = removeSchema.safeParse({ raceId: textField(formData, "raceId") });
  if (!parsed.success) {
    return { status: "error", message: "Cette course n’existe pas." };
  }

  try {
    await deleteRaceResult(parsed.data.raceId);
  } catch (error) {
    console.error("[activity] retrait de la course impossible :", error);
    return { status: "error", message: "La course n’a pas été retirée. Réessaie." };
  }

  revalidatePath("/", "layout");
  return { status: "success", message: REMOVED_MESSAGE };
}

/**
 * Traduit une erreur du DAL en état de formulaire. Aucune trace d'exécution ne
 * franchit la frontière : l'inattendu est journalisé côté serveur et rendu
 * générique côté client.
 *
 * `RaceResultNotSavedError` (l'écriture n'a touché aucune ligne) tombe
 * volontairement dans le cas générique : ce n'est pas une faute de saisie qu'on
 * pourrait désigner dans un champ, c'est une anomalie — et une anomalie se
 * journalise côté serveur et se dit sans détail côté client. Ce qui compte est
 * qu'elle **passe par ici** au lieu de ressortir en « Course enregistrée ».
 */
function failure(error: unknown): RaceFormState {
  if (error instanceof InvalidRaceResultError) {
    // Le DAL nomme le champ fautif en termes de son propre modèle (`distanceM`,
    // `timeS`) ; le formulaire, lui, affiche des kilomètres et un chrono.
    const field = {
      racedOn: "racedOn",
      distanceM: "distanceKm",
      timeS: "time",
      name: "name",
    } as const;

    return {
      status: "error",
      message: error.message,
      fieldErrors: { [field[error.field]]: error.message },
    };
  }
  if (error instanceof RaceActivityNotFoundError) {
    return { status: "error", message: "Cette séance n’existe pas." };
  }

  console.error("[activity] déclaration de course impossible :", error);
  return { status: "error", message: `${GENERIC_FAILURE} Réessaie.` };
}
