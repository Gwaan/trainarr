/**
 * La proposition de FC de repos, telle qu'elle franchit la frontière client.
 *
 * Types et formatage seuls, **sans aucune dépendance serveur** — même montage que
 * `./max-hr-suggestion.ts`, dont cette proposition est le pendant : le tableau de
 * bord et l'onglet « Profil » des réglages montrent la même proposition, portée
 * par la même lecture du DAL, affichée par le même composant client.
 *
 * La seule chose que ce module calcule est le **sens** de l'écart : une FC de
 * repos peut se proposer à la baisse comme à la hausse (contrairement à la FC
 * max, qui ne monte jamais que d'un dépassement), et la carte ne dit pas la même
 * phrase dans les deux cas.
 */

/** Ce que la carte affiche. */
export type RestingHrSuggestionView = {
  /** La médiane observée, en battements par minute. */
  bpm: number;
  /** Nuits mesurées dans la fenêtre — la carte source sa valeur. */
  measuredNights: number;
  /** FC de repos du profil, `null` s'il n'en porte pas encore. */
  profileBpm: number | null;
  /**
   * Le sens de l'écart, du point de vue de l'athlète :
   * - `down` : la médiane est **plus basse** que le profil ;
   * - `up` : elle est plus haute ;
   * - `first` : le profil n'a pas encore de FC de repos, il n'y a pas d'écart.
   */
  direction: "down" | "up" | "first";
  /** Écart absolu avec le profil, en bpm. `0` quand il n'y a pas de profil. */
  deltaBpm: number;
};

/** Ce que rend l'action, une fois la proposition tranchée. */
export type RestingHrSuggestionState = {
  status: "idle" | "accepted" | "dismissed" | "error";
  /** Message d'échec, destiné à l'athlète. Jamais de trace d'exécution. */
  message?: string;
};

export const RESTING_HR_SUGGESTION_IDLE: RestingHrSuggestionState = { status: "idle" };

/**
 * Le DTO du DAL, réduit à ce que la carte affiche.
 *
 * Le paramètre est décrit **structurellement**, pas importé de `src/data/` : ce
 * module est lu par un composant client, il ne doit dépendre d'aucun module
 * `server-only`.
 */
export function toRestingHrSuggestionView(
  suggestion: {
    bpm: number;
    measuredNights: number;
    profileBpm: number | null;
  } | null,
): RestingHrSuggestionView | null {
  if (suggestion === null) return null;

  const { bpm, profileBpm } = suggestion;

  return {
    bpm,
    measuredNights: suggestion.measuredNights,
    profileBpm,
    direction: profileBpm === null ? "first" : bpm < profileBpm ? "down" : "up",
    deltaBpm: profileBpm === null ? 0 : Math.abs(bpm - profileBpm),
  };
}
