/**
 * Le **plafond de la sortie longue**, et ce à quoi il renonce.
 *
 * ## Ce que le plafond protège
 *
 * Deux besoins distincts, une seule mécanique.
 *
 * 1. **Le pic d'une séance isolée**, sur une reprise. Frandsen 2025 (5 205
 *    coureurs) est le seul travail récent qui associe empiriquement un paramètre
 *    de charge au risque, et ce paramètre est le **pic d'une séance**, pas la
 *    charge hebdomadaire ni un ratio aigu/chronique. L'appelant en tire un
 *    plafond — la plus longue séance des trente derniers jours, majorée de 10 % —
 *    et le passe au squelette ; la sortie longue de la première semaine ne le
 *    dépasse pas, et les suivantes ne montent que de 10 % l'une après l'autre.
 * 2. **La part de la sortie longue** sous certaines intentions : 30 % du volume
 *    hebdomadaire pour une reprise au lieu des 40 % que la règle générale
 *    autorise (cf. `intent.ts`).
 *
 * ## Pourquoi le plafond passe par ici, et pas par `weeklySessionBudgets`
 *
 * Parce que le paramètre `longRunShare` de la décomposition est un **plancher
 * déguisé**, pas un plafond : la décomposition en prend le `max` avec la part
 * « équilibrée » qui garde la sortie longue plus longue que le plus gros footing
 * (`balanced = 1,6 / (footings + 1,6)`). Mesuré : à 4 séances sans qualité,
 * `balanced` vaut 34,8 % et lui passer 30 % ne change strictement rien. Un
 * plafond doit donc s'appliquer **après** la décomposition, en redonnant aux
 * footings ce que la sortie longue rend.
 *
 * ## Ce à quoi le plafond renonce, et pourquoi il le fait en silence
 *
 * La redistribution ne s'applique **que si elle laisse la semaine valide**. Trois
 * invariants la bornent, et aucun n'est négociable :
 *
 * - la sortie longue reste la **séance la plus longue** de sa semaine
 *   (`validatePlanBusinessRules` la refuse sinon, et le refus sort en incohérence
 *   interne puisque c'est l'appli qui a écrit la semaine) ;
 * - elle reste dans sa **part réglementaire** (au moins 20 % du volume) ;
 * - aucune séance ne sort des **bornes du contrat** (0,5 à 80 km).
 *
 * Quand l'un d'eux céderait, la semaine reste telle quelle : **le plafond cède,
 * jamais les invariants**. Concrètement, à 2 ou 3 séances par semaine la sortie
 * longue pèse structurellement 44 à 62 % du volume — la ramener à 30 % ferait des
 * footings plus longs qu'elle —, et le plafond y est donc inerte. C'est le bon
 * arbitrage : une semaine à deux séances n'a pas de problème de pic, elle a un
 * problème de fréquence, et ce n'est pas ce module qui le règle.
 *
 * Module **pur** : ni base, ni réseau, ni horloge, ni aléa.
 */

import type { SessionBudget } from '@/lib/ai/format';
import { PLAN_OUTPUT_BOUNDS, VOLUME_RULES } from '@/lib/ai/plan-schema';

/**
 * De combien une sortie longue peut dépasser le **pic déjà couru** dans ce plan.
 *
 * 10 %, le même geste que le plafond de départ : ce qui vaut pour le premier pic
 * vaut pour les suivants, et une sortie longue qui grimpe de 10 % par semaine
 * double en huit semaines — c'est déjà plus rapide que le volume hebdomadaire, à
 * qui la règle générale n'accorde que 12 % (`VOLUME_RULES.maxWeeklyGrowth`).
 */
const LONG_RUN_WEEKLY_GROWTH = 1.1;

/** Un kilométrage en dixièmes de kilomètre, la précision exacte des budgets. */
function tenths(km: number): number {
  return Math.round(km * 10);
}

/**
 * Ce qu'une semaine s'autorise comme sortie longue, en km — **du plus serré au
 * plus large**, et vide quand rien ne la plafonne.
 *
 * ## Pourquoi une liste, et pas un minimum
 *
 * Parce que les deux plafonds ne se valent pas devant l'échec. Mesuré sur une
 * reprise à 4 séances dont l'appelant plafonne la sortie longue à 6 km quand la
 * semaine en vise 35 : le plafond de 6 km est **inapplicable** (les footings
 * deviendraient deux fois plus longs que la sortie longue), et prendre le minimum
 * des deux faisait renoncer aux deux — la semaine ressortait avec une sortie
 * longue à 12,5 km, soit **plus** que si l'intention avait plafonné seule, à
 * 10,6 km. Un plafond de plus ne doit jamais relever une sortie longue.
 *
 * Les candidats se tentent donc l'un après l'autre, du plus serré au plus large,
 * et le premier qui tient l'emporte. Le plafond cède un cran à la fois, jamais
 * d'un bloc.
 *
 * ## Pourquoi le **pic écrit**, et pas la sortie longue de la semaine d'avant
 *
 * Parce qu'un plan respire : une semaine allégée fait descendre la sortie longue,
 * et celle d'après remonte au niveau d'avant. Mesuré sur un plan de 16 semaines
 * plafonné à 6 km — un plafond que la première semaine ne peut de toute façon pas
 * tenir : chaîné sur la semaine précédente, le plafond rabotait la semaine 5
 * (14,8 → 14,3 km) et la semaine 6 (16,0 → 15,7 km) **alors que l'athlète avait
 * déjà couru 15,5 km en semaine 3**. Le rebond d'après une semaine allégée n'est
 * pas un nouveau pic ; le chaîner sur le pic réellement écrit le laisse passer, et
 * ne plafonne que ce qui monte vraiment plus haut qu'avant.
 *
 * @param capKm le plafond de l'appelant (la plus longue séance récente, majorée),
 * `null` quand il n'en a pas.
 * @param peakLongRunKm la plus longue sortie longue **effectivement écrite**
 * depuis le début du plan, `null` avant la première. C'est bien la valeur écrite
 * et non le budget brut : chaîner sur le budget laisserait la semaine 2 défaire le
 * plafond de la semaine 1.
 * @param shareCapKm ce que la part maximale de l'intention laisse à la sortie
 * longue, `null` quand l'intention n'en impose pas.
 */
export function longRunCapCandidatesKm(
  capKm: number | null,
  peakLongRunKm: number | null,
  shareCapKm: number | null,
): number[] {
  const candidates: number[] = [];

  if (capKm !== null) {
    // La première sortie longue ne dépasse pas le plafond de l'appelant ; les
    // suivantes montent de 10 % au plus au-dessus du pic déjà couru.
    candidates.push(
      peakLongRunKm === null ? capKm : Math.max(capKm, peakLongRunKm * LONG_RUN_WEEKLY_GROWTH),
    );
  }
  if (shareCapKm !== null) candidates.push(shareCapKm);

  return candidates.sort((left, right) => left - right);
}

/**
 * Les budgets de la semaine, sortie longue ramenée sous son plafond et l'excédent
 * reversé aux footings — `null` quand la redistribution casserait un invariant
 * (cf. l'en-tête), à charge de l'appelant d'essayer un plafond plus large ou de
 * laisser la semaine telle quelle.
 *
 * La somme ne bouge jamais : ce qui est retiré à la sortie longue est donné aux
 * footings, au dixième de kilomètre près, sans quoi la semaine sortirait de sa
 * cible — et une cible manquée est une violation de plus, pas un plafond de moins.
 *
 * @param targetKm la cible de la semaine, sur laquelle se mesure la part de la
 * sortie longue. C'est exactement la somme des budgets : le squelette a refusé
 * les semaines où ce n'était pas le cas (`feasibility.ts`).
 */
export function cappedLongRunBudgets(
  budgets: readonly SessionBudget[],
  allowedKm: number,
  targetKm: number,
): SessionBudget[] | null {
  const long = budgets.find((budget) => budget.role === 'long');
  const easyCount = budgets.filter((budget) => budget.role === 'easy').length;
  // Sans footing où reverser l'excédent, il n'y a rien à faire : une semaine à
  // deux séances n'a pas de problème de pic, elle a un problème de fréquence.
  if (long === undefined || easyCount === 0) return null;

  // Le plafond s'arrondit **vers le bas** : un plafond arrondi au dixième
  // supérieur serait un plafond dépassé.
  const allowedTenths = Math.floor(allowedKm * 10 + 1e-9);
  const excessTenths = tenths(long.km) - allowedTenths;
  // Déjà sous son plafond : la semaine passe telle quelle, et c'est un succès.
  if (excessTenths <= 0) return [...budgets];

  const longKm = allowedTenths / 10;
  // L'excédent se partage également entre les footings, les premiers servis
  // absorbant le reliquat de la division : ils restent au plus à un dixième les
  // uns des autres, ce qui est déjà l'écart que la décomposition leur laisse.
  const perEasy = Math.floor(excessTenths / easyCount);
  const remainder = excessTenths % easyCount;

  let easyIndex = 0;
  const capped = budgets.map((budget) => {
    if (budget.role === 'long') return { role: budget.role, km: longKm };
    if (budget.role !== 'easy') return budget;
    const extra = perEasy + (easyIndex < remainder ? 1 : 0);
    easyIndex += 1;
    return { role: budget.role, km: (tenths(budget.km) + extra) / 10 };
  });

  return breaksInvariants(capped, longKm, targetKm) ? null : capped;
}

/**
 * La semaine plafonnée casse-t-elle une des trois règles que le squelette doit
 * satisfaire par construction ?
 *
 * C'est la seule garde de ce module, et elle est volontairement conservatrice :
 * au moindre doute, la semaine d'origine repart telle quelle.
 */
function breaksInvariants(
  budgets: readonly SessionBudget[],
  longKm: number,
  targetKm: number,
): boolean {
  if (longKm < PLAN_OUTPUT_BOUNDS.distanceKm.min) return true;
  // La part réglementaire de la sortie longue : la borne basse est la seule qui
  // puisse être franchie par le bas en la raccourcissant.
  if (longKm < targetKm * VOLUME_RULES.longRunShare.min) return true;

  for (const budget of budgets) {
    if (budget.role === 'long') continue;
    // La sortie longue reste la séance la plus longue de la semaine — l'égalité
    // suffit, la validation accepte plusieurs maxima.
    if (budget.km > longKm) return true;
    if (budget.km > PLAN_OUTPUT_BOUNDS.distanceKm.max) return true;
  }

  return false;
}
