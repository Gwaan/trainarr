import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { ActivityNotFoundError } from './activities';
import { getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import { activities, activityFeedbacks } from './db/schema';

/**
 * Feedback du coach sur une séance réalisée.
 *
 * **Un feedback par activité, pas un fil de discussion** : régénérer écrase
 * (upsert sur `activity_id`). L'analyse d'une séance n'a qu'une version
 * courante — celle qui tient compte de tout ce qu'on sait aujourd'hui.
 *
 * Chaque fonction revérifie que l'activité appartient à l'athlète avant de lire
 * ou d'écrire : l'identifiant vient du client (segment `[id]` d'URL, argument
 * d'action), il n'est jamais une preuve d'appartenance.
 */

/** Ce que l'UI affiche d'un feedback. Ni id de ligne, ni id d'activité. */
export type ActivityFeedbackDto = {
  /** Texte markdown, rendu tel quel. */
  content: string;
  /** Modèle qui l'a rédigé, `null` si la provenance n'est pas connue. */
  model: string | null;
  /** Instant de rédaction, sérialisé en ISO-8601. */
  createdAt: string;
};

/**
 * L'activité visée n'existe pas ou n'appartient pas à l'athlète.
 *
 * Déclarée dans `./activities` — elle parle d'une activité, et les écritures de
 * séries temporelles la lèvent aussi — et réexportée ici, où elle vivait, pour
 * tous ses appelants historiques.
 */
export { ActivityNotFoundError };

/** `true` si l'activité existe **et** appartient à l'athlète enregistré. */
async function ownsActivity(activityId: number): Promise<boolean> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return false;

  const rows = await db
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, athleteId)))
    .limit(1);

  return rows.length > 0;
}

/**
 * Le feedback d'une activité, `null` si elle n'en a pas — ou si elle n'est pas
 * celle de l'athlète (même réponse dans les deux cas, cf. anti-IDOR).
 */
export async function getActivityFeedback(activityId: number): Promise<ActivityFeedbackDto | null> {
  if (!(await ownsActivity(activityId))) return null;

  const rows = await db
    .select()
    .from(activityFeedbacks)
    .where(eq(activityFeedbacks.activityId, activityId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return { content: row.content, model: row.model, createdAt: row.createdAt.toISOString() };
}

/**
 * Écrit (ou réécrit) le feedback d'une activité.
 *
 * `ON CONFLICT (activity_id)` plutôt qu'un `DELETE` suivi d'un `INSERT` : l'index
 * unique du schéma porte l'idempotence, y compris si deux générations se
 * croisent — la seconde met à jour la ligne au lieu d'échouer.
 *
 * `createdAt` n'est volontairement pas touché : il date le premier feedback,
 * `updatedAt` date la dernière régénération.
 *
 * @throws {ActivityNotFoundError} si l'activité n'est pas celle de l'athlète.
 */
export async function saveActivityFeedback(
  activityId: number,
  content: string,
  model: string | null,
): Promise<void> {
  if (!(await ownsActivity(activityId))) throw new ActivityNotFoundError();

  await db
    .insert(activityFeedbacks)
    .values({ activityId, content, model })
    .onConflictDoUpdate({
      target: activityFeedbacks.activityId,
      set: { content: sql`excluded.content`, model: sql`excluded.model`, updatedAt: new Date() },
    });
}
