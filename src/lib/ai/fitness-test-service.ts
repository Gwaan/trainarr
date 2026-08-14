import 'server-only';

/**
 * Ce qui se passe quand l'athlète a couru son **test chronométré**.
 *
 * Le plan pose des tests dans sa périodisation
 * (`plan-skeleton/fitness-test.ts`) ; les règles qui décident du sort du chrono
 * vivent dans `lib/metrics/fitness-test.ts`, pures et testées sans base. Ce
 * module-ci est la plomberie entre les deux : il lit ce que l'import vient
 * d'écrire, applique le verdict, et — quand le chrono a bougé — **recalcule
 * toutes les allures du plan restant**.
 *
 * ## Pourquoi le recalcul est indispensable, et pourquoi il passe par là
 *
 * Le chrono de référence n'est pas un chiffre décoratif : c'est de lui que
 * `trainingPacesFromRace` tire la table E/M/T/I/R, et de cette table que chaque
 * séance tire sa cible. Le mettre à jour sans réécrire les semaines à venir
 * laisserait un plan qui **annonce** un nouveau chrono et **prescrit** les
 * anciennes allures — exactement le genre d'incohérence silencieuse que ce
 * projet refuse. `rewriteRemainingPlan` est le seul chemin qui reconstruit la
 * fin d'un plan en cours, et il lit les allures depuis le plan : on lui passe
 * donc le plan **déjà porteur du nouveau chrono**, et l'écriture des deux
 * moitiés — chrono et séances — tient dans une seule transaction
 * (`applyPlanUpdate`).
 *
 * ## Le silence est un bug
 *
 * Chaque test se journalise en `[plan/test]`, quel que soit son sort : accepté,
 * refusé faute d'effort maximal, refusé pour cadence, ou sans mesure
 * exploitable. Et chaque test laisse une **note lisible par l'athlète** sur le
 * plan (`plans.last_test_note`) — y compris quand rien ne bouge. Un plan qui
 * prendrait des décisions que personne ne voit ne serait plus le sien.
 *
 * ## Un test à la fois
 *
 * Un verrou de process, même mécanique et mêmes limites que celui de la révision
 * (cf. `review-service.ts`) : il vit sur `globalThis` pour être le même quel que
 * soit le bundle appelant, et il ne protège que de la concurrence interne. Ce
 * qu'il ferme concrètement : un backfill qui redéposerait deux fois le fichier
 * du test lancerait deux reconstructions du même plan, dont l'une écraserait
 * l'autre après plusieurs minutes de génération.
 *
 * **Ce verrou-là ne voit pas celui de la révision**, et l'inverse est vrai : les
 * deux services en ont un chacun. C'est pourquoi ce module applique, comme la
 * révision, un **contrôle de fraîcheur** juste avant d'écrire (cf.
 * {@link applyImprovedTest}) — sans quoi un test parti deux secondes après une
 * révision écrirait des séances construites sur des réglages déjà remplacés.
 *
 * ## Un test ne s'évalue qu'une fois
 *
 * Un réimport du même fichier — backfill, `processed/` vidé — repasse par ici.
 * La garde est en tête de {@link applyFitnessTest} : un test que le chrono de
 * référence en vigueur a déjà pris en compte ne se rejoue pas, sans quoi la note
 * de l'athlète se ferait écraser par un verdict qui la contredit.
 */

import { todayCivilDate } from '@/data/athlete';
import { getTrainingSnapshot } from '@/data/coach-context';
import { getFitnessTestCandidate, recordFitnessTest } from '@/data/fitness-test';
import { reconcilePlanSessions } from '@/data/plan-reconciliation';
import { getPlanUpdatedAt } from '@/data/plan-review';
import {
  InvalidPlanError,
  applyPlanUpdate,
  getActivePlanWithSessions,
  type PlanDto,
} from '@/data/plans';
import { shiftCivilDate } from '@/lib/dates/civil';
import { syncPlanToIntervalsSafely } from '@/lib/intervals/push-plan';
import {
  fitnessTestVerdict,
  MAXIMAL_EFFORT_HR_SHARE,
  type FitnessTestVerdict,
} from '@/lib/metrics/fitness-test';
import {
  InvalidRacePerformanceError,
  trainingPacesFromRace,
  vdotFromRace,
} from '@/lib/metrics/vdot';

import { fitnessTestNote } from './fitness-test-note';
import { mapPlanWeeksToSessions } from './plan-schema';
import {
  planWeeklyVolumeKm,
  remainingPlanWindow,
  rewriteRemainingPlan,
  type RemainingPlanRewrite,
  type RemainingPlanWindow,
} from './plan-service';

/** L'état de process du service : un verrou, et rien d'autre. */
type FitnessTestState = { running: boolean };

/** La clé de l'état partagé — même raison que `REVIEW_STATE_KEY` (cf. `review-service.ts`). */
const FITNESS_TEST_STATE_KEY: unique symbol = Symbol.for('trainarr.fitness-test-state');

type GlobalWithFitnessTestState = typeof globalThis & {
  [FITNESS_TEST_STATE_KEY]?: FitnessTestState;
};

function fitnessTestState(): FitnessTestState {
  const store = globalThis as GlobalWithFitnessTestState;

  const existing = store[FITNESS_TEST_STATE_KEY];
  if (existing !== undefined) return existing;

  const created: FitnessTestState = { running: false };
  store[FITNESS_TEST_STATE_KEY] = created;
  return created;
}

/**
 * Libère le verrou du service.
 *
 * Exportée pour les tests uniquement — l'état survit d'un cas à l'autre (et même
 * d'un module rechargé à l'autre, puisqu'il vit sur `globalThis`), et un verrou
 * laissé pris par un scénario d'échec ferait sortir tous les suivants sans rien
 * faire.
 */
export function resetFitnessTestState(): void {
  fitnessTestState().running = false;
}

/**
 * L'allure de **seuil** d'une table, en s/km — le milieu de la bande.
 *
 * C'est elle que la note met en avant, et pas l'endurance : c'est l'allure dont
 * Scudamore et al. (2017) montrent qu'un 5 km chronométré la donne de façon
 * fiable à tous les niveaux, et c'est celle que l'athlète reconnaît d'une séance
 * à l'autre.
 */
function thresholdPaceSecPerKm(distanceM: number, timeS: number): number | null {
  try {
    const paces = trainingPacesFromRace(distanceM, timeS);
    return Math.round((paces.threshold.minSecPerKm + paces.threshold.maxSecPerKm) / 2);
  } catch (error) {
    if (error instanceof InvalidRacePerformanceError) return null;
    throw error;
  }
}

/**
 * Applique le test chronométré que cette activité vient peut-être de réaliser.
 *
 * **Ne lève jamais et n'est jamais attendue par un appelant** : c'est le
 * pipeline d'import qui la déclenche, en oubliant sa promesse. No-op silencieux
 * quand l'activité ne réalise pas un test — c'est le cas de tous les imports
 * sauf une poignée par plan.
 *
 * **L'athlète est un paramètre**, comme pour l'ingestion qui la déclenche
 * (`ingestFitBuffer`) : ce service tourne dans le watcher FIT, hors requête. Il
 * n'y a pas de session à interroger — et tout ce qu'il appelle le reçoit à son
 * tour, jusqu'à la publication du calendrier.
 */
export async function maybeApplyFitnessTest(
  activityId: number,
  athleteId: number,
): Promise<void> {
  const state = fitnessTestState();
  if (state.running) {
    console.log('[plan/test] déclenchement ignoré : un test est déjà en cours de traitement.');
    return;
  }

  state.running = true;
  try {
    await applyFitnessTest(activityId, athleteId);
  } catch (error) {
    const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
    console.error(`[plan/test] activité ${activityId} : traitement du test impossible — ${reason}`);
  } finally {
    state.running = false;
  }
}

/** Le corps de {@link maybeApplyFitnessTest}, une fois le verrou pris. */
async function applyFitnessTest(activityId: number, athleteId: number): Promise<void> {
  const candidate = await getFitnessTestCandidate(activityId, athleteId);
  if (candidate === null) return;

  // Un test que la référence en vigueur a **déjà** pris en compte ne se rejoue
  // pas.
  //
  // Le cas se produit à chaque réimport du fichier du test — un backfill, un
  // `processed/` vidé à la main, cas documentés comme inoffensifs
  // (`.claude/rules/data-import.md`). La chaîne d'import repasse alors ici avec
  // le même chrono, mais le chrono de référence a bougé entre-temps : la cadence
  // rend `too-soon`, et la note « chrono non retenu, il redeviendra ajustable
  // dans 28 jours » écrase le « nouveau record, allures recalculées » qui était
  // la seule trace du résultat. Le plan finirait à jour et incompréhensible.
  //
  // La comparaison couvre aussi le sens rétrograde, celui d'un backfill qui
  // rapatrie du plus récent au plus ancien : un test **antérieur** à la
  // référence en vigueur n'a rien à dire non plus — il a déjà été pris en
  // compte, ou il est plus vieux que ce qu'on sait de l'athlète.
  //
  // Ce qui reste ouvert l'est volontairement : un test qui n'a pas fait bouger
  // la référence (`not-improved`, `not-maximal`, `unmeasurable`, `too-soon`) est
  // réévalué, et c'est sans conséquence — rien n'a changé, le verdict est le
  // même et la note se réécrit à l'identique. Mais si le réimport apporte les
  // séries qui manquaient à l'activité, l'évaluation qui devient possible a bien
  // lieu.
  if (candidate.referenceUpdatedOn !== null && candidate.testedOn <= candidate.referenceUpdatedOn) {
    console.log(
      `[plan/test] plan ${candidate.planId}, activité ${candidate.activityId} : test du ` +
        `${candidate.testedOn} déjà pris en compte (chrono de référence mis à jour le ` +
        `${candidate.referenceUpdatedOn}) — rien à réévaluer.`,
    );
    return;
  }

  // Le chrono de référence en vigueur, en VDOT — la seule échelle qui compare
  // un 5 km à un 10 km ou à un semi.
  let referenceVdot: number;
  try {
    referenceVdot = vdotFromRace(candidate.referenceDistanceM, candidate.referenceTimeS);
  } catch (error) {
    if (!(error instanceof InvalidRacePerformanceError)) throw error;
    // Un chrono de référence que le modèle refuse ne peut pas servir d'étalon.
    // Le plan a été créé avec, donc c'est une incohérence : on le dit, et on ne
    // touche à rien.
    console.error(
      `[plan/test] plan ${candidate.planId} : chrono de référence inexploitable — ${error.message}`,
    );
    return;
  }

  // La cadence se compte depuis la dernière mise à jour ; à défaut, depuis le
  // premier jour du plan — c'est là que le chrono de référence a été déclaré.
  const since = candidate.referenceUpdatedOn ?? candidate.planStartsOn;
  const daysSinceReference = Math.max(
    0,
    Math.round((Date.parse(candidate.testedOn) - Date.parse(since)) / 86_400_000),
  );

  const verdict = fitnessTestVerdict({
    bestFiveKTimeS: candidate.bestFiveKTimeS,
    activityMaxHrBpm: candidate.activityMaxHrBpm,
    profileMaxHrBpm: candidate.profileMaxHrBpm,
    referenceVdot,
    daysSinceReference,
  });

  console.log(
    `[plan/test] plan ${candidate.planId}, activité ${candidate.activityId} : verdict « ${verdict.outcome} » ` +
      `(meilleur 5 km ${candidate.bestFiveKTimeS === null ? 'introuvable' : `${Math.round(candidate.bestFiveKTimeS)} s`}, ` +
      `FC max ${candidate.activityMaxHrBpm ?? '—'}/${candidate.profileMaxHrBpm ?? '—'} bpm, ` +
      `seuil d'effort maximal ${Math.round(MAXIMAL_EFFORT_HR_SHARE * 100)} %, ` +
      `${daysSinceReference} j depuis la référence).`,
  );

  if (verdict.outcome !== 'improved') {
    await recordFitnessTest(
      candidate.planId,
      { note: fitnessTestNote(verdict, candidate.testedOn, null) },
      athleteId,
    );
    return;
  }

  const paceChange = paceChangeOf(
    candidate.referenceDistanceM,
    candidate.referenceTimeS,
    verdict.timeS,
  );
  await applyImprovedTest(candidate.planId, verdict, candidate.testedOn, paceChange, athleteId);
}

/** L'allure de seuil avant et après, `null` quand l'une des deux n'est pas calculable. */
function paceChangeOf(
  referenceDistanceM: number,
  referenceTimeS: number,
  testTimeS: number,
): { fromSecPerKm: number; toSecPerKm: number } | null {
  const before = thresholdPaceSecPerKm(referenceDistanceM, referenceTimeS);
  const after = thresholdPaceSecPerKm(5_000, testTimeS);
  return before === null || after === null
    ? null
    : { fromSecPerKm: before, toSecPerKm: after };
}

/**
 * Le chrono a progressé : on l'écrit, et on réécrit la fin du plan avec lui.
 *
 * Les deux moitiés tiennent dans **une** transaction (`applyPlanUpdate`). Deux
 * écritures séparées laisseraient, entre elles, un plan dont les séances ne
 * viennent pas du chrono qu'il affiche.
 *
 * Deux replis, et chacun écrit quand même la note — le résultat d'un test est un
 * fait, il ne se perd pas parce que la reconstruction a échoué :
 *
 * - **plus une semaine à réécrire** (le test tombait en fin de plan, ou le plan
 *   s'est terminé entre-temps) : le chrono est enregistré seul. Il servira au
 *   plan suivant ;
 * - **la reconstruction échoue** : le chrono est enregistré seul lui aussi, et
 *   la révision automatique — qui lit les allures sur le plan — recalculera les
 *   semaines restantes à son prochain palier ;
 * - **le plan a changé pendant la reconstruction** : même issue, pour la raison
 *   décrite au contrôle de fraîcheur plus bas.
 */
async function applyImprovedTest(
  planId: number,
  verdict: Extract<FitnessTestVerdict, { outcome: 'improved' }>,
  testedOn: string,
  paceChange: { fromSecPerKm: number; toSecPerKm: number } | null,
  athleteId: number,
): Promise<void> {
  const note = fitnessTestNote(verdict, testedOn, paceChange);
  const timeS = Math.round(verdict.timeS);
  const today = todayCivilDate();
  // La référence est datée du **jour du test**, jamais du jour de l'import : ce
  // que cette date porte est la cadence de Daniels, c'est-à-dire l'écart entre
  // deux **efforts**. Un fichier arrivé trois jours plus tard rognerait sinon
  // trois jours sur la fenêtre du test suivant, qui, lui, est déjà posé dans le
  // plan — et le rejetterait pour une raison qui n'a rien de physiologique.
  const reference = { timeS, updatedOn: testedOn };

  const active = await getActivePlanWithSessions(athleteId);
  if (active === null || active.plan.id !== planId) {
    console.log(`[plan/test] plan ${planId} : plus le plan actif — chrono non écrit.`);
    return;
  }

  // L'état du plan avant les minutes de reconstruction, pour le contrôle de
  // fraîcheur qui suit.
  const updatedAtBefore = await getPlanUpdatedAt(planId, athleteId);

  // La même reprise que partout ailleurs : demain. La séance du jour est en
  // cours ou déjà faite — et celle d'aujourd'hui, ici, c'est le test lui-même.
  const fromDate = shiftCivilDate(today, 1);

  // Le plan **porteur du nouveau chrono** : c'est de lui que la reconstruction
  // tire sa table d'allures (`planTrainingPaces`).
  const updated: PlanDto = { ...active.plan, referenceDistance: '5k', referenceTimeS: timeS };

  let remaining: RemainingPlanWindow;
  try {
    remaining = remainingPlanWindow(updated, fromDate);
  } catch (error) {
    if (!(error instanceof InvalidPlanError)) throw error;
    console.log(
      `[plan/test] plan ${planId} : plus une semaine à recalculer — chrono enregistré seul.`,
    );
    await recordFitnessTest(planId, { note, reference }, athleteId);
    return;
  }

  let rewrite: RemainingPlanRewrite;
  try {
    rewrite = await rewriteRemainingPlan({
      plan: updated,
      window: remaining,
      snapshot: await getTrainingSnapshot(athleteId),
      plannedWeeklyKm: planWeeklyVolumeKm(active.sessions),
    });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
    console.error(
      `[plan/test] plan ${planId} : reconstruction impossible — ${reason} ; ` +
        `chrono enregistré seul, la révision recalculera les semaines restantes.`,
    );
    await recordFitnessTest(planId, { note, reference }, athleteId);
    return;
  }

  // Le plan a-t-il bougé pendant les minutes de reconstruction ? Le même
  // contrôle que la révision (`review-service.ts`), et au même endroit : au plus
  // près de la transaction, après la seule étape lente de la fonction.
  //
  // Sans lui, les deux verrous de process — un par service — ne se voient pas
  // l'un l'autre : un import qui lance une révision, puis un second import deux
  // secondes plus tard qui lance un test, et le test écrit des séances
  // construites sur des réglages que la révision vient de remplacer. Le sens
  // inverse était déjà sûr, c'est l'asymétrie qui posait problème.
  //
  // Le chrono, lui, s'écrit quand même : il ne vient pas du plan mais de
  // l'activité, et c'est un fait mesuré qui ne se perd pas parce qu'une révision
  // est passée entre-temps. Seules les séances calculées dessus sont jetées ; la
  // révision suivante les recalculera à partir du plan à jour.
  const updatedAtAfter = await getPlanUpdatedAt(planId, athleteId);
  if (updatedAtAfter !== updatedAtBefore) {
    console.log(
      `[plan/test] plan ${planId} modifié pendant la reconstruction — séances abandonnées ; ` +
        `chrono enregistré seul, la révision recalculera les semaines restantes.`,
    );
    await recordFitnessTest(planId, { note, reference }, athleteId);
    return;
  }

  try {
    await applyPlanUpdate(
      planId,
      {
        fromDate,
        sessions: mapPlanWeeksToSessions(rewrite.weeks, remaining.firstWeekStart),
        settings: {
          referenceDistance: '5k',
          referenceTimeS: timeS,
          referenceUpdatedOn: testedOn,
          lastTestNote: note,
        },
      },
      athleteId,
    );
  } catch (error) {
    const reason = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
    console.error(
      `[plan/test] plan ${planId} : écriture du plan impossible — ${reason} ; ` +
        `chrono enregistré seul, la révision recalculera les semaines restantes.`,
    );
    await recordFitnessTest(planId, { note, reference }, athleteId);
    return;
  }

  console.log(
    `[plan/test] plan ${planId} : chrono de référence porté à 5 km en ${timeS} s ` +
      `(VDOT ${verdict.vdot.toFixed(1)}, +${verdict.gain.toFixed(1)}) et fin du plan réécrite.`,
  );

  await applyTestEffects(planId, athleteId);
}

/**
 * Les deux effets de bord d'un plan qui vient de changer, menés comme une tâche
 * de fond — mêmes raisons et mêmes gardes que `applyReviewEffects`
 * (`review-service.ts`), y compris l'attente de la synchronisation : le
 * déclencheur est le watcher FIT, qui tourne hors contexte de requête.
 */
async function applyTestEffects(planId: number, athleteId: number): Promise<void> {
  try {
    await reconcilePlanSessions(planId, athleteId);
  } catch (error) {
    console.error(`[plan/test] rapprochement des séances du plan ${planId} impossible :`, error);
  }

  try {
    await syncPlanToIntervalsSafely('test chronométré', athleteId);
  } catch (error) {
    console.error(`[plan/test] synchronisation du calendrier impossible :`, error);
  }
}
