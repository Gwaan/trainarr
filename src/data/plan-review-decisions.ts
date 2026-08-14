import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import { planReviewDecisions, type PlanReviewVerdict } from './db/schema';

/**
 * Le **journal des décisions de revue** : une ligne par verdict rendu par le
 * coach, « keep » comme « adjust ».
 *
 * ## Ce qu'il sert, et ce qu'il ne sert pas
 *
 * Il sert à relire le juge. Un « adjust » laissait une trace — la proposition
 * déposée —, un « keep » n'en laissait aucune, alors que c'est le verdict
 * ordinaire : rien ne permettait de dire si le modèle décide la même chose deux
 * fois sur des situations semblables, ni sur quelles entrées il l'a décidée.
 *
 * Il ne sert à **rien d'autre**. Aucune décision de l'application ne le lit :
 * la cadence des revues reste portée par `plans.reviewed_session_count`
 * (`plan-review.ts`), et une écriture manquée ici ne change rien à ce que le
 * coach fera ensuite — c'est l'appelant qui garantit qu'elle ne fait pas échouer
 * la revue (`lib/ai/review-service.ts`).
 *
 * ## L'athlète est un paramètre à l'écriture, la session à la lecture
 *
 * Même partage que `plan-revisions.ts`, et pour la même raison : la revue tourne
 * dans le watcher FIT, hors requête — il n'y a pas de session à interroger, et
 * l'athlète lui est donné. La lecture, elle, sert un écran : elle se cloisonne
 * sur l'athlète de la session, comme toutes les autres lectures du DAL.
 */

/** Le résumé des entrées d'une décision, tel que le service le calcule. */
export type PlanReviewDecisionInput = {
  planId: number;
  verdict: PlanReviewVerdict;
  /** Ce que le modèle a dit de sa décision. */
  reason: string;
  /** Rang de la semaine du plan au jour de la décision : 1 = première semaine. */
  planWeek: number;
  /** Séances réalisées sur la fenêtre relue. */
  sessionsCompleted: number;
  /** Séances manquées sur cette même fenêtre. */
  sessionsMissed: number;
  /** La charge du jour, `null` quand elle n'était pas calculable. */
  fitness: { ctl: number; atl: number; tsb: number } | null;
  /** La proposition déposée, `null` quand la décision n'en a déposé aucune. */
  revisionId: number | null;
};

/**
 * Une décision relue, dans la forme que l'observabilité en attend.
 *
 * DTO minimal : ni identifiant de ligne, ni identifiant de plan, ni identifiant
 * de proposition — aucune clé de base ne franchit la frontière (cf.
 * `.claude/rules/security.md`). De la proposition, il ne reste que le fait
 * qu'il y en ait eu une, qui est la seule chose qu'un lecteur en tire.
 */
export type PlanReviewDecisionDto = {
  verdict: PlanReviewVerdict;
  reason: string;
  planWeek: number;
  sessionsCompleted: number;
  sessionsMissed: number;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  /** La décision a-t-elle abouti à une proposition déposée ? */
  deposited: boolean;
  /** Instant de la décision, en ISO-8601. */
  decidedAt: string;
};

/**
 * Combien de décisions la lecture rend par défaut.
 *
 * Vingt : à raison d'une revue toutes les quatre séances réalisées, c'est
 * plusieurs mois d'entraînement — assez pour juger d'une constance, et assez peu
 * pour tenir dans un écran.
 */
export const PLAN_REVIEW_DECISIONS_LIMIT = 20;

/**
 * Journalise une décision de revue.
 *
 * Écrite pour **les deux verdicts**, au moment où le verdict tombe : c'est tout
 * l'objet du journal (cf. l'en-tête).
 *
 * Ne relit rien et ne vérifie rien du plan visé : la revue vient de le lire sous
 * cet athlète-là, et un journal qui refuserait d'écrire perdrait la trace qu'on
 * lui demande de garder. L'appartenance, elle, est écrite : `athlete_id` vient
 * de l'appelant, jamais de la ligne journalisée.
 */
export async function recordPlanReviewDecision(
  input: PlanReviewDecisionInput,
  athleteId: number,
): Promise<void> {
  await db.insert(planReviewDecisions).values({
    athleteId,
    planId: input.planId,
    verdict: input.verdict,
    reason: input.reason,
    planWeek: input.planWeek,
    sessionsCompleted: input.sessionsCompleted,
    sessionsMissed: input.sessionsMissed,
    ctl: input.fitness?.ctl ?? null,
    atl: input.fitness?.atl ?? null,
    tsb: input.fitness?.tsb ?? null,
    revisionId: input.revisionId,
  });
}

/**
 * Les dernières décisions de revue de l'athlète connectée, les plus récentes
 * d'abord.
 *
 * Liste vide sans session ou sans athlète : une lecture d'observabilité n'a pas
 * à distinguer « personne n'est connecté » de « rien à montrer ».
 */
export async function listPlanReviewDecisions(
  limit: number = PLAN_REVIEW_DECISIONS_LIMIT,
): Promise<PlanReviewDecisionDto[]> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return [];

  const rows = await db
    .select({
      verdict: planReviewDecisions.verdict,
      reason: planReviewDecisions.reason,
      planWeek: planReviewDecisions.planWeek,
      sessionsCompleted: planReviewDecisions.sessionsCompleted,
      sessionsMissed: planReviewDecisions.sessionsMissed,
      ctl: planReviewDecisions.ctl,
      atl: planReviewDecisions.atl,
      tsb: planReviewDecisions.tsb,
      revisionId: planReviewDecisions.revisionId,
      createdAt: planReviewDecisions.createdAt,
    })
    .from(planReviewDecisions)
    .where(eq(planReviewDecisions.athleteId, athleteId))
    .orderBy(desc(planReviewDecisions.createdAt), desc(planReviewDecisions.id))
    .limit(limit);

  return rows.map(
    (row): PlanReviewDecisionDto => ({
      verdict: row.verdict,
      reason: row.reason,
      planWeek: row.planWeek,
      sessionsCompleted: row.sessionsCompleted,
      sessionsMissed: row.sessionsMissed,
      ctl: row.ctl,
      atl: row.atl,
      tsb: row.tsb,
      deposited: row.revisionId !== null,
      decidedAt: row.createdAt.toISOString(),
    }),
  );
}
