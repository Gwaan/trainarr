import 'server-only';

/**
 * Lecture défensive des séries temporelles stockées en `jsonb`.
 *
 * Le contenu d'une colonne `jsonb` est typé **côté schéma**, mais Postgres rend
 * ce qu'une version antérieure du code y a écrit : un canal peut donc arriver
 * dans une forme que le type promet et que la base ne garantit pas. Ces deux
 * fonctions sont le point de passage unique qui vérifie la forme au lieu de
 * l'affirmer — un `as` ici ferait planter un calcul physio plusieurs appels plus
 * loin, avec un `NaN` pour seul indice.
 */

/** La série est-elle bien une suite de nombres (ou de trous) ? */
export function isNumberSeries(data: readonly unknown[]): data is (number | null)[] {
  return data.every((value) => value === null || typeof value === 'number');
}

/**
 * Une série numérique de `activity_streams`, `null` si absente, vide ou mal
 * formée.
 */
export function numberSeries(
  rows: readonly { type: string; data: unknown[] }[],
  type: string,
): (number | null)[] | null {
  const row = rows.find((candidate) => candidate.type === type);
  if (row === undefined || row.data.length === 0) return null;
  return isNumberSeries(row.data) ? row.data : null;
}
