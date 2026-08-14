import 'server-only';

import { and, eq, getTableColumns } from 'drizzle-orm';
import { z } from 'zod';

import type { PlanRevisionDirection, PlanRevisionTotals } from '@/lib/plan-revision/direction';
import { planSessionStepsSchema, type PlanSessionSteps } from '@/lib/plan-steps/schema';

import { getCurrentAthleteId, isCivilDate } from './athlete';
import { db } from './db/client';
import { isUniqueViolation } from './db/errors';
import {
  PLAN_REFERENCE_DISTANCES,
  planRevisions,
  plans,
  type PlanRevision,
  type PlanRevisionSource,
} from './db/schema';
import { getPlanUpdatedAt } from './plan-review';
import { applyPlanUpdate, type PlanSessionDto } from './plans';

/**
 * Les **réévaluations de plan proposées** : leur dépôt par les services de
 * suivi, leur lecture par les deux écrans qui les montrent, et les deux issues
 * possibles — acceptée, refusée.
 *
 * ## Le coach propose, l'athlète dispose — y compris ici
 *
 * La revue périodique (`lib/ai/review-service.ts`) et la recalibration d'après
 * un test chronométré (`lib/ai/fitness-test-service.ts`) réécrivaient la suite
 * du plan **directement**, en tâche de fond après un import. Le plan changeait
 * sans accord. Elles déposent désormais ici, et **rien ne s'applique sans
 * acceptation** : ni les séances, ni les réglages, ni le chrono de référence, ni
 * la republication du calendrier intervals.icu.
 *
 * L'ajustement demandé par l'athlète (« plutôt 3 séances ») ne passe pas par là
 * et n'a pas à y passer : c'est elle qui le demande, avec retour immédiat.
 *
 * ## Accepter rejoue, ne recalcule pas
 *
 * {@link acceptPlanRevision} applique le `payload` **tel qu'il a été stocké**.
 * Recalculer au moment du clic donnerait un autre plan que celui qui a été
 * montré — l'accord ne porterait alors sur rien. Le prix de ce choix est la
 * **péremption** : si le plan a bougé entre le calcul et le clic (ajustement
 * manuel, séance déplacée, plan archivé), la proposition prolonge un plan qui
 * n'existe plus telle qu'elle. Elle est alors refusée en le disant, plutôt
 * qu'écrite par-dessus le travail de l'athlète.
 *
 * ## Les marqueurs avancent au **dépôt**, pas à l'acceptation
 *
 * C'est la décision structurante de ce module, et elle vaut d'être écrite ici
 * plutôt que dans chacun des deux services (cf. {@link depositPlanRevision}).
 *
 * ## L'athlète est un paramètre — sauf pour les deux décisions
 *
 * Le dépôt et les lectures reçoivent leur athlète : le déclencheur est
 * l'ingestion d'un fichier FIT, qui tourne hors requête. Accepter et refuser,
 * en revanche, viennent d'un clic : elles lisent l'athlète de la session, comme
 * les décisions sur une proposition de plan (`plans.ts`).
 */

/*
 * Le payload : la forme persistée de ce qui sera rejoué.
 */

/**
 * Une séance de la proposition, telle qu'elle est stockée puis rejouée.
 *
 * Champs **tous présents**, `null` là où le DAL stocke `NULL` : c'est ce que
 * `mapPlanWeeksToSessions` produit, et un JSON dont les clés facultatives
 * disparaissent au sérialisage ne se relit pas de la même façon d'une version à
 * l'autre. Le déroulé passe par le schéma des séances déjà en place — il n'y a
 * qu'une définition de ce qu'est une étape, et c'est elle.
 */
const revisionSessionSchema = z.object({
  scheduledOn: z.string().refine(isCivilDate, 'Date de séance : format AAAA-MM-JJ attendu.'),
  kind: z.string().min(1),
  title: z.string().min(1),
  warmup: z.string().nullable(),
  recovery: z.string().nullable(),
  cooldown: z.string().nullable(),
  targetPaceSecPerKm: z.number().nullable(),
  volumeM: z.number().nullable(),
  durationS: z.number().nullable(),
  steps: planSessionStepsSchema.nullable(),
});

/**
 * Les réglages que la proposition changerait — le pendant persisté de
 * `PlanSettingsPatch`.
 *
 * Tous facultatifs : une révision ne touche qu'à ce qu'elle change. Le chrono de
 * référence en fait partie, et c'est le point du chantier côté test chronométré —
 * il est **proposé**, pas appliqué à l'import.
 */
const revisionSettingsSchema = z.object({
  sessionsPerWeek: z.number().int().optional(),
  weeklyTimeMinutes: z.number().int().nullable().optional(),
  longRunDay: z.number().int().optional(),
  summary: z.string().nullable().optional(),
  referenceDistance: z.enum(PLAN_REFERENCE_DISTANCES).optional(),
  referenceTimeS: z.number().int().optional(),
  referenceUpdatedOn: z.string().optional(),
  lastTestNote: z.string().optional(),
});

/**
 * Le contenu rejouable d'une proposition : exactement ce que
 * `applyPlanUpdate` consomme.
 *
 * Validé à l'écriture **et** à la lecture. À l'écriture parce qu'un payload
 * aberrant ne doit pas atteindre la colonne ; à la lecture parce que Postgres
 * rend ce qu'une version antérieure du code y a écrit, et qu'un `jsonb` typé
 * côté schéma n'est qu'une promesse.
 */
export const planRevisionPayloadSchema = z.object({
  fromDate: z.string().refine(isCivilDate, 'Date de reprise : format AAAA-MM-JJ attendu.'),
  sessions: z.array(revisionSessionSchema),
  settings: revisionSettingsSchema,
});

/**
 * Le contenu rejouable, inféré du schéma — jamais réécrit à la main.
 *
 * Qu'il soit bien ce que le DAL des plans sait appliquer n'a pas besoin d'être
 * affirmé : {@link acceptPlanRevision} le passe directement à
 * `applyPlanUpdate`, et c'est cet appel qui ne compilerait plus si les
 * deux formes divergeaient.
 */
export type PlanRevisionPayload = z.infer<typeof planRevisionPayloadSchema>;

/** Une séance de la proposition, dans la forme stricte que la colonne stocke. */
export type PlanRevisionSessionInput = z.infer<typeof revisionSessionSchema>;

/**
 * Normalise les séances que le planificateur produit vers la forme stockée :
 * les clés facultatives deviennent des `null` explicites.
 *
 * `NewPlanSessionInput` laisse ces clés absentes ou `null` indifféremment — ce
 * qui convient à un `INSERT`, mais pas à un JSON qu'on relira dans six mois avec
 * une autre version du code. Le stockage n'a qu'une forme, et c'est ici qu'on
 * l'impose, une fois, pour les deux services qui déposent.
 */
export function toPlanRevisionSessions(
  sessions: readonly {
    scheduledOn: string;
    kind: string;
    title: string;
    warmup?: string | null;
    recovery?: string | null;
    cooldown?: string | null;
    targetPaceSecPerKm?: number | null;
    volumeM?: number | null;
    durationS?: number | null;
    steps?: PlanSessionSteps | null;
  }[],
): PlanRevisionSessionInput[] {
  return sessions.map((session) => ({
    scheduledOn: session.scheduledOn,
    kind: session.kind,
    title: session.title,
    warmup: session.warmup ?? null,
    recovery: session.recovery ?? null,
    cooldown: session.cooldown ?? null,
    targetPaceSecPerKm: session.targetPaceSecPerKm ?? null,
    volumeM: session.volumeM ?? null,
    durationS: session.durationS ?? null,
    steps: session.steps ?? null,
  }));
}

/*
 * Erreurs métier.
 */

/**
 * La proposition visée n'existe pas, ou n'appartient pas à l'athlète.
 *
 * Les deux causes partagent la même erreur : distinguer « elle existe mais elle
 * n'est pas à toi » de « elle n'existe pas » révélerait l'existence de la ligne
 * (anti-IDOR), exactement comme `PlanNotFoundError` côté plans.
 */
export class PlanRevisionNotFoundError extends Error {
  constructor() {
    super("Cette proposition n'existe plus : recharge la page.");
    this.name = 'PlanRevisionNotFoundError';
  }
}

/**
 * Le plan a changé depuis le calcul de la proposition : elle est **périmée**.
 *
 * Message destiné à l'athlète : il doit dire ce qui s'est passé, parce que la
 * cause est presque toujours une action qu'elle vient de faire elle-même.
 */
export class StalePlanRevisionError extends Error {
  constructor() {
    super(
      'Ton plan a changé depuis que cette réévaluation a été calculée : elle ne prolonge plus le plan ' +
        "qu'elle visait, et n'a donc pas été appliquée. Le coach en proposera une nouvelle après tes prochaines séances.",
    );
    this.name = 'StalePlanRevisionError';
  }
}

/*
 * DTOs.
 */

/** Ce que les deux écrans affichent d'une proposition — jamais son payload. */
export type PlanRevisionDto = {
  id: number;
  /** La poignée que l'accepteur renvoie ; l'appartenance est revérifiée à chaque appel. */
  planId: number;
  source: PlanRevisionSource;
  direction: PlanRevisionDirection;
  reason: string;
  /** Nombre de semaines réécrites. */
  weeks: number;
  before: PlanRevisionTotals;
  after: PlanRevisionTotals;
  /** Instant du calcul, sérialisé en ISO-8601 (le DTO traverse la frontière client). */
  createdAt: string;
};

/**
 * La proposition **et les semaines qu'elle propose**, pour la page du plan.
 *
 * Les séances sont rendues dans le DTO que l'écran du plan sait déjà afficher,
 * pas dans la forme stockée : le payload complet ne franchit jamais la frontière
 * client. Leurs `id` sont **négatifs** — ce sont des séances qui n'existent pas
 * en base, et rien ne doit pouvoir les prendre pour des lignes réelles.
 */
export type PlanRevisionDetailDto = {
  revision: PlanRevisionDto;
  /** Jour de reprise : la première semaine proposée commence ce jour-là. */
  fromDate: string;
  sessions: PlanSessionDto[];
};

function toPlanRevisionDto(row: PlanRevision): PlanRevisionDto {
  return {
    id: row.id,
    planId: row.planId,
    source: row.source,
    direction: row.direction,
    reason: row.reason,
    weeks: row.weeks,
    before: { volumeKm: row.beforeVolumeKm, intensityKm: row.beforeIntensityKm },
    after: { volumeKm: row.afterVolumeKm, intensityKm: row.afterIntensityKm },
    createdAt: row.createdAt.toISOString(),
  };
}

/*
 * Dépôt.
 */

/** Ce qu'un service dépose, indépendamment de ce qui l'a déclenché. */
type PlanRevisionDepositBase = {
  planId: number;
  reason: string;
  direction: PlanRevisionDirection;
  weeks: number;
  before: PlanRevisionTotals;
  after: PlanRevisionTotals;
  payload: PlanRevisionPayload;
};

/**
 * Un dépôt, avec **le marqueur que sa source avance** (cf.
 * {@link depositPlanRevision}). Union discriminée : une revue ne peut pas
 * déposer en avançant la date d'un test, ni l'inverse.
 */
export type PlanRevisionDeposit = PlanRevisionDepositBase &
  (
    | {
        source: 'review';
        /** Le compte de séances réalisées que le coach vient de relire. */
        reviewedSessionCount: number;
      }
    | {
        source: 'fitness-test';
        /** Date civile du test qui vient d'être évalué. */
        referenceUpdatedOn: string;
        /** Ce que le test a donné, en une phrase pour l'athlète. */
        lastTestNote: string;
      }
  );

/**
 * L'issue d'un dépôt — aucune n'est une panne, et aucune ne lève.
 *
 * `no-active-plan` : le plan a été archivé pendant les minutes de calcul.
 * `conflict` : l'autre service a déposé au même instant, et l'index unique a
 * tranché. Les deux services ont leur propre verrou de processus, mais ces
 * verrous ne se voient pas l'un l'autre.
 */
export type PlanRevisionDepositOutcome = 'deposited' | 'no-active-plan' | 'conflict';

/**
 * Ce que le dépôt marque comme **déjà examiné** sur le plan.
 *
 * Aucun de ces champs ne touche `plans.updated_at`, et c'est essentiel : cette
 * colonne date le **contenu** du plan (son objectif, ses séances, ses réglages),
 * et c'est elle qui sert de témoin de péremption. La faire bouger au dépôt
 * périmerait la proposition à l'instant même où on l'écrit — et périmerait au
 * passage une proposition déjà en attente. Même raisonnement que
 * `markPlanReviewed` (`plan-review.ts`) : l'état d'un service n'est pas une
 * modification du plan.
 */
function markerValues(input: PlanRevisionDeposit) {
  return input.source === 'review'
    ? { reviewedSessionCount: input.reviewedSessionCount, reviewedAt: new Date() }
    : { referenceUpdatedOn: input.referenceUpdatedOn, lastTestNote: input.lastTestNote };
}

/**
 * Dépose une proposition de réévaluation, et marque au passage ce que le service
 * vient d'examiner.
 *
 * ## Pourquoi le marqueur avance **au dépôt** et non à l'acceptation
 *
 * Le marqueur ne dit pas « le plan a changé », il dit « le coach a regardé ça ».
 * Or il l'a regardé : le jugement est fait, les minutes de modèle sont
 * dépensées, la proposition est écrite. Ce qui reste à l'athlète, c'est une
 * décision sur le calendrier — pas sur le fait que son passé a été relu.
 *
 * Trois conséquences, et ce sont elles qui décident :
 *
 * 1. **Un refus est définitif.** Si le marqueur n'avançait qu'à l'acceptation,
 *    le prochain fichier importé retrouverait le seuil franchi, relancerait le
 *    même calcul sur les mêmes données et redéposerait la même proposition —
 *    exactement ce qu'un refus doit empêcher. Aucun second mécanisme de mémoire
 *    n'est nécessaire : le marqueur qui cadence est le marqueur qui mémorise.
 * 2. **Une proposition en attente ne coûte rien.** Sans cela, chaque import
 *    pendant que l'athlète réfléchit relancerait une génération complète
 *    (jusqu'à 45 appels au modèle sur un plan de 16 semaines) pour écraser la
 *    proposition qu'elle est en train de lire.
 * 3. **Rien de faux n'est écrit.** Le compte de séances relues et la date du
 *    dernier test évalué sont vrais dès le dépôt ; le chrono, les séances et les
 *    réglages, eux, restent dans le payload et n'entrent en base qu'à
 *    l'acceptation.
 *
 * Le prix assumé : une proposition laissée en attente ne sera pas recalculée
 * avant le palier suivant. C'est le bon prix — une proposition qui changerait
 * sous les yeux de qui la lit serait pire.
 *
 * **Au plus une proposition en attente par athlète** : la précédente est
 * supprimée d'abord, dans la même transaction (le motif de `createDraftPlanWithSessions`).
 * La plus récente est la seule qui décrive l'état du jour.
 *
 * Ne lève pas pour les issues normales (cf. {@link PlanRevisionDepositOutcome}).
 * Un payload hors schéma, lui, remonte : c'est une incohérence interne du
 * service appelant, pas une situation à absorber.
 */
export async function depositPlanRevision(
  input: PlanRevisionDeposit,
  athleteId: number,
): Promise<PlanRevisionDepositOutcome> {
  // Avant d'ouvrir la transaction : un payload aberrant ne doit pas commencer
  // par effacer la proposition précédente.
  const payload = planRevisionPayloadSchema.parse(input.payload);

  try {
    return await db.transaction(async (tx) => {
      const planRows = await tx
        .select({ updatedAt: plans.updatedAt })
        .from(plans)
        .where(
          and(eq(plans.id, input.planId), eq(plans.athleteId, athleteId), eq(plans.status, 'active')),
        )
        .limit(1);

      const plan = planRows[0];
      if (!plan) return 'no-active-plan';

      await tx
        .update(plans)
        .set(markerValues(input))
        .where(
          and(eq(plans.id, input.planId), eq(plans.athleteId, athleteId), eq(plans.status, 'active')),
        );

      await tx.delete(planRevisions).where(eq(planRevisions.athleteId, athleteId));

      await tx.insert(planRevisions).values({
        athleteId,
        planId: input.planId,
        source: input.source,
        reason: input.reason,
        direction: input.direction,
        weeks: input.weeks,
        beforeVolumeKm: input.before.volumeKm,
        beforeIntensityKm: input.before.intensityKm,
        afterVolumeKm: input.after.volumeKm,
        afterIntensityKm: input.after.intensityKm,
        payload,
        // Lu dans la transaction, **après** le marqueur : celui-ci ne touche pas
        // `updated_at`, le témoin décrit donc bien l'état sur lequel le calcul a
        // été fait.
        planUpdatedAt: plan.updatedAt,
      });

      return 'deposited';
    });
  } catch (error) {
    // L'insertion ne peut heurter que `plan_revisions_pending_per_athlete` :
    // l'autre service vient de déposer la sienne. Tout autre échec remonte tel
    // quel — un `catch` qui avale l'inattendu ferait passer une panne pour une
    // course.
    if (isUniqueViolation(error)) return 'conflict';
    throw error;
  }
}

/*
 * Lectures.
 */

/**
 * La proposition en attente de l'athlète, `null` s'il n'y en a pas.
 *
 * La jointure sur le plan **actif** n'est pas une précaution de style : adopter
 * une proposition de plan archive le plan en cours, et la proposition de
 * réévaluation qui le visait ne décrit plus rien. Elle cesse alors d'apparaître,
 * sans qu'aucun nettoyage n'ait à courir derrière.
 */
async function selectPendingRevision(athleteId: number): Promise<PlanRevision | null> {
  const rows = await db
    .select(getTableColumns(planRevisions))
    .from(planRevisions)
    .innerJoin(
      plans,
      and(
        eq(plans.id, planRevisions.planId),
        eq(plans.athleteId, planRevisions.athleteId),
        eq(plans.status, 'active'),
      ),
    )
    .where(eq(planRevisions.athleteId, athleteId))
    .limit(1);

  return rows[0] ?? null;
}

/** La proposition en attente, sans son contenu — ce que le tableau de bord affiche. */
export async function getPendingPlanRevision(athleteId: number): Promise<PlanRevisionDto | null> {
  const row = await selectPendingRevision(athleteId);
  return row === null ? null : toPlanRevisionDto(row);
}

/**
 * La proposition en attente **et les semaines qu'elle propose**, pour la page du
 * plan.
 *
 * `null` quand le payload stocké ne se relit plus : une proposition qu'on ne
 * sait pas afficher ne doit pas s'afficher à moitié, et l'accepter serait pire.
 * Le cas est journalisé — il ne peut venir que d'un changement de forme du
 * payload entre deux déploiements.
 */
export async function getPendingPlanRevisionDetail(
  athleteId: number,
): Promise<PlanRevisionDetailDto | null> {
  const row = await selectPendingRevision(athleteId);
  if (row === null) return null;

  const parsed = planRevisionPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    console.error(
      `[plan/revision] proposition ${row.id} illisible (payload hors schéma) — non affichée :`,
      parsed.error.issues[0]?.message ?? 'forme inattendue',
    );
    return null;
  }

  return {
    revision: toPlanRevisionDto(row),
    fromDate: parsed.data.fromDate,
    sessions: parsed.data.sessions.map(
      (session, index): PlanSessionDto => ({
        // Négatif et stable : ces séances n'existent pas en base, et l'écran ne
        // s'en sert que comme clé de rendu.
        id: -(index + 1),
        scheduledOn: session.scheduledOn,
        kind: session.kind,
        title: session.title,
        warmup: session.warmup,
        recovery: session.recovery,
        cooldown: session.cooldown,
        targetPaceSecPerKm: session.targetPaceSecPerKm,
        volumeM: session.volumeM,
        durationS: session.durationS,
        steps: session.steps,
        // Une séance proposée n'a rien réalisé : elle n'existe pas encore.
        completedActivityId: null,
      }),
    ),
  };
}

/*
 * Décisions.
 */

/** Supprime la proposition. `false` si elle n'était plus là. */
async function deletePlanRevision(revisionId: number, athleteId: number): Promise<boolean> {
  const deleted = await db
    .delete(planRevisions)
    .where(and(eq(planRevisions.id, revisionId), eq(planRevisions.athleteId, athleteId)))
    .returning({ id: planRevisions.id });

  return deleted.length > 0;
}

/**
 * Accepte la proposition : **le payload stocké** devient la suite du plan.
 *
 * Aucun recalcul (cf. l'en-tête du module). Le contrôle de fraîcheur précède
 * immédiatement l'écriture : si `plans.updated_at` a bougé depuis le calcul, la
 * proposition est périmée — elle est jetée et l'athlète en est informée, plutôt
 * que d'écraser un ajustement qu'elle vient de demander.
 *
 * La suppression suit l'écriture plutôt que de la précéder : un échec entre les
 * deux laisse la proposition en base, mais le plan qu'elle visait a désormais un
 * `updated_at` postérieur au témoin — elle est donc périmée, et le prochain clic
 * la jettera au lieu de l'appliquer deux fois. C'est la même fenêtre que celle
 * qu'assument déjà les services (`review-service.ts`), et elle se referme
 * d'elle-même.
 *
 * @returns l'identifiant du plan mis à jour — l'appelant en a besoin pour les
 * suites (rapprochement, republication du calendrier).
 * @throws {PlanRevisionNotFoundError} si la proposition n'est pas celle de
 * l'athlète, ou n'existe plus.
 * @throws {StalePlanRevisionError} si le plan a changé depuis le calcul.
 * @throws {PlanNotFoundError} si le plan n'est plus le plan actif de l'athlète.
 * @throws {InvalidPlanError} si le payload stocké ne s'écrit pas dans la fenêtre
 * du plan — une incohérence interne, jamais une faute de l'athlète.
 */
export async function acceptPlanRevision(revisionId: number): Promise<{ planId: number }> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new PlanRevisionNotFoundError();

  const row = await selectPendingRevision(athleteId);
  if (row === null || row.id !== revisionId) throw new PlanRevisionNotFoundError();

  const parsed = planRevisionPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    // Illisible : elle ne s'affichait déjà pas, elle ne s'applique pas non plus.
    await deletePlanRevision(row.id, athleteId);
    console.error(`[plan/revision] proposition ${row.id} illisible — jetée sans être appliquée.`);
    throw new PlanRevisionNotFoundError();
  }

  const updatedAt = await getPlanUpdatedAt(row.planId, athleteId);
  if (updatedAt === null || updatedAt !== row.planUpdatedAt.toISOString()) {
    await deletePlanRevision(row.id, athleteId);
    throw new StalePlanRevisionError();
  }

  await applyPlanUpdate(row.planId, parsed.data, athleteId);
  await deletePlanRevision(row.id, athleteId);

  return { planId: row.planId };
}

/**
 * Refuse la proposition : elle disparaît, et rien d'autre ne bouge — ni le plan,
 * ni le calendrier intervals.icu, qui ne l'ont jamais connue.
 *
 * Ce que le refus **ne fait pas**, et n'a pas à faire : reculer le marqueur. Il
 * a avancé au dépôt (cf. {@link depositPlanRevision}), et c'est précisément ce
 * qui empêche le prochain import de reproposer la même chose.
 *
 * @throws {PlanRevisionNotFoundError} si la proposition n'est pas celle de
 * l'athlète, ou n'existe plus — l'appelant décide si c'est un refus déjà abouti.
 */
export async function rejectPlanRevision(revisionId: number): Promise<void> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) throw new PlanRevisionNotFoundError();

  if (!(await deletePlanRevision(revisionId, athleteId))) {
    throw new PlanRevisionNotFoundError();
  }
}
