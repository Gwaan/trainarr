/**
 * Choix proposés par le formulaire de création — constantes partagées entre le
 * composant client et rien d'autre : les bornes qui font autorité sont celles de
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
