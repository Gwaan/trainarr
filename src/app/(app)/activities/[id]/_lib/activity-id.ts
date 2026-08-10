import { z } from "zod";

/**
 * Un segment dynamique est de l'input utilisateur (cf. `.claude/rules/security.md`) :
 * il est validé avant tout usage, et la page répond 404 s'il ne l'est pas.
 *
 * Le motif est volontairement plus strict qu'un `Number()` : `01`, `1.5`, `+1`,
 * ` 1` ou `1e3` désignent tous la même ligne une fois coercés — autant d'URL
 * différentes pour une même ressource. Une seule forme est acceptée.
 */
const ACTIVITY_ID = z.string().regex(/^[1-9]\d{0,8}$/);

/** L'identifiant d'activité de l'URL, ou `null` s'il n'en est pas un. */
export function parseActivityId(raw: string): number | null {
  const parsed = ACTIVITY_ID.safeParse(raw);
  return parsed.success ? Number(parsed.data) : null;
}
