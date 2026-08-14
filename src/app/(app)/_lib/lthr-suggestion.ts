/**
 * La proposition de **FC seuil**, telle qu'elle franchit la frontière client.
 *
 * Même montage que `./max-hr-suggestion.ts` et `./resting-hr-suggestion.ts` :
 * types et projection seuls, **sans aucune dépendance serveur** — le tableau de
 * bord et l'onglet « Profil » des réglages montrent la même proposition, portée
 * par la même lecture du DAL, affichée par le même composant client.
 *
 * Deux choses se calculent ici, et elles décident de ce que la carte dit :
 *
 * - le **sens** de l'écart au profil (une FC seuil monte avec la forme et
 *   redescend avec le désentraînement — la phrase n'est pas la même) ;
 * - la **concordance des deux sources** : quand la médiane des blocs *et* un
 *   test récent existent, la carte cite les deux. Deux mesures indépendantes qui
 *   tombent à trois battements l'une de l'autre sont la meilleure raison
 *   d'accepter ; deux mesures qui divergent de quinze méritent d'être vues avant
 *   qu'on adopte l'une d'elles.
 */

/** Ce que la carte affiche. */
export type LthrSuggestionView = {
  /** La valeur proposée, en battements par minute. */
  bpm: number;
  /**
   * D'où elle sort :
   * - `threshold-blocks` : la médiane des blocs de seuil réalisés ;
   * - `time-trial` : le dernier test chronométré, faute d'assez de blocs.
   */
  source: "threshold-blocks" | "time-trial";
  /** Séances de seuil derrière la médiane. `0` quand la valeur vient du test. */
  sessionCount: number;
  /**
   * Ce que le dernier test a mesuré, `null` s'il n'y en a pas eu.
   *
   * Rendu **même quand la médiane l'emporte** : c'est la seconde opinion, et la
   * carte la cite.
   */
  timeTrialBpm: number | null;
  /** FC seuil du profil, `null` s'il n'en porte pas encore. */
  profileBpm: number | null;
  /**
   * Le sens de l'écart, du point de vue de l'athlète :
   * - `up` : la mesure est **plus haute** que le profil ;
   * - `down` : elle est plus basse ;
   * - `first` : le profil n'a pas encore de FC seuil, il n'y a pas d'écart.
   */
  direction: "down" | "up" | "first";
  /** Écart absolu avec le profil, en bpm. `0` quand il n'y a pas de profil. */
  deltaBpm: number;
};

/** Ce que rend l'action, une fois la proposition tranchée. */
export type LthrSuggestionState = {
  status: "idle" | "accepted" | "dismissed" | "error";
  /** Message d'échec, destiné à l'athlète. Jamais de trace d'exécution. */
  message?: string;
};

export const LTHR_SUGGESTION_IDLE: LthrSuggestionState = { status: "idle" };

/**
 * Le DTO du DAL, réduit à ce que la carte affiche.
 *
 * Le paramètre est décrit **structurellement**, pas importé de `src/data/` : ce
 * module est lu par un composant client, il ne doit dépendre d'aucun module
 * `server-only`.
 */
export function toLthrSuggestionView(
  suggestion: {
    bpm: number;
    source: "threshold-blocks" | "time-trial";
    sessionCount: number;
    timeTrialBpm: number | null;
    profileBpm: number | null;
  } | null,
): LthrSuggestionView | null {
  if (suggestion === null) return null;

  const { bpm, profileBpm } = suggestion;

  return {
    bpm,
    source: suggestion.source,
    sessionCount: suggestion.sessionCount,
    timeTrialBpm: suggestion.timeTrialBpm,
    profileBpm,
    direction: profileBpm === null ? "first" : bpm < profileBpm ? "down" : "up",
    deltaBpm: profileBpm === null ? 0 : Math.abs(bpm - profileBpm),
  };
}
