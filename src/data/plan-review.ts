import 'server-only';

import { and, asc, eq, lte } from 'drizzle-orm';

import { toCivilDate } from '@/lib/dates/civil';

import { db } from './db/client';
import { activities, plannedSessions, plans } from './db/schema';

/**
 * Le bilan qui alimente la révision automatique du plan : ce que l'athlète a
 * réellement fait depuis la dernière relecture du coach, et le marqueur qui
 * cadence celle-ci.
 *
 * **Aucune lecture de ce module ne résout l'athlète elle-même** : il lui est
 * donné. Le seul déclencheur de la révision est l'ingestion d'un fichier FIT,
 * qui tourne hors requête — il n'y a pas de session à interroger, et lire
 * « l'athlète courant » rendait `null`, donc un bilan vide et une révision qui
 * ne tournait jamais.
 *
 * Lecture **et** écriture du marqueur vivent ici plutôt que dans `plans.ts` :
 * `reviewed_session_count` n'est pas un réglage du plan, c'est l'état d'un
 * service. Aucune des deux fonctions n'est appelée par l'UI.
 *
 * **La fenêtre se compte en séances, pas en jours.** Le marqueur est un nombre
 * de séances réalisées déjà couvertes ; le bilan reprend donc là où la dernière
 * révision s'était arrêtée ({@link sessionsSinceReview}), sans jamais dépendre
 * d'une date de révision — un plan repris après trois semaines d'arrêt doit
 * montrer ses trois semaines de séances manquées, pas un intervalle vide.
 *
 * **Et il est borné.** Un marqueur à zéro — plan antérieur à la migration, ou
 * jamais relu — ferait détailler tout le passé du plan, soit jusqu'à cent
 * cinquante lignes dans le prompt le plus exposé à la troncature. Au-delà de
 * {@link REVIEW_MAX_DETAILED_SESSIONS} séances, les plus anciennes se résument à
 * un décompte ({@link boundReviewSessions}) : ce qui décide d'une réadaptation,
 * c'est l'entraînement récent.
 */

/** Ce qu'une activité rapprochée dit de la séance qu'elle a réalisée. */
export type PlanReviewOutcomeDto = {
  distanceM: number;
  movingTimeS: number;
  avgPaceSecPerKm: number | null;
  avgHrBpm: number | null;
};

/**
 * Une séance passée du plan : le prévu, et le réalisé quand il y en a un.
 *
 * DTO minimal — ni identifiants, ni textes libres, ni déroulé : le bilan sert à
 * comparer des cibles à des mesures, et chaque champ envoyé au modèle se paie en
 * tokens (cf. l'en-tête de `data/coach-context.ts`).
 */
export type PlanReviewSessionDto = {
  /** Date civile `YYYY-MM-DD`. */
  scheduledOn: string;
  kind: string;
  title: string;
  targetPaceSecPerKm: number | null;
  volumeM: number | null;
  durationS: number | null;
  /** `null` pour une séance passée que rien n'a réalisée : elle est manquée. */
  completed: PlanReviewOutcomeDto | null;
};

/** Ce que le bilan compte sans le détailler (cf. {@link boundReviewSessions}). */
export type PlanReviewOlderDto = {
  /** Nombre de séances plus anciennes que la fenêtre détaillée. */
  count: number;
  /** Combien d'entre elles ont été réalisées. */
  completed: number;
  /** Combien d'entre elles ont été manquées (`count - completed`). */
  missed: number;
};

/** L'état d'avancement du plan au regard des révisions du coach. */
export type PlanReviewDto = {
  /** Nombre total de séances du plan réalisées à ce jour. */
  completedSessionCount: number;
  /** Ce que la dernière révision avait déjà couvert (0 si aucune n'a eu lieu). */
  reviewedSessionCount: number;
  /**
   * Les séances passées depuis la dernière révision, réalisées comme manquées —
   * au plus les {@link REVIEW_MAX_DETAILED_SESSIONS} plus récentes.
   */
  sessions: PlanReviewSessionDto[];
  /** Les séances écartées du détail, ou `null` quand la fenêtre les contenait toutes. */
  older: PlanReviewOlderDto | null;
  /**
   * Dernière modification du plan, en ISO-8601 — le témoin de fraîcheur que la
   * révision automatique relit avant d'écrire (cf. `lib/ai/review-service.ts`).
   *
   * Interne au service : `markPlanReviewed` ne le touche pas, seule une écriture
   * du plan lui-même le fait bouger.
   */
  updatedAt: string;
};

/**
 * Combien de séances le bilan détaille au plus, de la plus récente à la plus
 * ancienne.
 *
 * Douze : deux à trois semaines d'entraînement à la cadence habituelle, soit
 * largement de quoi juger une tendance — et ~40 tokens par ligne, donc une
 * enveloppe qui ne bouge plus quel que soit l'âge du plan. Au-delà, le détail
 * n'apporte plus de décision : une séance ratée il y a deux mois ne change pas
 * la semaine prochaine.
 */
export const REVIEW_MAX_DETAILED_SESSIONS = 12;

/**
 * Les séances postérieures à la dernière révision.
 *
 * Le tri d'entrée fait foi (chronologique) : on avance dans les séances passées
 * en comptant les réalisées, et on garde tout ce qui suit la
 * `reviewedSessionCount`-ième. Une séance manquée antérieure à ce point était
 * déjà sous les yeux du coach lors de la révision précédente ; la remontrer
 * ferait rejuger deux fois le même passé.
 *
 * Fonction pure, exportée pour les tests.
 */
export function sessionsSinceReview(
  sessions: readonly PlanReviewSessionDto[],
  reviewedSessionCount: number,
): PlanReviewSessionDto[] {
  let seen = 0;
  let index = 0;
  while (index < sessions.length && seen < reviewedSessionCount) {
    if (sessions[index].completed !== null) seen += 1;
    index += 1;
  }
  return sessions.slice(index);
}

/**
 * Borne le détail du bilan aux `max` séances les plus récentes, et compte le
 * reste.
 *
 * Le décompte n'est pas une consolation : dire « et 30 séances plus anciennes,
 * dont 8 manquées » porte l'essentiel de ce que ces lignes auraient dit — un
 * volume tenu, ou un plan abandonné — pour le prix d'une ligne.
 *
 * Fonction pure, exportée pour les tests.
 */
export function boundReviewSessions(
  sessions: readonly PlanReviewSessionDto[],
  max: number = REVIEW_MAX_DETAILED_SESSIONS,
): { sessions: PlanReviewSessionDto[]; older: PlanReviewOlderDto | null } {
  if (sessions.length <= max) return { sessions: [...sessions], older: null };

  const older = sessions.slice(0, sessions.length - max);
  const completed = older.filter((session) => session.completed !== null).length;
  return {
    sessions: sessions.slice(sessions.length - max),
    older: { count: older.length, completed, missed: older.length - completed },
  };
}

/**
 * Le bilan du plan **actif** de l'athlète, `null` s'il n'y en a pas.
 *
 * L'appartenance est dans les deux `WHERE` — le plan comme les séances sont
 * filtrés par l'athlète reçu : un `planId` qui n'est pas le sien ne remonte
 * rien, exactement comme un plan inexistant (anti-IDOR).
 *
 * La jointure vers `activities` est **externe** : une séance passée sans
 * activité rapprochée est une séance manquée, et c'est une donnée du bilan — la
 * perdre en jointure interne reviendrait à ne montrer au coach que les séances
 * réussies.
 */
export async function getPlanReview(
  planId: number,
  athleteId: number,
): Promise<PlanReviewDto | null> {
  const planRows = await db
    .select({ reviewedSessionCount: plans.reviewedSessionCount, updatedAt: plans.updatedAt })
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
    .limit(1);

  const plan = planRows[0];
  if (!plan) return null;

  const today = toCivilDate(new Date());

  const rows = await db
    .select({
      scheduledOn: plannedSessions.scheduledOn,
      kind: plannedSessions.kind,
      title: plannedSessions.title,
      targetPaceSecPerKm: plannedSessions.targetPaceSecPerKm,
      volumeM: plannedSessions.volumeM,
      durationS: plannedSessions.durationS,
      distanceM: activities.distanceM,
      movingTimeS: activities.movingTimeS,
      avgPaceSecPerKm: activities.avgPaceSecPerKm,
      avgHrBpm: activities.avgHrBpm,
    })
    .from(plannedSessions)
    // Le filtre par athlète est répété sur l'activité : le lien est posé par le
    // rapprochement sous un seul athlète, mais une jointure qui ne le dit pas
    // s'en remettrait à cet invariant plutôt que de le vérifier.
    .leftJoin(
      activities,
      and(
        eq(plannedSessions.completedActivityId, activities.id),
        eq(activities.athleteId, athleteId),
      ),
    )
    .where(
      and(
        eq(plannedSessions.planId, planId),
        eq(plannedSessions.athleteId, athleteId),
        lte(plannedSessions.scheduledOn, today),
      ),
    )
    // Deux séances peuvent tomber le même jour : `id` rend l'ordre stable, donc
    // le découpage de la fenêtre reproductible d'une lecture à l'autre.
    .orderBy(asc(plannedSessions.scheduledOn), asc(plannedSessions.id));

  const sessions = rows.map(
    (row): PlanReviewSessionDto => ({
      scheduledOn: row.scheduledOn,
      kind: row.kind,
      title: row.title,
      targetPaceSecPerKm: row.targetPaceSecPerKm,
      volumeM: row.volumeM,
      durationS: row.durationS,
      completed:
        row.distanceM === null || row.movingTimeS === null
          ? null
          : {
              distanceM: row.distanceM,
              movingTimeS: row.movingTimeS,
              avgPaceSecPerKm: row.avgPaceSecPerKm,
              avgHrBpm: row.avgHrBpm,
            },
    }),
  );

  const since = boundReviewSessions(sessionsSinceReview(sessions, plan.reviewedSessionCount));

  return {
    completedSessionCount: sessions.filter((session) => session.completed !== null).length,
    reviewedSessionCount: plan.reviewedSessionCount,
    sessions: since.sessions,
    older: since.older,
    updatedAt: plan.updatedAt.toISOString(),
  };
}

/**
 * L'instant de dernière modification du plan **actif**, en ISO-8601, ou `null`
 * si ce plan n'est plus le plan actif de l'athlète.
 *
 * Lecture minimale, faite pour être répétée : la révision automatique la relance
 * juste avant d'écrire, pour vérifier que le plan n'a pas bougé pendant les
 * minutes de génération (cf. `lib/ai/review-service.ts`). Charger tout le bilan
 * pour comparer un horodatage serait payer la jointure des séances pour rien.
 */
export async function getPlanUpdatedAt(
  planId: number,
  athleteId: number,
): Promise<string | null> {
  const rows = await db
    .select({ updatedAt: plans.updatedAt })
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : row.updatedAt.toISOString();
}

/**
 * Avance le marqueur de révision : le coach vient de relire le plan au vu de
 * `completedSessionCount` séances réalisées.
 *
 * Écrit dans tous les cas de succès, que la révision ait changé le plan ou
 * non — c'est ce qui empêche de redemander la même relecture à chaque import.
 * Un échec, lui, laisse le marqueur en place : la prochaine séance importée
 * retentera.
 *
 * `updated_at` n'est **pas** touché : il date le plan (son objectif, ses
 * séances), pas l'état du service qui le relit.
 *
 * L'appartenance et l'état actif sont dans le `WHERE` de l'`UPDATE` lui-même,
 * comme partout dans le DAL des plans ; aucune ligne touchée n'est pas une
 * erreur ici (le plan a pu être archivé pendant la génération), et rien n'est
 * rendu.
 */
export async function markPlanReviewed(
  planId: number,
  completedSessionCount: number,
  athleteId: number,
): Promise<void> {
  await db
    .update(plans)
    .set({ reviewedSessionCount: completedSessionCount, reviewedAt: new Date() })
    .where(and(eq(plans.id, planId), eq(plans.athleteId, athleteId), eq(plans.status, 'active')));
}
