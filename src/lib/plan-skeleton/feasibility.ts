/**
 * Ce qu'un volume hebdomadaire **ne peut pas financer** — et pourquoi le
 * squelette refuse d'écrire une semaine plutôt que de l'approximer.
 *
 * ## Le constat
 *
 * {@link weeklySessionBudgets} répartit une cible entre les séances de la
 * semaine, mais aucune séance ne descend sous
 * `PLAN_OUTPUT_BOUNDS.distanceKm.min` (0,5 km) : c'est un plancher du contrat de
 * sortie, pas un réglage. Quand la cible est trop basse pour payer ce plancher
 * sur toutes les séances demandées, la décomposition **remonte** les footings et
 * sa somme dépasse la cible. Le squelette écrit alors une semaine que
 * `validatePlanBusinessRules` refuse — et il n'y a plus personne en aval pour la
 * corriger, puisque c'est l'appli qui l'a écrite.
 *
 * Mesuré par une revue par exécution, sur 1 179 360 combinaisons légales du
 * formulaire : **12 596 semaines invalides (1,07 %)**, en deux classes.
 *
 * - **Cible ±10 %.** Athlète débutante, meilleure semaine récente 3 km, aucun
 *   budget temps, 6 séances, marathon dans 8 semaines : semaine 8, cible 2,9 km,
 *   écrit 3,5 km (+20,7 %) — `weeklySessionBudgets(2.9, 6, 1)` rend
 *   `[long 1 · quality 0,5 · easy 0,5 ×4]`.
 * - **Semaine allégée.** La semaine de respiration, remontée par le plancher,
 *   cesse d'être allégée, et c'est la règle « pas quatre semaines de suite sans
 *   allégée » qui casse.
 *
 * ## Pourquoi refuser, et pas rattraper
 *
 * Deux rattrapages ont été essayés et écartés, chacun par ce qu'il casse :
 *
 * - **écrire moins de séances** cette semaine-là : `validatePlanBusinessRules`
 *   en exige **exactement** `sessionsPerWeek` sur une semaine pleine, la
 *   violation change simplement de nom ;
 * - **remonter la cible** au minimum finançable : quand le plancher domine,
 *   toutes les semaines s'écrasent sur la même valeur, et la progression comme
 *   la semaine allégée deviennent arithmétiquement impossibles.
 *
 * Il reste ce que dit `CLAUDE.md` : *si un calcul manque de données, le dire*.
 * Un athlète à 3 km par semaine qui demande 6 séances demande 500 m par séance —
 * ce n'est pas un plan d'entraînement, c'est une configuration infaisable, et
 * c'est cela qu'il faut lui répondre.
 *
 * Module **pur** : ni base, ni réseau, ni horloge, ni aléa.
 */

import { formatNumber } from '@/lib/ai/format';
import { PLAN_OUTPUT_BOUNDS, weeklySessionBudgets } from '@/lib/ai/plan-schema';

/**
 * La cible à laquelle on **mesure** les parts que {@link weeklySessionBudgets}
 * donne à chaque rôle, en km.
 *
 * Ces parts sont des constantes de `plan-schema` (part de la sortie longue, part
 * d'une séance de qualité) que ce module n'a pas le droit d'importer — elles y
 * sont privées, et les recopier ici les ferait diverger au premier réglage. On
 * les **observe** donc sur la fonction elle-même, à une cible assez grande pour
 * que les arrondis au demi-kilomètre n'y pèsent plus rien : à 1 000 km, l'erreur
 * relative sur une part vaut au plus 0,025 %.
 */
const SHARE_PROBE_KM = 1_000;

/**
 * Ce qu'un arrondi `halfKm` peut ajouter à une séance, en km.
 *
 * `Math.round(x × 2) / 2` remonte au plus d'un quart de kilomètre. Les deux
 * autres arrondis de la décomposition (les bornes de la sortie longue, au
 * dixième) remontent d'au plus 0,1 km : ce quart les majore tous.
 */
const HALF_KM_ROUNDING_KM = 0.25;

/**
 * Ce que le partage des footings peut éroder de leur part idéale, en km.
 *
 * Les footings sont servis en dernier, l'un après l'autre, chacun arrondi au
 * dixième — un arrondi qui peut remonter de 0,05 km et laisser d'autant moins au
 * suivant. Après `i` footings servis, la part de ceux qui restent a donc baissé
 * d'au plus `0,05 / (e − i − 1)` ; sommé, cela fait `0,05 × H(e−1)`, la série
 * harmonique. Un footing tombe sous le plancher quand sa part passe sous 0,5 km,
 * d'où la marge ci-dessous.
 */
function easyShareFloorKm(easyCount: number): number {
  let harmonic = 0;
  for (let index = 1; index <= easyCount - 1; index += 1) harmonic += 1 / index;
  return PLAN_OUTPUT_BOUNDS.distanceKm.min + 0.05 * harmonic;
}

/**
 * Marge de sécurité au-delà de la cible à partir de laquelle plus aucune semaine
 * ne peut échouer, en km — le balayage va jusque-là.
 *
 * La borne est démontrée (cf. {@link minFundableWeeklyKm}) ; ces cinq kilomètres
 * ne couvrent que l'imprécision de la mesure des parts ({@link SHARE_PROBE_KM}),
 * et coûtent cinquante évaluations d'une fonction pure et mémoïsée.
 */
const SWEEP_MARGIN_KM = 5;

/**
 * Le résultat de {@link minFundableWeeklyKm}, par `séances/créneaux/part`.
 *
 * **La part de qualité fait partie de la clé**, depuis que le squelette la fait
 * varier d'une semaine à l'autre ({@link weeklyQualityShares}) : elle change la
 * décomposition, donc le minimum. L'omettre rendrait le minimum de la première
 * semaine calculée pour toutes les suivantes — un refus (ou une acceptation) au
 * mauvais seuil, silencieusement.
 *
 * La clé n'est pas quantifiée : deux parts distinctes de 1e-9 doivent donner
 * deux entrées distinctes, sans quoi le minimum cesserait de coïncider
 * exactement avec {@link weeklySessionBudgets} — ce que le balayage de
 * `feasibility.test.ts` exige. Le nombre d'entrées reste borné par les valeurs
 * que la rampe peut prendre (une par rang de développement et par longueur de
 * plan), et chacune coûte une centaine d'évaluations d'une fonction pure.
 */
const minimumCache = new Map<string, number>();

/**
 * Une décomposition finance-t-elle vraiment sa cible ?
 *
 * Deux exigences, et la première est plus dure que la bande de ±10 % de
 * `validatePlanBusinessRules` :
 *
 * - **la somme tombe exactement sur la cible.** Tant qu'aucun plancher ne
 *   mord, la somme des budgets *est* la cible (les footings absorbent le
 *   reliquat au dixième) ; dès qu'un plancher mord, elle la dépasse. Exiger
 *   l'égalité, c'est donc exiger qu'aucun plancher n'ait mordu — et c'est ce qui
 *   rend la semaine valide **par construction** : elle vaut sa cible, et les
 *   cibles satisfont les règles de volume par construction elles aussi.
 *
 *   Se contenter de la bande ne suffit pas, et c'est mesuré : un minimum calé
 *   sur ±10 % laisse passer 945 plans invalides sur 444 528 combinaisons
 *   balayées — des semaines dans la bande, mais assez remontées pour que la
 *   semaine allégée cesse d'alléger. L'égalité exacte, elle, en laisse **zéro**.
 * - **aucune séance sous le plancher du contrat** (0,5 km) : une séance de
 *   0,4 km serait refusée par Zod avant même d'atteindre les règles métier.
 */
function financesTarget(
  targetKm: number,
  sessionCount: number,
  qualitySlotCount: number,
  qualityShare: number,
): boolean {
  // `undefined` sur la part de sortie longue : c'est le défaut de la
  // décomposition qu'on interroge, et le recopier ici le ferait diverger.
  const budgets = weeklySessionBudgets(
    targetKm,
    sessionCount,
    qualitySlotCount,
    undefined,
    qualityShare,
  );
  if (budgets.length === 0) return false;

  let sum = 0;
  for (const budget of budgets) {
    if (budget.km < PLAN_OUTPUT_BOUNDS.distanceKm.min - 1e-9) return false;
    sum += budget.km;
  }
  return Math.abs(sum - targetKm) < 1e-9;
}

/**
 * Le **volume hebdomadaire minimal finançable**, en km : la plus petite cible à
 * partir de laquelle {@link weeklySessionBudgets} retombe exactement dessus,
 * pour ce nombre de séances et de créneaux de qualité. En dessous, la semaine
 * est infaisable et le squelette refuse de l'écrire
 * ({@link PlanSkeletonInfeasibleError}).
 *
 * ## Pourquoi un balayage et pas une formule
 *
 * Parce que la décomposition n'est pas monotone : à 2 séances, une cible de
 * 1,0 km tombe juste (sortie longue 0,5 + footing 0,5) quand 1,3 km échoue (la
 * sortie longue s'arrondit à 1,0, il ne reste que 0,3 pour un footing qui ne
 * descend pas sous 0,5). Aucune inégalité en forme close ne décrit la
 * composition de deux arrondis (`halfKm`, `tenthKm`) et de deux bornes ; toute
 * formule qu'on écrirait ici serait une seconde implémentation de
 * `weeklySessionBudgets`, à maintenir en parallèle. On interroge donc la
 * fonction elle-même — ce qui a aussi l'avantage de suivre ses réglages sans
 * qu'on y pense.
 *
 * ## Pourquoi le balayage se termine
 *
 * Au-delà d'une cible calculable, plus aucune semaine ne peut échouer. Soit `c`
 * la part que la sortie longue et les créneaux prennent au total (mesurée sur la
 * fonction, cf. {@link SHARE_PROBE_KM}) et `d = 1 − c` celle qui reste aux
 * footings :
 *
 * - ce qui reste aux `e` footings vaut au moins `T × d − 0,25 × (1 + créneaux)`,
 *   les arrondis compris ({@link HALF_KM_ROUNDING_KM}) ;
 * - aucun footing ne tombe sous son plancher tant que cette part dépasse
 *   `e × ({@link easyShareFloorKm})`.
 *
 * D'où la borne `T ≥ (e × plancherFooting + 0,25 × (1 + créneaux)) / d`, au-delà
 * de laquelle la somme retombe exactement sur la cible. Le balayage la dépasse
 * de {@link SWEEP_MARGIN_KM}, par prudence sur la mesure des parts.
 *
 * Quand `d ≤ 0` — assez de créneaux de qualité pour que la sortie longue et eux
 * mangent tout le volume —, **aucune** cible n'est finançable : la fonction rend
 * `Infinity`, et toute semaine est donc refusée.
 *
 * Le pas du balayage est le dixième de kilomètre, la précision exacte des cibles
 * ({@link weeklyVolumeTargets} arrondit au dixième inférieur) : aucune cible ne
 * tombe entre deux points du balayage.
 *
 * @param sessionCount le nombre de séances de la semaine, sortie longue
 * comprise. Zéro séance ne finance rien : `Infinity`.
 * @param qualitySlotCount le nombre de créneaux de qualité, tel que
 * {@link weeklySessionBudgets} le bornera lui-même à `sessionCount − 2`.
 * @param qualityShare la part que prendra **chaque** créneau de qualité de
 * cette semaine-là. Paramètre **obligatoire**, et c'est délibéré : depuis que
 * le squelette la fait varier d'une semaine à l'autre, un défaut ici
 * rétablirait en silence le défaut qu'on corrige — un minimum calculé sur une
 * part que la semaine n'utilise pas. C'est l'appelant qui sait, et il doit le
 * dire.
 */
export function minFundableWeeklyKm(
  sessionCount: number,
  qualitySlotCount: number,
  qualityShare: number,
): number {
  if (sessionCount <= 0) return Number.POSITIVE_INFINITY;

  // Une séance unique EST la sortie longue : elle prend toute la cible, il n'y a
  // rien à répartir et donc aucun plancher à faire mordre. Seul le plancher du
  // contrat de sortie s'applique encore.
  if (sessionCount === 1) return PLAN_OUTPUT_BOUNDS.distanceKm.min;

  const quality = Math.min(Math.max(0, Math.trunc(qualitySlotCount)), sessionCount - 2);
  // Sans créneau, la part de qualité ne pèse sur rien : la faire entrer dans la
  // clé multiplierait les entrées sans changer un seul résultat.
  const key = `${sessionCount}/${quality}/${quality === 0 ? 0 : qualityShare}`;
  const cached = minimumCache.get(key);
  if (cached !== undefined) return cached;

  const probe = weeklySessionBudgets(
    SHARE_PROBE_KM,
    sessionCount,
    quality,
    undefined,
    qualityShare,
  );
  const easyCount = probe.filter((budget) => budget.role === 'easy').length;
  const easyShare =
    probe
      .filter((budget) => budget.role === 'easy')
      .reduce((total, budget) => total + budget.km, 0) / SHARE_PROBE_KM;

  if (easyShare <= 0) {
    minimumCache.set(key, Number.POSITIVE_INFINITY);
    return Number.POSITIVE_INFINITY;
  }

  const sweepToKm =
    (easyCount * easyShareFloorKm(easyCount) + HALF_KM_ROUNDING_KM * (1 + quality)) / easyShare +
    SWEEP_MARGIN_KM;

  // Le dernier échec, pas le premier succès : la décomposition n'est pas
  // monotone, et s'arrêter au premier succès rendrait un minimum sous lequel
  // d'autres cibles échouent encore.
  let lastFailingTenths = 0;
  for (let tenths = 1; tenths <= Math.ceil(sweepToKm * 10); tenths += 1) {
    if (!financesTarget(tenths / 10, sessionCount, quality, qualityShare)) lastFailingTenths = tenths;
  }

  const minimum = (lastFailingTenths + 1) / 10;
  minimumCache.set(key, minimum);
  return minimum;
}

/** Une semaine que sa cible ne finance pas, et de quoi le dire à l'athlète. */
export type PlanSkeletonUnderfundedWeek = {
  /** Numéro 1-based dans la numérotation du plan entier. */
  weekNumber: number;
  /** La cible calculée pour cette semaine, en km. */
  targetKm: number;
  /** Le minimum qu'il aurait fallu pour la financer, en km. */
  minimumKm: number;
  /** Les séances que la semaine aurait portées — une semaine entamée en porte moins. */
  sessionCount: number;
  /** Les créneaux de qualité qu'elle aurait portés. */
  qualitySlotCount: number;
};

/**
 * Le squelette refuse d'écrire ce plan : au moins une semaine vise un volume que
 * le nombre de séances demandé ne peut pas financer.
 *
 * Levée par `buildPlanSkeleton` **avant d'écrire quoi que ce soit** — un plan à
 * moitié écrit n'aiderait personne. Elle porte de quoi construire un message
 * d'UI actionnable, et c'est l'appelant qui l'écrit : les semaines fautives avec
 * leur cible et leur minimum, le nombre de séances demandé, et celui qui
 * tiendrait à ce volume ({@link fundableSessionsPerWeek}) — la seule chose que
 * l'athlète puisse changer, avec son volume.
 *
 * Le `message` reste factuel et français : il part dans les journaux, pas dans
 * l'écran.
 */
export class PlanSkeletonInfeasibleError extends Error {
  override readonly name = 'PlanSkeletonInfeasibleError';

  /** Les semaines fautives, dans l'ordre du plan — jamais vide. */
  readonly weeks: readonly PlanSkeletonUnderfundedWeek[];

  /** Le nombre de séances par semaine que l'athlète a réglé. */
  readonly requestedSessionsPerWeek: number;

  /**
   * Le plus grand nombre de séances par semaine que **toutes** les semaines du
   * plan financeraient — `0` quand même une seule séance par semaine ne tient
   * pas, c'est-à-dire quand c'est le volume lui-même qui est irréaliste.
   */
  readonly fundableSessionsPerWeek: number;

  constructor(params: {
    weeks: readonly PlanSkeletonUnderfundedWeek[];
    requestedSessionsPerWeek: number;
    fundableSessionsPerWeek: number;
  }) {
    super(infeasibleMessage(params));
    this.weeks = params.weeks;
    this.requestedSessionsPerWeek = params.requestedSessionsPerWeek;
    this.fundableSessionsPerWeek = params.fundableSessionsPerWeek;
  }
}

/** `Semaines 6, 8 : …` — le pluriel se décide sur le compte, comme partout ailleurs. */
function infeasibleMessage(params: {
  weeks: readonly PlanSkeletonUnderfundedWeek[];
  requestedSessionsPerWeek: number;
  fundableSessionsPerWeek: number;
}): string {
  const { weeks, requestedSessionsPerWeek, fundableSessionsPerWeek } = params;
  const numbers = weeks.map((week) => week.weekNumber);
  const where = numbers.length === 1 ? `Semaine ${numbers[0]}` : `Semaines ${numbers.join(', ')}`;
  // La semaine la plus pauvre porte le chiffre : c'est elle qui contraint tout
  // le plan, et une liste de cibles ne dirait rien de plus.
  const worst = weeks.reduce((lowest, week) => (week.targetKm < lowest.targetKm ? week : lowest));
  const fallback =
    fundableSessionsPerWeek === 0
      ? `Aucun nombre de séances ne tient à ce volume.`
      : `À ce volume, ${fundableSessionsPerWeek} séance${fundableSessionsPerWeek > 1 ? 's' : ''} par semaine au plus.`;

  return (
    `${where} : une cible de ${formatNumber(worst.targetKm, 1)} km ne finance pas ` +
    `${requestedSessionsPerWeek} séances par semaine — il en faudrait au moins ` +
    `${formatNumber(worst.minimumKm, 1)} km, chaque séance ne pouvant descendre sous ` +
    `${formatNumber(PLAN_OUTPUT_BOUNDS.distanceKm.min, 1)} km. ${fallback}`
  );
}
