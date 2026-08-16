/**
 * Monotonie et contrainte de Foster.
 *
 * Source : Foster C, « Monitoring training in athletes with reference to
 * overtraining syndrome », *Med Sci Sports Exerc* 30(7), 1998, 1164-1168 — et
 * Foster C et al., « Athletic performance in relation to training load »,
 * *Wisconsin Medical Journal* 95(6), 1996, 370-374, où la contrainte est
 * introduite. Deux grandeurs, calculées sur une semaine glissante :
 *
 * ```
 *   monotonie  = moyenne des charges quotidiennes / leur écart-type
 *   contrainte = charge totale de la semaine × monotonie
 * ```
 *
 * ## Ce que la monotonie mesure, et pourquoi les jours de repos comptent
 *
 * Ce n'est **pas** un volume : c'est l'uniformité d'une semaine. Deux semaines
 * de charge hebdomadaire strictement identique n'ont pas la même monotonie selon
 * qu'elles alternent dur / facile / repos ou qu'elles répètent sept fois la même
 * séance moyenne. La seconde est celle que Foster associe au surentraînement et
 * à la maladie — et c'est précisément celle que la métrique dénonce, en donnant
 * un écart-type faible donc un quotient élevé.
 *
 * Les jours de repos entrent donc dans la fenêtre **avec une charge de 0**, et
 * non écartés. Les écarter reviendrait à noter une semaine sur ses seuls jours
 * d'entraînement, c'est-à-dire à effacer exactement l'information cherchée : une
 * semaine de six jours durs et d'un jour de repos serait lue comme une semaine
 * de six jours durs, la plus monotone qui soit.
 *
 * La contrainte, elle, remet le volume dans l'équation : une semaine monotone
 * mais légère n'est pas une semaine monotone et lourde.
 *
 * ## Écart-type de population (÷ n), pas d'échantillon (÷ n−1)
 *
 * Foster décrit l'écart-type **des sept charges quotidiennes observées**. Ces
 * sept valeurs ne sont pas un échantillon tiré d'une population plus large dont
 * on estimerait la dispersion : elles *sont* la semaine, en entier. La
 * correction de Bessel n'a rien à corriger ici, et l'appliquer gonflerait
 * l'écart-type de √(7/6) ≈ 1,08, donc rabaisserait toute monotonie de 8 % —
 * assez pour déplacer une semaine sous le repère de lecture usuel. Le choix est
 * figé par un test dédié, qui compare la valeur rendue aux deux conventions.
 *
 * ## Aucun seuil ici
 *
 * « Au-dessus de 2, attention » est une **lecture**, pas un calcul : elle
 * appartient à la couche d'affichage, comme `readTsb` vit dans
 * `_lib/metric-tone.ts` et non dans `./load`. Ce module ne rend que des nombres.
 */

import { civilDaysBetween, isCivilDate, shiftCivilDate } from '@/lib/dates/civil';

import type { DailyTrimp } from './load';

/** Longueur de la fenêtre glissante : la semaine de Foster. */
const WINDOW_DAYS = 7;

export type MonotonyPoint = {
  date: string;
  /** Monotonie de Foster sur les 7 jours s'achevant à cette date. `null` quand elle n'a pas de sens. */
  monotony: number | null;
  /** Contrainte = charge de la semaine × monotonie. `null` si la monotonie l'est. */
  strain: number | null;
  /** Somme des TRIMP quotidiens de la fenêtre — utile à l'écran, et déjà calculée ici. */
  weeklyLoad: number;
};

/**
 * Série monotonie / contrainte, un point par jour civil.
 *
 * L'entrée est **densifiée** avant tout calcul, exactement comme dans
 * `computeLoadSeries` : elle peut arriver creuse ou non triée, et une fenêtre de
 * sept *entrées* au lieu de sept *jours* mesurerait l'uniformité d'un axe
 * temporel imaginaire. Plusieurs entrées d'une même date sont sommées (la charge
 * d'une journée est la somme de ses séances) ; une date qui n'existe pas au
 * calendrier est ignorée, faute de pouvoir être placée sur l'axe ; une charge non
 * finie ou négative compte pour 0, ce qui garantit que tout ce qui sort d'ici est
 * fini.
 *
 * Trois cas rendent `monotony` (et donc `strain`) à `null` — jamais l'infini,
 * jamais une valeur inventée :
 *
 *  - **fenêtre incomplète** : les six premiers points de la série n'ont pas sept
 *    jours d'historique derrière eux. Une monotonie sur quatre jours n'est pas
 *    une monotonie de Foster ;
 *  - **écart-type nul** : sept jours rigoureusement identiques. Le quotient
 *    diverge — la monotonie est mathématiquement infinie, physiologiquement
 *    indéfinie. C'est le cas, notamment, de sept jours à zéro : une semaine sans
 *    aucun entraînement n'est pas la semaine la plus monotone du monde, elle
 *    n'est pas une semaine d'entraînement du tout ;
 *  - par conséquence, `strain` suit `monotony`.
 *
 * `weeklyLoad` est toujours rendu, y compris sur une fenêtre incomplète où il
 * n'est alors que la somme des jours *disponibles*, mécaniquement sous-estimée
 * (comme le sont les premiers points de CTL/ATL, faute de valeur de warm-up).
 * L'écran qui l'affiche sait qu'il est partiel à ce que `monotony` vaut `null`.
 */
export function computeMonotonySeries(daily: readonly DailyTrimp[]): MonotonyPoint[] {
  const trimpByDate = new Map<string, number>();

  for (const entry of daily) {
    if (!isCivilDate(entry.date)) continue;

    const trimp = Number.isFinite(entry.trimp) && entry.trimp > 0 ? entry.trimp : 0;
    trimpByDate.set(entry.date, (trimpByDate.get(entry.date) ?? 0) + trimp);
  }

  if (trimpByDate.size === 0) return [];

  const dates = [...trimpByDate.keys()].sort();
  const firstDate = dates[0];
  const spanDays = civilDaysBetween(firstDate, dates[dates.length - 1]);

  const series: MonotonyPoint[] = [];
  // Fenêtre glissante des `WINDOW_DAYS` dernières charges quotidiennes, la plus
  // ancienne en tête. Densification et fenêtrage dans la même passe : chaque
  // jour civil est visité une fois et une seule.
  const windowLoads: number[] = [];

  for (let offset = 0; offset <= spanDays; offset += 1) {
    const date = shiftCivilDate(firstDate, offset);

    windowLoads.push(trimpByDate.get(date) ?? 0);
    if (windowLoads.length > WINDOW_DAYS) windowLoads.shift();

    const weeklyLoad = windowLoads.reduce((total, trimp) => total + trimp, 0);
    const monotony =
      windowLoads.length === WINDOW_DAYS ? monotonyOf(windowLoads, weeklyLoad) : null;

    series.push({
      date,
      monotony,
      strain: monotony === null ? null : weeklyLoad * monotony,
      weeklyLoad,
    });
  }

  return series;
}

/**
 * Monotonie d'une fenêtre pleine, ou `null` si son écart-type est nul.
 *
 * Variance calculée en **deux passes** (moyenne, puis somme des écarts au carré)
 * plutôt que par `E[x²] − E[x]²` : sur sept valeurs identiques, la seconde forme
 * soustrait deux grands nombres presque égaux et peut rendre un résidu minuscule
 * mais non nul — donc une monotonie de l'ordre de 10¹⁵ au lieu du `null` attendu.
 * La forme à deux passes rend exactement 0, et le test `=== 0` peut rester
 * exact : y mettre une tolérance reviendrait à inventer un seuil.
 */
function monotonyOf(loads: readonly number[], weeklyLoad: number): number | null {
  const mean = weeklyLoad / WINDOW_DAYS;

  let squaredDeviations = 0;
  for (const trimp of loads) {
    squaredDeviations += (trimp - mean) * (trimp - mean);
  }

  // Écart-type de population : les sept jours sont la semaine, pas un
  // échantillon d'une population plus large (cf. l'en-tête du module).
  const standardDeviation = Math.sqrt(squaredDeviations / WINDOW_DAYS);
  if (standardDeviation === 0) return null;

  return mean / standardDeviation;
}
