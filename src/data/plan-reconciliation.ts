import 'server-only';

import { and, eq, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';

import { civilDateToMs, shiftCivilDate, toCivilDate } from '@/lib/dates/civil';

import { db } from './db/client';
import { activities, plannedSessions, plans } from './db/schema';
import { isRunning } from './training-metrics';

/**
 * Rapprochement entre le prévu et le réalisé : quelle activité a réalisé quelle
 * séance planifiée (`planned_sessions.completed_activity_id`).
 *
 * Sans ce lien, une séance passée s'affiche « manquée » même quand la sortie est
 * en base, et le coach commente le réalisé sans jamais le comparer au prévu.
 *
 * Deux entrées, une seule règle de décision :
 *
 * 1. {@link linkActivityToPlannedSession} après chaque import — une activité
 *    arrive, on cherche la séance qu'elle réalise ;
 * 2. {@link reconcilePlanSessions} après (re)génération d'un plan — des séances
 *    arrivent, on cherche les activités déjà en base qui les réalisent.
 *
 * **Rapprochement au jour civil, pas à l'heure.** Une séance est planifiée un
 * jour ; l'activité, elle, porte un instant. La comparaison passe donc toujours
 * par {@link toCivilDate} (fuseau de l'athlète), jamais par une troncature UTC —
 * une sortie de 7 h du matin en heure d'été tombe la veille en UTC.
 *
 * **Le rapprochement ne détruit rien** : il ne remplit que des colonnes vides et
 * ne défait jamais un lien existant. Un rapprochement raté se rattrape au
 * passage suivant ; un lien effacé à tort, non.
 */

/*
 * Décision — pure, sans base.
 */

/** Une séance candidate, réduite à ce qui la départage des autres. */
export type SessionCandidate = {
  id: number;
  /** `null` pour une séance hors plan ; sinon un plan **actif** (cf. la requête). */
  planId: number | null;
};

/** Une activité candidate, réduite à ce qui la départage des autres. */
export type ActivityCandidate = {
  id: number;
  startedAt: Date;
  sportType: string;
};

/** Une séance en attente de rapprochement. */
export type PendingSession = {
  id: number;
  /** Date civile `YYYY-MM-DD`. */
  scheduledOn: string;
};

/** Un rapprochement décidé, prêt à être écrit. */
export type SessionMatch = {
  sessionId: number;
  activityId: number;
};

/**
 * La séance qu'une activité réalise, parmi celles du même jour.
 *
 * Deux séances peuvent tomber le même jour (une du plan actif, une hors plan
 * saisie à part). Le choix ne se joue pas à pile ou face : **le plan actif
 * l'emporte** — c'est lui que l'athlète suit et que l'UI affiche — puis le plus
 * petit `id`, c'est-à-dire la première créée. Un critère totalement déterministe
 * est ce qui rend l'opération rejouable : deux imports du même fichier, ou un
 * import suivi d'une réconciliation, aboutissent au même lien.
 */
export function pickPlannedSession(
  candidates: readonly SessionCandidate[],
): SessionCandidate | null {
  let best: SessionCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || compareSessions(candidate, best) < 0) best = candidate;
  }
  return best;
}

/** Ordre de préférence entre deux séances du même jour (négatif = `a` gagne). */
function compareSessions(a: SessionCandidate, b: SessionCandidate): number {
  const planned = Number(b.planId !== null) - Number(a.planId !== null);
  return planned !== 0 ? planned : a.id - b.id;
}

/**
 * Les rapprochements possibles entre des séances en attente et des activités.
 *
 * **Une activité ne réalise qu'une séance** : les activités déjà rapprochées
 * (`linkedActivityIds`) sont écartées d'entrée, et une activité retenue pour une
 * séance ne resservira pas pour une autre. Sans quoi une journée à deux séances
 * planifiées et une seule sortie afficherait deux séances réussies.
 *
 * Ordres déterministes, pour la même raison que {@link pickPlannedSession} :
 * les séances sont traitées par date puis par `id`, et l'activité retenue est la
 * plus matinale du jour. Rien ici ne devine *laquelle* de deux sorties du même
 * jour était la séance — cette information n'existe pas ; à défaut, l'ordre
 * chronologique est stable et explicable.
 *
 * Les activités qui ne sont pas de la course à pied sont ignorées : un plan de
 * course ne se réalise pas en nageant.
 */
export function matchActivitiesToSessions(
  sessions: readonly PendingSession[],
  candidates: readonly ActivityCandidate[],
  linkedActivityIds: ReadonlySet<number>,
): SessionMatch[] {
  const byDay = new Map<string, ActivityCandidate[]>();
  for (const candidate of candidates) {
    if (!isRunning(candidate.sportType)) continue;
    if (linkedActivityIds.has(candidate.id)) continue;

    const day = toCivilDate(candidate.startedAt);
    const sameDay = byDay.get(day);
    if (sameDay) sameDay.push(candidate);
    else byDay.set(day, [candidate]);
  }
  for (const sameDay of byDay.values()) sameDay.sort(compareActivities);

  const ordered = [...sessions].sort(comparePendingSessions);

  const matches: SessionMatch[] = [];
  for (const session of ordered) {
    // `shift()` consomme l'activité : la séance suivante du même jour, s'il y en
    // a une, devra se contenter d'une autre sortie — ou d'aucune.
    const activity = byDay.get(session.scheduledOn)?.shift();
    if (activity) matches.push({ sessionId: session.id, activityId: activity.id });
  }
  return matches;
}

/** Ordre chronologique entre deux activités du même jour, `id` en départage. */
function compareActivities(a: ActivityCandidate, b: ActivityCandidate): number {
  const started = a.startedAt.getTime() - b.startedAt.getTime();
  return started !== 0 ? started : a.id - b.id;
}

/** Ordre de traitement des séances : par jour, puis par `id`. */
function comparePendingSessions(a: PendingSession, b: PendingSession): number {
  if (a.scheduledOn !== b.scheduledOn) return a.scheduledOn < b.scheduledOn ? -1 : 1;
  return a.id - b.id;
}

/*
 * Écritures.
 */

/**
 * Pose le lien sur une séance encore libre.
 *
 * Le `completed_activity_id IS NULL` de la clause `WHERE` n'est pas décoratif :
 * c'est lui qui ferme la course entre deux imports simultanés (en
 * `READ COMMITTED`, tous deux ont lu la séance libre). Le perdant n'écrase rien
 * et rend `false`.
 */
async function claimSession(sessionId: number, activityId: number): Promise<boolean> {
  const updated = await db
    .update(plannedSessions)
    .set({ completedActivityId: activityId })
    .where(and(eq(plannedSessions.id, sessionId), isNull(plannedSessions.completedActivityId)))
    .returning({ id: plannedSessions.id });

  return updated.length > 0;
}

/** Identifiant du plan actif de l'athlète, `null` s'il n'en a pas. */
async function getActivePlanId(athleteId: number): Promise<number | null> {
  const rows = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Rapproche une activité fraîchement importée de la séance qu'elle réalise.
 *
 * Appelée après chaque import, y compris un réimport : elle est **idempotente**
 * — une activité déjà rapprochée ne l'est pas une seconde fois, et rend `false`
 * sans rien écrire.
 *
 * L'athlète n'est pas relu du contexte mais pris sur l'activité elle-même :
 * l'appelant est le pipeline d'import, pas un client, et les deux tables sont
 * rapprochées sous le **même** athlète — aucune séance d'un autre ne peut être
 * touchée.
 *
 * Une séance d'un plan **archivé** n'est jamais rapprochée : l'athlète ne le
 * suit plus, le compléter a posteriori réécrirait un passé qui n'a pas eu lieu.
 * Les séances hors plan (`plan_id IS NULL`), elles, restent éligibles.
 *
 * @returns `true` si un lien vient d'être posé.
 */
export async function linkActivityToPlannedSession(activityId: number): Promise<boolean> {
  const rows = await db
    .select({
      athleteId: activities.athleteId,
      sportType: activities.sportType,
      startedAt: activities.startedAt,
    })
    .from(activities)
    .where(eq(activities.id, activityId))
    .limit(1);

  const activity = rows[0];
  if (!activity || !isRunning(activity.sportType)) return false;

  const linked = await db
    .select({ id: plannedSessions.id })
    .from(plannedSessions)
    .where(eq(plannedSessions.completedActivityId, activityId))
    .limit(1);
  if (linked.length > 0) return false;

  const activePlanId = await getActivePlanId(activity.athleteId);
  const eligiblePlan =
    activePlanId === null
      ? isNull(plannedSessions.planId)
      : or(isNull(plannedSessions.planId), eq(plannedSessions.planId, activePlanId));

  const candidates = await db
    .select({ id: plannedSessions.id, planId: plannedSessions.planId })
    .from(plannedSessions)
    .where(
      and(
        eq(plannedSessions.athleteId, activity.athleteId),
        eq(plannedSessions.scheduledOn, toCivilDate(activity.startedAt)),
        isNull(plannedSessions.completedActivityId),
        eligiblePlan,
      ),
    );

  const session = pickPlannedSession(candidates);
  if (!session) return false;

  return claimSession(session.id, activityId);
}

/**
 * Rattrape le rapprochement de tout un plan, pour les séances déjà passées.
 *
 * À appeler après une (re)génération : les activités du passé sont en base
 * depuis longtemps, personne ne les réimportera, donc c'est ici — et nulle part
 * ailleurs — que les séances rétroactives trouvent leur réalisé.
 *
 * Les séances à venir sont volontairement hors périmètre : rien ne peut encore
 * les avoir réalisées.
 *
 * **L'athlète est un paramètre**, jamais une déduction. Cette fonction a deux
 * mondes d'appel : une Server Action (adoption, ajustement — l'appelant lit
 * l'athlète de la session) et le suivi de plan déclenché par une ingestion de
 * fond, qui n'a pas de requête et donc pas de session. Lire « l'athlète
 * courant » ici rendait `null` dans le second cas, et le rapprochement ne
 * posait aucun lien — sans le moindre échec visible.
 *
 * @returns le nombre de liens posés.
 */
export async function reconcilePlanSessions(planId: number, athleteId: number): Promise<number> {
  const today = toCivilDate(new Date());

  // Le filtre par athlète, en plus du plan, porte l'anti-IDOR : un identifiant
  // de plan qui n'est pas le sien ne remonte aucune séance.
  const sessions = await db
    .select({ id: plannedSessions.id, scheduledOn: plannedSessions.scheduledOn })
    .from(plannedSessions)
    .where(
      and(
        eq(plannedSessions.planId, planId),
        eq(plannedSessions.athleteId, athleteId),
        isNull(plannedSessions.completedActivityId),
        lte(plannedSessions.scheduledOn, today),
      ),
    );
  if (sessions.length === 0) return 0;

  let firstDay = today;
  for (const session of sessions) {
    if (session.scheduledOn < firstDay) firstDay = session.scheduledOn;
  }

  // La borne SQL porte sur un instant, le rapprochement sur un jour civil : les
  // bornes sont des minuits UTC élargis d'un jour de part et d'autre, de quoi
  // couvrir n'importe quel décalage de fuseau. C'est un filtre grossier destiné
  // à ne pas lire tout l'historique ; `matchActivitiesToSessions` tranche
  // ensuite au jour civil près.
  const candidates = await db
    .select({
      id: activities.id,
      startedAt: activities.startedAt,
      sportType: activities.sportType,
    })
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        gte(activities.startedAt, new Date(civilDateToMs(shiftCivilDate(firstDay, -1)))),
        lte(activities.startedAt, new Date(civilDateToMs(shiftCivilDate(today, 2)))),
      ),
    );

  // Toutes les activités déjà rapprochées de l'athlète, plan actif ou non : une
  // sortie ne réalise qu'une séance, y compris à travers deux plans.
  const linkedRows = await db
    .select({ activityId: plannedSessions.completedActivityId })
    .from(plannedSessions)
    .where(
      and(
        eq(plannedSessions.athleteId, athleteId),
        isNotNull(plannedSessions.completedActivityId),
      ),
    );
  const linkedActivityIds = new Set(
    linkedRows
      .map((row) => row.activityId)
      .filter((activityId): activityId is number => activityId !== null),
  );

  const matches = matchActivitiesToSessions(sessions, candidates, linkedActivityIds);

  let linked = 0;
  for (const match of matches) {
    if (await claimSession(match.sessionId, match.activityId)) linked += 1;
  }
  return linked;
}
