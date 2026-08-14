/**
 * La proposition de FC max, telle qu'elle franchit la frontière client.
 *
 * Types et formatage seuls, **sans aucune dépendance serveur** : le tableau de
 * bord et l'onglet « Profil » des réglages montrent la même proposition, portée
 * par la même lecture du DAL, et le composant qui l'affiche est un composant
 * client partagé par les deux.
 *
 * Le DAL rend un instant ; ce module en fait une date lisible. Rien d'autre ne
 * franchit : ni identifiant d'athlète, ni la moindre autre séance.
 */

import { APP_TIME_ZONE } from "@/config/time";

/** Ce que la carte affiche, chaînes prêtes à rendre. */
export type MaxHrSuggestionView = {
  /** La fréquence observée, en battements par minute. */
  bpm: number;
  /** L'activité d'où elle sort — la carte y renvoie, une valeur inexplicable se refuse. */
  activityId: number;
  activityName: string;
  /** « 12 août », ou « 12 août 2025 » quand ce n'est pas l'année en cours. */
  observedOn: string;
};

/** Ce que rend l'action, une fois la proposition tranchée. */
export type MaxHrSuggestionState = {
  status: "idle" | "accepted" | "dismissed" | "error";
  /** Message d'échec, destiné à l'athlète. Jamais de trace d'exécution. */
  message?: string;
};

export const MAX_HR_SUGGESTION_IDLE: MaxHrSuggestionState = { status: "idle" };

// `timeZone` explicite : le container tourne en UTC, alors que la date d'une
// séance se lit en heure locale de l'athlète.
const dayMonthFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  timeZone: APP_TIME_ZONE,
});

const dayMonthYearFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});

const yearFormatter = new Intl.DateTimeFormat("fr-FR", {
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});

/**
 * Le DTO du DAL, réduit à ce que la carte affiche.
 *
 * Le paramètre est décrit **structurellement**, pas importé de `src/data/` : ce
 * module est lu par un composant client, il ne doit dépendre d'aucun module
 * `server-only`.
 *
 * L'année n'apparaît que si la séance n'est pas de l'année en cours : « le
 * 12 août » suffit pour une sortie d'il y a trois jours, et « le 12 août 2025 »
 * évite de faire passer une vieille pointe pour une nouvelle.
 */
export function toMaxHrSuggestionView(
  suggestion: {
    bpm: number;
    activityId: number;
    activityName: string;
    activityStartedAt: Date;
  } | null,
  now: Date = new Date(),
): MaxHrSuggestionView | null {
  if (suggestion === null) return null;

  const sameYear =
    yearFormatter.format(suggestion.activityStartedAt) === yearFormatter.format(now);

  return {
    bpm: suggestion.bpm,
    activityId: suggestion.activityId,
    activityName: suggestion.activityName,
    observedOn: (sameYear ? dayMonthFormatter : dayMonthYearFormatter).format(
      suggestion.activityStartedAt,
    ),
  };
}
