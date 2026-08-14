import 'server-only';

import { and, eq, gte, inArray, lte } from 'drizzle-orm';

import { civilDateToMs, shiftCivilDate, toCivilDate } from '@/lib/dates/civil';
import { computeBestSegments } from '@/lib/metrics/best-segments';
import { REFERENCE_DISTANCES } from '@/lib/metrics/vdot';
import { FITNESS_TEST_EFFORT_M, FITNESS_TEST_KIND } from '@/lib/plan-skeleton';

import { getAthleteProfileById } from './athlete';
import { db } from './db/client';
import { activities, activityStreams, plannedSessions, plans } from './db/schema';
import { isRunning } from './training-metrics';

/**
 * Ce qu'il faut savoir pour décider du sort d'un **test chronométré** venant
 * d'être importé.
 *
 * La lecture ne rend quelque chose que si toutes les conditions de forme sont
 * réunies : l'activité réalise une séance planifiée, cette séance est un test,
 * et elle appartient au plan **actif** de l'athlète. Tout le reste — l'effort
 * était-il maximal, le chrono est-il meilleur, la cadence est-elle respectée —
 * est une décision, elle vit dans `lib/metrics/fitness-test.ts`.
 *
 * Le partage est le même que partout ailleurs sur ce projet : le DAL lit et
 * écrit, les règles se testent sans base.
 */

/** Ce que le service reçoit : l'activité, le plan, et le meilleur 5 km isolé. */
export type FitnessTestCandidateDto = {
  planId: number;
  /**
   * L'activité **retenue** comme étant le test — pas nécessairement celle qui
   * vient d'être importée ({@link pickTestActivity}). Rendue pour que le journal
   * dise laquelle des sorties du jour a fourni le chrono.
   */
  activityId: number;
  /** Date civile du premier jour du plan — l'ancre de la cadence à défaut de mise à jour. */
  planStartsOn: string;
  /** Le chrono de référence en vigueur : distance en mètres et temps en secondes. */
  referenceDistanceM: number;
  referenceTimeS: number;
  /** Date civile de la dernière mise à jour du chrono par un test, `null` s'il n'y en a pas eu. */
  referenceUpdatedOn: string | null;
  /**
   * Date civile du test — celle à laquelle la séance était **planifiée**, qui
   * est aussi celle des activités retenues : le rapprochement ne lie qu'au jour
   * civil (`plan-reconciliation.ts`), dans le fuseau de l'athlète.
   */
  testedOn: string;
  /** FC max atteinte pendant l'activité retenue, `null` sans capteur cardiaque. */
  activityMaxHrBpm: number | null;
  /** FC max du **profil**, `null` quand l'athlète ne l'a pas saisie. */
  profileMaxHrBpm: number | null;
  /**
   * Le temps du meilleur 5 km continu de l'activité retenue, en secondes —
   * `null` quand aucune sortie du jour n'en contient (trop courtes, ou sans
   * série de distance).
   *
   * Isolé par {@link computeBestSegments}, la même mécanique que les « meilleurs
   * efforts » affichés sur la page d'une activité : le fichier FIT ne porte
   * aucun marqueur « ici commence le test », et les tours de montre sont ce que
   * l'auto-lap a découpé — pas ce que l'athlète a chronométré.
   */
  bestFiveKTimeS: number | null;
};

/**
 * Le test que cette activité vient de réaliser, `null` quand ce n'en est pas un.
 *
 * Trois refus, tous silencieux et tous normaux — l'immense majorité des imports
 * n'est pas un test :
 *
 * - l'activité n'est rapprochée d'aucune séance planifiée, ou la séance n'est
 *   pas un test ;
 * - la séance n'appartient pas au plan actif (un plan archivé ne se recalibre
 *   pas) ;
 * - le plan n'a pas de chrono de référence : il n'y a alors rien à mettre à
 *   jour, ses allures ne viennent pas d'une table VDOT.
 *
 * **L'athlète est un paramètre** : l'appelant est le pipeline d'import, qui
 * tourne hors requête et sait à qui appartient le fichier. Il borne l'activité
 * lue, et les deux autres tables sont jointes sous le même athlète — aucun plan
 * d'un autre ne peut être touché. Le profil, lui, était lu par la session
 * (`getAthleteProfile`) : hors requête il ressortait `null`, et la FC max
 * manquante faisait refuser tous les tests pour « effort non maximal ».
 *
 * ## Le chrono ne vient pas forcément de l'activité qui déclenche
 *
 * Le rapprochement apparie au **jour civil**, et la première activité du jour
 * prend le créneau : un footing du matin importé avant le test du soir consomme
 * la séance, et le test lui-même ne serait jamais évalué. Le candidat se choisit
 * donc parmi **toutes** les sorties de la date planifiée
 * ({@link pickTestActivity}), pas sur celle qui se trouve rapprochée. Le
 * rapprochement, lui, n'est pas touché : c'est lui qui dit « cette journée était
 * celle du test », et c'est tout ce qu'on lui demande.
 */
export async function getFitnessTestCandidate(
  activityId: number,
  athleteId: number,
): Promise<FitnessTestCandidateDto | null> {
  const rows = await db
    .select({
      maxHrBpm: activities.maxHrBpm,
      sessionKind: plannedSessions.kind,
      scheduledOn: plannedSessions.scheduledOn,
      planId: plans.id,
      planStartsOn: plans.startsOn,
      referenceDistance: plans.referenceDistance,
      referenceTimeS: plans.referenceTimeS,
      referenceUpdatedOn: plans.referenceUpdatedOn,
    })
    .from(activities)
    .innerJoin(plannedSessions, eq(plannedSessions.completedActivityId, activities.id))
    .innerJoin(
      plans,
      and(eq(plans.id, plannedSessions.planId), eq(plans.athleteId, activities.athleteId)),
    )
    .where(
      and(
        eq(activities.id, activityId),
        eq(activities.athleteId, athleteId),
        eq(plans.status, 'active'),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.sessionKind !== FITNESS_TEST_KIND) return null;
  if (row.referenceDistance === null || row.referenceTimeS === null) return null;

  const [effort, profile] = await Promise.all([
    bestEffortOfDay(athleteId, row.scheduledOn, { id: activityId, maxHrBpm: row.maxHrBpm }),
    getAthleteProfileById(athleteId),
  ]);

  return {
    planId: row.planId,
    activityId: effort.activityId,
    planStartsOn: row.planStartsOn,
    referenceDistanceM: REFERENCE_DISTANCES[row.referenceDistance],
    referenceTimeS: row.referenceTimeS,
    referenceUpdatedOn: row.referenceUpdatedOn,
    testedOn: row.scheduledOn,
    activityMaxHrBpm: effort.maxHrBpm,
    profileMaxHrBpm: profile?.maxHrBpm ?? null,
    bestFiveKTimeS: effort.bestFiveKTimeS,
  };
}

/** Une sortie du jour, réduite à ce qui la départage des autres. */
type TestActivity = {
  id: number;
  maxHrBpm: number | null;
  bestFiveKTimeS: number | null;
};

/**
 * La sortie du jour qui **est** le test : celle dont le meilleur 5 km est le
 * plus rapide — pur, et testé comme tel.
 *
 * C'est le seul critère honnête dont on dispose. Le fichier FIT ne porte pas de
 * marqueur « ici commence le test », et rien ne distingue de l'extérieur un
 * footing d'un 5 km à fond sinon sa vitesse. Une sortie sans 5 km continu passe
 * après toutes celles qui en ont un — elle ne peut pas être le test —, et
 * l'égalité se tranche par le plus petit `id` : la même journée rendue deux fois
 * doit rendre la même activité, sans quoi un réimport rejouerait un autre
 * verdict.
 *
 * Rendre la moins lente **surestime** au pire : si l'athlète a couru un 5 km
 * rapide qui n'était pas le test, la validation d'effort maximal est ce qui rend
 * le cas inoffensif (cf. `lib/metrics/fitness-test.ts`).
 */
export function pickTestActivity(candidates: readonly TestActivity[]): TestActivity | null {
  let best: TestActivity | null = null;
  for (const candidate of candidates) {
    if (best === null || compareTestActivities(candidate, best) < 0) best = candidate;
  }
  return best;
}

/** Ordre de préférence entre deux sorties du même jour (négatif = `a` gagne). */
function compareTestActivities(a: TestActivity, b: TestActivity): number {
  if (a.bestFiveKTimeS === null || b.bestFiveKTimeS === null) {
    const measured = Number(b.bestFiveKTimeS !== null) - Number(a.bestFiveKTimeS !== null);
    return measured !== 0 ? measured : a.id - b.id;
  }
  const time = a.bestFiveKTimeS - b.bestFiveKTimeS;
  return time !== 0 ? time : a.id - b.id;
}

/**
 * Le meilleur 5 km de la journée `day`, et la sortie qui l'a produit.
 *
 * L'activité qui a déclenché l'import fait toujours partie des candidates,
 * qu'elle ressorte ou non du filtre de date : c'est le rapprochement qui l'a
 * désignée, et la journée retenue ne peut donc pas être vide.
 *
 * La borne SQL porte sur un instant, la journée sur un jour civil : les bornes
 * sont des minuits UTC élargis de part et d'autre, de quoi couvrir n'importe
 * quel décalage de fuseau ; `toCivilDate` tranche ensuite au jour près. Même
 * mécanique que `reconcilePlanSessions`.
 */
async function bestEffortOfDay(
  athleteId: number,
  day: string,
  linked: { id: number; maxHrBpm: number | null },
): Promise<{ activityId: number; maxHrBpm: number | null; bestFiveKTimeS: number | null }> {
  const rows = await db
    .select({
      id: activities.id,
      startedAt: activities.startedAt,
      sportType: activities.sportType,
      maxHrBpm: activities.maxHrBpm,
    })
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        gte(activities.startedAt, new Date(civilDateToMs(shiftCivilDate(day, -1)))),
        lte(activities.startedAt, new Date(civilDateToMs(shiftCivilDate(day, 2)))),
      ),
    );

  const sameDay = rows.filter(
    (row) => row.id !== linked.id && isRunning(row.sportType) && toCivilDate(row.startedAt) === day,
  );
  const ids = [linked.id, ...sameDay.map((row) => row.id)];

  const streamRows = await db
    .select()
    .from(activityStreams)
    .where(inArray(activityStreams.activityId, ids));

  const toCandidate = (row: { id: number; maxHrBpm: number | null }): TestActivity => ({
    id: row.id,
    maxHrBpm: row.maxHrBpm,
    bestFiveKTimeS: bestFiveKTimeS(streamRows.filter((stream) => stream.activityId === row.id)),
  });

  const linkedCandidate = toCandidate(linked);
  // Jamais `null` en pratique : la liste porte au moins l'activité rapprochée.
  const best = pickTestActivity([linkedCandidate, ...sameDay.map(toCandidate)]) ?? linkedCandidate;
  return { activityId: best.id, maxHrBpm: best.maxHrBpm, bestFiveKTimeS: best.bestFiveKTimeS };
}

/**
 * Le meilleur 5 km continu des séries de l'activité, `null` quand la séance n'en
 * porte pas.
 *
 * Les deux canaux sont vérifiés à la lecture plutôt qu'affirmés : le contenu
 * d'une colonne `jsonb` est typé côté schéma, mais Postgres rend ce qu'une
 * version antérieure du code y a écrit.
 */
function bestFiveKTimeS(rows: readonly { type: string; data: unknown[] }[]): number | null {
  const distance = numberSeries(rows, 'distance');
  const time = numberSeries(rows, 'time');
  if (distance === null || time === null) return null;

  const segment = computeBestSegments(distance, time).find(
    (candidate) => candidate.targetM === FITNESS_TEST_EFFORT_M,
  );
  return segment?.timeS ?? null;
}

/** Ce qu'un test laisse au plan quand il n'y a aucune semaine à réécrire. */
export type FitnessTestRecord = {
  /** La phrase destinée à l'athlète — toujours écrite, quel que soit le verdict. */
  note: string;
  /**
   * Le chrono de référence mis à jour, absent quand le test ne le fait pas
   * bouger (le cas de loin le plus fréquent).
   */
  reference?: { timeS: number; updatedOn: string };
};

/**
 * Inscrit le résultat d'un test sur le plan actif, **sans toucher aux séances**.
 *
 * Le chemin nominal d'un test qui améliore le chrono ne passe pas par ici : il
 * passe par `applyPlanUpdate`, qui écrit le nouveau chrono **et** les semaines
 * recalculées dans la même transaction — sans quoi le plan afficherait, entre
 * les deux écritures, des allures qui ne viennent pas du chrono qu'il annonce.
 *
 * Cette fonction couvre les deux cas où il n'y a rien à réécrire : un test qui
 * ne change rien (la note seule), et un test qui améliore le chrono alors qu'il
 * ne reste plus une semaine à recalculer.
 *
 * L'appartenance et l'état actif sont dans le `WHERE` de l'`UPDATE` : une
 * lecture préalable laisserait une fenêtre entre le contrôle et l'écriture.
 *
 * @returns `false` si le plan n'est plus le plan actif de l'athlète — un plan
 * archivé pendant l'import n'est pas une anomalie, il n'y a rien à y écrire.
 */
export async function recordFitnessTest(
  planId: number,
  record: FitnessTestRecord,
  athleteId: number,
): Promise<boolean> {
  const updated = await db
    .update(plans)
    .set({
      lastTestNote: record.note,
      ...(record.reference === undefined
        ? {}
        : {
            referenceDistance: '5k',
            referenceTimeS: Math.round(record.reference.timeS),
            referenceUpdatedOn: record.reference.updatedOn,
          }),
      updatedAt: new Date(),
    })
    .where(and(eq(plans.id, planId), eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
    .returning({ id: plans.id });

  return updated.length > 0;
}

/** La série est-elle bien une suite de nombres (ou de trous) ? */
function isNumberSeries(data: readonly unknown[]): data is (number | null)[] {
  return data.every((value) => value === null || typeof value === 'number');
}

/** Une série numérique de `activity_streams`, `null` si absente ou mal formée. */
function numberSeries(
  rows: readonly { type: string; data: unknown[] }[],
  type: string,
): (number | null)[] | null {
  const row = rows.find((candidate) => candidate.type === type);
  if (row === undefined || row.data.length === 0) return null;
  return isNumberSeries(row.data) ? row.data : null;
}
