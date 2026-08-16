import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { REFERENCE_DISTANCES, predictedRaces, vdotFromRace } from '@/lib/metrics';
import type { RacePrediction } from '@/lib/metrics';

import { getCurrentAthleteId } from './athlete';
import { db } from './db/client';
import { plans, type PlanReferenceDistance } from './db/schema';

/**
 * Chronos prévus sur les distances de route — l'état courant de l'athlète, pas
 * une série.
 *
 * ## D'où vient le VDOT, et d'où il ne vient pas
 *
 * **Une seule source : le chrono de référence du plan actif**
 * (`plans.reference_distance` / `reference_time_s`), converti par `vdotFromRace`.
 * C'est une performance réellement courue, déclarée par l'athlète, et c'est déjà
 * elle qui fixe toutes les allures de son plan : prédire sur autre chose ferait
 * dire à cette page l'inverse de ce que dit la page du plan.
 *
 * **Le test chronométré n'est pas une seconde source, parce qu'il n'en est pas
 * une** : quand un test bat la référence, la recalibration proposée remplace le
 * chrono lui-même (`referenceDistance = '5k'`, cf. `lib/ai/fitness-test-service`)
 * une fois acceptée. Un test réussi *devient* donc le chrono lu ici, et rien
 * n'est persisté à part. Ce que le DAL expose du côté test — `getFitnessTestCandidate` —
 * demande un identifiant d'activité **et** un chrono de référence déjà en place :
 * c'est l'entrée du pipeline d'import, pas une lecture d'écran, et elle ne
 * pourrait de toute façon rien servir quand la référence manque.
 *
 * **La VO₂max effective n'est pas un VDOT.** Même échelle, même première
 * régression, objets différents : le VDOT suppose un effort maximal, la VO₂max
 * effective est corrigée par la fréquence cardiaque et Trainarr n'y applique pas
 * le facteur correctif de Runalyze, faute de courses déclarées — ses valeurs
 * « peuvent lire un peu haut » (`lib/metrics/vo2max.ts`). La prendre pour une
 * ancre présenterait une approximation comme une performance.
 *
 * ## Indépendant du filtre de période
 *
 * Comme `current.fitness` et `current.vo2max` de `./progression` : c'est un état
 * courant. Changer la fenêtre affichée ne change pas ce qu'on vaut sur 10 km, et
 * l'écran ne doit pas laisser croire le contraire.
 */

export type RaceAnchorDto = {
  distance: PlanReferenceDistance;
  distanceM: number;
  /** Le chrono déclaré, en secondes. */
  timeS: number;
  /** VDOT qu'implique ce chrono — non arrondi, l'affichage tranche. */
  vdot: number;
  /**
   * Date civile depuis laquelle la référence est en place : le jour du dernier
   * test **évalué** s'il y en a eu un, sinon le premier jour du plan, où le
   * chrono a été déclaré (c'est l'ancre que `plans.reference_updated_on`
   * documente).
   */
  since: string;
  /**
   * La date ci-dessus est celle d'un test chronométré.
   *
   * **Elle date le dernier test évalué, pas forcément le chrono affiché** : le
   * marqueur avance au dépôt de la proposition, qu'elle soit ensuite acceptée ou
   * refusée (cf. `lib/ai/fitness-test-service`). L'ancre réelle est donc au plus
   * vieille que cette date — jamais plus fraîche —, ce qui rend l'âge affiché
   * honnête tant qu'il est présenté comme celui du dernier test, et non comme
   * celui du chrono.
   */
  fromTest: boolean;
};

/**
 * Pourquoi aucun chrono prévu — non-`null` exactement quand `anchor` l'est et
 * qu'un athlète existe. Même contrat que `Vo2maxUnavailableDto` : l'athlète doit
 * lire **sa** cause, pas la liste des conditions possibles.
 */
export type RacePredictionUnavailableDto = {
  /** Aucun plan actif : il n'y a nulle part où déclarer un chrono. */
  noActivePlan: boolean;
};

export type RacePredictionsDto = {
  anchor: RaceAnchorDto | null;
  /** Les quatre distances de route, `[]` sans ancre. */
  races: RacePrediction[];
  unavailable: RacePredictionUnavailableDto | null;
};

/** Aucune session, aucun athlète : rien à prédire, et aucune cause à expliquer. */
const NOTHING: RacePredictionsDto = { anchor: null, races: [], unavailable: null };

export async function getRacePredictions(): Promise<RacePredictionsDto> {
  const athleteId = await getCurrentAthleteId();
  if (athleteId === null) return NOTHING;

  const rows = await db
    .select({
      startsOn: plans.startsOn,
      referenceDistance: plans.referenceDistance,
      referenceTimeS: plans.referenceTimeS,
      referenceUpdatedOn: plans.referenceUpdatedOn,
    })
    .from(plans)
    .where(and(eq(plans.athleteId, athleteId), eq(plans.status, 'active')))
    // Un index partiel rend la ligne unique pour `active` ; le tri garde
    // néanmoins la réponse déterministe, comme dans `./plans`.
    .orderBy(desc(plans.createdAt), desc(plans.id))
    .limit(1);

  const row = rows[0];
  if (!row) return { anchor: null, races: [], unavailable: { noActivePlan: true } };

  // Les deux champs vont ensemble ou pas du tout (invariant du DAL des plans) :
  // le second test ne fait que le prouver au compilateur.
  if (row.referenceDistance === null || row.referenceTimeS === null) {
    return { anchor: null, races: [], unavailable: { noActivePlan: false } };
  }

  const distanceM = REFERENCE_DISTANCES[row.referenceDistance];
  // `vdotFromRace` lève sur un chrono implausible — impossible ici : c'est la
  // même fonction qui garde l'écriture (`validateReferenceRace`), et un test
  // n'écrit qu'un chrono dont le VDOT a déjà été calculé.
  const vdot = vdotFromRace(distanceM, row.referenceTimeS);

  return {
    anchor: {
      distance: row.referenceDistance,
      distanceM,
      timeS: row.referenceTimeS,
      vdot,
      since: row.referenceUpdatedOn ?? row.startsOn,
      fromTest: row.referenceUpdatedOn !== null,
    },
    races: predictedRaces(vdot),
    unavailable: null,
  };
}
