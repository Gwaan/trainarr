/**
 * Choix proposés par le formulaire de création (et leurs libellés, que
 * l'affichage du plan réutilise) : les bornes qui font autorité sont celles de
 * la Server Action (`actions.ts`), qui accepte un intervalle plus large que ces
 * listes.
 */

import { ISO_DAY_LABELS } from "./format-plan";

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
