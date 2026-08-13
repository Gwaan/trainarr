/**
 * Ce que l'URL de `/plan` porte : la **vue** (calendrier ou liste) et le **mois**
 * affiché. Fonctions pures, testées.
 *
 * Même parti pris que la période de « Progression » (`progression/_lib/range.ts`)
 * et pour les mêmes raisons : ni la vue ni le mois ne sont un état React. C'est
 * le serveur qui lit la plage, l'URL qui la porte, et un retour arrière comme un
 * rechargement retombent sur l'écran qu'on regardait. Les paramètres venant du
 * navigateur, ils sont validés comme n'importe quelle entrée externe — une
 * valeur inconnue retombe sur le défaut plutôt que d'échouer.
 */

import { z } from "zod";

import { isoWeekEnd, isoWeekStart } from "@/lib/dates/civil";

/** Noms des paramètres d'URL, en français comme le reste de l'interface. */
export const PLAN_VIEW_PARAM = "vue";
export const MONTH_PARAM = "mois";

export type PlanViewParam = "calendrier" | "liste";

/**
 * Le calendrier par défaut : c'est la vue qui répond à la question qu'on se pose
 * en ouvrant l'onglet — « qu'est-ce que je cours, et quand ? » — et la seule où
 * une séance se déplace. La liste reste à une tape, pour lire un programme
 * semaine par semaine.
 */
const DEFAULT_VIEW: PlanViewParam = "calendrier";

const viewSchema = z.enum(["calendrier", "liste"]).catch(DEFAULT_VIEW);

export const PLAN_VIEW_OPTIONS = [
  { param: "calendrier", label: "Calendrier" },
  { param: "liste", label: "Liste" },
] as const satisfies readonly { param: PlanViewParam; label: string }[];

/** Le paramètre `searchParams` peut être absent, répété, ou n'importe quoi. */
export function parsePlanViewParam(value: unknown): PlanViewParam {
  return viewSchema.parse(value);
}

/**
 * Un mois `YYYY-MM`.
 *
 * Seule la **forme** est vérifiée ici : l'amplitude réelle de la lecture est
 * bornée par le DAL (`CALENDAR_RANGE_LIMITS`), et un mois de l'an 3000 ne rend
 * qu'un calendrier vide — pas une erreur.
 */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Le mois `YYYY-MM` d'une date civile `YYYY-MM-DD`. */
export function civilMonth(civilDate: string): string {
  return civilDate.slice(0, 7);
}

export function parseMonthParam(value: unknown, fallback: string): string {
  return typeof value === "string" && MONTH_PATTERN.test(value) ? value : fallback;
}

/** Mois décalé de `delta` mois (négatif pour reculer). */
export function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + delta;
  // Division euclidienne : `Math.floor` recule bien d'une année sur un index
  // négatif, là où une troncature ramènerait janvier de l'année en cours.
  const shiftedYear = year + Math.floor(index / 12);
  const shiftedMonth = (((index % 12) + 12) % 12) + 1;
  return `${String(shiftedYear).padStart(4, "0")}-${String(shiftedMonth).padStart(2, "0")}`;
}

/** Dernier quantième du mois — 28, 29, 30 ou 31. */
function lastDayOfMonth(month: string): number {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  // Jour 0 du mois suivant = dernier jour de celui-ci, années bissextiles
  // comprises.
  return new Date(Date.UTC(year, index, 0)).getUTCDate();
}

/**
 * La plage à lire pour afficher `month` : des **semaines ISO entières**, du
 * lundi qui ouvre la première semaine du mois au dimanche qui ferme la dernière.
 *
 * Pas les seuls jours du mois : la grille de sept colonnes est faite de semaines,
 * et une semaine tronquée au 1er du mois ne dirait ni son volume ni son
 * enchaînement de séances. Six semaines au plus, soit 42 jours — très en deçà de
 * ce que le DAL accepte.
 */
export function monthGridRange(month: string): { from: string; to: string } {
  const first = `${month}-01`;
  const last = `${month}-${String(lastDayOfMonth(month)).padStart(2, "0")}`;
  return { from: isoWeekStart(first), to: isoWeekEnd(last) };
}

/**
 * Lien vers `/plan` dans l'état demandé.
 *
 * Les défauts ne portent pas de paramètre — l'URL reste `/plan` tant qu'on
 * regarde le calendrier du mois courant. Le mois est conservé même en vue liste :
 * revenir au calendrier doit rendre le mois qu'on venait de quitter.
 */
export function planHref(
  target: { view: PlanViewParam; month: string },
  currentMonth: string,
): string {
  const params = new URLSearchParams();
  if (target.view !== DEFAULT_VIEW) params.set(PLAN_VIEW_PARAM, target.view);
  if (target.month !== currentMonth) params.set(MONTH_PARAM, target.month);

  const query = params.toString();
  return query === "" ? "/plan" : `/plan?${query}`;
}
