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
 */

export type EffortInput = { distanceM: number; movingTimeS: number };

/**
 * Bornes de validité du modèle. En deçà, la performance est dominée par la
 * filière anaérobie et la régression de Daniels & Gilbert ne s'applique plus.
 */
const MIN_DISTANCE_M = 1500;
const MIN_DURATION_MIN = 4;

/** Garde-fou physiologique : hors de cette plage, le résultat est une aberration. */
const MIN_PLAUSIBLE_VDOT = 20;
const MAX_PLAUSIBLE_VDOT = 90;

/**
 * VDOT (Daniels & Gilbert). Renvoie `null` si l'effort est hors du domaine de
 * validité du modèle (< 1500 m ou < 4 min), si les entrées sont nulles,
 * négatives ou non finies, ou si le VDOT obtenu sort de la plage plausible.
 */
export function estimateVdot(effort: EffortInput): number | null {
  const { distanceM, movingTimeS } = effort;

  if (!Number.isFinite(distanceM) || distanceM <= 0) return null;
  if (!Number.isFinite(movingTimeS) || movingTimeS <= 0) return null;
  if (distanceM < MIN_DISTANCE_M) return null;

  const durationMin = movingTimeS / 60;
  if (durationMin < MIN_DURATION_MIN) return null;

  const velocityMPerMin = distanceM / durationMin;
  const vo2 = -4.6 + 0.182258 * velocityMPerMin + 0.000104 * velocityMPerMin * velocityMPerMin;
  const pctOfMax =
    0.8 +
    0.1894393 * Math.exp(-0.012778 * durationMin) +
    0.2989558 * Math.exp(-0.1932605 * durationMin);

  const vdot = vo2 / pctOfMax;
  if (!Number.isFinite(vdot)) return null;
  if (vdot < MIN_PLAUSIBLE_VDOT || vdot > MAX_PLAUSIBLE_VDOT) return null;

  return vdot;
}
