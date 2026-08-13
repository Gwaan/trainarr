/**
 * Le vocabulaire du glisser-déposer du calendrier : identifiants des éléments
 * soulevés et des cases qui les accueillent, et **annonces en français** pour
 * les lecteurs d'écran. Fonctions pures, testées.
 *
 * Deux raisons de les sortir des composants :
 *
 * 1. les identifiants sont des chaînes que deux composants distincts fabriquent
 *    (la pastille de séance) et relisent (le contexte de dépôt). Une seule
 *    définition, et elle se teste ;
 * 2. un calendrier qui ne se manipule qu'au doigt exclut le clavier. Les
 *    annonces sont donc du texte de première classe — relu, testé, et rédigé
 *    pour être entendu, pas lu.
 *
 * Les types d'identifiants restent `string | number` plutôt que le
 * `UniqueIdentifier` de dnd-kit : ce module ne dépend d'aucune bibliothèque.
 */

const DAY_PREFIX = "jour:";
const SESSION_PREFIX = "seance:";

/** Identifiant de la case d'un jour, ex. `jour:2026-08-12`. */
export function dayDropId(date: string): string {
  return `${DAY_PREFIX}${date}`;
}

/** Identifiant d'une pastille de séance, ex. `seance:42`. */
export function sessionDragId(sessionId: number): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

/** La date d'une case, `null` si l'identifiant n'en est pas une. */
export function parseDayDropId(id: string | number | null | undefined): string | null {
  if (typeof id !== "string" || !id.startsWith(DAY_PREFIX)) return null;
  const date = id.slice(DAY_PREFIX.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/** L'identifiant de séance porté par une pastille, `null` sinon. */
export function parseSessionDragId(id: string | number | null | undefined): number | null {
  if (typeof id !== "string" || !id.startsWith(SESSION_PREFIX)) return null;
  const raw = id.slice(SESSION_PREFIX.length);
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * Ce qu'un lecteur d'écran lit au moment où la séance prend le focus.
 *
 * Les touches sont nommées : sans elles, un utilisateur au clavier sait qu'il
 * tient quelque chose mais pas comment le poser.
 */
export const CALENDAR_DRAG_INSTRUCTIONS =
  "Pour déplacer une séance, appuie sur Espace ou Entrée. Utilise ensuite les flèches pour choisir un jour, Espace ou Entrée pour l'y déposer, Échap pour annuler.";

export function announceDragStart(session: string): string {
  return `Séance ${session} soulevée. Choisis un jour avec les flèches, puis dépose avec Espace.`;
}

/**
 * Le survol dit **deux** choses : sur quel jour on est, et si ce jour accepte le
 * dépôt. La seconde n'est pas un détail — au clavier, rien d'autre ne signale
 * qu'un jour est refusé.
 */
export function announceDragOver(
  session: string,
  day: string | null,
  accepted: boolean,
): string {
  if (day === null) return `Séance ${session} en dehors du calendrier.`;
  return accepted
    ? `Séance ${session} sur ${day}. Dépôt possible.`
    : `Séance ${session} sur ${day}. Dépôt impossible ce jour-là.`;
}

/**
 * La fin du geste annonce **ce qui a eu lieu**, pas ce qui était visé.
 *
 * Elle consulte le même verdict que le survol : un jour qui refusait le dépôt le
 * refuse encore au relâchement, et annoncer « déposée » serait mentir à la seule
 * personne qui n'a pas l'écran pour la contredire. Le motif est celui du module
 * de règles, rendu tel quel — le texte même que le serveur emploierait.
 */
export function announceDragEnd(
  session: string,
  day: string | null,
  /** Le motif du refus ; `null` quand le dépôt est accepté. */
  refusal: string | null,
): string {
  if (day === null) return `Séance ${session} reposée à sa place.`;
  return refusal === null
    ? `Séance ${session} déposée sur ${day}.`
    : `Séance ${session} non déposée sur ${day}. ${refusal}`;
}

export function announceDragCancel(session: string): string {
  return `Déplacement annulé : la séance ${session} reste à sa place.`;
}
