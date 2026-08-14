/**
 * Pagination de l'historique — lecture du paramètre d'URL et repères de
 * position. Fonctions pures, testées.
 *
 * Même parti pris que la période de « Progression » (`progression/_lib/range.ts`)
 * et que le mois du plan (`plan/_lib/calendar-params.ts`), pour les mêmes
 * raisons : la page affichée n'est pas un état React mais une **URL**. Le
 * serveur relit les semaines demandées, un rechargement, un retour arrière ou un
 * lien partagé retombent sur le même écran, et la page reste un Server
 * Component.
 *
 * Le paramètre vient du navigateur : il est validé comme n'importe quelle
 * entrée externe — tout ce qui n'est pas un rang de page plausible retombe sur
 * la première page plutôt que d'échouer, et jamais sur un `OFFSET` arbitraire.
 */

import { z } from "zod";

import { APP_TIME_ZONE } from "@/config/time";
import { civilDateToMs, shiftCivilDate } from "@/lib/dates/civil";

/** Nom du paramètre d'URL, en français comme le reste de l'interface. */
export const PAGE_PARAM = "page";

/**
 * Huit semaines par page : deux mois d'entraînement, soit le bloc que Gwen lit
 * d'un coup — et ce que la page affichait avant d'être paginée.
 */
export const WEEKS_PER_PAGE = 8;

const DEFAULT_PAGE = 1;

/**
 * Plafond du rang de page.
 *
 * Deux cents pages de huit semaines couvrent près de trente ans de sorties : la
 * borne ne gêne aucun historique réel, et elle interdit qu'une URL trafiquée
 * fasse balayer à Postgres un `OFFSET` sans rapport avec des données. Le DAL
 * borne de son côté (`ACTIVITY_WEEK_PAGE_LIMITS`) — ces deux gardes sont
 * indépendantes à dessein : celle-ci protège l'URL, celle-là protège la requête,
 * quelle que soit la porte d'entrée.
 */
export const MAX_PAGE = 200;

/**
 * Une valeur hors plage retombe sur la première page (`catch`) : c'est le
 * comportement des autres paramètres de l'appli — une URL bricolée donne un
 * écran banal, jamais une erreur.
 */
const pageSchema = z.coerce
  .number()
  .int()
  .min(DEFAULT_PAGE)
  .max(MAX_PAGE)
  .catch(DEFAULT_PAGE);

/**
 * Le rang de page demandé, 1 = les semaines les plus récentes.
 *
 * Le paramètre peut être absent, répété (donc un tableau), vide ou n'importe
 * quoi : seules les chaînes sont examinées, le reste vaut « première page ».
 */
export function parsePageParam(value: unknown): number {
  return typeof value === "string" ? pageSchema.parse(value) : DEFAULT_PAGE;
}

/** Rang de la première semaine de la page dans l'historique (0 = la plus récente). */
export function pageOffset(page: number): number {
  return (page - 1) * WEEKS_PER_PAGE;
}

/**
 * Lien vers une page de l'historique. La première ne porte pas de paramètre :
 * l'URL reste `/activities` tant qu'on regarde les dernières semaines.
 */
export function activitiesHref(page: number): string {
  return page <= DEFAULT_PAGE ? "/activities" : `/activities?${PAGE_PARAM}=${page}`;
}

// `timeZone` explicite : le container tourne en UTC, alors que les semaines sont
// découpées en heure locale de l'athlète.
const dayMonthFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  timeZone: APP_TIME_ZONE,
});

const dayMonthYearFormatter = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});

/**
 * Le repère de position de la page : la plage de dates réellement affichée, du
 * lundi de la semaine la plus ancienne au dimanche de la plus récente.
 *
 * Des dates plutôt qu'un « page 3 sur ? » : le nombre total de pages n'est
 * jamais compté (cf. `ActivityWeekPage.hasOlder`), et une plage de dates dit
 * bien plus à qui cherche une sortie précise. L'année n'apparaît qu'une fois,
 * sur la borne la plus récente, sauf si la plage change d'année.
 *
 * @param oldestWeekStart lundi `YYYY-MM-DD` de la semaine la plus ancienne.
 * @param newestWeekStart lundi `YYYY-MM-DD` de la semaine la plus récente.
 */
export function formatWeekSpan(oldestWeekStart: string, newestWeekStart: string): string {
  const from = new Date(civilDateToMs(oldestWeekStart));
  const to = new Date(civilDateToMs(shiftCivilDate(newestWeekStart, 6)));

  const sameYear = oldestWeekStart.slice(0, 4) === shiftCivilDate(newestWeekStart, 6).slice(0, 4);
  const start = sameYear ? dayMonthFormatter.format(from) : dayMonthYearFormatter.format(from);

  return `Du ${start} au ${dayMonthYearFormatter.format(to)}`;
}
