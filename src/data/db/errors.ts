/**
 * Lecture des erreurs Postgres levées par les requêtes du DAL.
 *
 * Pas de `server-only` ici, comme pour `schema.ts` : le module ne touche ni à la
 * base, ni à `env`, ni à quoi que ce soit de secret — il ne fait qu'inspecter la
 * forme d'un objet d'erreur.
 *
 * **Pourquoi ce n'est pas une lecture directe de `error.code`** : depuis
 * drizzle-orm 0.45, toute erreur du pilote remonte enveloppée dans un
 * `DrizzleQueryError` (`pg-core/session.js`, autour de `queryWithCache`) ;
 * l'erreur `postgres` d'origine n'est plus qu'un maillon de la chaîne `cause`.
 * Un `error.code === '23505'` posé sur l'erreur de surface ne matche donc
 * **jamais** en production — le rattrapage des courses ne s'exécutait pas.
 * On remonte la chaîne, sans présumer de la profondeur d'emballage (et sans
 * présumer non plus qu'il y en ait une : l'erreur nue reste reconnue).
 */

/**
 * `23505` — `unique_violation` dans la table des codes d'erreur Postgres
 * (annexe A de la documentation). C'est le code qu'on lit, jamais le message :
 * celui-ci est localisable.
 */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Profondeur maximale de remontée. Bornée : une chaîne `cause` cyclique (une
 * erreur qui se cite elle-même) ferait tourner la boucle indéfiniment, et aucun
 * emballage légitime n'ajoute cinq niveaux.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * Le maillon de la chaîne `cause` qui porte une violation d'unicité, `null` si
 * l'erreur n'en est pas une.
 */
function findUniqueViolation(error: unknown): object | null {
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    if ('code' in current && current.code === PG_UNIQUE_VIOLATION) return current;
    if (!('cause' in current)) return null;
    current = current.cause;
  }

  return null;
}

/** `true` si l'erreur (ou l'une de ses causes) est une violation d'unicité. */
export function isUniqueViolation(error: unknown): boolean {
  return findUniqueViolation(error) !== null;
}

/**
 * Nom de la contrainte violée, `null` si l'erreur n'est pas une violation
 * d'unicité ou si le pilote ne l'a pas transmis.
 *
 * Le nom compte dès qu'une table porte plusieurs contraintes uniques : sans lui,
 * une collision sur `fit_file_hash` et une collision sur la séance seraient
 * indiscernables. Le pilote `postgres` expose le champ serveur sous
 * `constraint_name` ; `constraint` est lu en second, c'est le nom qu'emploient
 * d'autres pilotes.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  const violation = findUniqueViolation(error);
  if (violation === null) return null;

  if ('constraint_name' in violation && typeof violation.constraint_name === 'string') {
    return violation.constraint_name;
  }
  if ('constraint' in violation && typeof violation.constraint === 'string') {
    return violation.constraint;
  }
  return null;
}
