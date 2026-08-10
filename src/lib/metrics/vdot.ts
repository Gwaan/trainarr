/**
 * VDOT — VO2max « effectif » déduit d'une performance de course.
 *
 * Source : Daniels J & Gilbert J, *Oxygen Power: Performance Tables for
 * Distance Runners*, 1979. Deux régressions :
 *  - coût en oxygène de la course, en ml/kg/min, à la vitesse v (m/min) :
 *    VO2 = −4.60 + 0.182258·v + 0.000104·v²
 *  - fraction de VO2max soutenable sur une durée t (min) :
 *    pct = 0.8 + 0.1894393·e^(−0.012778·t) + 0.2989558·e^(−0.1932605·t)
 * VDOT = VO2 / pct.
 *
 * **Ce module suppose un effort de course MAXIMAL** (course, test, contre-la-
 * montre) : la seconde régression déduit l'intensité de la seule durée, en
 * postulant que l'athlète a donné tout ce qu'il pouvait tenir sur ce temps.
 * Appliquée à un footing, elle sous-estime massivement la VO2max — c'est
 * `estimateEffectiveVo2max` (`./vo2max`), corrigée par la fréquence cardiaque,
 * qui vaut pour une séance quelconque.
 */

export type EffortInput = { distanceM: number; movingTimeS: number };

/**
 * Bornes de validité du modèle. En deçà, la performance est dominée par la
 * filière anaérobie et la régression de Daniels & Gilbert ne s'applique plus.
 *
 * Partagées avec `./vo2max`, qui écarte les mêmes efforts trop courts pour être
 * représentatifs (échauffement isolé, tour de piste enregistré à part).
 */
export const MIN_EFFORT_DISTANCE_M = 1500;
export const MIN_EFFORT_DURATION_MIN = 4;

/**
 * Garde-fou physiologique : hors de cette plage, le résultat est une aberration.
 * Partagé avec `./vo2max`.
 */
export const MIN_PLAUSIBLE_VO2MAX = 20;
export const MAX_PLAUSIBLE_VO2MAX = 90;

/**
 * Coût en oxygène de la course à la vitesse `velocityMPerMin`, en ml/kg/min.
 * Première régression de Daniels & Gilbert. À la vitesse associée à VO2max
 * (vVO2max), ce coût *est* la VO2max — c'est ce qu'exploite `./vo2max`.
 */
export function oxygenCostAtVelocity(velocityMPerMin: number): number {
  return (
    -4.6 + 0.182258 * velocityMPerMin + 0.000104 * velocityMPerMin * velocityMPerMin
  );
}

/**
 * Fraction de VO2max qu'un coureur peut soutenir pendant `durationMin` minutes.
 * Seconde régression de Daniels & Gilbert — n'a de sens que sur un effort mené
 * jusqu'à épuisement.
 */
export function sustainableFractionOverDuration(durationMin: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * durationMin) +
    0.2989558 * Math.exp(-0.1932605 * durationMin)
  );
}

/**
 * VDOT (Daniels & Gilbert) d'une **performance maximale**. Renvoie `null` si
 * l'effort est hors du domaine de validité du modèle (< 1500 m ou < 4 min), si
 * les entrées sont nulles, négatives ou non finies, ou si le VDOT obtenu sort de
 * la plage plausible.
 */
export function estimateVdot(effort: EffortInput): number | null {
  const { distanceM, movingTimeS } = effort;

  if (!Number.isFinite(distanceM) || distanceM <= 0) return null;
  if (!Number.isFinite(movingTimeS) || movingTimeS <= 0) return null;
  if (distanceM < MIN_EFFORT_DISTANCE_M) return null;

  const durationMin = movingTimeS / 60;
  if (durationMin < MIN_EFFORT_DURATION_MIN) return null;

  const velocityMPerMin = distanceM / durationMin;
  const vdot =
    oxygenCostAtVelocity(velocityMPerMin) / sustainableFractionOverDuration(durationMin);

  if (!Number.isFinite(vdot)) return null;
  if (vdot < MIN_PLAUSIBLE_VO2MAX || vdot > MAX_PLAUSIBLE_VO2MAX) return null;

  return vdot;
}
