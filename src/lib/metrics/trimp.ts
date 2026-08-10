/**
 * TRIMP pondéré par la fréquence cardiaque (Banister).
 *
 * Source : Banister EW, « Modeling elite athletic performance », in MacDougall,
 * Wenger & Green (éd.), *Physiological Testing of Elite Athletes*, Human
 * Kinetics, 1991. Coefficients de pondération exponentielle issus de la
 * régression sur la courbe lactate/réserve cardiaque : 0.64 · e^(1.92·HRr) chez
 * l'homme, 0.86 · e^(1.67·HRr) chez la femme.
 */

export type Sex = 'male' | 'female';

export type TrimpInput = {
  movingTimeS: number;
  avgHrBpm: number | null;
  restingHrBpm: number | null;
  maxHrBpm: number | null;
  sex: Sex;
};

/** Coefficients (a, b) de la pondération a · e^(b · HRr), spécifiques au sexe. */
const HR_WEIGHTS: Record<Sex, { readonly a: number; readonly b: number }> = {
  male: { a: 0.64, b: 1.92 },
  female: { a: 0.86, b: 1.67 },
};

/**
 * TRIMP de Banister : durée_min × HRr × a × e^(b · HRr).
 *
 * Renvoie `null` — jamais une valeur approchée — si une des FC nécessaires
 * manque, si l'échelle de réserve cardiaque est incohérente (max ≤ repos) ou si
 * la durée est nulle/négative. Les entrées non finies (`NaN`, `Infinity`) sont
 * traitées comme des données manquantes.
 *
 * `HRr` est borné dans [0, 1] : une FC moyenne sous la FC de repos ou au-dessus
 * de la FC max est une aberration de mesure, pas une charge négative ou majorée.
 */
export function computeTrimp(input: TrimpInput): number | null {
  const { movingTimeS, avgHrBpm, restingHrBpm, maxHrBpm, sex } = input;

  if (avgHrBpm === null || restingHrBpm === null || maxHrBpm === null) return null;
  if (!Number.isFinite(avgHrBpm) || !Number.isFinite(restingHrBpm) || !Number.isFinite(maxHrBpm)) {
    return null;
  }
  if (!Number.isFinite(movingTimeS) || movingTimeS <= 0) return null;
  if (maxHrBpm <= restingHrBpm) return null;

  const hrReserve = Math.min(1, Math.max(0, (avgHrBpm - restingHrBpm) / (maxHrBpm - restingHrBpm)));
  const durationMin = movingTimeS / 60;
  const { a, b } = HR_WEIGHTS[sex];

  return durationMin * hrReserve * a * Math.exp(b * hrReserve);
}
