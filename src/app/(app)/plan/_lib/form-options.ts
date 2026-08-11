/**
 * Choix proposés par le formulaire de création (et leurs libellés, que
 * l'affichage du plan réutilise) : les bornes qui font autorité sont celles de
 * la Server Action (`actions.ts`), qui accepte un intervalle plus large que ces
 * listes.
 */

import type { ReferenceDistance } from "@/lib/metrics/vdot";

import { ISO_DAY_LABELS } from "./format-plan";

/**
 * Champs du formulaire de création, tels que le client les nomme, dans l'ordre
 * où le rapport d'erreurs de la Server Action les parcourt.
 *
 * **Pourquoi ici et pas dans `actions.ts`**, qui en est pourtant le seul
 * consommateur applicatif : un fichier `'use server'` ne peut exporter que des
 * fonctions asynchrones (« A "use server" file can only export async functions »),
 * la liste y serait donc une valeur exportée illégale. Elle vit à côté, dans le
 * module des constantes partagées du formulaire, et `actions.ts` la parcourt.
 *
 * Cette liste est le contrat que `plan-steps.ts` doit couvrir exactement : un
 * champ absent des étapes verrait son erreur s'afficher sur une étape
 * inatteignable, un champ en trop désignerait une étape pour une erreur qui ne
 * viendra jamais. `plan-steps.test.ts` compare les deux ensembles.
 */
export const PLAN_FORM_FIELDS = [
  "goalType",
  "level",
  "goalText",
  "raceDate",
  "weeks",
  "referenceDistance",
  "referenceTime",
  "startsOn",
  "sessionsPerWeek",
  "weeklyTimeHours",
  "longRunDay",
] as const;

export type PlanFormField = (typeof PLAN_FORM_FIELDS)[number];

export type GoalType = "race" | "free";

export const GOAL_TYPE_CHOICES: readonly { value: GoalType; label: string; hint: string }[] = [
  {
    value: "race",
    label: "Course datée",
    hint: "Le plan se cale sur la date : développement, puis affûtage.",
  },
  {
    value: "free",
    label: "Objectif libre",
    hint: "Un bloc de la durée que tu choisis, sans échéance.",
  },
];

/**
 * Niveau en course de l'athlète. Repris de l'union du schéma (`PLAN_LEVELS`),
 * mais redéclaré ici comme `GoalType` : ce module est importé par un composant
 * client, et le schéma Drizzle n'a rien à faire dans ce bundle.
 */
export type Level = "beginner" | "intermediate" | "advanced";

/** Libellé français d'un niveau — le formulaire et l'en-tête du plan le partagent. */
export const LEVEL_LABELS: Record<Level, string> = {
  beginner: "Débutant",
  intermediate: "Intermédiaire",
  advanced: "Confirmé",
};

export const LEVEL_CHOICES: readonly { value: Level; label: string; hint: string }[] = [
  {
    value: "beginner",
    label: LEVEL_LABELS.beginner,
    hint: "Tu cours depuis moins d'un an, ou par intermittence.",
  },
  {
    value: "intermediate",
    label: LEVEL_LABELS.intermediate,
    hint: "Tu cours régulièrement depuis un à trois ans.",
  },
  {
    value: "advanced",
    label: LEVEL_LABELS.advanced,
    hint: "Tu t'entraînes de façon structurée depuis plusieurs années.",
  },
];

/** Le cas le plus courant, et le moins risqué des trois à se voir appliquer. */
export const DEFAULT_LEVEL: Level = "intermediate";

/*
 * Chrono de référence.
 *
 * C'est la donnée la plus utile du formulaire : elle **calcule** la table
 * d'allures du plan (VDOT, méthode Daniels) au lieu de la laisser deviner au
 * coach. Facultative, mais un plan sans chrono reste délibérément prudent.
 */

/** Libellé français d'une distance de référence — le formulaire et l'en-tête du plan le partagent. */
export const REFERENCE_DISTANCE_LABELS: Record<ReferenceDistance, string> = {
  "5k": "5 km",
  "10k": "10 km",
  half: "Semi",
  marathon: "Marathon",
};

/**
 * Distances proposées, avec le format de saisie que chacune appelle : `mm:ss`
 * jusqu'au 10 km, `hh:mm:ss` au-delà. Le champ accepte les deux quoi qu'il
 * arrive — l'exemple ne fait qu'orienter.
 */
export const REFERENCE_DISTANCE_CHOICES: readonly {
  value: ReferenceDistance;
  label: string;
  placeholder: string;
}[] = [
  { value: "5k", label: REFERENCE_DISTANCE_LABELS["5k"], placeholder: "24:30" },
  { value: "10k", label: REFERENCE_DISTANCE_LABELS["10k"], placeholder: "50:00" },
  { value: "half", label: REFERENCE_DISTANCE_LABELS.half, placeholder: "1:52:00" },
  { value: "marathon", label: REFERENCE_DISTANCE_LABELS.marathon, placeholder: "3:55:00" },
];

/** Le 10 km : assez court pour rester dans le domaine de fiabilité du VDOT, assez couru pour être disponible. */
export const DEFAULT_REFERENCE_DISTANCE: ReferenceDistance = "10k";

/**
 * `mm:ss` ou `hh:mm:ss` — le masque du champ chrono.
 *
 * Les minutes et les secondes restent sous 60 : « 90:00 » pour un semi est une
 * saisie ambiguë (90 minutes ? 90 secondes ?), mieux vaut la refuser tout de
 * suite que d'en deviner une.
 */
const RACE_TIME_SHAPE = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

/** Le chrono saisi, en secondes, ou `null` si ce n'en est pas un. */
export function parseRaceTimeSeconds(input: string): number | null {
  const match = RACE_TIME_SHAPE.exec(input.trim());
  if (match === null) return null;

  const [, hours, minutes, seconds] = match;
  const hoursPart = hours === undefined ? 0 : Number(hours) * 3_600;
  return hoursPart + Number(minutes) * 60 + Number(seconds);
}

/** Le chemin inverse : `2_910` → `48:30`, `6_720` → `1:52:00`. */
export function formatRaceTimeSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = String(total % 60).padStart(2, "0");

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** La distance de référence correspondant à cette chaîne, `null` si elle n'en désigne aucune. */
export function asReferenceDistance(value: string): ReferenceDistance | null {
  return REFERENCE_DISTANCE_CHOICES.find((choice) => choice.value === value)?.value ?? null;
}

/** Durées d'un objectif libre. Au-delà de 16 semaines, un bloc perd son sens. */
export const WEEK_CHOICES = [4, 6, 8, 10, 12, 16] as const;

/** Séances hebdomadaires : sous 2, aucune progression ; au-delà de 6, aucun repos. */
export const SESSIONS_PER_WEEK_CHOICES = [2, 3, 4, 5, 6] as const;

/** Jour de la sortie longue, au format ISO attendu par le coach (1 = lundi). */
export const LONG_RUN_DAY_CHOICES: readonly { value: number; label: string }[] =
  ISO_DAY_LABELS.map((label, index) => ({ value: index + 1, label }));

/** Dimanche — le jour le plus courant pour une sortie longue. */
export const DEFAULT_LONG_RUN_DAY = 7;

/** Séances par semaine proposées par défaut. */
export const DEFAULT_SESSIONS_PER_WEEK = 4;

/** Durée par défaut d'un objectif libre. */
export const DEFAULT_WEEKS = 8;

/**
 * Jeton que le formulaire d'archivage envoie et que l'action exige.
 *
 * L'archivage est destructif et son endpoint est public : un POST qui ne porte
 * pas cette confirmation n'archive rien.
 */
export const ARCHIVE_CONFIRMATION = 'archive';
