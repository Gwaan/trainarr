/**
 * La **composition** d'une semaine : à kilométrage donné, quelle part revient
 * aux séances de qualité — et donc, par différence, aux footings et à la sortie
 * longue.
 *
 * ## Le constat qui a fait écrire ce module
 *
 * Mesuré sur le plan réel de l'utilisatrice — 16 semaines, 4 séances, budget
 * 4 h, endurance à 7:23/km. Le budget temps plafonne le volume à 30,8 km, et ce
 * plafond est atteint dès la semaine 3. Les cibles hebdomadaires se mettent
 * alors à tourner en rond : **26,1 · 28,1 · 30,3 · 30,8**, trois fois de suite
 * de la semaine 5 à la semaine 14. Comme la décomposition d'une cible ne
 * dépendait que de cette cible, les semaines de même volume recevaient des
 * séances identiques au dixième : `s5 ≡ s9`, `s6 ≡ s10`. Seize semaines de
 * préparation qui en valaient huit, jouées deux fois.
 *
 * La cause est structurelle et ne se corrige pas côté volumes : quand le budget
 * temps sature, le kilométrage **ne peut plus** progresser. Ce qui doit
 * progresser à sa place est la composition de la semaine.
 *
 * ## Pourquoi la part de qualité, et elle seule
 *
 * Le levier évident — faire monter la part de la sortie longue — a été mesuré
 * et **écarté** : il est inerte là où on en a besoin. À 4 séances avec 2
 * créneaux de qualité, `weeklySessionBudgets` calcule
 * `balanced = rest × 1,6 / (easyCount + 1,6) = 0,68 × 1,6 / 2,6 = 41,9 %`,
 * au-dessus de `longRunMaxShare(4) = 40 %` : la part effective est déjà collée
 * à son plafond réglementaire (39,1 à 39,9 % mesurés sur les semaines 5 à 14),
 * et le paramètre `longRunShare` ne franchit jamais le `max(…)` qui la relève.
 * Une rampe de sortie longue n'aurait rien fait bouger de ce plan-là.
 *
 * Reste la part de qualité. Elle a l'avantage d'agir dans le bon sens vis-à-vis
 * du budget temps : les allures de qualité sont plus rapides que l'endurance,
 * donc déplacer des kilomètres du facile vers la qualité **à kilométrage
 * constant** ne peut que réduire le temps total de la semaine.
 *
 * ## La forme de la rampe
 *
 * Linéaire en fonction du rang de la semaine dans la séquence
 * `build` + `specific` du **plan entier**, de {@link QUALITY_SHARE.ramp.from} à
 * {@link QUALITY_SHARE.ramp.to}. La base et l'affûtage restent hors rampe, à
 * {@link QUALITY_SHARE.outsideRamp}.
 *
 * Module **pur** : ni base, ni réseau, ni `server-only`, ni horloge, ni aléa.
 */

import { intentRampsQualityShare, type PlanIntent } from './intent';
import type { PlanPhase } from './phases';

/**
 * Les parts de qualité, en fraction du volume hebdomadaire — **par séance de
 * qualité**, enveloppe comprise.
 *
 * ## Pourquoi l'amplitude vaut 4 points et pas 2
 *
 * C'est la contrainte la plus facile à « simplifier » par erreur, alors voici
 * le chiffre. Les budgets de qualité sont arrondis au **demi-kilomètre**
 * (`halfKm`, dans `plan-schema.ts`) : sur une semaine de 28,1 km, un cran de
 * cette grille vaut `0,5 / 28,1 = 1,78 point` de part. Une rampe de 16 → 18 %
 * n'ouvre donc qu'**un seul** cran sur toute sa longueur, et il tombe au
 * mauvais endroit — mesuré sur le plan de l'utilisatrice, dont les semaines 5 et
 * 9 sont toutes deux en développement à 28,1 km :
 *
 *     rang 0 sur 10 → 16,00 % → 28,1 × 0,1600 = 4,496 km → halfKm → 4,5 km
 *     rang 4 sur 10 → 16,89 % → 28,1 × 0,1689 = 4,746 km → halfKm → 4,5 km
 *
 * Les deux semaines retombent sur le même budget, et `s5 ≡ s9` survit. Avec
 * 15 → 19 %, les mêmes rangs donnent 4,215 km (→ 4,0) et 4,777 km (→ 5,0) : les
 * deux semaines se séparent. Sous 4 points d'amplitude, ce module ne sert à
 * rien ; c'est la grille d'arrondi qui commande, pas l'esthétique de la rampe.
 *
 * ## Pourquoi ces bornes-là
 *
 * 15 à 19 % encadre les 16 % historiques et reste dans la fourchette 15-18 %
 * dont ils étaient le milieu, à un point près en fin de spécificité — où une
 * séance de qualité un peu plus fournie est précisément ce qu'on veut.
 */
export const QUALITY_SHARE = {
  /**
   * Hors rampe : la base et l'affûtage.
   *
   * La base parce que la qualité y est neuve et courte — des répétitions, pas
   * du travail long —, l'affûtage parce qu'il réduit déjà le volume par ses
   * propres facteurs et qu'une part qui monterait irait à contre-emploi.
   * 14 % : un cran sous le bas de la rampe, sans double réduction.
   */
  outsideRamp: 0.14,
  /** Les bornes de la rampe, de la première à la dernière semaine de développement. */
  ramp: { from: 0.15, to: 0.19 },
} as const;

/**
 * Où la fenêtre construite se situe dans la séquence de développement du **plan
 * entier** — l'ancrage sans lequel la rampe se recalerait à chaque
 * reconstruction.
 *
 * ## Le piège qu'il évite
 *
 * `buildPlanSkeleton` sert aussi aux reconstructions (`rewriteRemainingPlan`),
 * où les semaines sont renumérotées depuis 1 et où le tableau des phases est
 * **tranché** : une fenêtre ouvrant en milieu de spécificité voit
 * `['specific', 'specific', 'taper', 'race']`. Une rampe calée sur la position
 * dans la fenêtre remettrait la composition au bas de sa progression à chaque
 * réadaptation — et comme la révision se déclenche toutes les quatre séances,
 * la préparation n'avancerait jamais. C'est exactement la famille de défauts
 * corrigée sur la cadence des semaines allégées, l'affûtage et le cliquet :
 * une arithmétique de fenêtre là où il fallait celle du plan.
 */
export type CompositionAnchor = {
  /**
   * Le nombre de semaines `build` + `specific` du **plan entier** — la longueur
   * totale de la rampe, que la fenêtre ne connaît pas d'elle-même.
   */
  planDevelopmentWeeks: number;
  /**
   * Combien de ces semaines la fenêtre **ne porte pas**.
   *
   * Ce n'est pas tout à fait « celles qui la précèdent », et la nuance compte :
   * `remainingComposition` ramène la première semaine d'une fenêtre entamée à
   * `partial`, ce qui lui retire son rang de développement sans la sortir du
   * plan. La formule qui tombe juste dans les deux cas est donc une
   * soustraction — `planDevelopmentWeeks` moins les semaines de développement
   * réellement présentes dans la fenêtre —, et c'est celle que
   * `rewriteRemainingPlan` applique.
   */
  completedDevelopmentWeeks: number;
};

/** Les deux phases que la rampe traverse — ni la base, ni l'affûtage, ni la course. */
export function isDevelopmentPhase(phase: PlanPhase): boolean {
  return phase === 'build' || phase === 'specific';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * La part de qualité d'une semaine de développement de rang `rank` dans une
 * séquence qui en compte `total`.
 *
 * Le rang 0 reçoit le bas de la rampe, le rang `total − 1` son haut. Une
 * séquence d'une seule semaine reçoit le **milieu** : elle n'est ni un début ni
 * une fin de progression, et le milieu est la seule réponse qui ne soit pas
 * arbitraire — c'est aussi la plus proche des 16 % historiques.
 *
 * Le `clamp` n'est pas décoratif : l'ancrage vient de l'appelant, et un plan
 * dont la durée enregistrée aurait divergé de sa fenêtre pousserait le rang
 * hors de la séquence — donc la part hors de ses bornes, et de là le minimum
 * finançable hors de ce que la décomposition fait réellement.
 */
function rampShare(rank: number, total: number): number {
  const progress = total <= 1 ? 0.5 : clamp(rank / (total - 1), 0, 1);
  return QUALITY_SHARE.ramp.from + (QUALITY_SHARE.ramp.to - QUALITY_SHARE.ramp.from) * progress;
}

/**
 * La part de qualité de chaque semaine de la fenêtre, dans l'ordre.
 *
 * Les semaines `partial` et `race` en reçoivent une elles aussi, et elle ne
 * sert jamais : ces deux phases n'ouvrent aucun créneau de qualité
 * (`qualityZones` rend une liste vide), et `weeklySessionBudgets` multiplie la
 * part par un compte de créneaux nul.
 *
 * ## Les intentions qui ne rampent pas
 *
 * `weight_loss` reçoit {@link QUALITY_SHARE.outsideRamp} sur **toutes** ses
 * semaines, et c'est une décision de fond plutôt qu'un réglage : la rampe déplace
 * des kilomètres du facile vers la qualité au fil du plan, or c'est le volume
 * facile qui est l'actif à protéger quand le levier est la dépense (cf.
 * `intent.ts`). `return` ne rampe pas non plus, faute d'ouvrir le moindre créneau
 * — une part qui croîtrait sans rien multiplier raconterait une progression qui
 * n'a pas lieu.
 *
 * @param intent ce que l'athlète vient chercher — seules `race` et `faster`
 * font croître la part de qualité ({@link intentRampsQualityShare}).
 * @param phases une phase par semaine de la fenêtre, dans l'ordre.
 * @param anchor la position de la fenêtre dans le plan entier. **Absent = la
 * fenêtre EST le plan**, ce qui est le cas nominal d'une création : la rampe se
 * mesure alors sur la fenêtre elle-même, et rend exactement ce qu'une
 * reconstruction rendra pour les mêmes semaines calendaires.
 */
export function weeklyQualityShares(
  intent: PlanIntent,
  phases: readonly PlanPhase[],
  anchor?: CompositionAnchor,
): number[] {
  if (!intentRampsQualityShare(intent)) return phases.map(() => QUALITY_SHARE.outsideRamp);

  const total = anchor?.planDevelopmentWeeks ?? phases.filter(isDevelopmentPhase).length;
  const completed = anchor?.completedDevelopmentWeeks ?? 0;

  let seen = 0;
  return phases.map((phase) => {
    if (!isDevelopmentPhase(phase)) return QUALITY_SHARE.outsideRamp;
    const share = rampShare(completed + seen, total);
    seen += 1;
    return share;
  });
}
