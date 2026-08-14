import 'server-only';

import { and, asc, eq, gte, lte } from 'drizzle-orm';

import { civilDateToMs, isCivilDate, shiftCivilDate, toCivilDate } from '@/lib/dates/civil';
import type { PlanSessionSteps } from '@/lib/plan-steps/schema';

import { getCurrentAthleteId, todayCivilDate } from './athlete';
import { db } from './db/client';
import { activities, plannedSessions, plans, type Activity, type PlannedSession } from './db/schema';
import { planEndExclusive } from './plans';

/**
 * Lecture du **calendrier** : ce qui est prévu et ce qui a été couru, sur une
 * plage de jours.
 *
 * Une lecture, pas deux : la page pose une plage et reçoit d'un coup les séances
 * planifiées, les sorties réellement courues qu'aucune séance ne réalise, et les
 * bornes du plan actif. Trois appels séparés donneraient trois instants de
 * lecture différents — une séance rapprochée entre le premier et le deuxième
 * apparaîtrait deux fois à l'écran.
 *
 * ## Ce que la plage contient, et ce qu'elle ne contient pas
 *
 * **Toutes** les séances de l'athlète tombant dans la plage, sans filtre de
 * plan : celles du plan actif, celles d'un plan archivé (il n'en reste que du
 * passé — l'archivage emporte ses séances à venir non réalisées) et celles qui
 * n'appartiennent à aucun plan (`plan_id` nul, une séance posée à la main). Un
 * calendrier montre ce qui a été prévu, y compris par un plan qui n'est plus en
 * cours ; masquer ces jours-là ferait croire à des semaines vides. Seul le
 * **déplacement** est plus étroit : il exige que la séance appartienne au plan
 * actif (cf. `plan/_lib/calendar-actions.ts`).
 *
 * **Les activités, elles, ne sont rendues que si aucune séance de la plage ne
 * les réalise** : sans cette soustraction, une sortie rapprochée s'afficherait
 * deux fois le même jour — une fois comme séance faite, une fois comme sortie
 * libre. Ce qui reste, ce sont les sorties hors plan : une randonnée, une séance
 * de vélo, un footing improvisé.
 */

/** Une séance planifiée, telle que le calendrier l'affiche et la déplace. */
export type CalendarSessionDto = {
  id: number;
  /** Jour civil `YYYY-MM-DD`. */
  date: string;
  /** Ex. « VMA », « Sortie longue ». */
  kind: string;
  /** Ex. « 6 × 800 m ». */
  title: string;
  /** Déroulé structuré, `null` quand la séance n'en porte pas. */
  steps: PlanSessionSteps | null;
  volumeM: number | null;
  durationS: number | null;
  /** Séance déjà courue : elle ne se déplace pas. */
  completed: boolean;
  /**
   * Déplaçable ? Faux si courue, ou si le jour est passé.
   *
   * C'est le gel de la **séance**, pas la validité d'une destination : les
   * bornes du plan ({@link CalendarRangeDto.plan}) disent, elles, où un dépôt est
   * permis. Le verdict complet reste celui de `judgeSessionMove`, que la Server
   * Action rejoue quoi qu'affiche l'écran.
   */
  movable: boolean;
};

/**
 * Une sortie réellement courue qu'aucune séance planifiée ne réalise.
 *
 * DTO minimal : de quoi remplir une pastille de calendrier et ouvrir le détail
 * de l'activité. Ni `athleteId`, ni empreinte de fichier, ni instant de départ —
 * le jour civil suffit à la poser dans une case.
 */
export type CalendarActivityDto = {
  id: number;
  /** Jour civil `YYYY-MM-DD` du départ, dans le fuseau de l'athlète. */
  date: string;
  name: string;
  sportType: string;
  distanceM: number;
  movingTimeS: number;
  avgPaceSecPerKm: number | null;
};

export type CalendarRangeDto = {
  /** Bornes demandées, renvoyées telles quelles : l'UI n'a pas à les mémoriser. */
  from: string;
  to: string;
  /** Bornes du plan actif, pour que l'UI sache où les dépôts sont permis. */
  plan: {
    startsOn: string;
    /** Dernier jour couvert, **inclus**. */
    endsOn: string;
    raceDate: string | null;
    /** Jour ISO de la sortie longue : 1 = lundi … 7 = dimanche. */
    longRunDay: number;
  } | null;
  sessions: CalendarSessionDto[];
  activities: CalendarActivityDto[];
};

/**
 * Bornes d'une plage de calendrier.
 *
 * L'amplitude est bornée parce que `from` et `to` viennent du client : une plage
 * de dix ans lirait tout l'historique des activités à chaque rendu. Un an et un
 * jour couvre le plus large affichage plausible (douze mois entiers) ; au-delà,
 * ce n'est plus un calendrier, c'est un export.
 */
export const CALENDAR_RANGE_LIMITS = { maxDays: 366 } as const;

/**
 * La plage demandée n'est pas lisible : dates mal formées, ordre inversé, ou
 * amplitude hors bornes.
 *
 * Erreur nommée plutôt que message inspecté : l'appelant distingue ainsi une
 * requête invalide d'une panne.
 */
export class InvalidCalendarRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCalendarRangeError';
  }
}

const DAY_MS = 86_400_000;

/**
 * Marge d'interrogation des activités, de part et d'autre de la plage civile.
 *
 * Une activité porte un **instant**, la plage porte des **jours civils** : dans
 * le fuseau de l'athlète, le jour `from` commence avant minuit UTC de `from`, et
 * le jour `to` finit après. Un jour de marge de chaque côté couvre n'importe
 * quel décalage horaire ; le filtre exact se fait ensuite sur {@link toCivilDate},
 * la même conversion que le rapprochement.
 */
const ACTIVITY_QUERY_MARGIN_DAYS = 1;

/** @throws {InvalidCalendarRangeError} */
function validateRange(from: string, to: string): void {
  if (!isCivilDate(from) || !isCivilDate(to)) {
    throw new InvalidCalendarRangeError('Plage de calendrier : dates AAAA-MM-JJ attendues.');
  }
  // Comparaison lexicographique : sur des dates civiles bien formées, elle
  // coïncide avec l'ordre chronologique.
  if (to < from) {
    throw new InvalidCalendarRangeError('Plage de calendrier : la fin précède le début.');
  }
  const days = Math.round((civilDateToMs(to) - civilDateToMs(from)) / DAY_MS) + 1;
  if (days > CALENDAR_RANGE_LIMITS.maxDays) {
    throw new InvalidCalendarRangeError(
      `Plage de calendrier : ${CALENDAR_RANGE_LIMITS.maxDays} jours au plus.`,
    );
  }
}

/** Vide, mais valide : l'onboarding n'a pas eu lieu, ou rien n'est planifié. */
function emptyRange(from: string, to: string): CalendarRangeDto {
  return { from, to, plan: null, sessions: [], activities: [] };
}

export function toCalendarSessionDto(row: PlannedSession, today: string): CalendarSessionDto {
  const completed = row.completedActivityId !== null;
  return {
    id: row.id,
    date: row.scheduledOn,
    kind: row.kind,
    title: row.title,
    steps: row.steps,
    volumeM: row.volumeM,
    durationS: row.durationS,
    completed,
    movable: !completed && row.scheduledOn >= today,
  };
}

export function toCalendarActivityDto(row: Activity): CalendarActivityDto {
  return {
    id: row.id,
    date: toCivilDate(row.startedAt),
    name: row.name,
    sportType: row.sportType,
    distanceM: row.distanceM,
    movingTimeS: row.movingTimeS,
    avgPaceSecPerKm: row.avgPaceSecPerKm,
  };
}

/**
 * Les activités de la plage qu'aucune des séances données ne réalise, converties
 * en DTOs et rangées par jour.
 *
 * Fonction pure, exportée pour les tests : c'est elle qui porte la soustraction
 * (une sortie rapprochée est déjà à l'écran sous forme de séance faite) et le
 * recadrage de la marge d'interrogation sur la plage réellement demandée.
 */
export function calendarActivities(
  rows: readonly Activity[],
  sessions: readonly PlannedSession[],
  range: { from: string; to: string },
): CalendarActivityDto[] {
  const claimed = new Set(
    sessions
      .map((session) => session.completedActivityId)
      .filter((id): id is number => id !== null),
  );

  return rows
    .filter((row) => !claimed.has(row.id))
    .map(toCalendarActivityDto)
    .filter((activity) => activity.date >= range.from && activity.date <= range.to)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);
}

/**
 * Le calendrier de la plage `[from, to]`, bornes incluses.
 *
 * @throws {InvalidCalendarRangeError} si la plage est mal formée ou trop large.
 */
export async function getCalendarRange(from: string, to: string): Promise<CalendarRangeDto> {
  validateRange(from, to);

  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return emptyRange(from, to);

  const today = todayCivilDate();
  const oldest = new Date(civilDateToMs(from) - ACTIVITY_QUERY_MARGIN_DAYS * DAY_MS);
  const newest = new Date(civilDateToMs(to) + (ACTIVITY_QUERY_MARGIN_DAYS + 1) * DAY_MS);

  const [sessionRows, activityRows, planRows] = await Promise.all([
    db
      .select()
      .from(plannedSessions)
      .where(
        and(
          eq(plannedSessions.athleteId, athleteId),
          gte(plannedSessions.scheduledOn, from),
          lte(plannedSessions.scheduledOn, to),
        ),
      )
      // `id` en second : deux séances peuvent tomber le même jour, l'ordre
      // d'affichage doit rester stable d'un rendu à l'autre.
      .orderBy(asc(plannedSessions.scheduledOn), asc(plannedSessions.id)),
    db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.athleteId, athleteId),
          gte(activities.startedAt, oldest),
          lte(activities.startedAt, newest),
        ),
      )
      .orderBy(asc(activities.startedAt)),
    db
      .select()
      .from(plans)
      .where(and(eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
      .limit(1),
  ]);

  const plan = planRows[0];

  return {
    from,
    to,
    plan:
      plan === undefined
        ? null
        : {
            startsOn: plan.startsOn,
            // `planEndExclusive` rend le premier jour **non** couvert : le
            // dernier jour du plan est la veille. Le calcul reste celui du DAL
            // des plans, pour que les bornes affichées soient exactement celles
            // que l'écriture validera.
            endsOn: shiftCivilDate(planEndExclusive(plan.startsOn, plan.weeks), -1),
            raceDate: plan.raceDate,
            longRunDay: plan.longRunDay,
          },
    sessions: sessionRows.map((row) => toCalendarSessionDto(row, today)),
    activities: calendarActivities(activityRows, sessionRows, { from, to }),
  };
}
