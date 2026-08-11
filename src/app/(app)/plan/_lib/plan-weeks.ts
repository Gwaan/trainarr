/**
 * Découpage d'un plan en semaines et lecture de l'état d'une séance — fonctions
 * pures, testées.
 *
 * La grille des semaines est celle du plan : des blocs de sept jours à partir de
 * l'**ancre**, le lundi de la semaine de `startsOn`. Ce sont donc des semaines
 * ISO, comme celles des statistiques — et c'est la même grille que le DAL valide
 * (`planEndExclusive`). Un plan démarré en milieu de semaine ouvre une première
 * semaine entamée : elle est affichée à partir du jour du départ, pas du lundi
 * qui la précède et sur lequel le plan ne pose rien.
 */

import type { PlanSessionDto } from "@/data/plans";
import { isoWeekStart, shiftCivilDate } from "@/lib/dates/civil";

import { formatDistance } from "../../_lib/format";

import { formatCivilRange } from "./format-plan";

/**
 * Où en est une séance.
 *
 * `completed` prime sur tout le reste : une séance rapprochée d'une activité est
 * de l'histoire, quelle que soit sa date.
 */
export type PlanSessionState = "completed" | "today" | "missed" | "upcoming";

export type PlanWeekView = {
  /** Rang dans le plan, à partir de 1 — ce que l'en-tête affiche. */
  number: number;
  /**
   * Dates civiles `YYYY-MM-DD` du premier et du dernier jour couverts. Le lundi
   * et le dimanche de la semaine ISO, sauf pour une première semaine entamée :
   * elle commence au jour de départ du plan.
   */
  startsOn: string;
  endsOn: string;
  /** Intervalle formaté, ex. `18–24 août`. */
  label: string;
  sessions: PlanSessionDto[];
  /** Somme des volumes annoncés, `null` si aucune séance n'en porte. */
  totalVolumeM: number | null;
  /** Séances rapprochées d'une activité — l'avancement réel de la semaine. */
  completedCount: number;
  status: "past" | "current" | "upcoming";
  /**
   * Semaine dépliée au chargement. Sur téléphone, une pile de douze semaines
   * ouvertes n'est pas un plan : seules la semaine en cours et la suivante
   * s'ouvrent d'office, le reste attend un geste.
   */
  expanded: boolean;
};

/**
 * Dernier jour couvert par le plan (inclus) : le dimanche de sa dernière semaine,
 * compté depuis l'ancre — comme `planEndExclusive` côté DAL.
 */
export function planEndsOn(plan: { startsOn: string; weeks: number }): string {
  return shiftCivilDate(isoWeekStart(plan.startsOn), plan.weeks * 7 - 1);
}

export function planSessionState(
  session: Pick<PlanSessionDto, "scheduledOn" | "completedActivityId">,
  today: string,
): PlanSessionState {
  if (session.completedActivityId !== null) return "completed";
  if (session.scheduledOn === today) return "today";
  // Comparaison lexicographique : sur des dates civiles `YYYY-MM-DD` bien
  // formées, elle coïncide avec l'ordre chronologique.
  return session.scheduledOn < today ? "missed" : "upcoming";
}

/**
 * Les semaines du plan, **toutes** rendues — y compris celles qu'aucune séance
 * n'occupe : une semaine vide au milieu d'un bloc est une information, la taire
 * ferait croire à un plan plus court qu'il n'est.
 */
export function groupPlanWeeks(
  plan: { startsOn: string; weeks: number },
  sessions: readonly PlanSessionDto[],
  today: string,
): PlanWeekView[] {
  const weeks: PlanWeekView[] = [];
  const gridStart = isoWeekStart(plan.startsOn);

  for (let index = 0; index < plan.weeks; index += 1) {
    const weekStart = shiftCivilDate(gridStart, index * 7);
    const endsOn = shiftCivilDate(weekStart, 6);
    // Première semaine entamée : les jours qui précèdent le départ ne font pas
    // partie du plan — les afficher annoncerait une semaine qui n'a pas eu lieu.
    const startsOn = index === 0 && plan.startsOn > weekStart ? plan.startsOn : weekStart;

    const weekSessions = sessions.filter(
      (session) => session.scheduledOn >= startsOn && session.scheduledOn <= endsOn,
    );
    const volumes = weekSessions
      .map((session) => session.volumeM)
      .filter((volume): volume is number => volume !== null);

    weeks.push({
      number: index + 1,
      startsOn,
      endsOn,
      label: formatCivilRange(startsOn, endsOn),
      sessions: weekSessions,
      totalVolumeM:
        volumes.length > 0 ? volumes.reduce((total, volume) => total + volume, 0) : null,
      completedCount: weekSessions.filter(
        (session) => session.completedActivityId !== null,
      ).length,
      status: endsOn < today ? "past" : startsOn > today ? "upcoming" : "current",
      // Renseigné juste après : l'ouverture d'une semaine dépend de ses voisines.
      expanded: false,
    });
  }

  // La semaine en cours et celle qui suit. Plan terminé ou pas encore commencé,
  // il n'y a pas de semaine en cours : on ouvre la première à venir, sinon la
  // dernière — jamais un écran de cartes toutes fermées.
  const current = weeks.findIndex((week) => week.status === "current");
  const firstUpcoming = weeks.findIndex((week) => week.status === "upcoming");
  const anchor =
    current !== -1 ? current : firstUpcoming !== -1 ? firstUpcoming : weeks.length - 1;

  for (const [index, week] of weeks.entries()) {
    week.expanded = index === anchor || (current !== -1 && index === current + 1);
  }

  return weeks;
}

/** Accord en nombre — « 1 séance », « 3 séances ». */
function plural(count: number, singular: string): string {
  return count > 1 ? `${singular}s` : singular;
}

/**
 * Résumé d'une semaine sous son intitulé : ce qui a été fait quand la semaine
 * est entamée, ce qui est prévu sinon, suivi du volume annoncé.
 *
 * `null` pour une semaine sans séance — c'est l'état vide qui parle alors, pas
 * un « 0 séance ».
 */
export function formatWeekSummary(week: PlanWeekView): string | null {
  const total = week.sessions.length;
  if (total === 0) return null;

  const parts: string[] = [
    week.status === "upcoming"
      ? `${total} ${plural(total, "séance")}`
      : `${week.completedCount}/${total} ${plural(total, "réalisée")}`,
  ];

  if (week.totalVolumeM !== null) parts.push(formatDistance(week.totalVolumeM));

  return parts.join(" · ");
}

/**
 * Où en est le plan, pour l'en-tête : `Semaine 3 / 12` tant qu'il court, son
 * étendue sinon.
 */
export function formatPlanProgress(weeks: readonly PlanWeekView[]): string {
  const current = weeks.find((week) => week.status === "current");
  return current === undefined
    ? `${weeks.length} semaines`
    : `Semaine ${current.number} / ${weeks.length}`;
}
